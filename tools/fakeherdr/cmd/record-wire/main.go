// Command record-wire drives the bridge (yoicks serve) and its CLI through one
// operation at a time against a fake herdr and writes, per operation, what herdr
// received plus the HTTP answer or the CLI output to testdata/wire/<op>.json, which
// TestGoMatchesWireRecordings compares the current build with. The recordings were
// taken from the TypeScript bridge the Go one was ported from (since deleted):
// re-record only for an intended change of behavior, and review the diff.
//
// Everything lives in a fresh temp dir (state, config, data, HOME, a scratch git repo
// with an origin) and the bridge listens on 127.0.0.1:8392. The account checks read
// /proc, so two `sleep` processes stand in for agents: one with the default account
// (HOME's), one with another CLAUDE_CONFIG_DIR. Fake `herdr` and `gh` CLIs come first
// on PATH, so the CLI's pass-through calls are logged instead of run, and so do fakes
// of `direnv` (it sources the dir's .envrc), `tailscale` and `qrencode` (both absent),
// so the recordings don't depend on this machine's setup.
//
// Each CLI call runs detached (setsid -f), as the CLI takes its nearest claude
// ancestor's account as its own. From the repo root, with the web UI built (it builds
// ./cmd/yoicks; needs setsid):
//
//	go build -o /tmp/record-wire ./tools/fakeherdr/cmd/record-wire && /tmp/record-wire
//
// It writes testdata/wire/DONE (or FAILED with the reason) when finished.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/y011d4/herdr-plugin-yoicks/tools/fakeherdr"
)

// the bridge's port and where the recordings go (main_test.go repoints both)
var (
	port   = "8392"
	outDir = filepath.Join("testdata", "wire")
)

// goBin is the yoicks recorded, as `yoicks serve` and its commands: main
// builds it, main_test.go its own.
var goBin string

