package bridge

// The headless orchestrator's MCP server (mcp.go) through fakeclaude, which calls it as
// Claude Code does, and the wake-ups against fakeherdr's agent waits.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
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

// bearer is h's current child's bearer.
func bearer(h *headlessRunner) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.mcpBearer
}

func TestMCPListener(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	h := b.srv.headless["h1"]
	if !strings.HasPrefix(h.mcpURL, "http://127.0.0.1:") {
		t.Fatalf("url %s", h.mcpURL)
	}
	if bearer(h) != "" {
		t.Fatal("a bearer before any child")
	}
	b.start(t)
	b.waitStatus(t, "idle")
	for _, bearer := range []string{"", "wrong", strings.Repeat("0", len(bearer(h)))} {
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
		cs, err := mcpClient(t, h.mcpURL, bearer(h))
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
	// the child's mcp.json: 0600, the bridge's server and that child's bearer
	path := headlessPath(b.srv.cfg.StateDir, "h1", ".mcp.json")
	if st, err := os.Stat(path); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("%s: %v %v", path, st, err)
	}
	if got, _ := os.ReadFile(path); !strings.Contains(string(got), bearer(h)) || !strings.Contains(string(got), h.mcpURL) {
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

	// what it said before asking shows while the question waits (narration, as Claude Code writes it)
	b.send(t, "ask 2")
	v = b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	if q := v.Headless.Pending.Questions; len(q) != 2 || q[1].Question != "Size?" {
		t.Fatalf("questions %+v", q)
	}
	var chat struct{ Items []TimelineItem }
	_, tr, _ = b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
	json.Unmarshal([]byte(tr), &chat)
	if n := len(chat.Items); n < 2 || chat.Items[n-2].Kind != "assistant" || chat.Items[n-2].Text != "Before you pick: apple is sweet, cherry is sour." ||
		chat.Items[n-1].Name != "AskUserQuestion" {
		t.Errorf("the chat while it asks: %s", tr)
	}
	// Chat about this: refused with Claude Code's words, the answers so far in them
	for _, body := range []string{`{"id":"x","chat":true,"deny":"no"}`, `{"id":"x","chat":true,"answers":{"a":1}}`, `{"id":"x","chat":true,"answers":"a"}`, `{"chat":true}`, `{"id":"x"}`} {
		if status, out := b.post(t, "answer", body); status != 400 {
			t.Errorf("%s: %d %s", body, status, out)
		}
	}
	if status, body := b.post(t, "answer", `{"id":"`+v.Headless.Pending.ID+`","chat":true,"answers":{"Which fruit?":"apple"}}`); status != 200 {
		t.Fatalf("chat: %d %s", status, body)
	}
	b.waitFor(t, "the turn's end", func(v OrchestratorView) bool { return v.Headless.Status == "done" && v.Headless.Pending == nil })
	_, tr, _ = b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
	chat.Items = nil
	json.Unmarshal([]byte(tr), &chat)
	refused := chat.Items[len(chat.Items)-2] // then the fake's reply
	if refused.Kind != "tool_result" || !refused.IsError || refused.Text != clarify(v.Headless.Pending.Questions, map[string]any{"Which fruit?": "apple"}) {
		t.Errorf("the tool_result: %s", tr)
	}

	// a message while a question waits is about it, not its answer (that is the panel's Type
	// something.): it is written, then the question refused as Chat about this
	b.send(t, "ask 2")
	b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	if status, out := b.post(t, "send", `{"text":"x","answers":["cherry"]}`); status != 400 {
		t.Errorf("answers not question → label: %d %s", status, out)
	}
	if status, out := b.post(t, "send", `{"text":"what is cherry?","answers":{"Which fruit?":"cherry"}}`); status != 200 { // the panel's so far
		t.Fatalf("send: %d %s", status, out)
	}
	b.waitStdin(t, `"content":"what is cherry?"`)
	waitUntil(t, 5*time.Second, "its reply", func() bool { // the fake takes it as the next turn, Claude Code at the refusal
		_, tr, _ = b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
		return strings.Contains(tr, `"text":"echo: what is cherry?"`)
	})
	b.waitFor(t, "no question", func(v OrchestratorView) bool { return v.Headless.Status == "done" && v.Headless.Pending == nil })
	if strings.Count(tr, `The user wants to clarify these questions.`) != 2 || !strings.Contains(tr, `Answer: cherry`) || strings.Contains(tr, `\"answers\":{\"Size?\"`) ||
		!strings.Contains(tr, `"text":"echo: what is cherry?"`) {
		t.Errorf("the tool_result: %s", tr)
	}

	// an interrupt cancels the call and the question
	b.send(t, "ask")
	b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	var status int
	var body string
	b.gate.during(func() { status, body = b.post(t, "interrupt", "") }) // the refusal at a model's pace
	if status != 200 {
		t.Fatalf("interrupt: %d %s", status, body)
	}
	b.waitFor(t, "no question", func(v OrchestratorView) bool { return v.Headless.Pending == nil && v.Headless.Status == "idle" })
}

// A message written while a question is on its way (in the stream, not at approve yet) would wait
// in Claude Code's queue behind it: the question is refused as it arrives, as Chat about this, and
// a later one isn't.
func TestHeadlessSendBehindAQuestion(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	h := b.srv.headless[b.name]
	b.send(t, "askhold")
	waitUntil(t, 5*time.Second, "the question in the stream", func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return len(h.asks) == 1
	})
	if status, out := b.post(t, "send", `{"text":"and this?","answers":{"Which fruit?":"apple"}}`); status != 200 {
		t.Fatalf("send: %d %s", status, out)
	}
	b.waitStdin(t, `"content":"and this?"`)
	b.release(t)
	var tr string
	waitUntil(t, 5*time.Second, "the refusal", func() bool {
		_, tr, _ = b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil)
		return strings.Contains(tr, `"text":"echo: and this?"`)
	})
	if !strings.Contains(tr, `The user wants to clarify these questions.`) || !strings.Contains(tr, `Answer: apple`) {
		t.Errorf("the tool_result: %s", tr)
	}
	b.send(t, "ask") // a later question waits for the user
	b.waitFor(t, "the next question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
}

