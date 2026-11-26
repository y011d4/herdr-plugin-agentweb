package bridge

// Headless orchestrators: the pure parts (argv, env, the billing checks, the orphan rule),
// then the runner through the bridge, against tools/fakeclaude (never a real Claude) and
// a fake herdr.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/y011d4/herdr-yoicks/tools/fakeherdr"
)

func TestHeadlessArgv(t *testing.T) {
	got := headlessArgv("s-1", false, "/st/headless/h.mcp.json", true)
	want := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--session-id", "s-1", "--mcp-config", "/st/headless/h.mcp.json", "--strict-mcp-config",
		"--permission-prompt-tool", "mcp__yoicks__approve", "--permission-mode", "manual", "--tools", "AskUserQuestion",
		"--allowedTools", "mcp__yoicks__overview,mcp__yoicks__agent_get,mcp__yoicks__agent_read,mcp__yoicks__agent_prompt,mcp__yoicks__agent_start,mcp__yoicks__worktree_remove"}
	if !slices.Equal(got, want) {
		t.Errorf("new: %v", got)
	}
	if got := headlessArgv("s-1", true, "/m", true); got[6] != "--resume" || got[7] != "s-1" {
		t.Errorf("resume: %v", got)
	}
	// no tools (YOICKS_HEADLESS_NO_TOOLS): approve only
	if got := headlessArgv("s-1", false, "/st/headless/h.mcp.json", false); !slices.Equal(got, want[:len(want)-2]) || !slices.Equal(headlessTools(false), []string{"AskUserQuestion"}) {
		t.Errorf("no tools: %v", got)
	}
	for _, a := range got {
		if a == "--bare" || a == "--dangerously-skip-permissions" {
			t.Errorf("argv has %s", a)
		}
	}
	if !hasMarker(got, "/st/headless/h.mcp.json") || hasMarker(got, "/st/headless/other.mcp.json") {
		t.Error("the marker")
	}
}

func TestHeadlessEnv(t *testing.T) {
	parent := []string{"HOME=/home/u", "PATH=/bin", "USER=u", "LC_ALL=C", "LANG=ja_JP.UTF-8", "TERM=xterm",
		"HERDR_SOCKET_PATH=/s", "HERDR_PANE_ID=p1", "ANTHROPIC_API_KEY=sk", "CLAUDE_CODE_USE_BEDROCK=1", "SECRET=x", "CLAUDE_CONFIG_DIR=/bridge's"}
	got := headlessEnv(parent, map[string]string{"CLAUDE_CONFIG_DIR": "/home/u/.config/claude/work", "HERDR_X": "1", "ANTHROPIC_BASE_URL": "u"})
	want := []string{"HOME=/home/u", "PATH=/bin", "USER=u", "LC_ALL=C", "LANG=ja_JP.UTF-8", "TERM=dumb", "CLAUDE_CONFIG_DIR=/home/u/.config/claude/work"}
	if !slices.Equal(got, want) {
		t.Errorf("got %v", got)
	}
}

func TestHeadlessBillingChecks(t *testing.T) {
	for k, want := range map[string]bool{"ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true, "CLAUDE_CODE_USE_VERTEX": true,
		"CLAUDE_CODE_USE_FOUNDRY": true, "AWS_BEARER_TOKEN_BEDROCK": true, "CLAUDE_CONFIG_DIR": false, "AWS_REGION": false} {
		if isBillingVar(k) != want {
			t.Errorf("isBillingVar(%s) != %v", k, want)
		}
	}
	for content, want := range map[string]string{
		`{"env":{"FOO":"1","ANTHROPIC_API_KEY":"sk"}}`: "env.ANTHROPIC_API_KEY",
		`{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}`:      "env.CLAUDE_CODE_USE_BEDROCK",
		`{"apiKeyHelper":"/bin/key"}`:                  "apiKeyHelper",
		`{"apiKeyHelper":"","env":{"FOO":"1"}}`:        "",
		`{"permissions":{"defaultMode":"dontAsk"}}`:    "",
		`{"env":`: "unreadable JSON",
	} {
		if got := settingsBilling([]byte(content)); got != want {
			t.Errorf("%s: %q, want %q", content, got, want)
		}
	}
}

