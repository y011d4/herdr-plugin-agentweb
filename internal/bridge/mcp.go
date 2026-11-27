package bridge

// The MCP server a headless orchestrator's child talks to (go-sdk, streamable HTTP): its
// tools (the CLI's orchestrator commands, as functions, and the user's to-do list), the permission tool approve
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
	"errors"
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
var yoicksTools = []string{"overview", "agent_get", "agent_read", "agent_prompt", "agent_start", "worktree_remove", "todo"}

const (
	// how often a held approve tells the client it waits: under MCP's 60 s call timeout and
	// the 300 s HTTP idle limit (S0 row 5)
	approveProgress = 20 * time.Second
	askReachWait    = 10 * time.Second        // how soon an AskUserQuestion in the stream must reach approve
	deliveryWindow  = 1500 * time.Millisecond // herdr refusing a prompt answers within it
	wakeCoalesce    = 3 * time.Second
)

// ── the listener ─────────────────────────────────────────────────────────────

type mcpHost struct {
	srv     *http.Server
	runners []*headlessRunner
	servers map[*headlessRunner]*mcp.Server
}

// startMCPHost opens the listener and gives each runner its URL and server. The bearer is
// per child: each start issues a new one, and Stop or Clear revoke it, so a child from
// before reaches nothing.
func startMCPHost(runners map[string]*headlessRunner) (*mcpHost, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	h := &mcpHost{servers: map[*headlessRunner]*mcp.Server{}}
	url := "http://" + ln.Addr().String() + "/mcp"
	for _, r := range runners {
		r.mcpURL = url
		h.runners = append(h.runners, r)
		h.servers[r] = r.mcpServer()
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

// serverFor is the server of the runner whose current child's bearer the request carries
// (nil: none).
func (h *mcpHost) serverFor(req *http.Request) *mcp.Server {
	var found *mcp.Server
	for _, r := range h.runners {
		if _, ok := r.caller(req.Header); ok {
			found = h.servers[r]
		}
	}
	return found
}

// caller is whether header carries its current child's bearer, and that child's epoch (a
// call binds to it on arrival: the child replaced since, a watch or question of the call's
// registers nothing).
func (r *headlessRunner) caller(header http.Header) (epoch int, ok bool) {
	got, has := strings.CutPrefix(header.Get("Authorization"), "Bearer ")
	r.mu.Lock()
	defer r.mu.Unlock()
	ok = has && r.mcpBearer != "" && subtle.ConstantTimeCompare([]byte(got), []byte(r.mcpBearer)) == 1
	return r.epoch, ok
}

// newBearer is a fresh bearer.
func newBearer() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (h *mcpHost) Close() { h.srv.Close() }

// mcpConfig is a child's --mcp-config: the bridge's server, with that child's bearer.
func (r *headlessRunner) mcpConfig(bearer string) []byte {
	b, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"yoicks": map[string]any{
		"type": "http", "url": r.mcpURL, "headers": map[string]string{"Authorization": "Bearer " + bearer}}}})
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
	Name    string `json:"name" jsonschema:"the agent's name (or pane id)"`
	Text    string `json:"text" jsonschema:"what to send it (/exit ends it)"`
	Purpose string `json:"purpose,omitempty" jsonschema:"only when this hands it different work: its new purpose (as agent_start's); left out, it keeps the one it has"`
}

type startIn struct {
	Name     string `json:"name" jsonschema:"the new worker's name: a short english description (fix-login-redirect)"`
	Purpose  string `json:"purpose,omitempty" jsonschema:"what it is for, in the user's language: one short line (at most 60 characters) the user's agents list shows over its name"`
	Cwd      string `json:"cwd" jsonschema:"the directory (repository) it works in"`
	Profile  string `json:"profile,omitempty" jsonschema:"a launch profile (default claude)"`
	Worktree string `json:"worktree,omitempty" jsonschema:"a branch: start it in a new worktree of the repository at cwd"`
	Base     string `json:"base,omitempty" jsonschema:"the worktree's base (e.g. origin/main)"`
	Task     string `json:"task,omitempty" jsonschema:"its first task, sent as agent_prompt does"`
}

type removeIn struct {
	Path string `json:"path" jsonschema:"the worktree's checkout path"`
}