// The approve call stays open past Claude Code's 60 s with progress.
func TestHeadlessApproveSendsProgress(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "ask")
	v := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	for n := 1; n <= 5; n++ {
		b.pass(t, "the held approve", approveProgress)
		waitUntil(t, 5*time.Second, "progress", func() bool {
			f, _ := os.ReadFile(b.log)
			return strings.Count(string(f), `"progress"`) >= n
		})
	}
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

func TestHeadlessRulesSections(t *testing.T) {
	// the headless rules are their section of the bundled ones (a changed rules.md needs no Clear:
	// a resumed session reads the new one at its start, checked live with Claude Code 2.1.322)
	rules, _ := os.ReadFile(filepath.Join("..", "..", "orchestrator", "rules.md"))
	hl, tui := rulesFor(string(rules), "headless"), rulesFor(string(rules), "tui")
	if !strings.Contains(hl, "agent_prompt") || strings.Contains(hl, "{{yoicks}}") || strings.Contains(hl, "<!--") ||
		!strings.Contains(tui, "{{yoicks}}") || strings.Contains(tui, "agent_prompt") || strings.Contains(tui, "<!--") {
		t.Error("rulesFor's sections")
	}
	// the PR watch's parts: only for a headless Home with pr_watch
	pr := orchestratorFiles(OrchestratorDef{Name: "p", Mode: "headless", PRWatch: true}, string(rules), "yoicks")["rules.md"]
	if strings.Contains(hl, "[yoicks] PR") || !strings.Contains(pr, "`[yoicks] PR merged: <url>") || strings.Contains(pr, "<!--") ||
		strings.Contains(rulesFor(string(rules), "tui", "pr-watch"), "[yoicks] PR") || len(pr) <= len(hl) {
		t.Error("rulesFor's pr-watch sections")
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

// wakes is the [yoicks] lines about w1 the orchestrator got.
func (b *hlBridge) wakes(t *testing.T) []string { return b.wakesWith(t, "[yoicks] w1") }

// wakesWith is the lines starting with prefix the orchestrator got.
func (b *hlBridge) wakesWith(t *testing.T, prefix string) []string {
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
			if strings.HasPrefix(line, prefix) {
				out = append(out, line)
			}
		}
	}
	return out
}

// prompt has the orchestrator send w1 a task; once herdr has it, the delivery window passes
// (a worker still at it is told delivered then; one done sooner was told at once).
func (b *hlBridge) prompt(t *testing.T) {
	t.Helper()
	n := len(b.world.Prompts())
	b.send(t, `call agent_prompt {"name":"w1","text":"do the thing"}`)
	waitUntil(t, 10*time.Second, "w1 gets the task", func() bool { return len(b.world.Prompts()) > n })
	b.clock.Advance(deliveryWindow)
	b.waitStatus(t, "done")
	_, tr, _ := b.do(t, "GET", "/api/panes/hl:"+b.name+"/transcript", b.token, nil)
	if !strings.Contains(tr, "delivered to w1") || strings.Contains(tr, "not delivered") {
		t.Fatalf("the tool's result: %s", tr)
	}
}

// waitWakes: the wake-ups are written, each once its coalescing window has passed, and
// nothing more is queued, nor written once another window has passed.
func (b *hlBridge) waitWakes(t *testing.T, want ...string) {
	t.Helper()
	h := b.srv.headless[b.name]
	waitUntil(t, 10*time.Second, "the wake-ups", func() bool {
		h.mu.Lock()
		queued := h.wakeTimer != nil
		h.mu.Unlock()
		if queued {
			b.clock.Advance(wakeCoalesce)
		}
		return len(b.wakes(t)) >= len(want)
	})
	h.mu.Lock()
	left := slices.Clone(h.wakes)
	h.mu.Unlock()
	b.clock.Advance(wakeCoalesce + time.Second)
	if got := b.wakes(t); !slices.Equal(got, want) || len(left) != 0 {
		t.Errorf("wakes %q (still queued %q), want %q", got, left, want)
	}
}

