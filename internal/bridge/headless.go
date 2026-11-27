package bridge

// Headless orchestrators (config orchestrators[].mode "headless", managed entries only):
// the bridge runs the orchestrator itself, as `claude -p` over stream-json, instead of an
// agent in a herdr pane. One headlessRunner per such entry: start (the billing checks and
// the orphan scan first), send, interrupt, stop, clear, restarts after a crash, and the
// bridge's shutdown. What the stream says is headless_state.go's. Nothing here runs
// without a headless entry.
//
// The child's argv carries --mcp-config <state>/headless/<name>.mcp.json, which only the
// bridge writes: the marker that tells its own (orphaned) child from a `claude --resume`
// the user runs on the same session. Its environment is an allowlist (never HERDR_*, which
// would make herdr's hooks report it as a pane, nor any billing variable).

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif" // imageBlocks decodes them
	_ "image/jpeg"
	_ "image/png"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// managedSettingsPath is Claude Code's managed (system-wide) settings file.
var managedSettingsPath = "/etc/claude-code/managed-settings.json"

const restartedNotice = "[yoicks] restarted while you were working; check overview."

// claudeBin is the claude the bridge runs: YOICKS_CLAUDE_BIN (tests: tools/fakeclaude),
// else claude on PATH.
func claudeBin() string { return firstNonEmpty(os.Getenv("YOICKS_CLAUDE_BIN"), "claude") }

// headlessArgv is the child's arguments: a resumed or a new session, no MCP server but the
// bridge's, manual permissions through its approve, one built-in tool, and (tools) the
// bridge's six allowed unasked.
func headlessArgv(sessionID string, resume bool, mcpConfig string, tools bool) []string {
	session := "--session-id"
	if resume {
		session = "--resume"
	}
	argv := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		session, sessionID, "--mcp-config", mcpConfig, "--strict-mcp-config",
		"--permission-prompt-tool", "mcp__yoicks__approve", "--permission-mode", "manual", "--tools", "AskUserQuestion"}
	if tools {
		argv = append(argv, "--allowedTools", strings.Join(headlessTools(true)[1:], ","))
	}
	return argv
}

// headlessTools is the exact tool set a child reports at init: AskUserQuestion, then the
// bridge's (approve is hidden by Claude Code itself, S0 row 19).
func headlessTools(tools bool) []string {
	out := []string{"AskUserQuestion"}
	if tools {
		for _, t := range yoicksTools {
			out = append(out, "mcp__yoicks__"+t)
		}
	}
	return out
}

// isBillingVar is a variable that could make Claude Code bill an API key or a cloud
// provider instead of the subscription.
func isBillingVar(k string) bool {
	return strings.HasPrefix(k, "ANTHROPIC_") || strings.HasPrefix(k, "CLAUDE_CODE_USE_") || k == "AWS_BEARER_TOKEN_BEDROCK"
}

// headlessEnv is the child's environment: the allowlisted parts of the bridge's, TERM=dumb,
// then the entry's own (billing and herdr variables never, whichever side has them).
func headlessEnv(parent []string, entry map[string]string) []string {
	keep := []string{"HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR"}
	var env []string
	for _, kv := range parent {
		k, _, _ := strings.Cut(kv, "=")
		if (slices.Contains(keep, k) || strings.HasPrefix(k, "LC_")) && entry[k] == "" {
			env = append(env, kv)
		}
	}
	env = append(env, "TERM=dumb")
	for _, k := range slices.Sorted(func(yield func(string) bool) {
		for k := range entry {
			if !yield(k) {
				return
			}
		}
	}) {
		if !isBillingVar(k) && !strings.HasPrefix(k, "HERDR_") && k != "TERM" {
			env = append(env, k+"="+entry[k])
		}
	}
	return env
}

// settingsBilling is what in a Claude Code settings file could bill an API key ("" = nothing):
// an env billing variable or an apiKeyHelper. claude auth status doesn't see a settings
// file's env (S0). A file that isn't JSON counts too (fail closed).
func settingsBilling(content []byte) string {
	var s struct {
		Env          map[string]any `json:"env"`
		APIKeyHelper any            `json:"apiKeyHelper"`
	}
	if json.Unmarshal(content, &s) != nil {
		return "unreadable JSON"
	}
	for _, k := range slices.Sorted(func(yield func(string) bool) {
		for k := range s.Env {
			if !yield(k) {
				return
			}
		}
	}) {
		if isBillingVar(k) {
			return "env." + k
		}
	}
	if s.APIKeyHelper != nil && s.APIKeyHelper != "" {
		return "apiKeyHelper"
	}
	return ""
}

// heldSession sorts the claudes that matter to a start: ours (with the bridge's marker: an
// earlier bridge's child, whatever its session) and anyone else's holding sessionID (a
// user's `claude --resume`).
func heldSession(procs []procArgs, sessionID, mcpConfig string) (ours, others []procArgs) {
	for _, p := range procs {
		switch {
		case hasMarker(p.argv, mcpConfig):
			ours = append(ours, p)
		case sessionID != "" && slices.Contains(p.argv, sessionID):
			others = append(others, p)
		}
	}
	return ours, others
}

// orphanTarget is what kill gets for an orphan: its group (-pid) only when it leads one,
// else the process alone (a group it merely belongs to may be anyone's).
func orphanTarget(pid, pgid int) int {
	if pgid == pid {
		return -pid
	}
	return pid
}

func hasMarker(argv []string, mcpConfig string) bool {
	i := slices.Index(argv, "--mcp-config")
	return i >= 0 && i+1 < len(argv) && argv[i+1] == mcpConfig
}

type procArgs struct {
	pid  int
	argv []string
}

// claudeProcs is this host's claude processes and their argv (/proc: Linux only; none elsewhere).
func claudeProcs() []procArgs {
	entries, _ := os.ReadDir("/proc")
	var out []procArgs
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if err != nil || len(b) == 0 {
			continue
		}
		argv := strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
		comm, _ := os.ReadFile("/proc/" + e.Name() + "/comm")
		if filepath.Base(argv[0]) == "claude" || strings.TrimSpace(string(comm)) == "claude" {
			out = append(out, procArgs{pid, argv})
		}
	}
	return out
}