func TestHeadlessOrphans(t *testing.T) {
	marker := "/st/headless/h.mcp.json"
	procs := []procArgs{
		{1, []string{"claude", "-p", "--resume", "sid", "--mcp-config", marker}}, // ours, orphaned
		{2, []string{"claude", "--resume", "sid"}},                               // the user's own
		{3, []string{"claude", "-p", "--resume", "other", "--mcp-config", marker}},
	}
	ours, others := heldSession(procs, "sid", marker)
	// a child with the marker is ours whatever its session; another claude only when on it
	if len(ours) != 2 || ours[0].pid != 1 || ours[1].pid != 3 || len(others) != 1 || others[0].pid != 2 {
		t.Errorf("ours %v, others %v", ours, others)
	}
	if ours, others := heldSession(procs, "", marker); len(ours) != 2 || len(others) != 0 {
		t.Errorf("no session: ours %v, others %v", ours, others)
	}
	if orphanTarget(10, 10) != -10 || orphanTarget(10, 4) != 10 {
		t.Error("the group is killed only when the orphan leads it")
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(newUUID()) {
		t.Error("newUUID")
	}
}

// ── the runner through the bridge ────────────────────────────────────────────

type hlBridge struct {
	*testBridge
	log  string // FAKECLAUDE_LOG
	home string
	name string // its orchestrator
}

// fakeClaudeEnv builds tools/fakeclaude as `claude` (the orphan scan looks for that name)
// and points the bridge at it, with a fresh HOME.
func fakeClaudeEnv(t *testing.T) (log, home string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	build := exec.Command("go", "build", "-o", bin, "./tools/fakeclaude")
	build.Dir = filepath.Join("..", "..")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building fakeclaude: %v\n%s", err, out)
	}
	home = filepath.Join(dir, "home")
	os.MkdirAll(home, 0o700)
	log = filepath.Join(dir, "fakeclaude.log")
	t.Setenv("YOICKS_CLAUDE_BIN", bin)
	t.Setenv("HOME", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	t.Setenv("FAKECLAUDE_LOG", log)
	old := managedSettingsPath
	managedSettingsPath = filepath.Join(dir, "managed-settings.json")
	t.Cleanup(func() { managedSettingsPath = old })
	return log, home
}

// startHeadless runs a bridge with one headless orchestrator, h1 (or the name hlName says), on fakeclaude.
func startHeadless(t *testing.T, stateDir string, env map[string]string, tweak func(*headlessRunner)) *hlBridge {
	t.Helper()
	log, home := os.Getenv("FAKECLAUDE_LOG"), os.Getenv("HOME")
	if !strings.HasSuffix(log, "fakeclaude.log") {
		log, home = fakeClaudeEnv(t)
	}
	if env == nil {
		env = map[string]string{}
	}
	// fakeclaude's settings reach it as the entry's env does (the bridge's own env is allowlisted)
	for _, kv := range os.Environ() {
		if k, v, _ := strings.Cut(kv, "="); strings.HasPrefix(k, "FAKECLAUDE_") {
			env[k] = v
		}
	}
	name := firstNonEmpty(os.Getenv("HLNAME"), "h1")
	def := OrchestratorDef{Name: name, Label: "H1", Dir: filepath.Join(home, "orchestrators", name), Env: env, Managed: true, Mode: "headless"}
	b := startBridge(t, Config{StateDir: stateDir, Orchestrators: []OrchestratorDef{def}}, nil, func(s *server) {
		h := s.headless[name]
		h.restartDelays = []time.Duration{50 * time.Millisecond, 50 * time.Millisecond, 50 * time.Millisecond}
		if tweak != nil {
			tweak(h)
		}
	})
	t.Cleanup(b.srv.shutdownHeadless) // before the bridge's own cleanup (LIFO)
	return &hlBridge{b, log, home, name}
}

func (b *hlBridge) post(t *testing.T, action, body string) (int, string) {
	t.Helper()
	status, out, _ := b.do(t, "POST", "/api/orchestrators/"+b.name+"/"+action, b.token, []byte(body))
	return status, out
}

func (b *hlBridge) view(t *testing.T) OrchestratorView {
	t.Helper()
	_, body, _ := b.do(t, "GET", "/api/state", b.token, nil)
	var st struct{ Orchestrators []OrchestratorView }
	if err := json.Unmarshal([]byte(body), &st); err != nil || len(st.Orchestrators) != 1 {
		t.Fatalf("state %s: %v", body, err)
	}
	return st.Orchestrators[0]
}

func (b *hlBridge) waitFor(t *testing.T, what string, ok func(v OrchestratorView) bool) OrchestratorView {
	t.Helper()
	var v OrchestratorView
	waitUntil(t, 10*time.Second, what, func() bool { v = b.view(t); return ok(v) })
	return v
}

func (b *hlBridge) waitStatus(t *testing.T, status string) OrchestratorView {
	t.Helper()
	return b.waitFor(t, "status "+status, func(v OrchestratorView) bool { return v.Headless != nil && v.Headless.Status == status })
}

func (b *hlBridge) start(t *testing.T) {
	t.Helper()
	if status, body := b.post(t, "start", ""); status != 200 || body != `{"ok":true,"paneId":"hl:`+b.name+`","name":"`+b.name+`"}` {
		t.Fatalf("start: %d %s", status, body)
	}
}

func (b *hlBridge) send(t *testing.T, text string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"text": text})
	if status, out := b.post(t, "send", string(body)); status != 200 {
		t.Fatalf("send %q: %d %s", text, status, out)
	}
}

// runs is fakeclaude's -p runs (pid, argv), in order; stdin its stdin lines.
func (b *hlBridge) runs(t *testing.T) (runs []procArgs, stdin []string) {
	t.Helper()
	f, err := os.Open(b.log)
	if err != nil {
		return nil, nil
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		var l struct {
			Pid   int
			Argv  []string
			Stdin *string
		}
		json.Unmarshal(sc.Bytes(), &l)
		if l.Stdin != nil {
			stdin = append(stdin, *l.Stdin)
		} else if slices.Contains(l.Argv, "-p") {
			runs = append(runs, procArgs{l.Pid, l.Argv})
		}
	}
	return runs, stdin
}

