package bridge

// The headless orchestrator's MCP server (mcp.go) through fakeclaude, which calls it as
// Claude Code does, and the wake-ups against fakeherdr's agent waits.

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/y011d4/herdr-yoicks/tools/fakeherdr"
)

// mcpClient connects to an orchestrator's server with bearer, as its child would.
func mcpClient(t *testing.T, url, bearer string) (*mcp.ClientSession, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := c.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: url,
		HTTPClient: &http.Client{Transport: headerRoundTripper{"Authorization": "Bearer " + bearer}}}, nil)
	if err == nil {
		t.Cleanup(func() { cs.Close() })
	}
	return cs, err
}

type headerRoundTripper map[string]string

func (h headerRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	for k, v := range h {
		r.Header.Set(k, v)
	}
	return http.DefaultTransport.RoundTrip(r)
}

func TestMCPListener(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	h := b.srv.headless["h1"]
	if !strings.HasPrefix(h.mcpURL, "http://127.0.0.1:") {
		t.Fatalf("url %s", h.mcpURL)
	}
	for _, bearer := range []string{"", "wrong", strings.Repeat("0", len(h.mcpBearer))} {
		req, _ := http.NewRequest("POST", h.mcpURL, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`))
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != 401 {
			t.Errorf("bearer %q: %d", bearer, res.StatusCode)
		}
	}
	// its six tools and approve; a second session (Claude Code initializes again every ~18
	// min, S0 row 20) is served the same
	for range 2 {
		cs, err := mcpClient(t, h.mcpURL, h.mcpBearer)
		if err != nil {
			t.Fatal(err)
		}
		tools, err := cs.ListTools(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		var names []string
		for _, tool := range tools.Tools {
			names = append(names, tool.Name)
		}
		if want := append([]string{"approve"}, yoicksTools...); !slices.Equal(slices.Sorted(slices.Values(names)), slices.Sorted(slices.Values(want))) {
			t.Errorf("tools %v", names)
		}
	}
	// the child's mcp.json: 0600, the bridge's server and bearer
	b.start(t)
	b.waitStatus(t, "idle")
	path := headlessPath(b.srv.cfg.StateDir, "h1", ".mcp.json")
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("%s: %v %v", path, st, err)
	}
	if got, _ := os.ReadFile(path); !strings.Contains(string(got), h.mcpBearer) || !strings.Contains(string(got), h.mcpURL) {
		t.Errorf("mcp.json %s", got)
	}
	// no headless entry, no listener
	if nb := startBridge(t, Config{}, nil, nil); nb.srv.mcp != nil {
		t.Error("a listener without a headless entry")
	}
}

func TestHeadlessAskAndAnswer(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "ask")
	v := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	p := v.Headless.Pending
	if v.Headless.Status != "blocked" || len(p.Questions) != 1 || p.Questions[0].Question != "Which fruit?" || len(p.Questions[0].Options) != 2 {
		t.Fatalf("%+v %+v", v.Headless, p)
	}
	if status, body := b.post(t, "answer", `{"id":"stale","answers":{"Which fruit?":"apple"}}`); status != 409 {
		t.Errorf("a stale id: %d %s", status, body)
	}
	if status, body := b.post(t, "answer", `{"id":"`+p.ID+`","answers":{"Which fruit?":"cherry, apple"}}`); status != 200 {
		t.Fatalf("answer: %d %s", status, body)
	}
	b.waitFor(t, "the turn's end", func(v OrchestratorView) bool { return v.Headless.Status == "done" && v.Headless.Pending == nil })
	_, tr, _ := b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
	if !strings.Contains(tr, `\"behavior\":\"allow\"`) || !strings.Contains(tr, `\"answers\":{\"Which fruit?\":\"cherry, apple\"}`) {
		t.Errorf("the tool_result: %s", tr)
	}
	if status, _ := b.post(t, "answer", `{"id":"`+p.ID+`","answers":{"Which fruit?":"apple"}}`); status != 409 {
		t.Errorf("answered twice: %d", status)
	}

	// a message while a question waits refuses it, with the message
	b.send(t, "ask")
	b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	b.send(t, "no fruit, thanks")
	b.waitFor(t, "the turn's end", func(v OrchestratorView) bool { return v.Headless.Status == "done" && v.Headless.Pending == nil })
	_, tr, _ = b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
	if !strings.Contains(tr, `\"behavior\":\"deny\",\"message\":\"no fruit, thanks\"`) {
		t.Errorf("the tool_result: %s", tr)
	}

	// an interrupt cancels the call and the question
	b.send(t, "ask")
	b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	if status, body := b.post(t, "interrupt", ""); status != 200 {
		t.Fatalf("interrupt: %d %s", status, body)
	}
	b.waitFor(t, "no question", func(v OrchestratorView) bool { return v.Headless.Pending == nil && v.Headless.Status == "idle" })
}

// The approve call stays open past Claude Code's 60 s with progress (the clock shortened).
func TestHeadlessApproveSendsProgress(t *testing.T) {
	old := approveProgress
	approveProgress = 100 * time.Millisecond
	t.Cleanup(func() { approveProgress = old })
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "ask")
	v := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	waitUntil(t, 5*time.Second, "progress", func() bool {
		f, _ := os.ReadFile(b.log)
		return strings.Count(string(f), `"progress"`) >= 5
	})
	b.post(t, "answer", `{"id":"`+v.Headless.Pending.ID+`","answers":{"Which fruit?":"apple"}}`)
	b.waitStatus(t, "done")
}

