package bridge

// The MCP server a headless orchestrator's child talks to (go-sdk, streamable HTTP): its
// six tools (the CLI's orchestrator commands, as functions), the permission tool approve
// (AskUserQuestion becomes the Home's question; anything else is denied unasked), and the
// wake-ups: each worker it prompts is watched through herdr's waits (S0 row 15: agent.prompt's
// wait is edge, agent.wait level), and a change to done, idle or blocked comes back to it as a
// `[yoicks] <worker>: <from> → <to>` message.
//
// The listener is its own, on 127.0.0.1:0, opened only with a headless entry. Each
// orchestrator has its own bearer (in its mcp.json, 0600), which picks its server; any other
// request is a 401.

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// the tools a headless child may use without asking (approve is the permission tool itself)
var yoicksTools = []string{"overview", "agent_get", "agent_read", "agent_prompt", "agent_start", "worktree_remove"}

// how often a held approve tells the client it waits: under MCP's 60 s call timeout and the
// 300 s HTTP idle limit (S0 row 5; a var for tests)
var approveProgress = 20 * time.Second

// how soon an AskUserQuestion in the stream must reach approve (a var for tests)
var askReachWait = 10 * time.Second

const (
	deliveryWindow = 1500 * time.Millisecond // herdr refusing a prompt answers within it
	wakeCoalesce   = 3 * time.Second
)

// ── the listener ─────────────────────────────────────────────────────────────

type mcpHost struct {
	srv     *http.Server
	servers map[string]*mcp.Server // by bearer
}

// startMCPHost opens the listener and gives each runner its bearer, URL and server.
func startMCPHost(runners map[string]*headlessRunner) (*mcpHost, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	h := &mcpHost{servers: map[string]*mcp.Server{}}
	url := "http://" + ln.Addr().String() + "/mcp"
	for _, r := range runners {
		b := make([]byte, 16)
		rand.Read(b)
		r.mcpURL, r.mcpBearer = url, hex.EncodeToString(b)
		h.servers[r.mcpBearer] = r.mcpServer()
	}
	inner := mcp.NewStreamableHTTPHandler(h.serverFor, nil)
	h.srv = &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if h.serverFor(req) == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		inner.ServeHTTP(w, req)
	})}
	go h.srv.Serve(ln)
	return h, nil
}

// serverFor is the server whose bearer the request carries (nil: none).
func (h *mcpHost) serverFor(req *http.Request) *mcp.Server {
	got, ok := strings.CutPrefix(req.Header.Get("Authorization"), "Bearer ")
	var found *mcp.Server
	for bearer, s := range h.servers {
		if ok && subtle.ConstantTimeCompare([]byte(got), []byte(bearer)) == 1 {
			found = s
		}
	}
	return found
}

func (h *mcpHost) Close() { h.srv.Close() }

// mcpConfig is the child's --mcp-config: the bridge's server, with its bearer.
func (r *headlessRunner) mcpConfig() []byte {
	b, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"yoicks": map[string]any{
		"type": "http", "url": r.mcpURL, "headers": map[string]string{"Authorization": "Bearer " + r.mcpBearer}}}})
	return b
}

// ── the tools ────────────────────────────────────────────────────────────────

type nameIn struct {
	Name string `json:"name" jsonschema:"the agent's name (or pane id)"`
}

type readIn struct {
	Name   string `json:"name" jsonschema:"the agent's name (or pane id)"`
	Source string `json:"source,omitempty" jsonschema:"recent (the default), recent_unwrapped, visible or detection"`
	Lines  int    `json:"lines,omitempty" jsonschema:"how many lines (recent: from the bottom)"`
}

type promptIn struct {
	Name string `json:"name" jsonschema:"the agent's name (or pane id)"`
	Text string `json:"text" jsonschema:"what to send it (/exit ends it)"`
}