// watching waits until w1's watch has seen it at status: what a next change is told from.
func (b *hlBridge) watching(t *testing.T, status string) {
	t.Helper()
	h := b.srv.headless[b.name]
	waitUntil(t, 10*time.Second, "w1 watched at "+status, func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return h.watches["w1p"] != nil && h.watches["w1p"].Status == status
	})
}

// watches is the number of workers the orchestrator follows.
func (b *hlBridge) watches() int {
	h := b.srv.headless[b.name]
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.watches)
}

// queued waits until a wake-up is queued (its window not passed yet).
func (b *hlBridge) queued(t *testing.T) {
	t.Helper()
	h := b.srv.headless[b.name]
	waitUntil(t, 10*time.Second, "a wake-up queued", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.wakes) > 0 })
}

func TestHeadlessWakeUps(t *testing.T) {
	needsAccounts(t)
	// (that herdr's wait outlasts the request timeout: TestHerdrWaitHasNoDeadline)
	t.Run("a worker that finishes after 10 s: one wake-up, one task", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		w := worker(t, b, "idle", nil)
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)             // delivered as the window ends
		w.Set("w1p", "working") // it takes the task up (within herdr's stall time)
		b.clock.Advance(10 * time.Second)
		w.Set("w1p", "done")
		b.waitWakes(t, "[yoicks] w1: working → done")
		if n := len(w.Prompts()); n != 1 || b.watches() != 0 {
			t.Errorf("%d prompts, %d watches", n, b.watches())
		}
	})
	t.Run("at once, and blocked then done", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		w := worker(t, b, "idle", func(w *fakeherdr.World, pane string) {
			w.Set(pane, "working")
			w.Set(pane, "done")
		})
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.waitWakes(t, "[yoicks] w1: working → done")

		w.OnPrompt(func(pane, text string) {
			w.Set(pane, "working")
			w.Set(pane, "blocked")
		})
		b.prompt(t)
		b.waitWakes(t, "[yoicks] w1: working → done", "[yoicks] w1: working → blocked")
		w.Set("w1p", "working") // the user answers in its pane
		b.watching(t, "working")
		w.Set("w1p", "done")
		b.waitWakes(t, "[yoicks] w1: working → done", "[yoicks] w1: working → blocked", "[yoicks] w1: working → done")
		if b.watches() != 0 {
			t.Errorf("%d watches", b.watches())
		}
	})
	for _, ready := range []bool{false, true} {
		// herdr answers agent_not_ready while a startup question holds it, agent_blocked at a dialog
		// (the folder-trust one of a worker in a new dir, as the pilot met)
		t.Run(fmt.Sprintf("blocked at its start (interactive %v): the task isn't sent, a wake-up once it is ready", ready), func(t *testing.T) {
			blockedAtStart(t, ready)
		})
	}
	t.Run("blocked in a task of its own: once answered it is followed, its next question wakes too", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		w := worker(t, b, "blocked", nil)
		b.start(t)
		b.waitStatus(t, "idle")
		b.send(t, `call agent_prompt {"name":"w1","text":"do the thing"}`)
		b.waitStatus(t, "done")
		w.Set("w1p", "working") // the user answered its permission question: it works on
		b.watching(t, "working")
		w.Set("w1p", "blocked") // and asks another
		b.waitWakes(t, "[yoicks] w1: working → blocked")
		w.Set("w1p", "working")
		b.watching(t, "working")
		w.Set("w1p", "done")
		// its own task's end: the orchestrator's task still waits to be sent
		b.waitWakes(t, "[yoicks] w1: working → blocked", "[yoicks] w1: working → done, ready, task not sent")
		if n := len(w.Prompts()); n != 0 || b.watches() != 0 {
			t.Errorf("%d prompts, %d watches", n, b.watches())
		}
	})
	t.Run("a stalled prompt goes on with the level wait", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		w := worker(t, b, "idle", nil)
		w.StallAfter(300 * time.Millisecond)
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t) // the delivery window passes the stall: herdr answers stalled
		// the level wait finds it idle as before: it waits for a move
		b.waiting(t, "the wait for a move", 8*time.Second)
		w.Set("w1p", "working") // later than the stall
		w.Set("w1p", "done")
		b.pass(t, "the pause before it looks again", 500*time.Millisecond)
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
		h := b.srv.headless["h1"]
		h.mu.Lock()
		epoch := h.epoch
		h.mu.Unlock()
		if !h.watch(&hlWatch{Pane: "w1p", Name: "w1", Status: status, Seq: seq}, "", nil, epoch) {
			t.Fatal("not watched")
		}
		b.srv.client.Refresh() // a reconnect's fresh snapshot
		for range 2 {          // each look finds it as told: it waits on for a move
			b.pass(t, "the wait for a move", 8*time.Second)
			b.pass(t, "the pause before it looks again", 500*time.Millisecond)
		}
		b.waiting(t, "the wait for a move", 8*time.Second) // again
		b.waitWakes(t, "[yoicks] w1: working → done")
		if b.watches() != 1 {
			t.Errorf("%d watches", b.watches())
		}
	})
}