func main() {
	_ = os.MkdirAll(outDir, 0o755)
	_ = os.Remove(filepath.Join(outDir, "DONE"))
	_ = os.Remove(filepath.Join(outDir, "FAILED"))
	err := buildThenRun()
	if err != nil {
		_ = os.WriteFile(filepath.Join(outDir, "FAILED"), []byte(err.Error()+"\n"), 0o644)
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = os.WriteFile(filepath.Join(outDir, "DONE"), nil, 0o644)
}

// buildThenRun builds ./cmd/yoicks into a temp dir and records it.
func buildThenRun() error {
	dir, err := os.MkdirTemp("", "record-wire")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	goBin = filepath.Join(dir, "yoicks") // the CLI knows a bridge by this name
	if out, err := exec.Command("go", "build", "-o", goBin, "./cmd/yoicks").CombinedOutput(); err != nil {
		return fmt.Errorf("go build: %v\n%s", err, out)
	}
	return run()
}

// session is the fake herdr's world for the wire recordings.
type session struct {
	tmp              string
	pidDefault       int // a process under the default account (HOME/.claude/projects)
	pidOther         int // one under another CLAUDE_CONFIG_DIR
	mu               sync.Mutex
	calls            map[string]int // per-operation call counts, by method+target
	newPanesAccount  int            // the pid new panes (p10…) report
	snapshotExtraWS  []map[string]any
	snapshotExtraTab []map[string]any
	snapshotExtra    []map[string]any
}

const sessionID = "0b9f3c1e-2d4a-4e8b-9c7d-5f6a7b8c9d0e"

func (s *session) reset() {
	s.mu.Lock()
	s.calls = map[string]int{}
	s.newPanesAccount = s.pidDefault
	s.mu.Unlock()
}

func (s *session) nth(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls[key]++
	return s.calls[key]
}

func (s *session) repo() string { return filepath.Join(s.tmp, "repo") }

func str(params json.RawMessage, key string) string {
	var m map[string]any
	_ = json.Unmarshal(params, &m)
	v, _ := m[key].(string)
	return v
}

func (s *session) handler(method string, params json.RawMessage) fakeherdr.Reply {
	switch method {
	case "session.snapshot":
		return fakeherdr.Reply{Result: map[string]any{"snapshot": s.snapshot()}}
	case "agent.list":
		return fakeherdr.Reply{Result: map[string]any{"agents": []any{
			map[string]any{"pane_id": "p1", "agent": "claude", "agent_status": "idle", "cwd": s.repo(), "completion_seq": 3, "state_change_seq": 7,
				"agent_session": map[string]any{"source": "herdr:claude", "agent": "claude", "kind": "id", "value": sessionID}},
			map[string]any{"pane_id": "p2", "agent": "claude", "agent_status": "working", "cwd": s.repo(), "state_change_seq": 8},
			map[string]any{"pane_id": "p5", "agent": "claude", "agent_status": "blocked", "cwd": filepath.Join(s.tmp, "other"), "state_change_seq": 9},
		}}}
	case "pane.process_info":
		pid := s.pidDefault
		switch id := str(params, "pane_id"); {
		case id == "p5":
			pid = s.pidOther
		case id == "p10" || id == "p11" || id == "p12":
			s.mu.Lock()
			pid = s.newPanesAccount
			s.mu.Unlock()
		}
		return fakeherdr.Reply{Result: map[string]any{"process_info": map[string]any{
			"shell_pid": 1, "foreground_process_group_id": pid,
			"foreground_processes": []any{map[string]any{"pid": pid, "name": "claude", "argv": []string{"claude"}}},
		}}}
	case "pane.get":
		id := str(params, "pane_id")
		return fakeherdr.Reply{Result: map[string]any{"pane": map[string]any{
			"pane_id": id, "agent": "claude", "cwd": s.repo(), "foreground_cwd": s.repo(),
			"agent_session": map[string]any{"source": "herdr:claude", "agent": "claude", "kind": "id", "value": sessionID},
			"scroll":        map[string]any{"history_lines": 0},
		}}}
	case "pane.read":
		return fakeherdr.Reply{Result: map[string]any{"type": "pane_read", "read": map[string]any{
			"text": "\u001b[1m❯\u001b[0m hello 日本語\r\nline two\r\n",
		}}}
	case "tab.create", "workspace.create":
		return fakeherdr.Reply{Result: map[string]any{"root_pane": map[string]any{"pane_id": "p10"}}}
	case "pane.split":
		return fakeherdr.Reply{Result: map[string]any{"pane": map[string]any{"pane_id": "p11"}}}
	case "agent.start":
		// a just-opened pane's shell isn't up yet on the first try
		if s.nth("agent.start") == 1 {
			return fakeherdr.Reply{Code: "agent_pane_busy", Message: "pane is busy"}
		}
		return fakeherdr.Reply{Result: map[string]any{"agent": map[string]any{
			"pane_id": str(params, "pane_id"), "agent": "claude", "name": str(params, "name")}}}
	case "agent.get":
		target := str(params, "target")
		pane := target
		if !strings.HasPrefix(target, "p") {
			pane = "p1" // a name: the fake has one named agent
		}
		if target == "w-other" {
			pane = "p5"
		}
		ready := s.nth("agent.get:"+target) > 1 // interactive only from the second look
		return fakeherdr.Reply{Result: map[string]any{"agent": map[string]any{
			"pane_id": pane, "agent": "claude", "name": target, "cwd": s.repo(),
			"agent_status": "idle", "interactive_ready": ready}}}
	case "worktree.create":
		path := str(params, "path")
		return fakeherdr.Reply{Result: map[string]any{
			"worktree":  map[string]any{"path": path, "branch": str(params, "branch"), "open_workspace_id": "w9"},
			"workspace": map[string]any{"workspace_id": "w9", "worktree": map[string]any{"checkout_path": path}},
			"root_pane": map[string]any{"pane_id": "p12"},
		}}
	}
	return fakeherdr.Reply{}
}

func (s *session) snapshot() map[string]any {
	ws := []map[string]any{
		{"workspace_id": "w1", "label": "repo", "active_tab_id": "t1",
			"worktree": map[string]any{"repo_key": filepath.Join(s.repo(), ".git"), "repo_name": "repo", "repo_root": s.repo(),
				"checkout_path": s.repo(), "is_linked_worktree": false}},
		{"workspace_id": "w2", "label": "other", "active_tab_id": "t5"},
		{"workspace_id": "w3", "label": "done", "active_tab_id": "t6",
			"worktree": map[string]any{"repo_key": filepath.Join(s.repo(), ".git"), "repo_name": "repo", "repo_root": s.repo(),
				"checkout_path": s.repo() + "-wt-done", "is_linked_worktree": true}},
	}
	tabs := []map[string]any{
		{"tab_id": "t1", "workspace_id": "w1", "label": "one"},
		{"tab_id": "t2", "workspace_id": "w1", "label": "two"},
		{"tab_id": "t3", "workspace_id": "w1", "label": "shell"},
		{"tab_id": "t5", "workspace_id": "w2", "label": "other"},
		{"tab_id": "t6", "workspace_id": "w3", "label": "done"},
	}
	agentSess := map[string]any{"source": "herdr:claude", "agent": "claude", "kind": "id", "value": sessionID}
	panes := []map[string]any{
		{"pane_id": "p1", "tab_id": "t1", "workspace_id": "w1", "agent": "claude", "agent_status": "idle", "focused": true,
			"cwd": s.repo(), "foreground_cwd": s.repo(), "title": "one", "agent_session": agentSess},
		{"pane_id": "p2", "tab_id": "t2", "workspace_id": "w1", "agent": "claude", "agent_status": "working",
			"cwd": s.repo(), "foreground_cwd": s.repo(), "title": "two"},
		{"pane_id": "p3", "tab_id": "t3", "workspace_id": "w1", "cwd": s.repo(), "foreground_cwd": s.repo()},
		{"pane_id": "p5", "tab_id": "t5", "workspace_id": "w2", "agent": "claude", "agent_status": "blocked",
			"cwd": filepath.Join(s.tmp, "other"), "title": "other"},
		{"pane_id": "p6", "tab_id": "t6", "workspace_id": "w3", "cwd": s.repo() + "-wt-done"},
	}
	return map[string]any{"version": "0.9.5", "protocol": 22, "focused_workspace_id": "w1", "focused_tab_id": "t1",
		"focused_pane_id": "p1", "workspaces": ws, "tabs": tabs, "panes": panes}
}

// ── setup ────────────────────────────────────────────────────────────────────

func sh(dir string, env []string, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s %v: %v: %s", name, args, err, out)
	}
	return nil
}