func (b *hlBridge) waitStdin(t *testing.T, substr string) {
	t.Helper()
	waitUntil(t, 10*time.Second, "stdin gets "+substr, func() bool {
		_, in := b.runs(t)
		return slices.ContainsFunc(in, func(l string) bool { return strings.Contains(l, substr) })
	})
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func hasWarning(v OrchestratorView, kind string) bool {
	return v.Headless != nil && slices.ContainsFunc(v.Headless.Warnings, func(w HeadlessWarning) bool { return w.Kind == kind })
}

func TestHeadlessTurn(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	// its agents: its account's, as a stopped TUI one's
	if v := b.waitFor(t, "its agents", func(v OrchestratorView) bool { return v.Agents != nil }); v.Mode != "headless" || v.PaneID != nil || v.Headless.Status != "stopped" {
		t.Fatalf("before the start: %+v", v)
	}
	b.start(t)
	v := b.waitStatus(t, "idle")
	if v.PaneID == nil || *v.PaneID != "hl:h1" || v.Headless.CompletionSeq != 0 || v.Headless.Pending != nil {
		t.Fatalf("started: %+v", v)
	}
	b.send(t, "slow 1")
	if v := b.view(t); v.Headless.Status != "working" {
		t.Errorf("after the send: %s", v.Headless.Status)
	}
	v = b.waitStatus(t, "done")
	if v.Headless.CompletionSeq != 1 || v.Headless.Usage == nil || v.Headless.Usage.FiveHour.Utilization != 0.25 ||
		v.Headless.Usage.ContextPct == nil || *v.Headless.Usage.ContextPct != 1 || len(v.Headless.Warnings) != 0 {
		t.Fatalf("done: %+v %+v", v.Headless, v.Headless.Usage)
	}

	// the chat: the transcript fakeclaude wrote, through the pane transcript route
	waitUntil(t, 5*time.Second, "the transcript", func() bool {
		_, body, _ := b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
		return strings.Contains(body, `"available":true`) && strings.Contains(body, `"text":"echo: slow 1"`)
	})

	// a message sent mid-turn is written at once, and answered
	b.send(t, "slow 2")
	b.waitStatus(t, "working")
	b.send(t, "while working")
	b.waitStdin(t, "while working")
	v = b.waitFor(t, "both turns", func(v OrchestratorView) bool { return v.Headless.CompletionSeq == 3 })
	if v.Headless.Status != "done" {
		t.Errorf("status %s", v.Headless.Status)
	}
	runs, _ := b.runs(t)
	if len(runs) != 1 || !slices.Contains(runs[0].argv, "--session-id") {
		t.Fatalf("runs %v", runs)
	}
	// the env allowlist reached it: no herdr variable, no billing one
	f, _ := os.ReadFile(b.log)
	if strings.Contains(string(f), `"HERDR_`) || strings.Contains(string(f), `"ANTHROPIC_`) {
		t.Errorf("env: %s", f)
	}
}

func TestHeadlessInterruptAndStop(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "slow 30")
	b.waitStatus(t, "working")
	began := time.Now()
	if status, body := b.post(t, "interrupt", ""); status != 200 || time.Since(began) > time.Second {
		t.Fatalf("interrupt: %d %s after %s", status, body, time.Since(began))
	}
	if v := b.waitStatus(t, "idle"); v.Headless.CompletionSeq != 0 {
		t.Errorf("an interrupted turn counted: %+v", v.Headless)
	}

	// Stop while working: within the budget, and nothing left running
	b.send(t, "slow 30")
	b.waitStatus(t, "working")
	began = time.Now()
	if status, body := b.post(t, "stop", ""); status != 200 {
		t.Fatalf("stop: %d %s", status, body)
	}
	if d := time.Since(began); d > 2500*time.Millisecond {
		t.Errorf("stop took %s", d)
	}
	runs, _ := b.runs(t)
	for _, r := range runs {
		if alive(r.pid) {
			t.Errorf("pid %d still runs", r.pid)
		}
	}
	if v := b.view(t); v.PaneID != nil || v.Headless.Status != "stopped" {
		t.Errorf("stopped: %+v", v)
	}
	if status, _ := b.post(t, "send", `{"text":"x"}`); status != 409 {
		t.Errorf("send while stopped: %d", status)
	}
}

func TestHeadlessCrashes(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	for i := 1; i <= 4; i++ {
		b.send(t, "crash")
		if i < 4 { // restarted, and its notice answered
			b.waitFor(t, "a restart", func(v OrchestratorView) bool {
				runs, _ := b.runs(t)
				return len(runs) == i+1 && v.Headless.Status == "done"
			})
		}
	}
	v := b.waitStatus(t, "error")
	if !hasWarning(v, "restart_limit") || !strings.Contains(v.Headless.Warnings[len(v.Headless.Warnings)-1].Message, "crashing as asked") {
		t.Fatalf("warnings %+v", v.Headless.Warnings)
	}
	runs, stdin := b.runs(t)
	if len(runs) != 4 {
		t.Fatalf("runs %d", len(runs))
	}
	for _, r := range runs[1:] {
		if r.argv[6] != "--resume" || r.argv[7] != runs[0].argv[7] {
			t.Errorf("a restart without --resume of the session: %v", r.argv)
		}
	}
	// each restart after a crash mid-turn tells it so
	if n := len(slices.DeleteFunc(stdin, func(l string) bool { return !strings.Contains(l, "restarted while you were working") })); n != 3 {
		t.Errorf("%d notices", n)
	}
}

func TestHeadlessResumesAcrossBridgeRestarts(t *testing.T) {
	state := t.TempDir()
	b := startHeadless(t, state, nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "hello")
	b.waitStatus(t, "done")
	b.send(t, "slow 30")
	b.waitStatus(t, "working")
	began := time.Now()
	b.srv.shutdownHeadless() // the bridge's shutdown
	if d := time.Since(began); d > 2500*time.Millisecond {
		t.Errorf("shutdown took %s", d)
	}
	runs, _ := b.runs(t)
	if alive(runs[0].pid) {
		t.Fatal("the child outlived the shutdown")
	}

	b2 := startHeadless(t, state, nil, nil)
	b2.srv.startHeadless()
	// the notice was answered: the count goes on from the first bridge's (a phone's seen-done
	// record is keyed on it)
	if v := b2.waitStatus(t, "done"); v.Headless.CompletionSeq != 2 {
		t.Errorf("completionSeq after the restart: %d, want 2", v.Headless.CompletionSeq)
	}
	runs, _ = b2.runs(t)
	if len(runs) != 2 || runs[1].argv[6] != "--resume" || runs[1].argv[7] != runs[0].argv[7] {
		t.Fatalf("runs %v", runs)
	}
	b2.waitStdin(t, "restarted while you were working")

	// Clear: a fresh session
	if status, body := b2.post(t, "clear", ""); status != 200 {
		t.Fatalf("clear: %d %s", status, body)
	}
	waitUntil(t, 5*time.Second, "the fresh run", func() bool { runs, _ = b2.runs(t); return len(runs) == 3 })
	if len(runs) != 3 || runs[2].argv[6] != "--session-id" || runs[2].argv[7] == runs[0].argv[7] {
		t.Fatalf("after clear %v", runs)
	}
}