// A headless orchestrator's done and blocked go out like an agent's: WS agent_status for
// hl:<name>, and the PC's notification (never for wc- names).
func TestHeadlessNotifications(t *testing.T) {
	for _, name := range []string{"h1", "wc-h1"} {
		t.Setenv("HLNAME", name)
		b := startHeadless(t, t.TempDir(), nil, nil)
		// the server's own callback, then a word that it has returned (any notification begun)
		h := b.srv.headless[name]
		told, onStatus := make(chan string, 4), h.onStatus
		h.onStatus = func(from, to string) { onStatus(from, to); told <- from + " → " + to }
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
		select {
		case s := <-told:
			if s != "working → done" {
				t.Errorf("%s: told %q", name, s)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: the status callback never ran", name)
		}
		b.srv.bg.Wait() // the PC notifications it began, shown
		if shown := len(b.world.Notifications()); (shown > 0) != (name == "h1") {
			t.Errorf("%s: %d notifications", name, shown)
		}
	}
}

// An AskUserQuestion that never reaches approve: the Home is told (r6).
func TestHeadlessQuestionNotReachingTheHome(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, "ask") // through approve: no warning
	v := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil })
	b.pass(t, "the question check", askReachWait) // it runs before Advance returns
	if v := b.view(t); hasWarning(v, "question_route") {
		t.Fatalf("a question that reached approve: %+v", v.Headless.Warnings)
	}
	b.post(t, "answer", `{"id":"`+v.Headless.Pending.ID+`","answers":{"Which fruit?":"apple"}}`)
	b.waitStatus(t, "done")
	b.send(t, "asknoroute")
	b.waitStatus(t, "done")
	if v := b.view(t); hasWarning(v, "question_route") {
		t.Fatalf("before its check: %+v", v.Headless.Warnings)
	}
	b.pass(t, "the question check", askReachWait)
	v = b.view(t)
	if !hasWarning(v, "question_route") {
		t.Fatalf("no warning: %+v", v.Headless.Warnings)
	}
	for _, w := range v.Headless.Warnings {
		if w.Kind == "question_route" && !slices.Equal(w.Actions, []string{"interrupt"}) {
			t.Errorf("actions %v", w.Actions)
		}
	}
}

// agent_prompt with nothing to send answers an error at once (and watches nothing).
func TestHeadlessPromptNeedsText(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	cs, err := mcpClient(t, b.srv.headless["h1"].mcpURL, bearer(b.srv.headless["h1"]))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, text := range []string{"", "  \n"} {
		res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "agent_prompt", Arguments: map[string]any{"name": "w1", "text": text}})
		if err != nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "non-empty") {
			t.Errorf("%q: %v %+v", text, err, res)
		}
	}
	h := b.srv.headless["h1"]
	h.mu.Lock()
	defer h.mu.Unlock()
	if n := len(h.watches); n != 0 {
		t.Errorf("%d watches", n)
	}
}

// A wake-up the child can't take (down, or the bridge restarting, before the coalesced
// write) waits, saved, for its next start.
func TestHeadlessWakeWaitsForTheChild(t *testing.T) {
	needsAccounts(t)
	script := func(w *fakeherdr.World, pane string) {
		w.Set(pane, "working")
		w.Set(pane, "done")
	}
	t.Run("a child down when the timer fires gets it once restarted", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) { h.restartDelays = []time.Duration{6 * time.Second} })
		worker(t, b, "idle", script)
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.queued(t) // the worker is done: its wake-up queued, not written yet
		b.send(t, "crash")
		b.waitFor(t, "the child down", func(v OrchestratorView) bool { return v.PaneID == nil })
		b.clock.Advance(wakeCoalesce + time.Second) // past the 3 s timer, within the 6 s down
		if got := b.wakes(t); len(got) != 0 {
			t.Fatalf("written with no child: %q", got)
		}
		b.restartDue()
		b.waitWakes(t, "[yoicks] w1: working → done")
	})
	t.Run("a Stop drops the queue with the watches; the timer then writes nothing", func(t *testing.T) {
		b := startHeadless(t, t.TempDir(), nil, nil)
		worker(t, b, "idle", script)
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.queued(t)
		b.post(t, "stop", "")
		b.start(t)
		b.waitStatus(t, "idle")
		b.clock.Advance(wakeCoalesce + time.Second)
		if got := b.wakes(t); len(got) != 0 {
			t.Errorf("wakes %q", got)
		}
		if v := b.view(t); v.Headless.Status != "idle" {
			t.Errorf("status %s: something was written", v.Headless.Status)
		}
	})
	t.Run("across a bridge restart", func(t *testing.T) {
		state := t.TempDir()
		b := startHeadless(t, state, nil, nil)
		worker(t, b, "idle", script)
		b.start(t)
		b.waitStatus(t, "idle")
		b.prompt(t)
		b.queued(t)
		b.srv.shutdownHeadless()
		b.clock.Advance(wakeCoalesce + time.Second) // its timer finds no child
		if saved, _ := os.ReadFile(headlessPath(state, "h1", ".json")); !strings.Contains(string(saved), `"wakes":["[yoicks] w1: working → done"]`) {
			t.Fatalf("saved %s", saved)
		}
		b2 := startHeadless(t, state, nil, nil)
		b2.srv.startHeadless()
		b2.waitWakes(t, "[yoicks] w1: working → done")
		if saved, _ := os.ReadFile(headlessPath(state, "h1", ".json")); strings.Contains(string(saved), "wakes") {
			t.Errorf("still saved after the write: %s", saved)
		}
	})
}