type startIn struct {
	Name     string `json:"name" jsonschema:"the new worker's name: w-<short english description>"`
	Cwd      string `json:"cwd" jsonschema:"the directory (repository) it works in"`
	Profile  string `json:"profile,omitempty" jsonschema:"a launch profile (default claude)"`
	Worktree string `json:"worktree,omitempty" jsonschema:"a branch: start it in a new worktree of the repository at cwd"`
	Base     string `json:"base,omitempty" jsonschema:"the worktree's base (e.g. origin/main)"`
	Task     string `json:"task,omitempty" jsonschema:"its first task, sent as agent_prompt does"`
}

type removeIn struct {
	Path string `json:"path" jsonschema:"the worktree's checkout path"`
}

type approveIn struct {
	ToolName  string         `json:"tool_name"`
	Input     map[string]any `json:"input"`
	ToolUseID string         `json:"tool_use_id"`
}

func textResult(text string, isErr bool) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}, IsError: isErr}
}

func errResult(err error) (*mcp.CallToolResult, any, error) {
	return textResult(err.Error(), true), nil, nil
}

// account is the Claude account its child runs under (its env's, never direnv's).
func (r *headlessRunner) account() string {
	return accountForConfigDir(r.def.Env["CLAUDE_CONFIG_DIR"], "")
}

func (r *headlessRunner) mcpServer() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "yoicks", Version: Version}, nil)
	mcp.AddTool(s, &mcp.Tool{Name: "approve", Description: "Permission prompt handler (yoicks: AskUserQuestion goes to the user's Home)."}, r.approve)
	if !r.tools {
		return s
	}
	mcp.AddTool(s, &mcp.Tool{Name: "overview", Description: "A read-only summary of the other agents of your Claude account: where each runs, its status, its last request and reply, its current tool call."},
		func(ctx context.Context, req *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
			r.log("tool overview")
			text, err := overviewText(r.rpc, r.account(), "", nowMs())
			if err != nil {
				return errResult(err)
			}
			return textResult(text, false), nil, nil
		})
	mcp.AddTool(s, &mcp.Tool{Name: "agent_get", Description: "herdr's agent.get of one of your account's agents: its status, cwd and more."},
		func(ctx context.Context, req *mcp.CallToolRequest, in nameIn) (*mcp.CallToolResult, any, error) {
			r.log("tool agent_get %s", in.Name)
			pane, err := ownAgentPane(r.rpc, in.Name, r.account())
			if err != nil {
				return errResult(err)
			}
			raw, err := r.rpc("agent.get", map[string]any{"target": pane})
			if err != nil {
				return errResult(err)
			}
			return textResult(string(raw), false), nil, nil
		})
	mcp.AddTool(s, &mcp.Tool{Name: "agent_read", Description: "Read one of your account's agents' screen or recent output."},
		func(ctx context.Context, req *mcp.CallToolRequest, in readIn) (*mcp.CallToolResult, any, error) {
			r.log("tool agent_read %s", in.Name)
			source := firstNonEmpty(in.Source, "recent")
			if !slices.Contains(readSources, source) { // herdr drops the connection on a bad enum
				return textResult("invalid source: "+source, true), nil, nil
			}
			pane, err := ownAgentPane(r.rpc, in.Name, r.account())
			if err != nil {
				return errResult(err)
			}
			params := map[string]any{"target": pane, "source": source}
			if in.Lines > 0 {
				params["lines"] = in.Lines
			}
			raw, err := r.rpc("agent.read", params)
			if err != nil {
				return errResult(err)
			}
			text, _ := paneReadText(raw).(string)
			return textResult(text, false), nil, nil
		})
	mcp.AddTool(s, &mcp.Tool{Name: "agent_prompt", Description: "Send one of your account's agents a message (a task, a follow-up, /exit). Don't wait for it: a [yoicks] message wakes you when it finishes or stops for an answer."},
		func(ctx context.Context, req *mcp.CallToolRequest, in promptIn) (*mcp.CallToolResult, any, error) {
			r.log("tool agent_prompt %s", in.Name)
			if strings.TrimSpace(in.Text) == "" {
				return r.prompt("", in.Name, in.Text), nil, nil // its error, before any herdr call
			}
			pane, err := ownAgentPane(r.rpc, in.Name, r.account())
			if err != nil {
				return errResult(err)
			}
			return r.prompt(pane, in.Name, in.Text), nil, nil
		})
	mcp.AddTool(s, &mcp.Tool{Name: "agent_start", Description: "Start a worker from a launch profile in a directory of your account (a new tab where a workspace is already at it, else a new workspace), or in a new worktree of the repository there; optionally send it its first task."},
		func(ctx context.Context, req *mcp.CallToolRequest, in startIn) (*mcp.CallToolResult, any, error) {
			r.log("tool agent_start %s", in.Name)
			opt := map[string]string{"cwd": in.Cwd}
			for k, v := range map[string]string{"profile": in.Profile, "worktree": in.Worktree, "base": in.Base} {
				if v != "" {
					opt[k] = v
				}
			}
			if in.Name == "" || in.Cwd == "" || in.Base != "" && in.Worktree == "" {
				return textResult("name and cwd are needed (base only with worktree)", true), nil, nil
			}
			pane, started, err := startOwnAgent(r.slowRPC, func() map[string]LaunchProfile { return r.profiles }, r.account(), in.Name, opt)
			if err != nil {
				return errResult(err)
			}
			if strings.TrimSpace(in.Task) == "" {
				return textResult(started, false), nil, nil
			}
			res := r.prompt(pane, in.Name, in.Task)
			res.Content[0].(*mcp.TextContent).Text = started + "; " + res.Content[0].(*mcp.TextContent).Text
			return res, nil, nil
		})
	mcp.AddTool(s, &mcp.Tool{Name: "worktree_remove", Description: "Remove a finished worker's worktree and its merged branch (only with no agent left in it and nothing uncommitted)."},
		func(ctx context.Context, req *mcp.CallToolRequest, in removeIn) (*mcp.CallToolResult, any, error) {
			r.log("tool worktree_remove %s", in.Path)
			removed, err := removeOwnWorktree(r.rpc, r.slowRPC, r.account(), in.Path)
			if err != nil {
				return errResult(err)
			}
			dir, _ := filepath.Abs(in.Path)
			r.unwatch(func(w *hlWatch) bool { return w.Cwd == dir || strings.HasPrefix(w.Cwd, dir+"/") })
			return textResult(removed, false), nil, nil
		})
	return s
}

