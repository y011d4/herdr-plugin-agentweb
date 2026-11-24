package bridge

// Which Claude account a process / pane / directory belongs to, a port of
// server/account.ts, so an orchestrator only sees and drives agents of its own
// account (agentwebctl overview + `agent` commands). An account is its transcript
// projects root — CLAUDE_CONFIG_DIR/projects, default ~/.claude/projects — the same
// key projectsRootForPid derives from a process. Every lookup answers "" (TS: null)
// when it can't tell, and callers treat that as "not yours" (fail closed).
//
// Accounts come from the environment: per-dir direnv `.envrc`s export
// CLAUDE_CONFIG_DIR. Like projectsRootForPid, nothing here holds or prints any
// other variable (an .envrc may carry secrets).

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// accountForConfigDir is CLAUDE_CONFIG_DIR/projects, else <home>/.claude/projects,
// resolved. home "" = Node's os.homedir() (the TS default, process.env.HOME || homedir()).
func accountForConfigDir(configDir, home string) string {
	if configDir != "" {
		return absPath(filepath.Join(configDir, "projects"))
	}
	if home == "" {
		home = osHomedir()
	}
	return absPath(filepath.Join(home, ".claude", "projects"))
}

// accountEnv is the environment that starts a claude under account: CLAUDE_CONFIG_DIR
// for any but the default account, which is left unset as it was (set, even to
// ~/.claude, Claude Code keeps its state elsewhere). nil for the default or an
// unknown ("") account.
func accountEnv(account, home string) map[string]string {
	if account == "" || account == accountForConfigDir("", home) {
		return nil
	}
	return map[string]string{"CLAUDE_CONFIG_DIR": filepath.Dir(account)}
}

// parseProcStat reads comm and the parent pid out of /proc/<pid>/stat
// ("pid (comm) state ppid …"; comm may hold spaces or parens).
func parseProcStat(stat string) (comm string, ppid int, ok bool) {
	lp := strings.IndexByte(stat, '(')
	rp := strings.LastIndexByte(stat, ')')
	if lp == -1 || rp < lp {
		return "", 0, false
	}
	rest := ""
	if rp+2 <= len(stat) {
		rest = stat[rp+2:]
	}
	fields := strings.Split(rest, " ")
	if len(fields) < 2 {
		return "", 0, false
	}
	// Number(): an empty field is 0
	if f := jsTrim(fields[1]); f != "" {
		n, err := strconv.Atoi(f)
		if err != nil {
			return "", 0, false
		}
		ppid = n
	}
	return stat[lp+1 : rp], ppid, true
}

func isClaude(pid int, comm string) bool {
	if comm == "claude" {
		return true
	}
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil {
		return false
	}
	argv0, _, _ := strings.Cut(string(b), "\x00")
	return argv0 != "" && filepath.Base(argv0) == "claude"
}

// ownAccount is the caller's account: that of the nearest `claude` ancestor (an
// orchestrator runs us from its Bash tool), so a command-line CLAUDE_CONFIG_DIR can't
// pose as another account. With no claude ancestor (a person in a terminal), our own
// environment.
func ownAccount() string {
	pid := os.Getppid()
	for hops := 0; hops < 64 && pid > 1; hops++ {
		stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil {
			break
		}
		comm, ppid, ok := parseProcStat(string(stat))
		if !ok {
			break
		}
		if isClaude(pid, comm) {
			return projectsRootForPid(pid)
		}
		pid = ppid
	}
	return accountForConfigDir(os.Getenv("CLAUDE_CONFIG_DIR"), "")
}

// paneAccount is a pane's account: that of its foreground process group leader — the
// agent the shell launched. A pane whose shell is in the foreground (no agent) is
// unknown: the shell's own environ predates direnv, so it would misreport.
func paneAccount(rpc Rpc, paneID string) (string, error) {
	raw, err := rpc("pane.process_info", map[string]any{"pane_id": paneID})
	if err != nil {
		return "", err
	}
	var res struct {
		ProcessInfo *struct {
			ForegroundProcessGroupID *float64 `json:"foreground_process_group_id"`
			ShellPid                 *float64 `json:"shell_pid"`
		} `json:"process_info"`
	}
	json.Unmarshal(raw, &res) // anything else: no number below, so unknown
	info := res.ProcessInfo
	if info == nil || info.ForegroundProcessGroupID == nil {
		return "", nil
	}
	pid := *info.ForegroundProcessGroupID
	if info.ShellPid != nil && pid == *info.ShellPid || pid != math.Trunc(pid) || math.Abs(pid) > math.MaxInt32 {
		return "", nil // not a pid /proc could name
	}
	return projectsRootForPid(int(pid)), nil
}