func setup(tmp string) error {
	for _, d := range []string{"state", "config", "data", "home", "bin", "other", "claude-b"} {
		if err := os.MkdirAll(filepath.Join(tmp, d), 0o755); err != nil {
			return err
		}
	}
	gitEnv := []string{"HOME=" + filepath.Join(tmp, "home"), "GIT_CONFIG_NOSYSTEM=1",
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.invalid", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.invalid"}
	repo := filepath.Join(tmp, "repo")
	steps := [][]string{
		{tmp, "git", "init", "-q", "--bare", "-b", "main", "origin.git"},
		{tmp, "git", "init", "-q", "-b", "main", "repo"},
		{repo, "git", "commit", "-q", "--allow-empty", "-m", "init"},
		{repo, "git", "remote", "add", "origin", filepath.Join(tmp, "origin.git")},
		{repo, "git", "push", "-q", "origin", "main"},
		{repo, "git", "remote", "set-head", "origin", "main"},
		{repo, "git", "worktree", "add", "-q", "-b", "done", repo + "-wt-done"},
	}
	for _, st := range steps {
		if err := sh(st[0], gitEnv, st[1], st[2:]...); err != nil {
			return err
		}
	}
	// a transcript for p1's session, where Claude Code would put it
	slug := regexp.MustCompile(`[/._]`).ReplaceAllString(repo, "-")
	tdir := filepath.Join(tmp, "home", ".claude", "projects", slug)
	if err := os.MkdirAll(tdir, 0o755); err != nil {
		return err
	}
	transcript := `{"type":"user","timestamp":"2026-11-24T00:00:00.000Z","message":{"role":"user","content":"fix the bug"}}
{"type":"assistant","timestamp":"2026-11-24T00:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Done: fixed it."}]}}
`
	if err := os.WriteFile(filepath.Join(tdir, sessionID+".jsonl"), []byte(transcript), 0o644); err != nil {
		return err
	}
	cfg := map[string]any{"orchestrators": []any{map[string]any{"name": "test", "label": "Test",
		"env": map[string]string{"CLAUDE_CONFIG_DIR": filepath.Join(tmp, "claude-b")}}}}
	b, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(tmp, "config", "config.json"), b, 0o644); err != nil {
		return err
	}
	// fake herdr / gh CLIs: log their argv, do nothing
	log := filepath.Join(tmp, "cli.log")
	scripts := map[string]string{
		"herdr": fmt.Sprintf("#!/bin/sh\necho \"herdr $*\" >> %s\n", log),
		"gh":    fmt.Sprintf("#!/bin/sh\necho \"gh $*\" >> %s\n", log),
		// `direnv exec <dir> <cmd…>`: cmd with <dir>/.envrc loaded (no allow list or parent dirs)
		"direnv":    "#!/bin/sh\n[ \"$1\" = exec ] || exit 1\ncd \"$2\" || exit 1\nshift 2\nif [ -f .envrc ]; then set -a; . ./.envrc; set +a; fi\nexec \"$@\"\n",
		"tailscale": "#!/bin/sh\nexit 1\n",
		"qrencode":  "#!/bin/sh\nexit 1\n",
	}
	for name, script := range scripts {
		if err := os.WriteFile(filepath.Join(tmp, "bin", name), []byte(script), 0o755); err != nil {
			return err
		}
	}
	// a dir whose .envrc picks the other account
	envrc := "export CLAUDE_CONFIG_DIR=" + filepath.Join(tmp, "claude-b") + "\n"
	return os.WriteFile(filepath.Join(tmp, "other", ".envrc"), []byte(envrc), 0o644)
}