type todoIn struct {
	Add  []todoAdd `json:"add,omitempty" jsonschema:"items to add"`
	Done []string  `json:"done,omitempty" jsonschema:"the ids of items that are done"`
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

type epochKey struct{}

// boundCalls binds each tool call to its caller: one from a child that is no longer the
// current one (a start, Stop or Clear revoked its bearer) is refused before its tool runs;
// the others carry their child's epoch (epochOf), which what they register must still
// match (watch, ask).
func (r *headlessRunner) boundCalls(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method != "tools/call" {
			return next(ctx, method, req)
		}
		// Claude Code names the tool_use each call is for (S0's mcp.log): the stream's result for
		// one never named here failed before reaching the bridge (onLine's mcp_call)
		if p, ok := req.GetParams().(*mcp.CallToolParamsRaw); ok && p.Name != "approve" {
			if id, _ := p.Meta["claudecode/toolUseId"].(string); id != "" {
				r.mu.Lock()
				r.served[id] = true
				r.mu.Unlock()
			}
		}
		epoch, ok := 0, false
		if extra := req.GetExtra(); extra != nil {
			epoch, ok = r.caller(extra.Header)
		}
		if !ok {
			return textResult("this orchestrator's session has ended (restarted, stopped or cleared)", true), nil
		}
		return next(context.WithValue(ctx, epochKey{}, epoch), method, req)
	}
}

func epochOf(ctx context.Context) int { epoch, _ := ctx.Value(epochKey{}).(int); return epoch }