// PaneAccountCache is each agent pane's account, for the per-orchestrator lists.
// Refresh (with the panes that have an agent now) looks a pane up when it has none yet
// and again once ttl has passed, so an answer that couldn't tell (nil) or one left by
// an agent swapped in the same pane corrects itself; panes that lost their agent are
// forgotten, and so is the answer of a lookup during which its pane lost its agent (it
// may describe that agent, not the next one). A lookup that fails is tried again on the
// next refresh. onChange runs when an answer changes the map or a dropped one leaves
// its pane to ask about again; the caller refreshes then, on each state change, and at
// least every ttl.
//
// Lookups run on their own goroutines, so Refresh never waits on one, and onChange is
// called with no lock held: the bridge calls Refresh while broadcasting, and its
// onChange broadcasts again.
// ponytail: a swapped agent keeps the old account for up to ttl; key on herdr's agent
// session if that ever matters.
type PaneAccountCache struct {
	lookup   func(paneID string) (string, error)
	onChange func()
	ttl      time.Duration
	now      func() time.Time

	mu        sync.Mutex
	accounts  map[string]string // "": the lookup couldn't tell
	checkedAt map[string]time.Time
	pending   map[string]bool
	dropped   map[string]bool // pending lookups whose pane lost its agent meanwhile
}

// newPaneAccountCache is paneAccountCache (TS defaults: ttl 60 s, now time.Now).
func newPaneAccountCache(lookup func(paneID string) (string, error), onChange func(), ttl time.Duration, now func() time.Time) *PaneAccountCache {
	return &PaneAccountCache{
		lookup: lookup, onChange: onChange, ttl: ttl, now: now,
		accounts: map[string]string{}, checkedAt: map[string]time.Time{},
		pending: map[string]bool{}, dropped: map[string]bool{},
	}
}

// Accounts is a copy of the pane → account map (nil: couldn't tell), for findOrchestrators.
func (c *PaneAccountCache) Accounts() map[string]*string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]*string, len(c.accounts))
	for k, v := range c.accounts {
		if v == "" {
			out[k] = nil
		} else {
			out[k] = &v
		}
	}
	return out
}

func (c *PaneAccountCache) Refresh(agentPanes []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	live := make(map[string]bool, len(agentPanes))
	for _, id := range agentPanes {
		live[id] = true
	}
	for id := range c.checkedAt {
		if !live[id] {
			delete(c.checkedAt, id)
			delete(c.accounts, id)
		}
	}
	for id := range c.pending {
		if !live[id] {
			c.dropped[id] = true
		}
	}
	for _, id := range agentPanes {
		if t, ok := c.checkedAt[id]; c.pending[id] || ok && c.now().Sub(t) < c.ttl {
			continue
		}
		c.pending[id] = true
		go c.check(id)
	}
}

// check is one lookup, in the TS's two steps: its answer (.then), then the cleanup (.finally).
func (c *PaneAccountCache) check(id string) {
	account, err := c.lookup(id)
	c.mu.Lock()
	changed := false
	if err == nil && !c.dropped[id] { // dropped: the pane's agent changed, a later refresh asks again
		c.checkedAt[id] = c.now()
		if prev, ok := c.accounts[id]; !ok || prev != account {
			c.accounts[id] = account
			changed = true
		}
	}
	c.mu.Unlock()
	if changed {
		c.onChange()
	}
	c.mu.Lock()
	delete(c.pending, id)
	wasDropped := c.dropped[id]
	delete(c.dropped, id)
	c.mu.Unlock()
	if wasDropped {
		c.onChange() // the caller refreshes: its pane may hold the next agent already
	}
}

// the marker ends the output (an .envrc may print lines of its own before it)
var dirAccountMarker = regexp.MustCompile(`(?:^|\n)ok:([^\n]*)$`)

// dirAccount is the account a fresh shell in dir would run under: what direnv exports
// there, starting from our environment minus any account and direnv state of our own.
// "" when direnv is missing, the dir doesn't exist, or its .envrc is blocked.
func dirAccount(dir string) string {
	var env []string
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); k != "CLAUDE_CONFIG_DIR" && !strings.HasPrefix(k, "DIRENV_") {
			env = append(env, kv)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	// print only the one variable, behind a marker that proves the .envrc loaded
	// (direnv itself fails before running the command when it can't)
	cmd := exec.CommandContext(ctx, "direnv", "exec", dir, "sh", "-c", `printf "ok:%s" "${CLAUDE_CONFIG_DIR-}"`)
	cmd.Env = env
	stdout := &cappedBuffer{max: 64 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = &cappedBuffer{max: 64 * 1024} // execFile's maxBuffer caps stderr too
	cmd.WaitDelay = time.Second                // something the .envrc left running can't hold the pipes past the timeout
	if cmd.Run() != nil {
		return ""
	}
	m := dirAccountMarker.FindStringSubmatch(stdout.String())
	if m == nil {
		return ""
	}
	return accountForConfigDir(m[1], "")
}