// The saved watches stay saved until the child has started and each is re-armed: a start
// refused on the way keeps them.
func TestHeadlessSavedWatchesOutliveARefusedStart(t *testing.T) {
	fakeClaudeEnv(t)
	state := t.TempDir()
	os.MkdirAll(filepath.Join(state, "headless"), 0o700)
	saved := `{"sessionId":"` + newUUID() + `","wanted":true,"watches":[{"pane":"w1p","name":"w1","cwd":"","status":"working","seq":7,"startup":false}]}`
	os.WriteFile(headlessPath(state, "h1", ".json"), []byte(saved), 0o600)
	t.Setenv("FAKECLAUDE_AUTH", "api_key")
	b := startHeadless(t, state, nil, nil)
	if status, _ := b.post(t, "start", ""); status != 409 {
		t.Fatalf("start: %d", status)
	}
	h0 := b.srv.headless["h1"] // anything saved meanwhile (a spawn failing, the bridge ending) keeps them
	h0.mu.Lock()
	h0.persist()
	h0.mu.Unlock()
	if got, _ := os.ReadFile(headlessPath(state, "h1", ".json")); !strings.Contains(string(got), `"pane":"w1p"`) {
		t.Fatalf("lost: %s", got)
	}
	t.Setenv("FAKECLAUDE_AUTH", "claude.ai/max")
	b2 := startHeadless(t, state, nil, nil)
	b2.world.Add(fakeherdr.Pane{ID: "w1p", Tab: "t9", Workspace: "w1", Agent: "claude", Status: "working", Name: "w1"})
	b2.start(t)
	h := b2.srv.headless["h1"]
	waitUntil(t, 5*time.Second, "re-armed", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return h.watches["w1p"] != nil && len(h.saved) == 0 })
	if got, _ := os.ReadFile(headlessPath(state, "h1", ".json")); !strings.Contains(string(got), `"pane":"w1p"`) {
		t.Errorf("not saved once running: %s", got)
	}
}

// Clear forgets its workers for good: the wake-up queued for the old session never reaches the
// fresh one (its timer finds a new generation), and the cleared state is saved before the
// start, so a refused start (and a bridge restart then) can't bring the old watches back.
func TestHeadlessClearForgetsWorkers(t *testing.T) {
	needsAccounts(t)
	state := t.TempDir()
	b := startHeadless(t, state, nil, nil)
	worker(t, b, "idle", func(w *fakeherdr.World, pane string) {
		w.Set(pane, "working")
		w.Set(pane, "done")
	})
	b.start(t)
	b.waitStatus(t, "idle")
	b.prompt(t)
	b.queued(t) // not written yet
	saved, _ := os.ReadFile(headlessPath(state, "h1", ".json"))
	if !strings.Contains(string(saved), `"wakes":["[yoicks] w1: working → done"]`) || strings.Contains(string(saved), `"pane":"w1p"`) {
		t.Fatalf("the wake-up and the watch's end, saved together: %s", saved)
	}
	// a Clear whose start is refused (a settings file with an API key helper)
	settings := filepath.Join(b.home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settings), 0o700)
	os.WriteFile(settings, []byte(`{"apiKeyHelper":"/bin/key"}`), 0o600)
	if status, body := b.post(t, "clear", ""); status != 409 {
		t.Fatalf("clear: %d %s", status, body)
	}
	saved, _ = os.ReadFile(headlessPath(state, "h1", ".json"))
	if !strings.Contains(string(saved), `"sessionId":""`) || strings.Contains(string(saved), "wakes") || strings.Contains(string(saved), "w1p") {
		t.Fatalf("after the refused clear: %s", saved)
	}
	os.Remove(settings)
	b.start(t)
	b.waitStatus(t, "idle")
	b.clock.Advance(wakeCoalesce + time.Second)
	if got := b.wakes(t); len(got) != 0 {
		t.Errorf("the old session's wake-up reached the fresh one: %q", got)
	}
	if v := b.view(t); v.Headless.Status != "idle" {
		t.Errorf("status %s: something was written to the fresh child", v.Headless.Status)
	}
	// idle comes at the spawn, before the child has logged its argv
	var runs []procArgs
	waitUntil(t, 5*time.Second, "the second run", func() bool { runs, _ = b.runs(t); return len(runs) == 2 })
	if last := runs[len(runs)-1].argv; last[6] != "--session-id" || last[7] == runs[0].argv[7] {
		t.Errorf("not a fresh session: %v", last)
	}
}