func standIn(env []string) (*exec.Cmd, error) {
	cmd := exec.Command("sleep", "600")
	cmd.Env = env
	return cmd, cmd.Start()
}

// ── recording ────────────────────────────────────────────────────────────────

type record struct {
	Op       string              `json:"op"`
	HTTP     *httpCall           `json:"http,omitempty"`
	WS       []string            `json:"ws,omitempty"` // messages sent, then those received
	CLI      *cliCall            `json:"cli,omitempty"`
	Herdr    []fakeherdr.Request `json:"herdr"`
	HerdrCLI []string            `json:"herdrCli,omitempty"` // fake herdr/gh CLI invocations
}

type httpCall struct {
	Method   string          `json:"method"`
	Path     string          `json:"path"`
	Body     json.RawMessage `json:"body,omitempty"`
	Status   int             `json:"status"`
	Response json.RawMessage `json:"response"`
}

type cliCall struct {
	Args   []string `json:"args"`
	Exit   int      `json:"exit"`
	Stdout string   `json:"stdout"`
	Stderr string   `json:"stderr"`
}

type recorder struct {
	s       *session
	srv     *fakeherdr.Server
	token   string
	baseEnv []string
	norm    func(string) string
}

// settle covers the client's debounces (250 ms) and agent.list's (50 ms) after an op.
const settle = 700 * time.Millisecond

func (r *recorder) op(name string, f func(rec *record) error) error {
	r.s.reset()
	logPath := filepath.Join(r.s.tmp, "cli.log")
	_ = os.Remove(logPath)
	mark := len(r.srv.Requests())
	rec := &record{Op: name}
	if err := f(rec); err != nil {
		return fmt.Errorf("%s: %w", name, err)
	}
	time.Sleep(settle)
	rec.Herdr = r.srv.Requests()[mark:]
	if b, err := os.ReadFile(logPath); err == nil {
		rec.HerdrCLI = strings.Split(strings.TrimSpace(string(b)), "\n")
	}
	b, _ := json.MarshalIndent(rec, "", " ")
	out := r.norm(string(b)) + "\n"
	fmt.Printf("%s: %d herdr requests\n", name, len(rec.Herdr))
	return os.WriteFile(filepath.Join(outDir, name+".json"), []byte(out), 0o644)
}