// A session that never got a message has no transcript, and Claude Code (as the fake) can't resume
// it: a Stop and Start, or a restart, begins it again under the same id instead of crash-looping.
func TestHeadlessRestartsASessionWithNoMessage(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	if status, body := b.post(t, "stop", ""); status != 200 {
		t.Fatalf("stop: %d %s", status, body)
	}
	b.start(t)
	b.waitStatus(t, "idle")
	var runs []procArgs
	waitUntil(t, 5*time.Second, "the second run", func() bool { runs, _ = b.runs(t); return len(runs) == 2 })
	if runs[1].argv[6] != "--session-id" || runs[1].argv[7] != runs[0].argv[7] {
		t.Fatalf("runs %v", runs)
	}
	b.send(t, "hello")
	b.waitStatus(t, "done")
	if status, body := b.post(t, "stop", ""); status != 200 {
		t.Fatalf("stop: %d %s", status, body)
	}
	b.start(t) // now it has a transcript: resumed
	waitUntil(t, 5*time.Second, "the third run", func() bool { runs, _ = b.runs(t); return len(runs) == 3 })
	if runs[2].argv[6] != "--resume" || runs[2].argv[7] != runs[0].argv[7] {
		t.Fatalf("runs %v", runs)
	}
}

func TestHeadlessDetectors(t *testing.T) {
	var mu sync.Mutex
	var logged []string
	b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) {
		h.silence = 600 * time.Millisecond
		h.log = func(f string, a ...any) { mu.Lock(); logged = append(logged, f); mu.Unlock() }
	})
	c, _, err := b.dial(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	b.start(t)
	b.waitStatus(t, "idle")
	for _, script := range []string{"unknown", "garbage", "askstdio"} {
		b.send(t, script)
		if script == "askstdio" { // over stdio too, the question is the Home's to answer
			v := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
			b.post(t, "answer", `{"id":"`+v.Headless.Pending.ID+`","deny":"not now"}`)
		}
		b.waitFor(t, script+" answered", func(v OrchestratorView) bool { return v.Headless.Status == "done" })
	}
	b.send(t, "hang 2")
	v := b.waitFor(t, "the silence warning", func(v OrchestratorView) bool { return hasWarning(v, "silent") })
	for _, w := range v.Headless.Warnings {
		if w.Kind == "silent" && !slices.Equal(w.Actions, []string{"interrupt", "clear"}) {
			t.Errorf("actions %v", w.Actions)
		}
	}
	v = b.waitStatus(t, "done")
	for _, kind := range []string{"unknown_event", "unreadable", "permission_route"} {
		if !hasWarning(v, kind) {
			t.Errorf("no %s warning: %+v", kind, v.Headless.Warnings)
		}
	}
	if hasWarning(v, "silent") {
		t.Error("the silence warning stayed after an event")
	}
	b.waitStdin(t, `"message":"not now"`) // the stdio permission request was answered

	// each kind was alerted once over WS
	alerts := map[string]int{}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			break
		}
		var m WsOrchestratorAlertMessage
		if json.Unmarshal(data, &m) == nil && m.Type == "orchestrator_alert" && m.Name == "h1" {
			alerts[m.Kind]++
		}
	}
	for _, kind := range []string{"unknown_event", "unreadable", "permission_route", "silent"} {
		if alerts[kind] != 1 {
			t.Errorf("alerts %v", alerts)
			break
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.ContainsFunc(logged, func(l string) bool { return strings.HasPrefix(l, "auth status") }) {
		t.Errorf("logged %v", logged)
	}
}

func TestHeadlessRefusesBilling(t *testing.T) {
	t.Run("an env billing variable: error before any start", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), map[string]string{"ANTHROPIC_API_KEY": "sk"}, nil)
		if v := b.view(t); v.Headless.Status != "error" || !hasWarning(v, "billing") {
			t.Fatalf("%+v", v.Headless)
		}
		if status, body := b.post(t, "start", ""); status != 409 || !strings.Contains(body, "billing_refused") {
			t.Errorf("start: %d %s", status, body)
		}
		b.srv.startHeadless()
		time.Sleep(200 * time.Millisecond)
		if runs, _ := b.runs(t); len(runs) != 0 {
			t.Errorf("runs %v", runs)
		}
	})
	t.Run("a home of its own", func(t *testing.T) {
		for _, k := range []string{"HOME", "XDG_CONFIG_HOME"} {
			b := startHeadless(t, t.TempDir(), map[string]string{k: "/elsewhere"}, nil)
			if v := b.view(t); v.Headless.Status != "error" || !hasWarning(v, "env") || !strings.Contains(v.Headless.Warnings[0].Message, k) {
				t.Fatalf("%s: %+v", k, v.Headless)
			}
			if status, body := b.post(t, "start", ""); status != 409 || !strings.Contains(body, "env_refused") {
				t.Errorf("%s: start: %d %s", k, status, body)
			}
		}
		if runs, _ := (&hlBridge{log: os.Getenv("FAKECLAUDE_LOG")}).runs(t); len(runs) != 0 {
			t.Errorf("runs %v", runs)
		}
	})
	t.Run("not a claude.ai subscription", func(t *testing.T) {
		var mu sync.Mutex
		var logged []string
		fakeClaudeEnv(t)
		t.Setenv("FAKECLAUDE_AUTH", "api_key")
		b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) {
			h.log = func(f string, a ...any) { mu.Lock(); logged = append(logged, fmt.Sprintf(f, a...)); mu.Unlock() }
		})
		if status, body := b.post(t, "start", ""); status != 409 || !strings.Contains(body, "auth_refused") {
			t.Errorf("start: %d %s", status, body)
		}
		if v := b.view(t); v.Headless.Status != "error" || !hasWarning(v, "auth") {
			t.Errorf("%+v", v.Headless)
		}
		mu.Lock()
		defer mu.Unlock()
		// auth status prints the account's email: only authMethod and subscriptionType are logged
		if all := strings.Join(logged, "\n"); !strings.Contains(all, "authMethod=api_key") || strings.Contains(all, "@") {
			t.Errorf("logged %s", all)
		}
	})
	t.Run("a settings file's env or apiKeyHelper", func(t *testing.T) {
		_, home := fakeClaudeEnv(t)
		for _, c := range []struct{ path, content string }{
			{filepath.Join(home, ".claude", "settings.json"), `{"apiKeyHelper":"/bin/key"}`},
			{filepath.Join(home, "orchestrators", "h1", ".claude", "settings.local.json"), `{"env":{"ANTHROPIC_API_KEY":"sk"}}`},
			{managedSettingsPath, `{"env":{"CLAUDE_CODE_USE_BEDROCK":"1"}}`},
		} {
			os.MkdirAll(filepath.Dir(c.path), 0o700)
			os.WriteFile(c.path, []byte(c.content), 0o600)
			b := startHeadless(t, t.TempDir(), nil, nil)
			if status, body := b.post(t, "start", ""); status != 409 || !strings.Contains(body, c.path) {
				t.Errorf("%s: %d %s", c.path, status, body)
			}
			os.Remove(c.path)
		}
	})
	t.Run("an init that would bill an API key stops it", func(t *testing.T) {
		fakeClaudeEnv(t)
		t.Setenv("FAKECLAUDE_APIKEYSOURCE", "ANTHROPIC_API_KEY")
		b := startHeadless(t, t.TempDir(), nil, nil)
		b.start(t)
		b.waitStatus(t, "idle")
		b.send(t, "hello")
		v := b.waitStatus(t, "error")
		if !hasWarning(v, "init") {
			t.Errorf("%+v", v.Headless)
		}
		time.Sleep(300 * time.Millisecond) // no restart
		if runs, _ := b.runs(t); len(runs) != 1 || alive(runs[0].pid) {
			t.Errorf("runs %v", runs)
		}
	})
}