// agent_start with a blank task starts the worker and sends it nothing.
func TestHeadlessStartWithABlankTask(t *testing.T) {
	needsAccounts(t)
	var calls []string
	var mu sync.Mutex
	b := startHeadless(t, t.TempDir(), nil, nil)
	standIn := exec.Command("sleep", "600")
	standIn.Env = []string{"HOME=" + b.home, "PATH=" + os.Getenv("PATH")}
	if err := standIn.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { standIn.Process.Kill(); standIn.Wait() })
	h := b.srv.headless["h1"]
	h.slowRPC = func(method string, params map[string]any) (json.RawMessage, error) { // herdr for the start
		mu.Lock()
		calls = append(calls, method)
		mu.Unlock()
		switch method {
		case "session.snapshot":
			return json.RawMessage(`{"snapshot":{"workspaces":[],"panes":[]}}`), nil
		case "workspace.create":
			return json.RawMessage(`{"root_pane":{"pane_id":"n1"}}`), nil
		case "agent.start", "agent.get":
			return json.RawMessage(`{"agent":{"pane_id":"n1","agent":"claude"}}`), nil
		case "pane.process_info":
			return json.RawMessage(fmt.Sprintf(`{"process_info":{"shell_pid":1,"foreground_process_group_id":%d}}`, standIn.Process.Pid)), nil
		}
		return json.RawMessage(`{}`), nil
	}
	b.start(t)
	b.waitStatus(t, "idle")
	cs, err := mcpClient(t, h.mcpURL, bearer(h))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "agent_start", Arguments: map[string]any{"name": "w-x", "cwd": t.TempDir(), "task": "  \n"}})
	if err != nil || res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "started w-x") || strings.Contains(res.Content[0].(*mcp.TextContent).Text, "deliver") {
		t.Fatalf("%v %+v", err, res)
	}
	mu.Lock()
	defer mu.Unlock()
	if slices.Contains(calls, "agent.prompt") || !slices.Contains(calls, "agent.start") || slices.ContainsFunc(b.fake.Requests(), func(r fakeherdr.Request) bool { return r.Method == "agent.prompt" }) {
		t.Errorf("calls %v", calls)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.watches) != 0 {
		t.Errorf("%d watches", len(h.watches))
	}
}

// A tool call is bound to the child it came from: one in flight across a Clear makes no
// watch (its worker gets nothing), and that child's bearer reaches nothing after.
func TestHeadlessCallAcrossAClear(t *testing.T) {
	needsAccounts(t)
	b := startHeadless(t, t.TempDir(), nil, nil)
	h := b.srv.headless["h1"]
	worker(t, b, "idle", nil)
	entered, release := make(chan struct{}), make(chan struct{})
	var gate sync.Once
	rpc := h.rpc
	h.rpc = func(method string, params map[string]any) (json.RawMessage, error) {
		if method == "agent.get" && params["target"] == "w1" {
			gate.Do(func() { close(entered); <-release }) // the tool's agent lookup, held
		}
		return rpc(method, params)
	}
	b.start(t)
	b.waitStatus(t, "idle")
	old := bearer(h)
	cs, err := mcpClient(t, h.mcpURL, old)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result := make(chan *mcp.CallToolResult, 1)
	go func() {
		res, _ := cs.CallTool(ctx, &mcp.CallToolParams{Name: "agent_prompt", Arguments: map[string]any{"name": "w1", "text": "do the thing"}})
		result <- res
	}()
	<-entered
	if status, body := b.post(t, "clear", ""); status != 200 {
		t.Fatalf("clear: %d %s", status, body)
	}
	b.waitStatus(t, "idle")
	close(release)
	res := <-result
	if res == nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "stopped or cleared") {
		t.Fatalf("the call from before the Clear: %+v", res)
	}
	// a watch is registered before its worker is sent anything, and herdr counts a prompt as it
	// takes it: none of either by the call's answer, none ever
	if watches, prompts := b.watches(), len(b.world.Prompts()); watches != 0 || prompts != 0 {
		t.Errorf("a watch survived the Clear (%d), the worker prompted %d times", watches, prompts)
	}
	if now := bearer(h); now == "" || now == old {
		t.Errorf("the fresh child's bearer: %q", now)
	}
	if _, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "overview"}); err == nil {
		t.Error("the old child's session still answered")
	}
	if _, err := mcpClient(t, h.mcpURL, old); err == nil {
		t.Error("the old bearer still connects")
	}
}