// markedHeadlessChild is the pid of a claude carrying the marker of orchestrator name (its
// headless child, from this bridge or an earlier one), 0 for none. Linux only.
func markedHeadlessChild(stateDir, name string) int {
	for _, p := range claudeProcs() {
		if hasMarker(p.argv, headlessPath(stateDir, name, ".mcp.json")) {
			return p.pid
		}
	}
	return 0
}

func headlessPath(stateDir, name, ext string) string {
	return filepath.Join(stateDir, "headless", name+ext)
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// tailWriter keeps the last bytes written (a child's stderr), never failing a write.
type tailWriter struct {
	mu  sync.Mutex
	buf []byte
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buf = append(w.buf, p...)
	if over := len(w.buf) - 2048; over > 0 {
		w.buf = w.buf[over:]
	}
	return len(p), nil
}

func (w *tailWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return strings.TrimSpace(strings.ToValidUTF8(string(w.buf), ""))
}

// ── the runner ───────────────────────────────────────────────────────────────

// clock is the time the runner's own timers run on: its restarts, the coalesced wake-ups, a
// prompt's delivery window, the waits between a watch's looks, the silence and the question
// checks. Not the deadlines on a real process or pipe (stopChild's signals, write deadlines):
// those stay on the real time. Tests give it a fakeherdr.FakeClock, moved on when they say.
type clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
	AfterFunc(d time.Duration, f func()) interface{ Stop() bool }
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }
func (realClock) AfterFunc(d time.Duration, f func()) interface{ Stop() bool } {
	return time.AfterFunc(d, f)
}

type headlessRunner struct {
	def      OrchestratorDef
	stateDir string
	rules    string
	// herdr: requests, ones allowing git and an agent's start time, and waits (no deadline)
	rpc, slowRPC Rpc
	waitRPC      func(ctx context.Context, method string, params map[string]any) (json.RawMessage, error)
	profiles     map[string]LaunchProfile   // agent_start's
	onChange     func()                     // its view changed
	onAlert      func(kind, message string) // a new warning: once per kind and session
	onStatus     func(from, to string)      // it went done or blocked
	log          func(format string, a ...any)

	// its MCP server (mcp.go): its URL, its current child's bearer ("": none, r.mu); tools
	// false: approve only (YOICKS_HEADLESS_NO_TOOLS, tests)
	mcpURL, mcpBearer string
	tools             bool

	// timings: their timers run on clock (the real one; a test's moves when the test says)
	clock         clock
	restartDelays []time.Duration // before each restart after a crash; one more crash in the window: error
	crashWindow   time.Duration
	interruptWait time.Duration
	silence       time.Duration
	lineHook      func([]byte) // tests: runs on each stdout line, in the reader
	startedHook   func()       // tests: runs once the child has started, before spawn goes on
	extraArgs     []string     // tests: more argv (the claudelive test's --model haiku); never set in production

	op sync.Mutex // start, stop, clear: one at a time

	mu           sync.Mutex
	sessionID    string
	wanted       bool
	interrupted  bool   // the bridge stopped it mid-turn: tell it so when it resumes
	rulesHash    string // of the rules its session began with
	closed       bool   // the bridge is shutting down
	child        *hlChild
	model        hlModel
	warnings     []HeadlessWarning
	alerted      map[string]bool // kinds notified this session
	crashes      []time.Time
	restartTimer interface{ Stop() bool }
	interrupts   map[string]chan struct{}
	nInterrupt   int
	lastEvent    time.Time
	pending      *hlPending          // the question waiting for the user
	asks         map[string]bool     // AskUserQuestion tool_use ids: did each reach approve?
	served       map[string]bool     // the tool_use ids of the tool calls that reached the bridge, until their result
	watches      map[string]*hlWatch // by pane
	saved        []hlWatch           // the watches saved by an earlier bridge, re-armed at the first start
	wakes        []string
	wakeTimer    interface{ Stop() bool }
	gen          int // its workers' generation: Stop and Clear begin a new one (forgetWorkers)
	// its child's epoch: each start (a restart's too), Stop and Clear begin a new one; a call
	// or a question from another child registers nothing (watch, ask)
	epoch int
}

type hlChild struct {
	cmd      *exec.Cmd
	stdin    *os.File
	wlock    chan struct{} // one write at a time; a channel, so a stop can wait for it a bounded time
	stdinEnd sync.Once
	stderr   *tailWriter
	done     chan struct{} // closed once it has exited and its stdout is read
	expected bool          // its exit was asked for (r.mu)
	failed   bool          // it is being killed for an error: what it still says is ignored (r.mu)
	epoch    int           // the runner's epoch it began in: what it asks carries this, not a later Stop/Clear's
}

// headlessState is the persisted part (<state>/headless/<name>.json).
type headlessState struct {
	SessionID   string    `json:"sessionId"`
	Wanted      bool      `json:"wanted"`
	Interrupted bool      `json:"interrupted,omitempty"`
	RulesHash   string    `json:"rulesHash,omitempty"`
	Watches     []hlWatch `json:"watches,omitempty"`
	Wakes       []string  `json:"wakes,omitempty"` // wake-ups not written to it yet
	// its completed turns so far, kept across bridge restarts: a phone's seen-done record is
	// keyed on it, so a count starting over would pass a new completion off as one seen
	CompletionSeq int64 `json:"completionSeq,omitempty"`
}