// ── approve: the questions ───────────────────────────────────────────────────

// hlPending is a question waiting for the user (AskUserQuestion), answered once.
type hlPending struct {
	id        string
	questions []AskQuestion
	input     map[string]any
	reply     chan map[string]any // the permission decision (buffered: the asker may be gone)
}

// approve is the child's --permission-prompt-tool: AskUserQuestion waits for the Home's
// answer, held open with progress notifications; anything else is denied unasked (N2).
func (r *headlessRunner) approve(ctx context.Context, req *mcp.CallToolRequest, in approveIn) (*mcp.CallToolResult, any, error) {
	if in.ToolName != "AskUserQuestion" {
		r.log("approve %s: denied", in.ToolName)
		return textResult(`{"behavior":"deny","message":"yoicks allows no tool but its own"}`, false), nil, nil
	}
	r.asked(in.ToolUseID)
	p := r.ask(in.Input)
	defer r.dropQuestion(p)
	tick := time.NewTicker(approveProgress)
	defer tick.Stop()
	for n := 1.0; ; n++ {
		select {
		case res := <-p.reply:
			b, _ := json.Marshal(res)
			return textResult(string(b), false), nil, nil
		case <-ctx.Done(): // the call was cancelled (an interrupt) or its session ended
			return nil, nil, ctx.Err()
		case <-tick.C:
			if token := req.Params.GetProgressToken(); token != nil {
				req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: token, Progress: n, Message: "waiting for the user"})
			}
		}
	}
}