func TestHeadlessToolOverview(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "tool")
	b.waitStatus(t, "done")
	_, tr, _ := b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
	if !strings.Contains(tr, "tool: ") || strings.Contains(tr, "the call failed") {
		t.Errorf("transcript %s", tr)
	}
}

// Without tools (YOICKS_HEADLESS_NO_TOOLS), only approve: its init has only AskUserQuestion.
func TestHeadlessNoTools(t *testing.T) {
	t.Setenv("YOICKS_HEADLESS_NO_TOOLS", "1")
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "hello")
	b.waitStatus(t, "done")
	runs, _ := b.runs(t)
	if slices.Contains(runs[0].argv, "--allowedTools") || !slices.Contains(runs[0].argv, "--permission-prompt-tool") {
		t.Errorf("argv %v", runs[0].argv)
	}
}

func TestHeadlessRulesChanged(t *testing.T) {
	state := t.TempDir()
	os.MkdirAll(filepath.Join(state, "headless"), 0o700)
	os.WriteFile(headlessPath(state, "h1", ".json"), []byte(`{"sessionId":"`+newUUID()+`","wanted":false,"rulesHash":"old"}`), 0o600)
	b := startHeadless(t, state, nil, nil)
	b.start(t)
	v := b.waitStatus(t, "idle")
	if !hasWarning(v, "rules") {
		t.Errorf("%+v", v.Headless.Warnings)
	}
	b.post(t, "clear", "")
	if v := b.waitStatus(t, "idle"); hasWarning(v, "rules") {
		t.Errorf("after clear: %+v", v.Headless.Warnings)
	}
	// the headless rules are its section of the bundled ones
	rules, _ := os.ReadFile(filepath.Join("..", "..", "orchestrator", "rules.md"))
	hl, tui := rulesFor(string(rules), "headless"), rulesFor(string(rules), "tui")
	if !strings.Contains(hl, "agent_prompt") || strings.Contains(hl, "{{yoicks}}") || strings.Contains(hl, "<!--") ||
		!strings.Contains(tui, "{{yoicks}}") || strings.Contains(tui, "agent_prompt") || strings.Contains(tui, "<!--") {
		t.Error("rulesFor's sections")
	}
}

// ── wake-ups ─────────────────────────────────────────────────────────────────

// worker adds w1 to the fake herdr, of the orchestrator's account (a stand-in process with
// its HOME), and returns the world.
func worker(t *testing.T, b *hlBridge, status string, script func(w *fakeherdr.World, pane string)) *fakeherdr.World {
	t.Helper()
	standIn := exec.Command("sleep", "600")
	standIn.Env = []string{"HOME=" + b.home, "PATH=" + os.Getenv("PATH")}
	if err := standIn.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { standIn.Process.Kill(); standIn.Wait() })
	w := b.world
	w.Add(fakeherdr.Pane{ID: "w1p", Tab: "t9", Workspace: "w1", Agent: "claude", Status: status, Name: "w1", Cwd: b.home, Pid: standIn.Process.Pid})
	if script != nil {
		w.OnPrompt(func(pane, text string) { script(w, pane) })
	}
	b.srv.client.Refresh()
	return w
}