// The child is the running one before its first line or its exit: an init at once is
// checked, an exit at once is a crash.
func TestHeadlessChildAtOnce(t *testing.T) {
	// spawn goes on late: its first line, or its end, comes before that
	late := func(h *headlessRunner) { h.startedHook = func() { time.Sleep(300 * time.Millisecond) } }
	t.Run("an init at once is checked", func(t *testing.T) {
		fakeClaudeEnv(t)
		t.Setenv("FAKECLAUDE_START", "init")
		t.Setenv("FAKECLAUDE_APIKEYSOURCE", "ANTHROPIC_API_KEY")
		b := startHeadless(t, t.TempDir(), nil, late)
		b.start(t)
		v := b.waitFor(t, "the init refused", func(v OrchestratorView) bool { return v.Headless.Status == "error" && v.PaneID == nil })
		if !hasWarning(v, "init") {
			t.Errorf("%+v", v.Headless)
		}
	})
	t.Run("an exit at once is a crash, restarted to the limit", func(t *testing.T) {
		fakeClaudeEnv(t)
		t.Setenv("FAKECLAUDE_START", "exit")
		b := startHeadless(t, t.TempDir(), nil, late)
		b.start(t)
		v := b.waitFor(t, "the restart limit", func(v OrchestratorView) bool { return v.Headless.Status == "error" })
		if !hasWarning(v, "restart_limit") || v.PaneID != nil {
			t.Errorf("%+v %v", v.Headless, v.PaneID)
		}
		if runs, _ := b.runs(t); len(runs) != 4 {
			t.Errorf("%d runs", len(runs))
		}
	})
}

func TestHeadlessStateDirUnwritable(t *testing.T) {
	state := t.TempDir()
	os.WriteFile(filepath.Join(state, "headless"), nil, 0o600) // a file where its dir goes
	b := startHeadless(t, state, nil, nil)
	if status, body := b.post(t, "start", ""); status != 500 || !strings.Contains(body, "could not write") {
		t.Errorf("start: %d %s", status, body)
	}
	if runs, _ := b.runs(t); len(runs) != 0 {
		t.Errorf("runs %v", runs)
	}
}

// A child that stopped reading stdin, with a send stuck on it, still stops within the budget.
func TestHeadlessShutdownPastAStuckWrite(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "deaf")
	big, _ := json.Marshal(map[string]string{"text": strings.Repeat("x", 60000)})
	sent := make(chan struct{})
	go func() {
		defer close(sent)
		for range 4 { // more than the pipe holds
			b.do(t, "POST", "/api/orchestrators/h1/send", b.token, big)
		}
	}()
	time.Sleep(1500 * time.Millisecond) // a send is stuck by now
	runs, _ := b.runs(t)
	began := time.Now()
	b.srv.shutdownHeadless()
	if d := time.Since(began); d > 2500*time.Millisecond {
		t.Errorf("shutdown took %s", d)
	}
	if alive(runs[0].pid) {
		t.Error("the child outlived the shutdown")
	}
	<-sent
}