// ask makes input (AskUserQuestion's) the pending question: it is blocked until answered.
func (r *headlessRunner) ask(input map[string]any) *hlPending {
	b, _ := json.Marshal(input)
	o, _ := jsonParse(string(b))
	p := &hlPending{id: newUUID()[:8], questions: extractAsk(o), input: input, reply: make(chan map[string]any, 1)}
	r.mu.Lock()
	if old := r.pending; old != nil {
		old.reply <- map[string]any{"behavior": "deny", "message": "another question came"}
	}
	r.pending = p
	from := r.model.Status
	r.model.Status = "blocked"
	r.mu.Unlock()
	r.log("question %s pending", p.id)
	r.statusChanged(from, "blocked")
	r.onChange()
	return p
}

// dropQuestion clears p when it is still the pending one (its call ended unanswered).
func (r *headlessRunner) dropQuestion(p *hlPending) {
	r.mu.Lock()
	dropped := r.pending == p
	if dropped {
		r.pending = nil
		if r.model.Status == "blocked" {
			r.model.Status = "working"
		}
	}
	r.mu.Unlock()
	if dropped {
		r.onChange()
	}
}

// Answer answers the pending question id: answers (question → label(s), a multiSelect's
// joined by ", ") allows it, deny refuses it with that message. A stale id is a 409.
func (r *headlessRunner) Answer(id string, answers map[string]any, deny string) error {
	r.mu.Lock()
	p := r.pending
	if p == nil || p.id != id {
		r.mu.Unlock()
		return &LifecycleError{Status: 409, Code: "stale_question", Message: "that question isn't the one pending"}
	}
	r.pending = nil
	r.model.Status = "working"
	r.mu.Unlock()
	if answers == nil {
		p.reply <- map[string]any{"behavior": "deny", "message": deny}
	} else {
		in := map[string]any{}
		for k, v := range p.input {
			in[k] = v
		}
		in["answers"] = answers
		p.reply <- map[string]any{"behavior": "allow", "updatedInput": in}
	}
	r.log("question %s answered", id)
	r.onChange()
	return nil
}

// asked notes that a question reached the permission route (see watchAsk).
func (r *headlessRunner) asked(toolUseID string) {
	r.mu.Lock()
	r.asks[toolUseID] = true
	r.mu.Unlock()
}

// watchAsk: an AskUserQuestion in the stream must reach approve within askReachWait, else
// the Home would never show it.
func (r *headlessRunner) watchAsk(toolUseID string) {
	r.mu.Lock()
	if _, seen := r.asks[toolUseID]; !seen {
		r.asks[toolUseID] = false
	}
	r.mu.Unlock()
	time.AfterFunc(askReachWait, func() {
		defer r.recoverAt("the question check")
		r.mu.Lock()
		alert := func() {}
		if !r.asks[toolUseID] && r.child != nil {
			alert = r.warn("question_route", "a question (AskUserQuestion) never reached the Home: interrupt and ask again")
		}
		delete(r.asks, toolUseID)
		r.mu.Unlock()
		alert()
		r.onChange()
	})
}

// ── wake-ups ─────────────────────────────────────────────────────────────────

var (
	untilSettled = []string{"done", "idle", "blocked"}
	untilMoved   = []string{"working", "idle", "done"} // after blocked
)

// hlWatch is a worker the orchestrator waits on (saved with its state, re-armed at start).
type hlWatch struct {
	Pane    string `json:"pane"`
	Name    string `json:"name"`
	Cwd     string `json:"cwd"`
	Status  string `json:"status"`  // the last one told (or seen at the send)
	Seq     int64  `json:"seq"`     // its state_change_seq then
	Startup bool   `json:"startup"` // blocked at its start, its task not sent: wake when it's ready
	cancel  context.CancelFunc
	seen    bool // its pane was in a state (a new worker's may not be yet)
}

// agentState is agent.get/agent.wait's agent: status, state_change_seq, cwd.
func agentState(raw json.RawMessage) (status string, seq int64, cwd string) {
	a := agentFromResult(raw)
	status, _ = a["agent_status"].(string)
	cwd, _ = a["cwd"].(string)
	return status, int64(num(a["state_change_seq"])), cwd
}