// wakes is the [yoicks] lines the orchestrator got.
func (b *hlBridge) wakes(t *testing.T) []string {
	_, stdin := b.runs(t)
	var out []string
	for _, l := range stdin {
		var m struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		}
		json.Unmarshal([]byte(l), &m)
		for _, line := range strings.Split(m.Message.Content, "\n") {
			if strings.HasPrefix(line, "[yoicks] w1") {
				out = append(out, line)
			}
		}
	}
	return out
}

func (b *hlBridge) prompt(t *testing.T) {
	t.Helper()
	b.send(t, `call agent_prompt {"name":"w1","text":"do the thing"}`)
	b.waitStatus(t, "done")
	_, tr, _ := b.do(t, "GET", "/api/panes/hl:"+b.name+"/transcript", b.token, nil)
	if !strings.Contains(tr, "delivered to w1") || strings.Contains(tr, "not delivered") {
		t.Fatalf("the tool's result: %s", tr)
	}
}

func (b *hlBridge) waitWakes(t *testing.T, want ...string) {
	t.Helper()
	waitUntil(t, 20*time.Second, "the wake-ups", func() bool { return len(b.wakes(t)) >= len(want) })
	time.Sleep(wakeCoalesce + time.Second) // and no more
	if got := b.wakes(t); !slices.Equal(got, want) {
		t.Errorf("wakes %q, want %q", got, want)
	}
}

func TestHeadlessWakeUps(t *testing.T) {
	t.Run("a worker that finishes after 10 s: one wake-up, one task", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		w := worker(t, b, "idle", func(w *fakeherdr.World, pane string) {
			w.Set(pane, "working")
			time.Sleep(11 * time.Second)
			w.Set(pane, "done")
		})
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.waitWakes(t, "[yoicks] w1: working → done")
		if n := len(w.Prompts()); n != 1 {
			t.Errorf("%d prompts", n)
		}
	})
	t.Run("at once, and blocked then done", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		worker(t, b, "idle", func(w *fakeherdr.World, pane string) {
			w.Set(pane, "working")
			w.Set(pane, "done")
		})
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.waitWakes(t, "[yoicks] w1: working → done")

		b.world.OnPrompt(func(pane, text string) {
			b.world.Set(pane, "working")
			time.Sleep(300 * time.Millisecond)
			b.world.Set(pane, "blocked")
			time.Sleep(4 * time.Second) // the user answers in its pane
			b.world.Set(pane, "working")
			time.Sleep(300 * time.Millisecond)
			b.world.Set(pane, "done")
		})
		b.prompt(t)
		b.waitWakes(t, "[yoicks] w1: working → done", "[yoicks] w1: working → blocked", "[yoicks] w1: working → done")
	})
	t.Run("blocked at its start: the task isn't sent, a wake-up once it is ready", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		w := worker(t, b, "blocked", nil)
		w.SetReady("w1p", false)
		b.start(t)
		b.waitStatus(t, "idle")
		b.send(t, `call agent_prompt {"name":"w1","text":"do the thing"}`)
		b.waitStatus(t, "done")
		_, tr, _ := b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
		if !strings.Contains(tr, "task not sent") {
			t.Fatalf("the tool's result: %s", tr)
		}
		w.SetReady("w1p", true)
		w.Set("w1p", "idle") // the user answered the folder-trust question
		b.waitWakes(t, "[yoicks] w1: ready, task not sent")
		if n := len(w.Prompts()); n != 0 {
			t.Errorf("%d prompts", n)
		}
	})
	t.Run("a stalled prompt goes on with the level wait", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		w := worker(t, b, "idle", func(w *fakeherdr.World, pane string) {
			time.Sleep(time.Second) // later than the stall
			w.Set(pane, "working")
			w.Set(pane, "done")
		})
		w.StallAfter(300 * time.Millisecond)
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.waitWakes(t, "[yoicks] w1: working → done")
	})
	t.Run("re-armed after a bridge restart: a change meanwhile wakes once", func(t *testing.T) {
		state := t.TempDir()
		b := startHeadless(t, state, nil, nil)
		w := worker(t, b, "idle", func(w *fakeherdr.World, pane string) { w.Set(pane, "working") })
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.srv.shutdownHeadless()
		saved, _ := os.ReadFile(headlessPath(state, "h1", ".json"))
		if !strings.Contains(string(saved), `"pane":"w1p"`) {
			t.Fatalf("saved %s", saved)
		}
		w.Set("w1p", "done") // while no bridge runs

		b2 := startHeadless(t, state, nil, nil) // another herdr world: the worker there, done
		b2.world.Add(fakeherdr.Pane{ID: "w1p", Tab: "t9", Workspace: "w1", Agent: "claude", Status: "working", Name: "w1"})
		b2.world.Set("w1p", "done") // a state_change_seq of its own (herdr counts again from its start)
		b2.srv.startHeadless()
		b2.waitWakes(t, "[yoicks] w1: working → done")
	})
	t.Run("no wake-up for a replay of the state already told (a reconnect, a re-arm)", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		worker(t, b, "idle", func(w *fakeherdr.World, pane string) {
			w.Set(pane, "working")
			w.Set(pane, "done")
		})
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.waitWakes(t, "[yoicks] w1: working → done")
		// a watch saved at that done answers at once with the same seq: it waits on, quiet
		raw, _ := b.srv.rpc("agent.get", map[string]any{"target": "w1p"})
		status, seq, _ := agentState(raw)
		b.srv.headless["h1"].watch(&hlWatch{Pane: "w1p", Name: "w1", Status: status, Seq: seq}, "", nil)
		b.srv.client.Refresh() // a reconnect's fresh snapshot
		b.waitWakes(t, "[yoicks] w1: working → done")
	})
}