func (r *headlessRunner) mcpServer() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "yoicks", Version: Version}, nil)
	s.AddReceivingMiddleware(r.boundCalls)
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
	mcp.AddTool(s, &mcp.Tool{Name: "agent_prompt", Description: "Send one of your account's agents a message (a task, a follow-up, /exit). Don't wait for it: a [yoicks] message wakes you when it finishes or stops for an answer. " +
		"Handing a worker different work, give its new purpose too."},
		func(ctx context.Context, req *mcp.CallToolRequest, in promptIn) (*mcp.CallToolResult, any, error) {
			r.log("tool agent_prompt %s", in.Name)
			purpose, err := checkPurpose(in.Purpose)
			if err != nil {
				return errResult(err)
			}
			if strings.TrimSpace(in.Text) == "" {
				res, _ := r.prompt("", in.Name, in.Text, epochOf(ctx)) // its error, before any herdr call
				return res, nil, nil
			}
			pane, err := ownAgentPane(r.rpc, in.Name, r.account())
			if err != nil {
				return errResult(err)
			}
			res, delivered := r.prompt(pane, in.Name, in.Text, epochOf(ctx))
			if delivered && purpose != "" { // a task not taken leaves the work it has
				r.purposes.Set(pane, purpose, nowMs())
			}
			return res, nil, nil
		})
	mcp.AddTool(s, &mcp.Tool{Name: "agent_start", Description: "Start a worker from a launch profile in a directory of your account (a new tab where a workspace is already at it, else a new workspace), or in a new worktree of the repository there; optionally send it its first task. " +
		"Give it a purpose: the user's agents list shows it over the worker's name."},
		func(ctx context.Context, req *mcp.CallToolRequest, in startIn) (*mcp.CallToolResult, any, error) {
			r.log("tool agent_start %s", in.Name)
			purpose, err := checkPurpose(in.Purpose)
			if err != nil {
				return errResult(err)
			}
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
			r.purposes.Set(pane, purpose, nowMs()) // none: a reused pane's old one goes too
			if strings.TrimSpace(in.Task) == "" {
				return textResult(started, false), nil, nil
			}
			res, _ := r.prompt(pane, in.Name, in.Task, epochOf(ctx))
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
	mcp.AddTool(s, &mcp.Tool{Name: "todo", Description: "The user's to-do list, shown on their Home: what only the user can do and nothing else shows them " +
		"(merge a PR, a decision outside this chat, a step on the PC, a login, a cleanup later on). Add items, mark items done by id, " +
		"or call it with nothing to read the list; it returns the list. A worker waiting for an approval and your own pending question show on their own: never add those; " +
		"a decision the user owes that no pending question shows (one you asked in plain text, say) goes on."},
		func(ctx context.Context, req *mcp.CallToolRequest, in todoIn) (*mcp.CallToolResult, any, error) {
			r.log("tool todo +%d -%d", len(in.Add), len(in.Done))
			items, gone, err := r.todos.Apply(r.def.Name, in.Add, in.Done, nowMs())
			if err != nil {
				return errResult(err)
			}
			return textResult(todoText(items, gone, r.todos.loc), false), nil, nil
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
	if r.approveHook != nil {
		r.approveHook()
	}
	p := r.ask(in.Input, epochOf(ctx))
	if p == nil {
		return textResult(`{"behavior":"deny","message":"this orchestrator's session has ended"}`, false), nil, nil
	}
	r.asked(in.ToolUseID, p)
	defer r.dropQuestion(p)
	for n := 1.0; ; n++ {
		select {
		case res := <-p.reply:
			if r.approveHook != nil {
				r.approveHook()
			}
			b, _ := json.Marshal(res)
			return textResult(string(b), false), nil, nil
		case <-ctx.Done(): // the call was cancelled (an interrupt) or its session ended
			return nil, nil, ctx.Err()
		case <-r.clock.After(approveProgress):
			if token := req.Params.GetProgressToken(); token != nil {
				req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{ProgressToken: token, Progress: n, Message: "waiting for the user"})
			}
		}
	}
}

// ask makes input (AskUserQuestion's) the pending question: it is blocked until answered.
// nil, the pending one untouched: the asking child (epoch) has been replaced since.
func (r *headlessRunner) ask(input map[string]any, epoch int) *hlPending {
	b, _ := json.Marshal(input)
	o, _ := jsonParse(string(b))
	p := &hlPending{id: newUUID()[:8], questions: extractAsk(o), input: input, reply: make(chan map[string]any, 1)}
	r.mu.Lock()
	if r.epoch != epoch {
		r.mu.Unlock()
		return nil
	}
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

// Chat refuses the pending question id as Claude Code's "Chat about this" does, with its message:
// the questions and the answers given so far (answers: maybe some, maybe none), so the model asks
// what the user would like to clarify. A stale id is a 409.
func (r *headlessRunner) Chat(id string, answers map[string]any) error {
	var questions []AskQuestion
	r.mu.Lock()
	if p := r.pending; p != nil && p.id == id {
		questions = p.questions
	}
	r.mu.Unlock()
	return r.Answer(id, nil, clarify(questions, answers))
}

// clarify is Claude Code 2.1.322's "Chat about this" refusal, word for word (its TUI's).
func clarify(questions []AskQuestion, answers map[string]any) string {
	var b strings.Builder
	b.WriteString("The user wants to clarify these questions.\n" +
		"    This means they may have additional information, context or questions for you.\n" +
		"    Take their response into account and then reformulate the questions if appropriate.\n" +
		"    Start by asking them what they would like to clarify.\n" +
		"    Questions asked:")
	for _, q := range questions {
		b.WriteString("\n- \"" + q.Question + "\"\n")
		if a, _ := answers[q.Question].(string); a != "" {
			b.WriteString("  Answer: " + a)
		} else {
			b.WriteString("  (No answer provided)")
		}
	}
	return b.String()
}

// asked notes that question p reached the permission route (see watchAsk). One a message was
// written behind while it was on its way (Send) is refused at once, as Chat about this.
func (r *headlessRunner) asked(toolUseID string, p *hlPending) {
	r.mu.Lock()
	r.asks[toolUseID] = true
	answers, chat := r.chatNext[toolUseID]
	delete(r.chatNext, toolUseID)
	r.mu.Unlock()
	if chat {
		r.Chat(p.id, answers)
	}
}

// watchAsk: an AskUserQuestion in the stream must reach approve within askReachWait, else
// the Home would never show it.
func (r *headlessRunner) watchAsk(toolUseID string) {
	r.mu.Lock()
	if _, seen := r.asks[toolUseID]; !seen {
		r.asks[toolUseID] = false
	}
	r.mu.Unlock()
	r.clock.AfterFunc(askReachWait, func() {
		defer r.recoverAt("the question check")
		r.mu.Lock()
		alert := func() {}
		if !r.asks[toolUseID] && r.child != nil {
			alert = r.warn("question_route", "a question (AskUserQuestion) never reached the Home: interrupt and ask again")
		}
		delete(r.asks, toolUseID)
		delete(r.chatNext, toolUseID)
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
	Status  string `json:"status"`           // the last one told (or seen at the send)
	Seq     int64  `json:"seq"`              // its state_change_seq then
	Startup bool   `json:"startup"`          // blocked at its start, its task not sent: wake when it's ready
	Unsent  bool   `json:"unsent,omitempty"` // followed on after that question with the task still unsent: its end says so
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

// prompt sends a worker text and watches it: delivered (the result says so, and delivered is true), not
// delivered (herdr's answer), or not sent because it waits on a question in its pane (herdr
// refuses a prompt then: agent_not_ready while a startup question holds it, agent_blocked at a
// dialog, the folder-trust one included), with a wake-up once it is ready. epoch is the
// calling child's: that child replaced since, no watch is made.
func (r *headlessRunner) prompt(pane, name, text string, epoch int) (res *mcp.CallToolResult, delivered bool) {
	if strings.TrimSpace(text) == "" { // nothing to send: no watch to wait on
		return textResult("text must be non-empty", true), false
	}
	deadline := r.clock.Now().Add(agentReadyTimeout)
	for {
		raw, err := r.rpc("agent.get", map[string]any{"target": pane})
		if err != nil {
			return textResult("not delivered to "+name+": "+err.Error(), true), false
		}
		status, seq, cwd := agentState(raw)
		w := &hlWatch{Pane: pane, Name: name, Cwd: cwd, Status: status, Seq: seq}
		first := make(chan error, 1)
		if !r.watch(w, text, first, epoch) {
			return textResult("not delivered to "+name+": the orchestrator was restarted, stopped or cleared", true), false
		}
		err = <-first
		if err == nil {
			return textResult("delivered to "+name+": you are woken when it finishes or stops for an answer", false), true
		}
		r.unwatch(func(o *hlWatch) bool { return o == w })
		if code := herdrCode(err); code != "agent_not_ready" && code != "agent_blocked" || !r.clock.Now().Before(deadline) {
			return textResult("not delivered to "+name+": "+err.Error(), true), false
		}
		if raw, err := r.rpc("agent.get", map[string]any{"target": pane}); err == nil {
			if status, seq, cwd := agentState(raw); status == "blocked" {
				r.watch(&hlWatch{Pane: pane, Name: name, Cwd: cwd, Status: status, Seq: seq, Startup: true}, "", nil, epoch)
				return textResult("task not sent: "+name+" waits on a question in its pane (folder trust, a permission) that the user answers there; you are woken when it is ready", false), false
			}
		}
		<-r.clock.After(250 * time.Millisecond)
	}
}

// watch starts w's goroutine (text: first send it, reporting delivery on first) and keeps
// it among the watches (one per pane: a newer one replaces it); false (and nothing started)
// when the child epoch isn't the current one (a restart, Stop or Clear since).
func (r *headlessRunner) watch(w *hlWatch, text string, first chan<- error, epoch int) bool {
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	r.mu.Lock()
	if r.epoch != epoch { // a call from a child since replaced (or a Stop or Clear meanwhile)
		r.mu.Unlock()
		cancel()
		return false
	}
	if old := r.watches[w.Pane]; old != nil {
		old.cancel()
	}
	r.watches[w.Pane] = w
	// it takes a saved one's place in this same save, so no later save brings that one back
	r.saved = slices.DeleteFunc(r.saved, func(s hlWatch) bool { return s.Pane == w.Pane })
	r.persist()
	r.mu.Unlock()
	go r.runWatch(ctx, w, text, first)
	return true
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
		t := r.clock.AfterFunc(deliveryWindow, func() { once(nil) })
		raw, err := r.waitRPC(ctx, "agent.prompt", map[string]any{"target": w.Pane, "text": text, "wait": map[string]any{"until": untilSettled}})
		early := t.Stop()
		if err != nil && early && herdrCode(err) != "agent_prompt_stalled" { // a stall was delivered, just not taken up yet
			once(err) // herdr refused it: not delivered
			return
		}
		once(nil)
		if !r.tell(w, "", "working", w.Seq, false) { // delivered: from here it works
			return
		}
		if err == nil {
			if !r.settle(w, raw, &until) {
				return
			}
		} else if ctx.Err() != nil {
			return
		}
		// agent_prompt_stalled (no working within 5 s) or a late failure: on with the level wait
	}
	for ctx.Err() == nil {
		if w.Startup {
			raw, err := r.waitRPC(ctx, "agent.wait", map[string]any{"target": w.Pane, "until": untilMoved})
			if err != nil {
				if !r.retryWatch(ctx, w, err) {
					return
				}
				continue
			}
			if status, _, _ := agentState(raw); status != "working" {
				r.tell(w, w.Name+": ready, task not sent", w.Status, w.Seq, true)
				return
			}
			// answered, it works on (a question in the middle of a task of its own): followed from
			// here as any watch, so its next question or its end wakes the orchestrator too
			r.mu.Lock()
			w.Startup, w.Unsent = false, true
			r.mu.Unlock()
			until = untilMoved
			if !r.settle(w, raw, &until) {
				return
			}
			continue
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
			select {
			case <-ctx.Done():
			case <-r.clock.After(500 * time.Millisecond):
			}
			continue
		}
		if !r.settle(w, raw, &until) {
			return
		}
	}
}

// settle tells a change the wait answered; false once the watch is over (settled, or ended
// meanwhile).
func (r *headlessRunner) settle(w *hlWatch, raw json.RawMessage, until *[]string) bool {
	status, seq, _ := agentState(raw)
	if slices.Equal(*until, untilMoved) && status == "working" { // answered: back to waiting for its end
		*until = untilSettled
		return r.tell(w, "", "working", seq, false)
	}
	end := status != "blocked"
	if !end {
		*until = untilMoved
	}
	// w.Status is only ever changed here, in its own goroutine
	line := fmt.Sprintf("%s: %s → %s", w.Name, w.Status, status)
	if end && w.Unsent { // the end of a task of its own, not of the orchestrator's
		line += ", ready, task not sent"
	}
	return r.tell(w, line, status, seq, end) && !end
}

// tell is a watch's change, in one save: line (when not "") queued as a wake-up, its status
// and seq, and (end) its removal. false when w is no watch any more (ended, replaced, or its
// orchestrator stopped or cleared): then it changes nothing.
func (r *headlessRunner) tell(w *hlWatch, line, status string, seq int64, end bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.watches[w.Pane] != w {
		return false
	}
	if line != "" {
		r.wakes = append(r.wakes, "[yoicks] "+line)
		r.scheduleWakes()
	}
	w.Status, w.Seq = status, seq
	if end {
		w.cancel()
		delete(r.watches, w.Pane)
	}
	r.persist()
	return true
}

// notice queues line as a wake-up of the bridge's own (the PR watch's), saved like a worker's:
// one queued while it is stopped is written at its next start.
func (r *headlessRunner) notice(line string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.wakes = append(r.wakes, "[yoicks] "+line)
	r.scheduleWakes()
	r.persist()
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
	case <-r.clock.After(time.Second):
		return true
	}
}

// scheduleWakes writes the queued wake-ups in wakeCoalesce, as one message, to the child of
// the moment; r.mu held. They stay queued (and saved) until a write succeeds, so a child down
// gets them once it (re)starts. The timer carries the generation: after a Stop or Clear
// (which drop the queue) it does nothing.
func (r *headlessRunner) scheduleWakes() {
	if r.wakeTimer != nil || len(r.wakes) == 0 {
		return
	}
	gen := r.gen
	r.wakeTimer = r.clock.AfterFunc(wakeCoalesce, func() {
		defer r.recoverAt("the wake-up")
		r.mu.Lock()
		if r.gen != gen {
			r.mu.Unlock()
			return
		}
		lines, c := slices.Clone(r.wakes), r.child
		r.mu.Unlock()
		err := errors.New("no child")
		if c != nil && len(lines) > 0 {
			err = r.writeTo(c, strings.Join(lines, "\n"))
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.gen != gen { // stopped or cleared meanwhile: that queue is gone
			return
		}
		r.wakeTimer = nil
		if err != nil {
			r.log("wake (%d line(s)) not sent yet: %s", len(lines), err)
			if r.child != nil { // a failed write to a live child: try again
				r.scheduleWakes()
			}
			return
		}
		r.log("wake: %d line(s)", len(lines))
		r.wakes = r.wakes[len(lines):] // the same generation: only appended to since
		r.persist()
		r.scheduleWakes() // ones queued meanwhile
	})
}

// rearm restarts the saved watches (after a bridge restart): level waits from the saved
// status and seq, so a change meanwhile wakes once and a replay of the same state doesn't.
// Each leaves the saved ones as it becomes a running one (watch), in the same save.
func (r *headlessRunner) rearm() {
	r.mu.Lock()
	saved, epoch := slices.Clone(r.saved), r.epoch // (r.op held: no Stop or Clear meanwhile)
	r.mu.Unlock()
	for i := range saved {
		r.watch(&saved[i], "", nil, epoch)
	}
}