func TestHeadlessOrphanScan(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the orphan scan reads /proc: Linux only")
	}
	state := t.TempDir()
	b := startHeadless(t, state, nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.post(t, "stop", "")
	runs, _ := b.runs(t)
	sid, mcp := runs[0].argv[7], headlessPath(state, "h1", ".mcp.json")
	run := func(args ...string) *exec.Cmd { return otherClaude(t, args...) }

	// the user's own claude on that session (it has had no message: no --resume of it): never
	// stopped, the start refused
	user := run("-p", "--session-id", sid)
	waitUntil(t, 5*time.Second, "it runs", func() bool { return len(claudeProcsWith(sid)) > 0 })
	if status, body := b.post(t, "start", ""); status != 409 || !strings.Contains(body, "session_in_use") {
		t.Errorf("start: %d %s", status, body)
	}
	if !alive(user.Process.Pid) {
		t.Error("the user's claude was stopped")
	}
	user.Process.Kill()
	user.Wait()

	// an earlier bridge's child (with the marker): stopped, then the start goes on
	orphan := run(headlessArgv(sid, false, mcp, true)...)
	waitUntil(t, 5*time.Second, "it runs", func() bool { return len(claudeProcsWith(sid)) > 0 })
	if pid := markedHeadlessChild(state, "h1"); pid != orphan.Process.Pid {
		t.Errorf("markedHeadlessChild %d, want %d", pid, orphan.Process.Pid)
	}
	b.start(t)
	orphan.Wait()
	if v := b.waitStatus(t, "idle"); v.PaneID == nil {
		t.Errorf("%+v", v)
	}
	if status, body := b.post(t, "start", ""); status != 409 {
		t.Errorf("a second start: %d %s", status, body)
	}
}

func claudeProcsWith(sid string) []procArgs {
	return slices.DeleteFunc(claudeProcs(), func(p procArgs) bool { return !slices.Contains(p.argv, sid) })
}

func TestHeadlessPanicStopsOnlyThatOrchestrator(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) {
		h.lineHook = func(line []byte) {
			if strings.Contains(string(line), "echo: boom") {
				panic("boom")
			}
		}
	})
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "boom")
	v := b.waitFor(t, "an error, the child gone", func(v OrchestratorView) bool { return v.Headless.Status == "error" && v.PaneID == nil })
	if !hasWarning(v, "panic") || v.PaneID != nil {
		t.Errorf("%+v", v)
	}
	if status, _, _ := b.do(t, "GET", "/api/state", b.token, nil); status != 200 {
		t.Errorf("the bridge stopped serving: %d", status)
	}
	runs, _ := b.runs(t)
	waitUntil(t, 3*time.Second, "the child ends", func() bool { return !alive(runs[0].pid) })
}

func TestHeadlessHasNoPane(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	n := len(b.fake.Requests())
	for _, r := range []struct{ method, path string }{
		{"POST", "/api/panes/hl:h1/input"}, {"GET", "/api/panes/hl:h1/read"}, {"POST", "/api/panes/hl%3Ah1/focus"},
		{"DELETE", "/api/panes/hl:h1"}, {"POST", "/api/agents/hl:h1/send"}, {"POST", "/api/agents/hl:h1/clear"},
	} {
		if status, body, _ := b.do(t, r.method, r.path, b.token, []byte(`{"text":"x"}`)); status != 404 {
			t.Errorf("%s %s: %d %s", r.method, r.path, status, body)
		}
	}
	c, _, err := b.dial(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err := c.Write(context.Background(), websocket.MessageText, []byte(`{"type":"watch_pane","paneId":"hl:h1"}`)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	if got := b.sent(n); len(got) != 0 {
		t.Errorf("herdr got %v for hl:h1", got)
	}
}

// No headless entry, no headless anything: no runner, no child, no log line.
func TestNoHeadlessWithoutAHeadlessEntry(t *testing.T) {
	log, home := fakeClaudeEnv(t)
	def := OrchestratorDef{Name: "t1", Dir: filepath.Join(home, "orchestrators", "t1"), Env: map[string]string{}, Managed: true}
	b := startBridge(t, Config{Orchestrators: []OrchestratorDef{def}}, nil, nil)
	b.srv.startHeadless()
	b.srv.shutdownHeadless()
	if len(b.srv.headless) != 0 {
		t.Errorf("runners %v", b.srv.headless)
	}
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(log); err == nil {
		t.Error("fakeclaude ran")
	}
	_, body, _ := b.do(t, "GET", "/api/state", b.token, nil)
	if !strings.Contains(body, `"mode":"tui","headless":null`) {
		t.Errorf("state %s", body)
	}
	if status, _, _ := b.do(t, "POST", "/api/orchestrators/t1/send", b.token, []byte(`{"text":"x"}`)); status != 404 {
		t.Errorf("send to a tui orchestrator: %d", status)
	}
}

// otherClaude runs a fakeclaude the bridge didn't start, in its own group.
func otherClaude(t *testing.T, args ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Getenv("YOICKS_CLAUDE_BIN"), args...)
	cmd.Dir = t.TempDir()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, _ := cmd.StdinPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { stdin.Close(); cmd.Process.Kill(); cmd.Wait() })
	return cmd
}