// A headless orchestrator's done and blocked go out like an agent's: WS agent_status for
// hl:<name>, and the PC's notification (never for wc- names).
func TestHeadlessNotifications(t *testing.T) {
	for _, name := range []string{"h1", "wc-h1"} {
		t.Setenv("HLNAME", name)
		b := startHeadless(t, t.TempDir(), nil, nil)
		c, _, err := b.dial(t, nil)
		if err != nil {
			t.Fatal(err)
		}
		b.start(t)
		b.waitStatus(t, "idle")
		b.send(t, "hello")
		b.waitStatus(t, "done")
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		got := false
		for !got {
			_, data, err := c.Read(ctx)
			if err != nil {
				break
			}
			var m WsAgentStatusMessage
			got = json.Unmarshal(data, &m) == nil && m.Type == "agent_status" && m.PaneID == "hl:"+name && m.From == "working" && m.To == "done" &&
				m.WorkspaceLabel != nil && *m.WorkspaceLabel == "H1"
		}
		cancel()
		c.Close(websocket.StatusNormalClosure, "")
		if !got {
			t.Errorf("%s: no agent_status", name)
		}
		time.Sleep(200 * time.Millisecond)
		if shown := len(b.world.Notifications()); (shown > 0) != (name == "h1") {
			t.Errorf("%s: %d notifications", name, shown)
		}
	}
}

// An AskUserQuestion that never reaches approve: the Home is told (r6).
func TestHeadlessQuestionNotReachingTheHome(t *testing.T) {
	old := askReachWait
	askReachWait = 300 * time.Millisecond
	t.Cleanup(func() { askReachWait = old })
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "ask") // through approve: no warning
	v := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	time.Sleep(600 * time.Millisecond)
	b.post(t, "answer", `{"id":"`+v.Headless.Pending.ID+`","answers":{"Which fruit?":"apple"}}`)
	b.waitStatus(t, "done")
	if v := b.view(t); hasWarning(v, "question_route") {
		t.Fatalf("a question that reached approve: %+v", v.Headless.Warnings)
	}
	b.send(t, "asknoroute")
	v = b.waitFor(t, "the warning", func(v OrchestratorView) bool { return hasWarning(v, "question_route") })
	for _, w := range v.Headless.Warnings {
		if w.Kind == "question_route" && !slices.Equal(w.Actions, []string{"interrupt"}) {
			t.Errorf("actions %v", w.Actions)
		}
	}
}