// A saved watch that settles as soon as it is re-armed leaves no saved copy for a later
// save to write back (a bridge stop then would bring back the watch beside its wake-up).
func TestHeadlessRearmedWatchLeavesNoSavedCopy(t *testing.T) {
	state := t.TempDir()
	b := startHeadless(t, state, nil, nil)
	b.world.Add(fakeherdr.Pane{ID: "w1p", Tab: "t9", Workspace: "w1", Agent: "claude", Status: "done", Name: "w1"})
	h := b.srv.headless["h1"]
	saved := hlWatch{Pane: "w1p", Name: "w1", Status: "working", Seq: 7}
	h.mu.Lock()
	h.saved, h.wanted = []hlWatch{saved}, true
	gen := h.gen
	h.mu.Unlock()
	h.watch(&saved, "", nil, gen) // as rearm does
	waitUntil(t, 5*time.Second, "settled", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return len(h.watches) == 0 && len(h.wakes) == 1 })
	h.mu.Lock()
	h.persist() // any later save, a bridge stop's say
	h.mu.Unlock()
	got, _ := os.ReadFile(headlessPath(state, "h1", ".json"))
	if !strings.Contains(string(got), "w1: working → done") || strings.Contains(string(got), `"pane":"w1p"`) {
		t.Errorf("saved: %s", got)
	}
}

// restarted crashes the child and waits for its automatic restart to come up.
func (b *hlBridge) restarted(t *testing.T) {
	t.Helper()
	b.send(t, "crash")
	waitUntil(t, 10*time.Second, "the restart", b.restartDue) // the crash seen, its delay passed: started again
	b.waitFor(t, "the new child up", func(v OrchestratorView) bool { return v.Headless.Status == "idle" || v.Headless.Status == "done" })
}

// A call from a child replaced by an automatic restart registers nothing: its agent_prompt,
// held in its agent lookup across the restart, makes no watch and sends the worker nothing,
// while the watch from before the crash lives on.
func TestHeadlessCallAcrossARestart(t *testing.T) {
	needsAccounts(t)
	b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) { h.restartDelays = []time.Duration{100 * time.Millisecond} })
	h := b.srv.headless["h1"]
	w := worker(t, b, "idle", func(w *fakeherdr.World, pane string) { w.Set(pane, "working") })
	var armed atomic.Bool
	entered, release := make(chan struct{}), make(chan struct{})
	var gate sync.Once
	rpc := h.rpc
	h.rpc = func(method string, params map[string]any) (json.RawMessage, error) {
		if method == "agent.get" && params["target"] == "w1" && armed.Load() {
			gate.Do(func() { close(entered); <-release }) // the tool's agent lookup, held
		}
		return rpc(method, params)
	}
	b.start(t)
	b.waitStatus(t, "idle")
	cs, err := mcpClient(t, h.mcpURL, bearer(h))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	call := func() *mcp.CallToolResult {
		res, _ := cs.CallTool(ctx, &mcp.CallToolParams{Name: "agent_prompt", Arguments: map[string]any{"name": "w1", "text": "do the thing"}})
		return res
	}
	first := make(chan *mcp.CallToolResult, 1)
	go func() { first <- call() }()
	waitUntil(t, 10*time.Second, "w1 gets the task", func() bool { return len(w.Prompts()) == 1 })
	b.clock.Advance(deliveryWindow)                // delivered, the worker at it
	if res := <-first; res == nil || res.IsError { // the watch from before: it keeps working
		t.Fatalf("the first prompt: %+v", res)
	}
	h.mu.Lock()
	before := h.watches["w1p"]
	h.mu.Unlock()
	armed.Store(true)
	result := make(chan *mcp.CallToolResult, 1)
	go func() { result <- call() }()
	<-entered
	b.restarted(t)
	close(release)
	res := <-result
	if res == nil || !res.IsError || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, "restarted") {
		t.Fatalf("the call from before the restart: %+v", res)
	}
	// (a watch is registered before its worker is sent anything, and herdr counts a prompt as
	// it takes it: by the call's answer, any would show)
	h.mu.Lock()
	after := h.watches["w1p"]
	h.mu.Unlock()
	if after == nil || after != before || len(w.Prompts()) != 1 {
		t.Errorf("the watch from before replaced (%v), the worker prompted %d times", after != before, len(w.Prompts()))
	}
}

// A question from a child replaced since (a call admitted before a restart that reaches
// approve after it) is denied, and the current child's pending question stays as it was.
func TestHeadlessQuestionFromAReplacedChild(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) { h.restartDelays = []time.Duration{100 * time.Millisecond} })
	h := b.srv.headless["h1"]
	b.start(t)
	b.waitStatus(t, "idle")
	h.mu.Lock()
	old := h.epoch // the first child's, as the middleware gave its calls
	h.mu.Unlock()
	b.restarted(t)
	b.send(t, "ask") // the new child's question
	p := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil }).Headless.Pending
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), epochKey{}, old), 2*time.Second)
	defer cancel() // (taken as the pending question, it would wait for an answer)
	res, _, err := h.approve(ctx, &mcp.CallToolRequest{Params: &mcp.CallToolParamsRaw{}}, approveIn{ToolName: "AskUserQuestion", ToolUseID: "t-old", Input: map[string]any{"questions": []any{}}})
	if err != nil || res == nil || !strings.Contains(res.Content[0].(*mcp.TextContent).Text, `"behavior":"deny"`) {
		t.Fatalf("the old child's question: %v %+v", err, res)
	}
	if v := b.view(t); v.Headless.Pending == nil || v.Headless.Pending.ID != p.ID || v.Headless.Status != "blocked" {
		t.Fatalf("the pending question touched: %+v", v.Headless)
	}
	if status, body := b.post(t, "answer", `{"id":"`+p.ID+`","answers":{"Which fruit?":"apple"}}`); status != 200 {
		t.Fatalf("answer: %d %s", status, body)
	}
	b.waitFor(t, "the turn's end", func(v OrchestratorView) bool { return v.Headless.Status == "done" && v.Headless.Pending == nil })
}