// An earlier bridge's child goes even when this start is refused (an env of its own), at the
// bridge's start and at a Start.
func TestHeadlessReapsOrphansBeforeARefusal(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the orphan scan reads /proc: Linux only")
	}
	fakeClaudeEnv(t)
	state := t.TempDir()
	os.MkdirAll(filepath.Join(state, "headless"), 0o700)
	sid := newUUID()
	os.WriteFile(headlessPath(state, "h1", ".json"), []byte(`{"sessionId":"`+sid+`","wanted":true}`), 0o600)
	orphan := func() chan struct{} {
		cmd := otherClaude(t, headlessArgv(sid, false, headlessPath(state, "h1", ".mcp.json"), true)...)
		waitUntil(t, 5*time.Second, "it runs", func() bool { return markedHeadlessChild(state, "h1") == cmd.Process.Pid })
		gone := make(chan struct{})
		go func() { cmd.Wait(); close(gone) }()
		return gone
	}
	wait := func(gone chan struct{}, when string) {
		select {
		case <-gone:
		case <-time.After(5 * time.Second):
			t.Errorf("%s: the orphan still runs", when)
		}
	}
	gone := orphan()
	b := startHeadless(t, state, map[string]string{"HOME": "/elsewhere"}, nil)
	b.srv.startHeadless()
	wait(gone, "the bridge's start")

	gone = orphan()
	if status, body := b.post(t, "start", ""); status != 409 || !strings.Contains(body, "env_refused") {
		t.Errorf("start: %d %s", status, body)
	}
	wait(gone, "a start")
}

// A message queued behind an interrupted turn runs next; with no turn running, an interrupt
// ends only the message it overtook (as Claude Code does, S0 row 2).
func TestHeadlessInterruptKeepsQueuedMessages(t *testing.T) {
	transcript := func(b *hlBridge) string {
		_, body, _ := b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
		return body
	}
	t.Run("the message an interrupt overtook ends; the one after it runs", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		b.start(t)
		b.waitStatus(t, "idle")
		b.send(t, "hold") // its turn begins only 2 s later
		if status, body := b.post(t, "interrupt", ""); status != 200 {
			t.Fatalf("interrupt: %d %s", status, body)
		}
		b.send(t, "after")
		b.waitFor(t, "after answered", func(v OrchestratorView) bool { return v.Headless.CompletionSeq == 1 && v.Headless.Status == "done" })
		if tr := transcript(b); !strings.Contains(tr, "echo: after") || strings.Contains(tr, "echo: hold") {
			t.Errorf("transcript %s", tr)
		}
	})
	t.Run("a message queued behind a turn survives its interrupt", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		b.start(t)
		b.waitStatus(t, "idle")
		b.send(t, "slow 30")
		waitUntil(t, 5*time.Second, "the turn begins", func() bool { return strings.Contains(transcript(b), `"text":"slow 30"`) })
		b.send(t, "queued")
		b.waitStdin(t, "queued")
		if status, body := b.post(t, "interrupt", ""); status != 200 {
			t.Fatalf("interrupt: %d %s", status, body)
		}
		b.waitFor(t, "queued answered", func(v OrchestratorView) bool { return v.Headless.CompletionSeq == 1 && v.Headless.Status == "done" })
		if tr := transcript(b); !strings.Contains(tr, "echo: queued") || strings.Contains(tr, "echo: slow 30") {
			t.Errorf("transcript %s", tr)
		}
	})
	t.Run("an interrupt between a reply and its result ends that turn; the queued one still runs", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		b.start(t)
		b.waitStatus(t, "idle")
		b.send(t, "replyhold") // replies, then waits 2 s before its result
		waitUntil(t, 5*time.Second, "the reply is out", func() bool { return strings.Contains(transcript(b), "echo: replyhold") })
		b.send(t, "queued")
		b.waitStdin(t, "queued")
		if status, body := b.post(t, "interrupt", ""); status != 200 {
			t.Fatalf("interrupt: %d %s", status, body)
		}
		// the interrupted turn ends aborted (no completion); the queued message is the one that completes
		b.waitFor(t, "queued answered", func(v OrchestratorView) bool { return v.Headless.CompletionSeq == 1 && v.Headless.Status == "done" })
		if tr := transcript(b); !strings.Contains(tr, "echo: queued") {
			t.Errorf("the queued message never ran: %s", tr)
		}
	})
}

// A stop overlapping a write that finishes at once still interrupts the turn first.
func TestHeadlessStopWaitsForAWriteInProgress(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "slow 30")
	b.waitStatus(t, "working")
	h := b.srv.headless["h1"]
	h.mu.Lock()
	c := h.child
	h.mu.Unlock()
	c.wlock <- struct{}{} // a write in progress, done 50 ms later
	go func() { time.Sleep(50 * time.Millisecond); <-c.wlock }()
	b.srv.shutdownHeadless()
	b.waitStdin(t, `"request_id":"yoicks-stop"`)
}