// newHeadlessRunner is def's runner; the server fills in its herdr calls, profiles and
// callbacks, the MCP host its server.
func newHeadlessRunner(def OrchestratorDef, stateDir, rules string) *headlessRunner {
	r := &headlessRunner{def: def, stateDir: stateDir, rules: rules,
		onChange: func() {}, onAlert: func(string, string) {}, onStatus: func(string, string) {},
		log:           func(f string, a ...any) { logf("[headless "+def.Name+"] "+f, a...) },
		tools:         os.Getenv("YOICKS_HEADLESS_NO_TOOLS") != "1",
		clock:         realClock{},
		restartDelays: []time.Duration{2 * time.Second, 10 * time.Second, 30 * time.Second},
		crashWindow:   10 * time.Minute, interruptWait: 2 * time.Second, silence: 3 * time.Minute,
		alerted: map[string]bool{}, interrupts: map[string]chan struct{}{}, asks: map[string]bool{}, served: map[string]bool{},
		watches: map[string]*hlWatch{}}
	r.model.Status = "stopped"
	var saved headlessState
	if b, err := os.ReadFile(headlessPath(stateDir, def.Name, ".json")); err == nil && json.Unmarshal(b, &saved) == nil && (saved.SessionID == "" || sessionIDRe.MatchString(saved.SessionID)) {
		r.sessionID, r.wanted, r.interrupted, r.rulesHash, r.saved, r.wakes = saved.SessionID, saved.Wanted, saved.Interrupted, saved.RulesHash, saved.Watches, saved.Wakes
		r.model.CompletionSeq = saved.CompletionSeq
	}
	if kind, msg := r.refusedEnv(); msg != "" {
		r.model.Status = "error"
		r.warnings = []HeadlessWarning{{Kind: kind, Message: msg, Since: nowMs(), Actions: warningActions[kind]}}
	}
	return r
}

// refusedEnv is why its entry's env can't run headless ("" = it can): a billing variable, or
// a home of its own (the child would read that home's settings and keep its transcripts
// there, while the checks, the account and the chat read the bridge's).
func (r *headlessRunner) refusedEnv() (kind, message string) {
	var billing, home []string
	for k := range r.def.Env {
		if isBillingVar(k) {
			billing = append(billing, k)
		} else if k == "HOME" || k == "XDG_CONFIG_HOME" {
			home = append(home, k)
		}
	}
	slices.Sort(billing)
	slices.Sort(home)
	switch {
	case len(billing) > 0:
		return "billing", fmt.Sprintf("its env sets %s: a headless orchestrator never runs with billing or auth variables", strings.Join(billing, ", "))
	case len(home) > 0:
		return "env", fmt.Sprintf("its env sets %s: a headless orchestrator runs in the bridge's home (pick its account with CLAUDE_CONFIG_DIR)", strings.Join(home, ", "))
	}
	return "", ""
}

// view is its state for clients, and whether its child runs.
func (r *headlessRunner) view() (HeadlessView, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v := HeadlessView{Status: r.model.Status, CompletionSeq: r.model.CompletionSeq, Warnings: slices.Clone(r.warnings)}
	if v.Warnings == nil {
		v.Warnings = []HeadlessWarning{}
	}
	if u := r.model.Usage; u != nil {
		c := *u
		v.Usage = &c
	}
	if p := r.pending; p != nil {
		v.Pending = &HeadlessPending{ID: p.id, Questions: p.questions}
	}
	return v, r.child != nil
}

func (r *headlessRunner) session() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sessionID
}

// transcriptFile is its session's transcript in its account's projects ("" when there is none
// yet: Claude Code writes it at the session's first message).
func (r *headlessRunner) transcriptFile() string {
	sid := r.session()
	if sid == "" {
		return ""
	}
	return resolveTranscriptPath(sid, r.def.Dir, []string{accountForConfigDir(r.def.Env["CLAUDE_CONFIG_DIR"], "")})
}

// hasTranscript is whether Claude Code has its session's transcript where it looks for one: its
// account's projects/<slug of its cwd as the child sees it, links resolved>/<id>.jsonl, followed
// wherever that links (unlike the chat's read, no containment applies to what Claude Code resumes).
func (r *headlessRunner) hasTranscript() bool {
	sid := r.session()
	if sid == "" {
		return false
	}
	dir := r.def.Dir
	if real, err := filepath.EvalSymlinks(dir); err == nil {
		dir = real
	}
	_, err := os.Stat(filepath.Join(accountForConfigDir(r.def.Env["CLAUDE_CONFIG_DIR"], ""), slugForCwd(dir), sid+".jsonl"))
	return err == nil
}

func (r *headlessRunner) wantsToRun() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.wanted && r.model.Status != "error"
}

// persist writes the saved state; r.mu held. Best-effort, like the pane profile store.
func (r *headlessRunner) persist() {
	var watches []hlWatch
	for _, w := range r.watches {
		watches = append(watches, *w)
	}
	for _, w := range r.saved { // not re-armed yet
		if r.watches[w.Pane] == nil {
			watches = append(watches, w)
		}
	}
	slices.SortFunc(watches, func(a, b hlWatch) int { return strings.Compare(a.Pane, b.Pane) })
	b, _ := json.Marshal(headlessState{r.sessionID, r.wanted, r.interrupted, r.rulesHash, watches, r.wakes, r.model.CompletionSeq})
	if os.MkdirAll(filepath.Join(r.stateDir, "headless"), 0o700) == nil {
		writeFile0600(headlessPath(r.stateDir, r.def.Name, ".json"), b)
	}
}

// warn adds (or renews) a warning; r.mu held. The returned func, called with r.mu released,
// sends the alert when this kind is new this session.
func (r *headlessRunner) warn(kind, message string) func() {
	r.log("warning %s: %s", kind, message)
	w := HeadlessWarning{Kind: kind, Message: message, Since: nowMs(), Actions: warningActions[kind]}
	if w.Actions == nil {
		w.Actions = []string{}
	}
	if i := slices.IndexFunc(r.warnings, func(o HeadlessWarning) bool { return o.Kind == kind }); i >= 0 {
		w.Since = r.warnings[i].Since
		r.warnings[i] = w
	} else {
		r.warnings = append(r.warnings, w)
	}
	if r.alerted[kind] {
		return func() {}
	}
	r.alerted[kind] = true
	return func() { r.onAlert(kind, message) }
}

// setClaudeCheck takes the last claude check (the bridge's minute tick): see syncCheckLocked.
func (r *headlessRunner) setClaudeCheck(c *ClaudeCheck) {
	r.mu.Lock()
	r.model.check = c
	changed := r.syncCheckLocked()
	r.mu.Unlock()
	if changed {
		r.onChange()
	}
}