func (r *recorder) http(rec *record, method, path string, body any) error {
	var rd io.Reader
	var raw json.RawMessage
	if body != nil {
		raw, _ = json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, "http://127.0.0.1:"+port+path, rd)
	req.Header.Set("Authorization", "Bearer "+r.token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	resp, _ := io.ReadAll(res.Body)
	if !json.Valid(resp) {
		resp, _ = json.Marshal(string(resp))
	}
	rec.HTTP = &httpCall{Method: method, Path: path, Body: raw, Status: res.StatusCode, Response: resp}
	return nil
}

// cli runs one CLI command detached from this process tree (setsid -f reparents it
// away from any claude ancestor, whose account the CLI would take as its own) and
// collects its output and exit code from files.
func (r *recorder) cli(rec *record, extraEnv []string, args ...string) error {
	argv := []string{goBin}
	dir, err := os.MkdirTemp("", "fwcli")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	out, errf, code := filepath.Join(dir, "out"), filepath.Join(dir, "err"), filepath.Join(dir, "code")
	wrap := `"$@" >"$OUT_" 2>"$ERR_" </dev/null; echo $? >"$CODE_.tmp"; mv "$CODE_.tmp" "$CODE_"`
	cmd := exec.Command("setsid", append([]string{"-f", "sh", "-c", wrap, "sh"}, append(argv, args...)...)...)
	cmd.Env = append(append(append([]string{}, r.baseEnv...), extraEnv...), "OUT_="+out, "ERR_="+errf, "CODE_="+code)
	if err := cmd.Run(); err != nil { // returns at once; the command goes on detached
		return fmt.Errorf("setsid: %v", err)
	}
	var exit []byte
	for end := time.Now().Add(2 * time.Minute); ; time.Sleep(50 * time.Millisecond) {
		if exit, err = os.ReadFile(code); err == nil || time.Now().After(end) {
			break
		}
	}
	if err != nil {
		return fmt.Errorf("the command never finished: %v", args)
	}
	stdout, _ := os.ReadFile(out)
	stderr, _ := os.ReadFile(errf)
	n, _ := strconv.Atoi(strings.TrimSpace(string(exit)))
	rec.CLI = &cliCall{Args: args, Exit: n, Stdout: string(stdout), Stderr: string(stderr)}
	return nil
}

func run() error {
	bridge := exec.Command(goBin, "serve")
	tmp, err := os.MkdirTemp("", "fw")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if err := setup(tmp); err != nil {
		return err
	}
	home := filepath.Join(tmp, "home")
	pathEnv := "PATH=" + filepath.Join(tmp, "bin") + ":" + os.Getenv("PATH")
	defA, err := standIn([]string{"HOME=" + home, pathEnv})
	if err != nil {
		return err
	}
	defer defA.Process.Kill()
	other, err := standIn([]string{"HOME=" + home, "CLAUDE_CONFIG_DIR=" + filepath.Join(tmp, "claude-b"), pathEnv})
	if err != nil {
		return err
	}
	defer other.Process.Kill()

	s := &session{tmp: tmp, pidDefault: defA.Process.Pid, pidOther: other.Process.Pid}
	s.reset()
	srv, err := fakeherdr.Start(filepath.Join(tmp, "h.sock"), s.handler)
	if err != nil {
		return err
	}
	defer srv.Close()

	baseEnv := []string{pathEnv, "HOME=" + home, "LANG=C.UTF-8",
		"HERDR_SOCKET_PATH=" + srv.Path,
		"HERDR_PLUGIN_STATE_DIR=" + filepath.Join(tmp, "state"),
		"HERDR_PLUGIN_CONFIG_DIR=" + filepath.Join(tmp, "config"),
		"XDG_DATA_HOME=" + filepath.Join(tmp, "data"),
		"HERDR_YOICKS_PORT=" + port,
	}
	// something else on the port would answer the health check in our bridge's place
	if ln, err := net.Listen("tcp", "127.0.0.1:"+port); err != nil {
		return fmt.Errorf("port %s is in use: %w", port, err)
	} else {
		ln.Close()
	}
	bridge.Env = baseEnv
	blog, _ := os.Create(filepath.Join(tmp, "bridge.log"))
	bridge.Stdout, bridge.Stderr = blog, blog
	if err := bridge.Start(); err != nil {
		return err
	}
	defer bridge.Process.Kill()
	exited := make(chan struct{})
	go func() { _ = bridge.Wait(); close(exited) }()
	if err := waitConnected(srv, exited); err != nil {
		b, _ := os.ReadFile(filepath.Join(tmp, "bridge.log"))
		return fmt.Errorf("%w; bridge log: %s", err, b)
	}
	tok, err := os.ReadFile(filepath.Join(tmp, "state", "token"))
	if err != nil {
		return err
	}
	// let the startup lookups (agent.list, each agent pane's account) finish
	time.Sleep(time.Second)

	tsRe := regexp.MustCompile(`\b(claude|codex|opencode|agent)-[0-9a-z]{8}\b`)
	agoRe := regexp.MustCompile(`last activity \d+[smhd] ago`)
	token := strings.TrimSpace(string(tok))
	portRe := regexp.MustCompile(`\b` + port + `\b`)
	norm := func(t string) string {
		t = strings.ReplaceAll(t, tmp, "$TMP")
		t = strings.ReplaceAll(t, token, "<token>")
		t = portRe.ReplaceAllString(t, "<port>")
		t = tsRe.ReplaceAllString(t, "$1-<time>")
		return agoRe.ReplaceAllString(t, "last activity <ago>")
	}
	r := &recorder{s: s, srv: srv, token: strings.TrimSpace(string(tok)), baseEnv: baseEnv, norm: norm}
	return recordAll(r)
}

// waitConnected waits until our bridge (still running) reports itself connected and
// our fake herdr has its subscription.
func waitConnected(srv *fakeherdr.Server, exited <-chan struct{}) error {
	for i := 0; i < 200; i++ {
		select {
		case <-exited:
			return fmt.Errorf("the bridge exited")
		default:
		}
		res, err := http.Get("http://127.0.0.1:" + port + "/healthz")
		if err == nil {
			var h struct {
				HerdrConnected bool `json:"herdrConnected"`
			}
			_ = json.NewDecoder(res.Body).Decode(&h)
			res.Body.Close()
			if h.HerdrConnected && srv.Subscribed() > 0 {
				return nil
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("the bridge never connected to the fake herdr")
}

func recordAll(r *recorder) error {
	large := strings.Repeat("0123456789abcdef", 1024) // 16 KiB
	ops := []struct {
		name string
		f    func(*record) error
	}{
		// sending a message: Ctrl+U ×30 (send_text) to clear the composer, then text + enter in one send_input
		{"input-clear-single-line", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/input", map[string]any{"text": "hello", "enter": true, "clear": true})
		}},
		{"input-clear-multi-line", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/input", map[string]any{"text": "line one\nline two\n日本語", "enter": true, "clear": true})
		}},
		{"input-clear-large", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/input", map[string]any{"text": large, "enter": true, "clear": true})
		}},
		{"input-keys", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/input", map[string]any{"keys": []string{"escape"}})
		}},
		// a numbered menu: the digit alone, as a raw keystroke
		{"input-press-digit", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/input", map[string]any{"press": "2"})
		}},
		{"input-press-prompt-changed", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/input", map[string]any{"press": "2", "expect_prompt": "not-this-one"})
		}},
		{"input-invalid-press", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/input", map[string]any{"press": "12"})
		}},
		{"scroll-up", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/scroll", map[string]any{"direction": "up", "steps": 3})
		}},
		{"scroll-down-clamped", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/scroll", map[string]any{"direction": "down", "steps": 99})
		}},
		{"read-visible", func(rec *record) error {
			return r.http(rec, "GET", "/api/panes/p1/read?source=visible&format=ansi", nil)
		}},
		{"read-recent-lines", func(rec *record) error {
			return r.http(rec, "GET", "/api/panes/p1/read?source=recent&lines=2000&format=text&strip_ansi=true", nil)
		}},
		// an invalid enum is refused before herdr (which would drop the connection) sees it
		{"read-invalid-source", func(rec *record) error {
			return r.http(rec, "GET", "/api/panes/p1/read?source=bogus", nil)
		}},
		{"focus", func(rec *record) error { return r.http(rec, "POST", "/api/panes/p1/focus", nil) }},
		{"transcript", func(rec *record) error { return r.http(rec, "GET", "/api/panes/p1/transcript", nil) }},
		{"agent-send", func(rec *record) error {
			return r.http(rec, "POST", "/api/agents/p1/send", map[string]any{"text": "next task"})
		}},
		{"agent-start-new-tab-with-task", func(rec *record) error {
			return r.http(rec, "POST", "/api/agents", map[string]any{"profile": "claude", "cwd": r.s.repo(), "name": "w-tab", "task": "do it"})
		}},
		{"agent-start-in-workspace", func(rec *record) error {
			return r.http(rec, "POST", "/api/agents", map[string]any{"profile": "codex", "workspace": "w1", "name": "w-ws"})
		}},
		{"agent-start-worktree", func(rec *record) error {
			return r.http(rec, "POST", "/api/agents", map[string]any{"profile": "claude", "name": "w-wt",
				"worktree": map[string]any{"repo": r.s.repo(), "branch": "feat/x"}})
		}},
		{"agent-start-unknown-profile", func(rec *record) error {
			return r.http(rec, "POST", "/api/agents", map[string]any{"profile": "bash"})
		}},
		{"worktree-create", func(rec *record) error {
			return r.http(rec, "POST", "/api/worktrees", map[string]any{"cwd": r.s.repo(), "branch": "feat-y", "base": "main"})
		}},
		{"stop", func(rec *record) error { return r.http(rec, "DELETE", "/api/panes/p2", nil) }},
		{"rename", func(rec *record) error {
			return r.http(rec, "POST", "/api/panes/p1/rename", map[string]any{"name": "Renamed One"})
		}},
		{"clear", func(rec *record) error { return r.http(rec, "POST", "/api/agents/p1/clear", nil) }},
		{"orchestrator-start", func(rec *record) error {
			r.s.mu.Lock()
			r.s.newPanesAccount = r.s.pidOther // comes up under the account its env sets
			r.s.mu.Unlock()
			return r.http(rec, "POST", "/api/orchestrators/test/start", nil)
		}},
		{"profiles", func(rec *record) error { return r.http(rec, "GET", "/api/profiles", nil) }},
		{"unauthorized", func(rec *record) error {
			res, err := http.Get("http://127.0.0.1:" + port + "/api/state")
			if err != nil {
				return err
			}
			body, _ := io.ReadAll(res.Body)
			res.Body.Close()
			rec.HTTP = &httpCall{Method: "GET", Path: "/api/state (no token)", Status: res.StatusCode, Response: body}
			return nil
		}},
		{"ws-watch-pane", func(rec *record) error {
			return r.ws(rec, `{"type":"watch_pane","paneId":"p1"}`, `{"type":"unwatch_pane"}`)
		}},
		{"ws-watch-transcript", func(rec *record) error {
			return r.ws(rec, `{"type":"watch_transcript","paneId":"p1"}`, `{"type":"unwatch_transcript"}`)
		}},
		// the CLI: account checks read /proc of the stand-in processes; the default
		// account (no CLAUDE_CONFIG_DIR) is the caller's own
		{"cli-overview", func(rec *record) error { return r.cli(rec, []string{"HERDR_PANE_ID=p2"}, "overview") }},
		{"cli-agent-get", func(rec *record) error { return r.cli(rec, nil, "agent", "get", "p1", "--json") }},
		{"cli-agent-get-other-account", func(rec *record) error { return r.cli(rec, nil, "agent", "get", "w-other") }},
		{"cli-agent-usage", func(rec *record) error { return r.cli(rec, nil, "agent") }},
		{"cli-agent-start", func(rec *record) error {
			return r.cli(rec, nil, "agent", "start", "w-cli", "--cwd", r.s.repo())
		}},
		{"cli-agent-start-worktree", func(rec *record) error {
			return r.cli(rec, nil, "agent", "start", "w-cli-wt", "--cwd", r.s.repo(), "--worktree", "cli-branch", "--base", "origin/main")
		}},
		{"cli-worktree-remove", func(rec *record) error {
			return r.cli(rec, nil, "worktree", "remove", r.s.repo()+"-wt-done")
		}},
		{"cli-worktree-remove-not-linked", func(rec *record) error {
			return r.cli(rec, nil, "worktree", "remove", r.s.repo())
		}},
		{"cli-orchestrator-start", func(rec *record) error {
			r.s.mu.Lock()
			r.s.newPanesAccount = r.s.pidOther
			r.s.mu.Unlock()
			return r.cli(rec, nil, "orchestrator", "start", "test")
		}},
		// the rest of the CLI (P3): herdr's own CLI gets the checked pane and the flags as
		// given; usage errors; the other refusals; the lifecycle commands without a bridge
		// of their own; the connect link
		{"cli-agent-read", func(rec *record) error { return r.cli(rec, nil, "agent", "read", "p1", "--lines", "5") }},
		{"cli-agent-prompt", func(rec *record) error {
			return r.cli(rec, nil, "agent", "prompt", "w-named", "do the thing", "--wait")
		}},
		{"cli-agent-wait", func(rec *record) error {
			return r.cli(rec, nil, "agent", "wait", "p1", "--status", "done", "--timeout", "5")
		}},
		{"cli-agent-get-flag-as-target", func(rec *record) error { return r.cli(rec, nil, "agent", "get", "--json") }},
		{"cli-agent-start-usage", func(rec *record) error { return r.cli(rec, nil, "agent", "start", "w-x") }},
		{"cli-agent-start-bad-flag", func(rec *record) error {
			return r.cli(rec, nil, "agent", "start", "w-x", "--cwd", r.s.repo(), "--command", "sh")
		}},
		{"cli-agent-start-other-account", func(rec *record) error {
			return r.cli(rec, nil, "agent", "start", "w-x", "--cwd", filepath.Join(r.s.tmp, "other"))
		}},
		{"cli-worktree-remove-other-account", func(rec *record) error {
			envrc := filepath.Join(r.s.repo()+"-wt-done", ".envrc")
			if err := os.WriteFile(envrc, []byte("export CLAUDE_CONFIG_DIR="+filepath.Join(r.s.tmp, "claude-b")+"\n"), 0o644); err != nil {
				return err
			}
			defer os.Remove(envrc)
			return r.cli(rec, nil, "worktree", "remove", r.s.repo()+"-wt-done")
		}},
		{"cli-worktree-usage", func(rec *record) error { return r.cli(rec, nil, "worktree") }},
		{"cli-orchestrator-unknown", func(rec *record) error { return r.cli(rec, nil, "orchestrator", "start", "nope") }},
		{"cli-usage", func(rec *record) error { return r.cli(rec, nil) }},
		{"cli-status-not-running", func(rec *record) error { return r.cli(rec, nil, "status") }},
		{"cli-stop-not-running", func(rec *record) error { return r.cli(rec, nil, "stop") }},
		{"cli-qr", func(rec *record) error { return r.cli(rec, nil, "qr") }},
	}
	for _, o := range ops {
		if err := r.op(o.name, o.f); err != nil {
			return err
		}
	}
	return nil
}