// prompt sends a worker text and watches it: delivered (the result says so), not
// delivered (herdr's answer), or not sent because it waits on a startup question.
func (r *headlessRunner) prompt(pane, name, text string) *mcp.CallToolResult {
	if strings.TrimSpace(text) == "" { // nothing to send: no watch to wait on
		return textResult("text must be non-empty", true)
	}
	deadline := time.Now().Add(agentReadyTimeout)
	for {
		raw, err := r.rpc("agent.get", map[string]any{"target": pane})
		if err != nil {
			return textResult("not delivered to "+name+": "+err.Error(), true)
		}
		status, seq, cwd := agentState(raw)
		w := &hlWatch{Pane: pane, Name: name, Cwd: cwd, Status: status, Seq: seq}
		first := make(chan error, 1)
		r.watch(w, text, first)
		err = <-first
		if err == nil {
			return textResult("delivered to "+name+": you are woken when it finishes or stops for an answer", false)
		}
		r.unwatch(func(o *hlWatch) bool { return o == w })
		if herdrCode(err) != "agent_not_ready" || !time.Now().Before(deadline) {
			return textResult("not delivered to "+name+": "+err.Error(), true)
		}
		if raw, err := r.rpc("agent.get", map[string]any{"target": pane}); err == nil {
			if status, seq, cwd := agentState(raw); status == "blocked" {
				r.watch(&hlWatch{Pane: pane, Name: name, Cwd: cwd, Status: status, Seq: seq, Startup: true}, "", nil)
				return textResult("task not sent: "+name+" waits on a startup question (folder trust?) the user answers in its pane; you are woken when it is ready", false)
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// watch starts w's goroutine (text: first send it, reporting delivery on first) and keeps
// it among the watches (one per pane: a newer one replaces it).
func (r *headlessRunner) watch(w *hlWatch, text string, first chan<- error) {
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	r.mu.Lock()
	if old := r.watches[w.Pane]; old != nil {
		old.cancel()
	}
	r.watches[w.Pane] = w
	r.persist()
	r.mu.Unlock()
	go r.runWatch(ctx, w, text, first)
}

// unwatch ends the watches match picks (closing their held connections); match runs with r.mu held.
func (r *headlessRunner) unwatch(match func(*hlWatch) bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := len(r.watches)
	for pane, w := range r.watches {
		if match(w) {
			w.cancel()
			delete(r.watches, pane)
		}
	}
	if len(r.watches) != n {
		r.persist()
	}
}

// dropGone ends the watches of panes gone from the state (the agent ended, the pane closed).
func (r *headlessRunner) dropGone(st *State) {
	r.unwatch(func(w *hlWatch) bool {
		if st.Pane(w.Pane) != nil {
			w.seen = true
		}
		return w.seen && st.Pane(w.Pane) == nil
	})
}

// runWatch follows one worker until it settles (done/idle), telling each change. With text,
// the send is herdr's edge wait; a stalled or a late-broken one, and a re-arm, go on with the
// level agent.wait and state_change_seq, compared with != (herdr's restart resets it).
func (r *headlessRunner) runWatch(ctx context.Context, w *hlWatch, text string, first chan<- error) {
	defer r.recoverAt("a worker's watch")
	var reported sync.Once
	once := func(err error) { // the delivery, told once (first is buffered)
		reported.Do(func() {
			if first != nil {
				first <- err
			}
		})
	}
	defer once(context.Canceled) // ended before any answer
	until := untilSettled
	if text != "" {
		t := time.AfterFunc(deliveryWindow, func() { once(nil) })
		raw, err := r.waitRPC(ctx, "agent.prompt", map[string]any{"target": w.Pane, "text": text, "wait": map[string]any{"until": untilSettled}})
		early := t.Stop()
		if err != nil && early && herdrCode(err) != "agent_prompt_stalled" { // a stall was delivered, just not taken up yet
			once(err) // herdr refused it: not delivered
			return
		}
		once(nil)
		r.told(w, "working", w.Seq) // delivered: from here it works
		if err == nil {
			if !r.settle(ctx, w, raw, &until) {
				return
			}
		} else if ctx.Err() != nil {
			return
		}
		// agent_prompt_stalled (no working within 5 s) or a late failure: on with the level wait
	}
	for ctx.Err() == nil {
		if w.Startup {
			if _, err := r.waitRPC(ctx, "agent.wait", map[string]any{"target": w.Pane, "until": []string{"idle", "done"}}); err != nil {
				if !r.retryWatch(ctx, w, err) {
					return
				}
				continue
			}
			r.wakeLine(w.Name + ": ready, task not sent")
			r.unwatch(func(o *hlWatch) bool { return o == w })
			return
		}
		raw, err := r.waitRPC(ctx, "agent.wait", map[string]any{"target": w.Pane, "until": until})
		if err != nil {
			if !r.retryWatch(ctx, w, err) {
				return
			}
			continue
		}
		status, seq, _ := agentState(raw)
		if seq == w.Seq && slices.Equal(until, untilSettled) { // the state already known: wait for it to move
			if status == "blocked" {
				until = untilMoved
				continue
			}
			// a quick worker may be done again before a level wait sees it working: look again after 8 s
			r.waitRPC(ctx, "agent.wait", map[string]any{"target": w.Pane, "until": []string{"working"}, "timeout_ms": 8000})
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if !r.settle(ctx, w, raw, &until) {
			return
		}
	}
}

// settle tells a change the wait answered; false once the watch is over (settled).
func (r *headlessRunner) settle(ctx context.Context, w *hlWatch, raw json.RawMessage, until *[]string) bool {
	status, seq, _ := agentState(raw)
	r.mu.Lock()
	from := w.Status
	r.mu.Unlock()
	if slices.Equal(*until, untilMoved) && status == "working" { // answered: back to waiting for its end
		r.told(w, "working", seq)
		*until = untilSettled
		return true
	}
	r.wakeLine(fmt.Sprintf("%s: %s → %s", w.Name, from, status))
	r.told(w, status, seq)
	if status == "blocked" {
		*until = untilMoved
		return true
	}
	r.unwatch(func(o *hlWatch) bool { return o == w })
	return false
}

func (r *headlessRunner) told(w *hlWatch, status string, seq int64) {
	r.mu.Lock()
	w.Status, w.Seq = status, seq
	r.persist()
	r.mu.Unlock()
}

// retryWatch: a broken wait is re-armed (herdr restarting, say) unless the watch ended or
// its agent is gone.
func (r *headlessRunner) retryWatch(ctx context.Context, w *hlWatch, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	if herdrCode(err) == "not_found" || herdrCode(err) == "agent_not_found" {
		r.unwatch(func(o *hlWatch) bool { return o == w })
		return false
	}
	select {
	case <-ctx.Done():
		return false
	case <-time.After(time.Second):
		return true
	}
}

// wakeLine queues a wake-up; the ones within wakeCoalesce go out as one message.
func (r *headlessRunner) wakeLine(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.wakes = append(r.wakes, "[yoicks] "+line)
	if r.wakeTimer == nil {
		r.wakeTimer = time.AfterFunc(wakeCoalesce, func() {
			defer r.recoverAt("the wake-up")
			r.mu.Lock()
			lines := r.wakes
			r.wakes, r.wakeTimer = nil, nil
			r.mu.Unlock()
			r.log("wake: %d line(s)", len(lines))
			if err := r.write(strings.Join(lines, "\n")); err != nil {
				r.log("wake not sent: %s", err)
			}
		})
	}
}

// rearm restarts the saved watches (after a bridge restart): level waits from the saved
// status and seq, so a change meanwhile wakes once and a replay of the same state doesn't.
func (r *headlessRunner) rearm(saved []hlWatch) {
	for i := range saved {
		w := saved[i]
		r.watch(&w, "", nil)
	}
}