// syncCheckLocked keeps the warnings in line with the last claude check: a canary warning while
// it is a failed one (alerted by the bridge, once for all orchestrators), and a version warning
// telling it; r.mu held. Whether they changed.
func (r *headlessRunner) syncCheckLocked() bool {
	c, changed := r.model.check, false
	i := slices.IndexFunc(r.warnings, func(w HeadlessWarning) bool { return w.Kind == "canary" })
	if c != nil && !c.OK {
		msg := "the last Claude Code check " + c.describe() + ": headless may not work; back to the TUI until a check passes"
		if changed = i < 0 || r.warnings[i].Message != msg; changed {
			r.warn("canary", msg)
		}
	} else if changed = i >= 0; changed {
		r.warnings = slices.Delete(r.warnings, i, i+1)
	}
	if i := slices.IndexFunc(r.warnings, func(w HeadlessWarning) bool { return w.Kind == "version" }); i >= 0 {
		if r.model.version == verifiedClaudeVersion { // the verified one now: the warning is stale
			r.warnings, changed = slices.Delete(r.warnings, i, i+1), true
		} else if msg := versionWarning(r.model.version, c); r.warnings[i].Message != msg {
			r.warnings[i].Message, changed = msg, true
		}
	}
	return changed
}

// fail makes it an error with a warning, and returns err.
func (r *headlessRunner) fail(kind string, err *LifecycleError) error {
	r.mu.Lock()
	r.model.Status = "error"
	alert := r.warn(kind, err.Message)
	r.mu.Unlock()
	alert()
	r.onChange()
	return err
}

// recoverAt ends a panic in one of the runner's own goroutines: that orchestrator is an
// error and its child stops; the bridge goes on.
func (r *headlessRunner) recoverAt(where string) {
	p := recover()
	if p == nil {
		return
	}
	r.log("panic in %s: %v\n%s", where, p, debug.Stack())
	r.mu.Lock()
	c := r.child
	if c != nil {
		c.expected, c.failed = true, true
	}
	r.model.Status = "error"
	alert := r.warn("panic", fmt.Sprintf("internal error in %s: %v; stopped", where, p))
	r.mu.Unlock()
	if c != nil {
		syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL)
	}
	alert()
	r.onChange()
}

// ── start ────────────────────────────────────────────────────────────────────

// Start starts it (Home's Start, or the bridge's own start of one that was running):
// resuming its session when it has one.
func (r *headlessRunner) Start() error {
	r.op.Lock()
	defer r.op.Unlock()
	r.mu.Lock()
	if r.child != nil {
		r.mu.Unlock()
		return &LifecycleError{Status: 409, Code: "already_running", Message: "orchestrator " + r.def.Name + " already runs"}
	}
	r.resetLocked()
	resume := r.sessionID != ""
	r.mu.Unlock()
	return r.start(resume)
}

// resetLocked forgets the last run's warnings and crashes (a person asked for a start); r.mu held.
func (r *headlessRunner) resetLocked() {
	if r.restartTimer != nil {
		r.restartTimer.Stop()
		r.restartTimer = nil
	}
	r.warnings, r.crashes = nil, nil
	r.syncCheckLocked() // the last claude check's warning stands across a start
	if r.model.Status == "error" {
		r.model.Status = "stopped"
	}
}

// start runs the checks, then the child; r.op held.
func (r *headlessRunner) start(resume bool) error {
	others := r.reapOrphans() // first: whatever refuses this start, an earlier bridge's child stops
	if kind, msg := r.refusedEnv(); msg != "" {
		return r.fail(kind, &LifecycleError{Status: 409, Code: kind + "_refused", Message: msg})
	}
	if r.rpc != nil {
		// best-effort: herdr down must not keep the orchestrator from coming back
		if pane, err := agentInDir(r.rpc, r.def.Dir); err != nil {
			r.log("could not check for a TUI agent in %s: %s", r.def.Dir, err)
		} else if pane != "" {
			return &LifecycleError{Status: 409, Code: "already_running", Message: fmt.Sprintf("a TUI agent runs in its dir (pane %s)", pane)}
		}
	}
	mcpConfig := headlessPath(r.stateDir, r.def.Name, ".mcp.json")
	// a session that has had no message has no transcript, and Claude Code can't resume it ("No
	// conversation found"): it begins again under the same id (nothing of it is lost)
	begin := resume && !r.hasTranscript()
	if resume && len(others) > 0 {
		return &LifecycleError{Status: 409, Code: "session_in_use", Message: fmt.Sprintf(
			"another claude (pid %d) runs its session %s: end it first (yoicks never stops it; only Linux, with /proc, can see it)", others[0].pid, r.session())}
	}
	if err := ensureOrchestratorDir(r.def, r.rules); err != nil {
		return r.fail("start", &LifecycleError{Status: 500, Code: "error", Message: "could not write " + r.def.Dir + ": " + err.Error()})
	}
	env := headlessEnv(os.Environ(), r.def.Env)
	out, err := r.check(env, "--version")
	if err != nil {
		return r.fail("start", &LifecycleError{Status: 500, Code: "claude_failed", Message: "claude --version failed: " + err.Error()})
	}
	version, _, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	r.mu.Lock()
	r.model.version = version
	versionAlert := func() {}
	if version != verifiedClaudeVersion {
		versionAlert = r.warn("version", versionWarning(version, r.model.check))
	} else { // back on the verified version (an update between restarts): no warning left over
		r.warnings = slices.DeleteFunc(r.warnings, func(w HeadlessWarning) bool { return w.Kind == "version" })
	}
	r.mu.Unlock()
	versionAlert()
	// its output holds the account's email: only these two fields are ever read or logged
	var auth struct {
		AuthMethod       string `json:"authMethod"`
		SubscriptionType string `json:"subscriptionType"`
	}
	out, err = r.check(env, "auth", "status", "--json")
	json.Unmarshal(out, &auth)
	r.log("auth status: authMethod=%s subscriptionType=%s", auth.AuthMethod, auth.SubscriptionType)
	if err != nil || auth.AuthMethod != "claude.ai" || auth.SubscriptionType == "" {
		return r.fail("auth", &LifecycleError{Status: 409, Code: "auth_refused", Message: fmt.Sprintf(
			"claude auth status says authMethod %q, subscription %q: headless runs only on a claude.ai subscription", auth.AuthMethod, auth.SubscriptionType)})
	}
	if found := r.scanSettings(); found != "" {
		return r.fail("billing", &LifecycleError{Status: 409, Code: "billing_refused", Message: found + ": a headless orchestrator never runs with an API key"})
	}
	if r.mcpURL == "" {
		return r.fail("start", &LifecycleError{Status: 500, Code: "error", Message: "the bridge's MCP listener isn't open (see bridge.log)"})
	}
	bearer := newBearer() // this child's own: a child from before reaches nothing
	err = os.MkdirAll(filepath.Join(r.stateDir, "headless"), 0o700)
	if err == nil {
		err = writeFile0600(mcpConfig, r.mcpConfig(bearer))
	}
	if err != nil {
		return r.fail("start", &LifecycleError{Status: 500, Code: "error", Message: "could not write " + mcpConfig + ": " + err.Error()})
	}
	hash := sha256.Sum256([]byte(orchestratorFiles(r.def, r.rules, yoicksCommand())["rules.md"]))
	r.mu.Lock()
	if !resume {
		r.sessionID = newUUID()
	}
	alert := func() {}
	if !resume || begin || r.rulesHash == "" {
		r.rulesHash = hex.EncodeToString(hash[:])
	} else if r.rulesHash != hex.EncodeToString(hash[:]) { // its system prompt keeps the rules it began with
		alert = r.warn("rules", "the orchestrator rules changed since this session began: Clear to apply them")
	}
	r.wanted, r.mcpBearer = true, bearer
	r.epoch++ // a new child: what the one before asked registers nothing
	notice := r.interrupted
	r.interrupted = false
	r.persist()
	r.mu.Unlock()
	alert()
	if err := r.spawn(append(headlessArgv(r.session(), resume && !begin, mcpConfig, r.tools), r.extraArgs...), env); err != nil {
		return r.fail("start", &LifecycleError{Status: 500, Code: "claude_failed", Message: "could not start claude: " + err.Error()})
	}
	r.rearm()
	r.mu.Lock()
	r.scheduleWakes() // the ones it missed while down
	r.mu.Unlock()
	if notice {
		r.write(restartedNotice)
	}
	return nil
}