// ws opens /ws, sends start, keeps it open for ~2.5 s (three 800 ms pane polls / the
// transcript's first resolve and two 1 s ticks), sends stop and closes.
func (r *recorder) ws(rec *record, start, stop string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws://127.0.0.1:"+port+"/ws?token="+r.token, nil)
	if err != nil {
		return err
	}
	defer c.CloseNow()
	c.SetReadLimit(1 << 20)
	var mu sync.Mutex
	var got []string
	go func() {
		for {
			_, msg, err := c.Read(ctx)
			if err != nil {
				return
			}
			var m struct {
				Type string `json:"type"`
			}
			_ = json.Unmarshal(msg, &m)
			if m.Type == "state" {
				continue // the full state on connect; covered by the contract fixtures
			}
			mu.Lock()
			got = append(got, string(msg))
			mu.Unlock()
		}
	}()
	time.Sleep(300 * time.Millisecond) // the connect-time state push first
	_ = c.Write(ctx, websocket.MessageText, []byte(start))
	time.Sleep(2500 * time.Millisecond)
	_ = c.Write(ctx, websocket.MessageText, []byte(stop))
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	rec.WS = append([]string{"> " + start, "> " + stop}, got...)
	mu.Unlock()
	return c.Close(websocket.StatusNormalClosure, "")
}