// The last claude check (<state>/canary.json) reaches the state and the headless ones: a
// failed one is a canary warning, and the version warning tells it; a failed one alerts once
// (the PC's notification here), a passing one ends the warning.
func TestHeadlessClaudeCheck(t *testing.T) {
	log, home := fakeClaudeEnv(t)
	state := t.TempDir()
	write := func(at time.Time, ok bool, failed string) {
		os.WriteFile(filepath.Join(state, "canary.json"), fmt.Appendf(nil, `{"at":%d,"version":"2.1.330","ok":%v,"failed":[%s]}`, at.UnixMilli(), ok, failed), 0o600)
	}
	first := time.Date(2026, 11, 26, 9, 0, 0, 0, time.Local)
	write(first, false, `"resume"`)
	var shown sync.Mutex
	var alerts []string
	def := OrchestratorDef{Name: "h1", Dir: filepath.Join(home, "orchestrators", "h1"), Managed: true, Mode: "headless",
		Env: map[string]string{"FAKECLAUDE_LOG": log, "FAKECLAUDE_VERSION": "2.1.330"}}
	tb := startBridge(t, Config{StateDir: state, Orchestrators: []OrchestratorDef{def}}, func(m string, p json.RawMessage) (fakeherdr.Reply, bool) {
		if m == "notification.show" && strings.Contains(string(p), "claude check failed") {
			shown.Lock()
			alerts = append(alerts, string(p))
			shown.Unlock()
		}
		return fakeherdr.Reply{}, false
	}, nil)
	t.Cleanup(tb.srv.shutdownHeadless)
	b := &hlBridge{tb, log, home, "h1"}
	nAlerts := func() int { shown.Lock(); defer shown.Unlock(); return len(alerts) }
	warning := func(v OrchestratorView, kind string) string {
		for _, w := range v.Headless.Warnings {
			if w.Kind == kind {
				return w.Message + " " + strings.Join(w.Actions, ",")
			}
		}
		return ""
	}
	failedFirst := "failed on " + first.Format("2006-01-02 15:04") + " (2.1.330: resume)"

	_, body, _ := b.do(t, "GET", "/api/state", b.token, nil)
	if !strings.Contains(body, fmt.Sprintf(`"claudeCheck":{"at":%d,"version":"2.1.330","ok":false,"failed":["resume"]}`, first.UnixMilli())) {
		t.Fatalf("state: %s", body)
	}
	if w := warning(b.view(t), "canary"); !strings.Contains(w, failedFirst) || !strings.HasSuffix(w, " tui") {
		t.Errorf("canary warning %q", w)
	}
	waitUntil(t, 5*time.Second, "the alert", func() bool { return nAlerts() == 1 })
	// a start and a Clear keep the check: its warnings stand at once, no tick needed
	for _, action := range []string{"start", "clear"} {
		if code, body := b.post(t, action, ""); code != 200 {
			t.Fatalf("%s: %d %s", action, code, body)
		}
		v := b.waitStatus(t, "idle")
		if w := warning(v, "canary"); !strings.Contains(w, failedFirst) {
			t.Errorf("after %s: canary %q", action, w)
		}
		if w := warning(v, "version"); !strings.Contains(w, "Claude Code 2.1.330 is not verified") || !strings.Contains(w, "the last check "+failedFirst) {
			t.Errorf("after %s: version %q", action, w)
		}
	}
	// a passing check ends the canary warning, and the version warning says so
	write(first.Add(time.Hour), true, "")
	b.srv.checkClaude()
	if v := b.view(t); warning(v, "canary") != "" || !strings.Contains(warning(v, "version"), "the last check passed on "+first.Add(time.Hour).Format("2006-01-02 15:04")) {
		t.Errorf("after a passing check: %+v", v.Headless.Warnings)
	}
	write(first.Add(2*time.Hour), false, `"interrupt"`)
	b.srv.checkClaude()
	waitUntil(t, 5*time.Second, "the second alert", func() bool { return nAlerts() == 2 })
	time.Sleep(200 * time.Millisecond)
	if n := nAlerts(); n != 2 {
		t.Errorf("%d alerts: %q", n, alerts)
	}
	// Claude Code back on the verified version, updated before an automatic restart: the version warning goes
	h := b.srv.headless["h1"]
	h.mu.Lock()
	h.def.Env["FAKECLAUDE_VERSION"] = verifiedClaudeVersion
	h.mu.Unlock()
	b.restarted(t) // a crash, then the automatic restart (not a Clear, which drops every warning)
	if w := warning(b.view(t), "version"); w != "" {
		t.Errorf("the verified version still warned: %q", w)
	}
	b.srv.checkClaude()
	if w := warning(b.view(t), "version"); w != "" {
		t.Errorf("a check brought the version warning back: %q", w)
	}
	// a file that isn't a whole check is none; and without a headless entry it isn't read at all
	os.WriteFile(filepath.Join(state, "canary.json"), []byte(`{"at":1,"ok":fal`), 0o600)
	b.srv.checkClaude()
	if _, body, _ := b.do(t, "GET", "/api/state", b.token, nil); !strings.Contains(body, `"claudeCheck":null`) {
		t.Errorf("half a file: %s", body)
	}
	write(first, false, `"resume"`)
	plain := startBridge(t, Config{StateDir: state}, nil, nil)
	if _, body, _ := plain.do(t, "GET", "/api/state", plain.token, nil); !strings.Contains(body, `"claudeCheck":null`) {
		t.Errorf("read without a headless entry: %s", body)
	}
}

// Whether a session can be resumed is where Claude Code looks: under the slug of its cwd as the
// child sees it (a linked orchestrator dir resolved), and a project dir linked elsewhere counts.
func TestHeadlessHasTranscript(t *testing.T) {
	cfg, outside, real := t.TempDir(), t.TempDir(), t.TempDir()
	real, _ = filepath.EvalSymlinks(real)
	dir := filepath.Join(t.TempDir(), "orch") // a link to real, as a linked XDG_DATA_HOME makes it
	os.Symlink(real, dir)
	r := newHeadlessRunner(OrchestratorDef{Name: "h1", Dir: dir, Env: map[string]string{"CLAUDE_CONFIG_DIR": cfg}, Managed: true, Mode: "headless"}, t.TempDir(), "")
	r.sessionID = newUUID()
	if r.hasTranscript() {
		t.Fatal("a transcript before any")
	}
	os.MkdirAll(filepath.Join(cfg, "projects"), 0o700)
	os.Symlink(outside, filepath.Join(cfg, "projects", slugForCwd(real)))
	os.WriteFile(filepath.Join(outside, r.sessionID+".jsonl"), []byte("{}\n"), 0o600)
	if !r.hasTranscript() {
		t.Error("the transcript under the resolved dir's slug, in a linked project dir")
	}
}