// reapOrphans kills the children an earlier bridge left (they carry its marker) and returns
// the other claudes on its session, which it never kills; none outside Linux (no /proc).
// r.op held, with no child of its own.
func (r *headlessRunner) reapOrphans() []procArgs {
	if runtime.GOOS != "linux" {
		return nil
	}
	ours, others := heldSession(claudeProcs(), r.session(), headlessPath(r.stateDir, r.def.Name, ".mcp.json"))
	for _, p := range ours {
		r.killOrphan(p.pid)
	}
	return others
}

// reap is the bridge's start for one it doesn't start: only the orphans go.
func (r *headlessRunner) reap() {
	defer r.recoverAt("the orphan scan")
	r.op.Lock()
	defer r.op.Unlock()
	r.mu.Lock()
	running := r.child != nil
	r.mu.Unlock()
	if !running {
		r.reapOrphans()
	}
}

// check runs claude with args under the child's env, in its dir (≤15 s).
func (r *headlessRunner) check(env []string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, claudeBin(), args...)
	cmd.Dir, cmd.Env = r.def.Dir, env
	cmd.Stdout = &cappedBuffer{max: 64 * 1024}
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	return cmd.Stdout.(*cappedBuffer).Bytes(), err
}

// scanSettings is the first settings file that could bill an API key ("" = none).
func (r *headlessRunner) scanSettings() string {
	user := firstNonEmpty(r.def.Env["CLAUDE_CONFIG_DIR"], filepath.Join(osHomedir(), ".claude"))
	for _, p := range []string{filepath.Join(user, "settings.json"), filepath.Join(r.def.Dir, ".claude", "settings.json"),
		filepath.Join(r.def.Dir, ".claude", "settings.local.json"), managedSettingsPath} {
		if b, err := os.ReadFile(p); err == nil {
			if found := settingsBilling(b); found != "" {
				return p + " has " + found
			}
		}
	}
	return ""
}

// killOrphan ends an earlier bridge's child (it carries the marker): its process group
// when it leads one, as the bridge starts it, else only itself.
func (r *headlessRunner) killOrphan(pid int) {
	pgid, _ := syscall.Getpgid(pid)
	target := orphanTarget(pid, pgid)
	r.log("orphan: killing pid %d (group: %v)", pid, target < 0)
	syscall.Kill(target, syscall.SIGKILL)
	for end := time.Now().Add(2 * time.Second); time.Now().Before(end) && syscall.Kill(pid, 0) == nil; time.Sleep(20 * time.Millisecond) {
	}
}

// spawn starts the child; r.op held.
func (r *headlessRunner) spawn(argv, env []string) error {
	outR, outW, err := os.Pipe()
	if err != nil {
		return err
	}
	inR, inW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return err
	}
	cmd := exec.Command(claudeBin(), argv...)
	cmd.Dir, cmd.Env = r.def.Dir, env
	cmd.Stdin, cmd.Stdout = inR, outW
	c := &hlChild{cmd: cmd, stdin: inW, stderr: &tailWriter{}, done: make(chan struct{}), wlock: make(chan struct{}, 1)}
	cmd.Stderr = c.stderr
	cmd.WaitDelay = time.Second
	cmd.SysProcAttr = childSysProcAttr()
	started := make(chan error, 1)
	go func() {
		defer r.recoverAt("the child's waiter")
		// Pdeathsig fires when the thread that started the child ends, not the bridge: this
		// goroutine keeps that thread until the child has exited
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		err := cmd.Start()
		inR.Close()
		outW.Close()
		if err != nil {
			outR.Close()
			inW.Close()
			started <- err
			return
		}
		// it is the running child before its first line is read or its exit seen: neither may
		// find another child (the init check would be skipped, a dead child left as running)
		r.mu.Lock()
		r.child, r.lastEvent, c.epoch = c, r.clock.Now(), r.epoch
		r.model.inited, r.model.unreadableRun, r.model.yoicksUses, r.served = false, 0, nil, map[string]bool{}
		r.model.expectTools, r.model.expectMCP = headlessTools(r.tools), true
		r.model.Status = "idle"
		r.mu.Unlock()
		started <- nil
		read := make(chan struct{})
		go r.readStdout(c, outR, read)
		werr := cmd.Wait()
		select {
		case <-read:
		case <-time.After(time.Second): // something it left running holds stdout
			outR.Close()
			<-read
		}
		r.exited(c, werr)
		close(c.done)
	}()
	if err := <-started; err != nil {
		return err
	}
	if r.startedHook != nil {
		r.startedHook()
	}
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	r.log("started pid %d, session %s (%s)", cmd.Process.Pid, r.session(), argv[6])
	go r.watchSilence(c)
	r.onChange()
	if closed { // the bridge began to shut down meanwhile
		r.stopChild(c)
	}
	return nil
}