// A turn's question (an MCP call) can be handled before its system/init (a stdout line) is
// read: the late init leaves the orchestrator blocked on that question, not working.
func TestHeadlessQuestionBeforeItsInit(t *testing.T) {
	var hold atomic.Bool
	release, applied := make(chan struct{}), make(chan struct{})
	b := startHeadless(t, t.TempDir(), nil, func(h *headlessRunner) {
		h.lineHook = func(line []byte) {
			switch {
			case !hold.Load():
			case strings.Contains(string(line), `"subtype":"init"`):
				<-release // read only once the question is pending
			case strings.Contains(string(line), `"AskUserQuestion"`):
				hold.Store(false)
				close(applied) // the line after it: the init is applied
			}
		}
	})
	b.start(t)
	b.waitStatus(t, "idle")
	hold.Store(true)
	b.send(t, "ask")
	p := b.waitFor(t, "the question", func(v OrchestratorView) bool { return v.Headless.Pending != nil }).Headless.Pending
	close(release)
	<-applied
	if v := b.view(t); v.Headless.Pending == nil || v.Headless.Pending.ID != p.ID || v.Headless.Status != "blocked" {
		t.Fatalf("after the late init: %+v", v.Headless)
	}
	if status, body := b.post(t, "answer", `{"id":"`+p.ID+`","answers":{"Which fruit?":"apple"}}`); status != 200 {
		t.Fatalf("answer: %d %s", status, body)
	}
	b.waitFor(t, "the turn's end", func(v OrchestratorView) bool { return v.Headless.Status == "done" && v.Headless.Pending == nil })
}

// A child still talking after a Stop or Clear began the next epoch (it hasn't exited yet) asks
// with its own epoch: its stdio question is denied and never becomes the pending one.
func TestHeadlessStdioQuestionFromAChildBeingReplaced(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	h := b.srv.headless["h1"]
	b.start(t)
	b.waitStatus(t, "idle")
	h.mu.Lock()
	h.epoch++ // as a Stop or Clear does before the old child has exited
	h.mu.Unlock()
	b.send(t, "askstdio") // its question comes as a can_use_tool on stdout
	b.waitStdin(t, `this orchestrator's session has ended`)
	if v := b.view(t); v.Headless.Pending != nil || v.Headless.Status == "blocked" {
		t.Fatalf("a question from the child being replaced became pending: %+v", v.Headless)
	}
}

// needsAccounts skips a test whose worker must pass the account check: a pane's Claude account
// is read from /proc (Linux only; macOS's needs sysctl, a CLAUDE.md follow-up).
func needsAccounts(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "linux" {
		t.Skip("a worker's Claude account is read from /proc: Linux only")
	}
}

// A yoicks tool's error result whose call never reached the bridge (it failed in Claude Code:
// its MCP session, the bearer, the transport) warns mcp_call; a call the bridge served and
// answered with an error doesn't.
func TestHeadlessMCPCallFailure(t *testing.T) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	b.start(t)
	b.waitStatus(t, "idle")
	b.send(t, `call agent_get {"name":"nobody"}`)
	b.waitStatus(t, "done")
	if _, tr, _ := b.do(t, "GET", "/api/panes/hl:h1/transcript", b.token, nil); !strings.Contains(tr, `"isError":true`) {
		t.Fatalf("not an error result: %s", tr)
	}
	if v := b.view(t); hasWarning(v, "mcp_call") {
		t.Fatalf("a served call warned: %+v", v.Headless.Warnings)
	}
	b.send(t, "mcpfail")
	v := b.waitFor(t, "the warning", func(v OrchestratorView) bool { return hasWarning(v, "mcp_call") })
	for _, w := range v.Headless.Warnings {
		if w.Kind == "mcp_call" && (w.Message != "overview failed before reaching the bridge (Error calling tool (overview): fake transport failure); Clear to reconnect" ||
			!slices.Equal(w.Actions, []string{"clear"})) {
			t.Errorf("%+v", w)
		}
	}
}

// blockedAtStart: a worker blocked at its start takes no task; the orchestrator is told so and woken
// once the user has answered in its pane.
func blockedAtStart(t *testing.T, ready bool) {
	b := startHeadless(t, t.TempDir(), nil, nil)
	w := worker(t, b, "blocked", nil)
	w.SetReady("w1p", ready)
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
}