// readStdout feeds each stdout line to the model; closes read at the end.
func (r *headlessRunner) readStdout(c *hlChild, out *os.File, read chan struct{}) {
	defer close(read)
	defer out.Close()
	defer r.recoverAt("the stdout reader")
	const maxLine = 16 << 20
	br := bufio.NewReaderSize(out, 64<<10)
	var line []byte
	tooLong := false
	for {
		chunk, err := br.ReadSlice('\n')
		if len(line)+len(chunk) <= maxLine {
			line = append(line, chunk...)
		} else {
			tooLong = true
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if tooLong {
			line = []byte("(a line over 16 MB)")
		}
		if l := strings.TrimSpace(string(line)); l != "" {
			r.onLine(c, []byte(l))
		}
		line, tooLong = line[:0], false
		if err != nil {
			return
		}
	}
}

func (r *headlessRunner) onLine(c *hlChild, line []byte) {
	if r.lineHook != nil {
		r.lineHook(line)
	}
	var alerts []func()
	r.mu.Lock()
	if r.child != c || c.failed {
		r.mu.Unlock()
		return
	}
	epoch := c.epoch // its own: a Stop or Clear may already have begun the next epoch while it still talks
	r.lastEvent = r.clock.Now()
	r.warnings = slices.DeleteFunc(r.warnings, func(w HeadlessWarning) bool { return w.Kind == "silent" })
	from, seq := r.model.Status, r.model.CompletionSeq
	step := r.model.apply(line, nowMs())
	to := r.model.Status
	if r.model.CompletionSeq != seq {
		r.persist()
	}
	for _, w := range step.Warnings {
		alerts = append(alerts, r.warn(w.Kind, w.Message))
	}
	if ch := r.interrupts[step.Acked]; ch != nil {
		close(ch)
		delete(r.interrupts, step.Acked)
	}
	for _, res := range step.Results {
		// an error for a call the bridge never served failed on the way (the MCP session, its
		// bearer, the transport), whatever Claude Code's words for it
		if res.IsError && !r.served[res.ID] {
			alerts = append(alerts, r.warn("mcp_call", res.Tool+" failed before reaching the bridge ("+res.Error+"); Clear to reconnect"))
		}
		delete(r.served, res.ID)
	}
	if step.Fatal != "" {
		c.expected, c.failed = true, true
		r.model.Status = "error"
		alerts = append(alerts, r.warn("init", step.Fatal))
	}
	r.mu.Unlock()
	for _, l := range []string{step.Init, step.Log} {
		if l != "" {
			r.log("%s", l)
		}
	}
	if step.Reply != nil {
		c.write(step.Reply)
	}
	if step.Fatal != "" {
		syscall.Kill(-c.cmd.Process.Pid, syscall.SIGKILL)
	}
	if step.Ask != "" {
		r.watchAsk(step.Ask)
	}
	if cu := step.CanUse; cu != nil {
		r.canUse(c, cu, epoch)
	}
	for _, a := range alerts {
		a()
	}
	r.statusChanged(from, to)
	r.onChange()
}

// canUse answers a permission request that came over stdio as approve would: AskUserQuestion
// waits for the Home's answer, anything else is denied.
func (r *headlessRunner) canUse(c *hlChild, cu *hlCanUse, epoch int) {
	reply := func(res map[string]any) {
		c.write(controlResponse(cu.RequestID, map[string]any{"subtype": "success", "response": res}))
	}
	if cu.Tool != "AskUserQuestion" {
		reply(map[string]any{"behavior": "deny", "message": "yoicks allows no tool but its own"})
		return
	}
	p := r.ask(cu.Input, epoch)
	if p == nil {
		reply(map[string]any{"behavior": "deny", "message": "this orchestrator's session has ended"})
		return
	}
	r.asked(cu.ToolUseID)
	go func() { reply(<-p.reply) }() // every pending question gets its reply (answer, deny, the child's end)
}

// statusChanged tells the notifications of a change to done or blocked.
func (r *headlessRunner) statusChanged(from, to string) {
	if from != to && (to == "done" || to == "blocked") {
		r.onStatus(from, to)
	}
}

// watchSilence warns when it has been working without a single event (heartbeats included)
// for r.silence.
func (r *headlessRunner) watchSilence(c *hlChild) {
	defer r.recoverAt("the silence watch")
	for {
		select {
		case <-c.done:
			return
		case <-r.clock.After(r.silence / 6):
		}
		r.mu.Lock()
		alert := func() {}
		silent := r.child == c && r.model.Status == "working" && r.clock.Now().Sub(r.lastEvent) >= r.silence &&
			!slices.ContainsFunc(r.warnings, func(w HeadlessWarning) bool { return w.Kind == "silent" })
		if silent {
			alert = r.warn("silent", fmt.Sprintf("no event for %s while working", r.silence.Round(time.Second)))
		}
		r.mu.Unlock()
		if silent {
			alert()
			r.onChange()
		}
	}
}

// exited follows the child's end: asked for, or a crash to restart after.
func (r *headlessRunner) exited(c *hlChild, werr error) {
	r.mu.Lock()
	r.child = nil
	for id, ch := range r.interrupts {
		close(ch)
		delete(r.interrupts, id)
	}
	r.denyPending("the orchestrator ended")
	busy := r.model.Status == "working" || r.model.Status == "blocked"
	how := "exit 0"
	if werr != nil {
		how = werr.Error()
	}
	if tail := c.stderr.String(); tail != "" {
		how += ": " + tail
	}
	r.log("pid %d ended (%s)", c.cmd.Process.Pid, how)
	if c.expected || r.closed {
		if r.model.Status != "error" {
			r.model.Status = "stopped"
		}
		r.mu.Unlock()
		r.onChange()
		return
	}
	now := r.clock.Now()
	r.crashes = append(slices.DeleteFunc(r.crashes, func(t time.Time) bool { return now.Sub(t) > r.crashWindow }), now)
	var alert func()
	if n := len(r.crashes); n > len(r.restartDelays) {
		r.model.Status = "error"
		alert = r.warn("restart_limit", fmt.Sprintf("Claude Code exited %d times within %s; stopped (%s)", n, r.crashWindow, how))
	} else {
		delay := r.restartDelays[n-1]
		r.model.Status = "stopped"
		alert = r.warn("exited", fmt.Sprintf("Claude Code exited unexpectedly (%s); restarting in %s", how, delay))
		r.restartTimer = r.clock.AfterFunc(delay, func() { r.restart(busy) })
	}
	r.mu.Unlock()
	alert()
	r.onChange()
}

// restart resumes the session after a crash; tells it when the crash cut a turn.
func (r *headlessRunner) restart(busy bool) {
	defer r.recoverAt("the restart")
	r.op.Lock()
	defer r.op.Unlock()
	r.mu.Lock()
	r.restartTimer = nil
	skip := r.child != nil || !r.wanted || r.closed
	if !skip && busy {
		r.interrupted = true // start sends the notice
	}
	r.mu.Unlock()
	if skip {
		return
	}
	r.log("restarting with --resume")
	if err := r.start(true); err != nil {
		r.failed(err)
	}
}

// failed shows a start the bridge made by itself (at its own start, after a crash) that
// failed: the refusals have their own warning, anything else gets one.
func (r *headlessRunner) failed(err error) {
	r.log("start failed: %s", err)
	r.mu.Lock()
	shown := r.model.Status == "error" || r.child != nil // (a child: someone else started it)
	r.mu.Unlock()
	if !shown {
		r.fail("start", &LifecycleError{Status: 500, Code: "start_failed", Message: "could not start: " + err.Error()})
	}
}

// ── talking to it ────────────────────────────────────────────────────────────

func (c *hlChild) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.wlock <- struct{}{}
	defer func() { <-c.wlock }()
	c.stdin.SetWriteDeadline(time.Now().Add(5 * time.Second)) // a child that stopped reading can't hang a request
	_, err = c.stdin.Write(append(b, '\n'))
	return err
}

func (c *hlChild) closeStdin() { c.stdinEnd.Do(func() { c.stdin.Close() }) }

func (r *headlessRunner) running() (*hlChild, error) {
	if c := r.child; c != nil {
		return c, nil
	}
	return nil, &LifecycleError{Status: 409, Code: "not_running", Message: "orchestrator " + r.def.Name + " isn't running"}
}

// Send is the user's message: with a question pending, the answer to it in the user's own
// words (AskUserQuestion's free-text answer, which the model takes as said: S0 row 12), the same
// text for each of its questions; else it is written, also mid-turn (Claude Code takes it in at
// the next tool boundary). A refusal would reach the model as an error with the text as its
// reason, which it reads as nonsense. Images (imageBlocks') go first, then the text, if any; an
// answer can't carry them, so with a question pending they are refused.
func (r *headlessRunner) Send(text string, images []any) error {
	r.mu.Lock()
	p := r.pending
	r.mu.Unlock()
	if p != nil {
		if len(images) > 0 {
			return &LifecycleError{Status: 409, Code: "question_pending", Message: "answer the question first: images can't answer it"}
		}
		answers := map[string]any{}
		for _, q := range p.questions {
			answers[q.Question] = text
		}
		if r.Answer(p.id, answers, "") == nil {
			return nil
		}
	}
	if len(images) == 0 {
		return r.write(text)
	}
	if jsTrim(text) != "" { // the API refuses an empty text block
		images = append(images, map[string]any{"type": "text", "text": text})
	}
	return r.write(images)
}

// The images a message may carry: JPEG, PNG or GIF that decode whole (a broken one in the
// session would fail every later turn), at most 2000 px a side (the API's limit once a request
// holds over 20 images) and 1 MiB in all, so the transcript line stays within a chat read
// (tailMaxBytes). The web UI scales and recompresses to fit.
const (
	maxImages     = 4
	maxImageBytes = 1 << 20
	maxImageSide  = 2000
)

var imageFormats = map[string]string{"image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif"}

// imageBlocks checks a send's images ([{mediaType, data: base64}]) and returns them as image
// content blocks (nil for none).
func imageBlocks(v any) ([]any, error) {
	if v == nil {
		return nil, nil
	}
	bad := func(msg string) error { return &LifecycleError{Status: 400, Code: "invalid_params", Message: msg} }
	list, ok := v.([]any)
	if !ok || len(list) > maxImages {
		return nil, bad(fmt.Sprintf("images must be a list of at most %d {mediaType, data}", maxImages))
	}
	var out []any
	total := 0
	for _, it := range list {
		m, _ := it.(map[string]any)
		mt, _ := m["mediaType"].(string)
		data, _ := m["data"].(string)
		format, ok := imageFormats[mt]
		if !ok {
			return nil, bad("an image must be image/jpeg, image/png or image/gif")
		}
		raw, err := base64.StdEncoding.DecodeString(data)
		if err != nil {
			return nil, bad("an image's data isn't base64")
		}
		if total += len(raw); total > maxImageBytes {
			return nil, bad("the images are over 1 MiB in all")
		}
		cfg, got, err := image.DecodeConfig(bytes.NewReader(raw))
		if err == nil && max(cfg.Width, cfg.Height) > maxImageSide {
			return nil, bad(fmt.Sprintf("an image is over %d px a side", maxImageSide))
		}
		if err == nil && got == format { // whole: DecodeConfig reads only the header
			_, _, err = image.Decode(bytes.NewReader(raw))
		}
		if err != nil || got != format {
			return nil, bad("an image isn't a whole " + mt)
		}
		out = append(out, map[string]any{"type": "image", "source": map[string]any{
			"type": "base64", "media_type": mt, "data": base64.StdEncoding.EncodeToString(raw)}})
	}
	return out, nil
}

// write writes a user message (the user's, or yoicks's own): its content, a string or blocks.
func (r *headlessRunner) write(content any) error {
	r.mu.Lock()
	c, err := r.running()
	r.mu.Unlock()
	if err != nil {
		return err
	}
	return r.writeTo(c, content)
}

// writeTo writes a user message to child c (never to a later one); it works on it from then.
func (r *headlessRunner) writeTo(c *hlChild, content any) error {
	r.mu.Lock()
	if r.child == c && r.model.Status != "working" && r.model.Status != "blocked" {
		r.model.Status, r.lastEvent = "working", r.clock.Now()
	}
	r.mu.Unlock()
	if err := c.write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}}); err != nil {
		return &LifecycleError{Status: 502, Code: "write_failed", Message: "could not write to claude: " + err.Error()}
	}
	r.onChange()
	return nil
}

// Interrupt stops the turn (the Agent SDK's interrupt). Unanswered within r.interruptWait,
// the child is restarted with --resume.
func (r *headlessRunner) Interrupt() error {
	r.mu.Lock()
	c, err := r.running()
	r.nInterrupt++
	id := fmt.Sprintf("yoicks-interrupt-%d", r.nInterrupt)
	acked := make(chan struct{})
	if err == nil {
		r.interrupts[id] = acked
		r.denyPending("interrupted") // an approve call ends with its cancellation; a stdio request with this
	}
	r.mu.Unlock()
	if err != nil {
		return err
	}
	c.write(map[string]any{"type": "control_request", "request_id": id, "request": map[string]any{"subtype": "interrupt"}})
	select {
	case <-acked:
		r.log("interrupt answered")
		return nil
	case <-r.clock.After(r.interruptWait):
	}
	r.op.Lock()
	defer r.op.Unlock()
	r.mu.Lock()
	delete(r.interrupts, id)
	alert := r.warn("interrupt", fmt.Sprintf("the interrupt got no answer within %s; restarted with --resume", r.interruptWait))
	same := r.child == c
	r.mu.Unlock()
	alert()
	if !same {
		return nil
	}
	r.stopChild(c)
	return r.start(true)
}

// stopChild ends a child, on one clock from its call: interrupt (after a write in progress,
// waited for up to 200 ms; skipped when one is stuck on a child that stopped reading), close
// stdin (alone it lets a turn run to its end; it also fails that stuck write), SIGTERM to its
// group at 1.5 s, SIGKILL at 2 s, given up at 4 s.
func (r *headlessRunner) stopChild(c *hlChild) {
	began := time.Now()
	r.mu.Lock()
	c.expected = true
	r.mu.Unlock()
	select {
	case c.wlock <- struct{}{}:
		c.stdin.SetWriteDeadline(began.Add(500 * time.Millisecond))
		c.stdin.Write([]byte(`{"type":"control_request","request_id":"yoicks-stop","request":{"subtype":"interrupt"}}` + "\n"))
		<-c.wlock
	case <-time.After(200 * time.Millisecond):
	}
	c.closeStdin()
	pid := c.cmd.Process.Pid
	for _, step := range []struct {
		at  time.Duration
		sig syscall.Signal
	}{{1500 * time.Millisecond, syscall.SIGTERM}, {2 * time.Second, syscall.SIGKILL}, {4 * time.Second, 0}} {
		select {
		case <-c.done:
			return
		case <-time.After(time.Until(began.Add(step.at))):
		}
		if step.sig != 0 {
			syscall.Kill(-pid, step.sig)
		}
	}
}

// Stop ends it until the next Start.
func (r *headlessRunner) Stop() error {
	r.op.Lock()
	defer r.op.Unlock()
	r.mu.Lock()
	if r.restartTimer != nil {
		r.restartTimer.Stop()
		r.restartTimer = nil
	}
	r.wanted = false
	r.forgetWorkers()
	r.persist()
	c := r.child
	r.mu.Unlock()
	if c != nil {
		r.stopChild(c)
	}
	r.mu.Lock()
	if r.model.Status != "error" {
		r.model.Status = "stopped"
	}
	r.mu.Unlock()
	r.log("stopped")
	r.onChange()
	return nil
}

// Clear starts it again in a fresh session.
func (r *headlessRunner) Clear() error {
	r.op.Lock()
	defer r.op.Unlock()
	r.mu.Lock()
	c := r.child
	r.forgetWorkers() // the fresh session knows none of them
	r.mu.Unlock()
	if c != nil {
		r.stopChild(c)
	}
	r.mu.Lock()
	r.resetLocked()
	r.sessionID, r.interrupted = "", false // saved now: a refused start leaves a fresh session to come
	r.alerted = map[string]bool{}
	r.model = hlModel{Status: r.model.Status, CompletionSeq: r.model.CompletionSeq, check: r.model.check}
	r.persist()
	r.mu.Unlock()
	return r.start(false)
}

// forgetWorkers ends what it follows of its workers: the watches (and the saved ones) and the
// queued wake-ups, with a new generation that every late callback of theirs finds changed, and
// its child's bearer and epoch (that child's calls are refused, and register nothing);
// r.mu held, the caller saves.
func (r *headlessRunner) forgetWorkers() {
	r.gen++
	r.mcpBearer = "" // its child's calls are refused from now on
	r.epoch++
	for _, w := range r.watches {
		w.cancel()
	}
	r.watches, r.saved, r.wakes = map[string]*hlWatch{}, nil, nil
	if r.wakeTimer != nil {
		r.wakeTimer.Stop()
		r.wakeTimer = nil
	}
}

// Shutdown ends the child for the bridge's exit (it resumes at the next bridge start). It
// doesn't wait for a start in progress: that one stops its child itself.
func (r *headlessRunner) Shutdown() {
	r.mu.Lock()
	r.closed = true
	if r.restartTimer != nil {
		r.restartTimer.Stop()
	}
	c := r.child
	if c != nil && (r.model.Status == "working" || r.model.Status == "blocked") {
		r.interrupted = true
		r.persist()
	}
	for _, w := range r.watches { // their connections close; they stay saved, re-armed at the next start
		w.cancel()
	}
	r.mu.Unlock()
	if c != nil {
		r.stopChild(c)
	}
}

// denyPending ends the pending question unanswered; r.mu held.
func (r *headlessRunner) denyPending(why string) {
	if p := r.pending; p != nil {
		r.pending = nil
		p.reply <- map[string]any{"behavior": "deny", "message": why}
	}
}
