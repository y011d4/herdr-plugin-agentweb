// Command fakeclaude stands in for Claude Code in the headless orchestrator's tests and
// checks (YOICKS_CLAUDE_BIN), so no real Claude ever runs there. Build it as `claude`: the
// bridge's orphan scan only looks at processes of that name.
//
//	claude --version                 FAKECLAUDE_VERSION (default 2.1.322)
//	claude auth status --json        FAKECLAUDE_AUTH = <authMethod>/<subscriptionType> (default claude.ai/max)
//	claude -p … stream-json …        a session over stdin/stdout, as Claude Code 2.1.322 does it
//	                                 (--resume of a session with no transcript yet: exit 1, as it does;
//	                                 one in another project dir of the account resumes there)
//
// In -p mode it connects to the --mcp-config server (its yoicks tools join --tools's, the
// --permission-prompt-tool one hidden). Each turn starts with system/init (apiKeySource from
// FAKECLAUDE_APIKEYSOURCE, default none) and writes the transcript to
// $CLAUDE_CONFIG_DIR (else ~/.claude)/projects/<slug of the cwd>/<session>.jsonl. A message
// is a script by its text:
//
//	slow N    work N s, a tool_progress heartbeat each second
//	hang      work without a single event until a SIGUSR1 (a test's say-so, not a clock)
//	crash     exit 1 mid-turn
//	garbage N N lines (default 1) that aren't JSON, then the reply
//	unknown   an event of a type Claude Code doesn't have, then the reply
//	ask [N]   words to the user (a narration block), an AskUserQuestion of N (1-4) questions, then its
//	          permission call (approve) and the decision as the tool_result
//	askhold [N] the same, held between the tool_use and the permission call until a SIGUSR1
//	askstdio  the same through a can_use_tool control_request instead (the route yoicks warns about)
//	asknoroute an AskUserQuestion tool_use that never reaches the permission tool
//	tool      call the yoicks overview tool; call <tool> <json args> any one: its text is the reply
//	deaf      stop reading stdin (what's written to it backs up)
//	other     the reply "echo: <text>"
//
//	hold      its turn begins only at a SIGUSR1 (then the reply)
//	replyhold send the reply, then hold its result until an interrupt
//
// A control_request interrupt ends the turn running, or with none running the one message it
// overtook, whose turn hasn't begun (result error_during_execution, terminal_reason aborted_*),
// then is answered; messages queued behind it stay and run next (as S0 measured).
// Stdin's end while idle exits 0; while working, after the turn. FAKECLAUDE_START=init sends
// an init at once, before any message; =exit exits 1 at once. FAKECLAUDE_LOG, when set, gets
// a JSON line for the argv (and env keys) and each stdin line. FAKECLAUDE_REAL=<path> execs that
// (real) claude instead, whatever the arguments.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	// one YOICKS_CLAUDE_BIN for the whole bridge: an orchestrator whose env names the real claude
	// runs that one instead (webcheck's real wc-h2 beside the fake wc-h1)
	if real := os.Getenv("FAKECLAUDE_REAL"); real != "" {
		err := syscall.Exec(real, append([]string{real}, os.Args[1:]...), os.Environ())
		fmt.Fprintln(os.Stderr, "fakeclaude: exec", real+":", err)
		os.Exit(1)
	}
	// before the first log line: a test that has seen it may signal (the default action would end it)
	signal.Notify(release, syscall.SIGUSR1)
	args := os.Args[1:]
	logLine(map[string]any{"pid": os.Getpid(), "argv": args, "env": envKeys()})
	switch {
	case slices.Equal(args, []string{"--version"}):
		fmt.Println(env("FAKECLAUDE_VERSION", "2.1.322") + " (Claude Code)")
	case len(args) >= 2 && args[0] == "auth" && args[1] == "status":
		method, sub, _ := strings.Cut(env("FAKECLAUDE_AUTH", "claude.ai/max"), "/")
		out, _ := json.Marshal(map[string]any{"loggedIn": true, "authMethod": method, "apiProvider": "firstParty",
			"email": "someone@example.com", "subscriptionType": sub})
		fmt.Println(string(out))
	case slices.Contains(args, "-p"):
		session(args)
	default:
		fmt.Fprintln(os.Stderr, "fakeclaude: unsupported arguments")
		os.Exit(2)
	}
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envKeys() []string {
	var keys []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// release: a SIGUSR1, on which a held turn goes on (hang, hold)
var release = make(chan os.Signal, 1)

var logMu sync.Mutex

func logLine(v map[string]any) {
	path := os.Getenv("FAKECLAUDE_LOG")
	if path == "" {
		return
	}
	logMu.Lock()
	defer logMu.Unlock()
	b, _ := json.Marshal(v)
	if f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		f.Write(append(b, '\n'))
		f.Close()
	}
}

func argAfter(args []string, flag string) string {
	if i := slices.Index(args, flag); i >= 0 && i+1 < len(args) {
		return args[i+1]
	}
	return ""
}

// ── a -p session ─────────────────────────────────────────────────────────────

type fake struct {
	id, cwd, transcript string
	tools               []string // built-in, then its MCP server's
	mcpServers          []any
	mcp                 *mcp.ClientSession

	outMu sync.Mutex

	mu      sync.Mutex
	cancel  context.CancelFunc // the turn running (nil: none)
	read    int                // messages read
	begun   int                // messages whose turn has begun (or was skipped)
	skip    map[int]bool       // messages an interrupt overtook before their turn began
	answers map[string]chan map[string]any
}

type queued struct {
	text    string // its words (a content array: its text blocks)
	content any    // as sent, recorded so
	n       int    // its place among the messages read
}

func session(args []string) {
	f := &fake{id: firstNonEmpty(argAfter(args, "--session-id"), argAfter(args, "--resume")), answers: map[string]chan map[string]any{}, skip: map[int]bool{}}
	if t := argAfter(args, "--tools"); t != "" {
		f.tools = strings.Split(t, ",")
	}
	if cfg := argAfter(args, "--mcp-config"); cfg != "" {
		names := f.connectMCP(cfg, argAfter(args, "--permission-prompt-tool"))
		f.tools = append(f.tools, names...)
		f.mcpServers = []any{map[string]any{"name": "yoicks", "source": "dynamic", "status": map[bool]string{true: "connected", false: "failed"}[f.mcp != nil]}}
	}
	f.cwd, _ = os.Getwd()
	root := os.Getenv("CLAUDE_CONFIG_DIR")
	if root == "" {
		root = filepath.Join(os.Getenv("HOME"), ".claude")
	}
	slug := strings.Map(func(r rune) rune {
		if r == '/' || r == '.' || r == '_' {
			return '-'
		}
		return r
	}, f.cwd)
	f.transcript = filepath.Join(root, "projects", slug, f.id+".jsonl")
	// as Claude Code 2.1.322 does: a session with no transcript yet (no message) can't be resumed,
	// and one in another project dir of the account is resumed there
	if id := argAfter(args, "--resume"); id != "" {
		if _, err := os.Stat(f.transcript); err != nil {
			entries, _ := os.ReadDir(filepath.Join(root, "projects")) // not a glob: root may hold glob characters
			for _, e := range entries {
				p := filepath.Join(root, "projects", e.Name(), id+".jsonl")
				if _, err := os.Stat(p); err == nil {
					f.transcript = p
					break
				}
			}
		}
		if _, err := os.Stat(f.transcript); err != nil {
			fmt.Fprintln(os.Stderr, "No conversation found with session ID: "+id)
			os.Exit(1)
		}
	}

	switch os.Getenv("FAKECLAUDE_START") {
	case "init": // an init before any message (Claude Code sends it at a turn's start)
		f.emit(f.init())
	case "exit":
		fmt.Fprintln(os.Stderr, "fakeclaude: exiting at once as asked")
		os.Exit(1)
	}
	msgs := make(chan queued, 64)
	go func() {
		sc := bufio.NewScanner(os.Stdin)
		sc.Buffer(make([]byte, 1<<20), 16<<20)
		for sc.Scan() {
			logLine(map[string]any{"stdin": sc.Text()})
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) != nil {
				continue
			}
			switch m["type"] {
			case "user":
				msg, _ := m["message"].(map[string]any)
				text, _ := msg["content"].(string)
				if blocks, ok := msg["content"].([]any); ok {
					for _, b := range blocks {
						block, _ := b.(map[string]any)
						if t, ok := block["text"].(string); ok {
							text += t
						}
					}
				}
				if text == "deaf" {
					time.Sleep(time.Hour) // stop reading stdin: the bridge's writes back up
				}
				f.mu.Lock()
				f.read++
				n := f.read
				f.mu.Unlock()
				msgs <- queued{text, msg["content"], n}
			case "control_request":
				req, _ := m["request"].(map[string]any)
				if req["subtype"] == "interrupt" {
					// registered before the answer: the turn running ends, or with none running
					// the next message, which it overtook, never begins
					f.mu.Lock()
					if f.cancel != nil {
						f.cancel()
					} else if f.begun < f.read {
						f.skip[f.begun+1] = true
					}
					f.mu.Unlock()
					f.emit(map[string]any{"type": "control_response", "response": map[string]any{
						"subtype": "success", "request_id": m["request_id"], "response": map[string]any{"still_queued": []any{}}}})
				}
			case "control_response":
				resp, _ := m["response"].(map[string]any)
				id, _ := resp["request_id"].(string)
				f.mu.Lock()
				if ch := f.answers[id]; ch != nil {
					ch <- resp
				}
				f.mu.Unlock()
			}
		}
		close(msgs)
	}()
	for q := range msgs {
		f.turn(q)
	}
}

func (f *fake) init() map[string]any {
	return map[string]any{"type": "system", "subtype": "init", "session_id": f.id, "cwd": f.cwd, "tools": f.tools,
		"mcp_servers": f.mcpServers, "model": "fake", "permissionMode": "default",
		"apiKeySource": env("FAKECLAUDE_APIKEYSOURCE", "none"), "claude_code_version": env("FAKECLAUDE_VERSION", "2.1.322")}
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (f *fake) emit(v any) {
	b, _ := json.Marshal(v)
	f.emitRaw(string(b))
}

func (f *fake) emitRaw(line string) {
	f.outMu.Lock()
	defer f.outMu.Unlock()
	if _, err := os.Stdout.WriteString(line + "\n"); err != nil {
		os.Exit(0) // the bridge is gone
	}
}

func (f *fake) record(v map[string]any) {
	v["sessionId"], v["cwd"], v["timestamp"] = f.id, f.cwd, time.Now().UTC().Format(time.RFC3339Nano)
	os.MkdirAll(filepath.Dir(f.transcript), 0o700)
	b, _ := json.Marshal(v)
	if file, err := os.OpenFile(f.transcript, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		file.Write(append(b, '\n'))
		file.Close()
	}
}

func (f *fake) turn(q queued) {
	text := q.text
	if text == "hold" {
		<-release
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f.mu.Lock()
	f.begun = q.n
	skipped := f.skip[q.n]
	delete(f.skip, q.n)
	if !skipped {
		f.cancel = cancel
	}
	f.mu.Unlock()
	if skipped { // an interrupt came after it was sent, before its turn began
		f.finish(ctx, aborted("aborted_streaming"))
		return
	}
	f.emit(f.init())
	f.record(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": q.content}})
	word, arg, _ := strings.Cut(text, " ")
	seconds, _ := strconv.Atoi(arg)
	switch word {
	case "crash":
		f.emit(assistant([]any{map[string]any{"type": "text", "text": "about to crash"}}))
		fmt.Fprintln(os.Stderr, "fakeclaude: crashing as asked")
		os.Exit(1)
	case "garbage":
		for i := 0; i < max(seconds, 1); i++ {
			f.emitRaw("this is not json")
		}
	case "unknown":
		f.emit(map[string]any{"type": "mystery_event", "session_id": f.id})
	case "ask", "askhold":
		f.askMCP(ctx, seconds, word == "askhold")
	case "asknoroute": // the question in the stream, never through the permission tool
		f.emit(assistant([]any{map[string]any{"type": "tool_use", "id": "toolu_lost", "name": "AskUserQuestion", "input": map[string]any{"questions": []any{}}}}))
	case "askstdio":
		f.ask(ctx)
	case "tool", "call": // a yoicks tool: overview, or call <tool> <json args>
		tool, js, _ := strings.Cut(arg, " ")
		args := map[string]any{}
		json.Unmarshal([]byte(js), &args)
		if word == "tool" {
			tool = "overview"
		}
		f.emit(assistant([]any{map[string]any{"type": "tool_use", "id": "toolu_call", "name": "mcp__yoicks__" + tool, "input": args}}))
		res, isError, err := f.call(ctx, tool, "toolu_call", args)
		if err != nil {
			res = "the call failed: " + err.Error()
		}
		f.toolResult("toolu_call", res, isError)
		f.reply(ctx, "tool: "+res)
		return
	case "mcpfail": // a yoicks call failing in Claude Code itself: an error result, the bridge never called
		f.emit(assistant([]any{map[string]any{"type": "tool_use", "id": "toolu_lost_call", "name": "mcp__yoicks__overview", "input": map[string]any{}}}))
		f.toolResult("toolu_lost_call", "<tool_use_error>Error calling tool (overview): fake transport failure\nmore detail</tool_use_error>", true)
	case "slow", "hang":
		f.emit(assistant([]any{map[string]any{"type": "tool_use", "id": "toolu_slow", "name": "Bash", "input": map[string]any{"command": "sleep " + arg}}}))
		if word == "hang" {
			select {
			case <-ctx.Done():
				f.finish(ctx, aborted("aborted_tools"))
				return
			case <-release:
			}
		}
		for i := 1; i <= seconds; i++ {
			select {
			case <-ctx.Done():
				f.finish(ctx, aborted("aborted_tools"))
				return
			case <-time.After(time.Second):
			}
			f.emit(map[string]any{"type": "tool_progress", "tool_name": "Bash", "tool_use_id": "toolu_slow", "elapsed_time_seconds": i, "heartbeat": true, "session_id": f.id})
		}
		f.emit(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_slow", "content": "finished"}}}})
	}
	f.reply(ctx, "echo: "+text)
}

// finish emits the turn's terminal result as it stops being the running one, both under f.mu,
// so an interrupt lands wholly before (the turn ends aborted, whatever it was about to send) or
// wholly after (it overtakes the next queued message).
func (f *fake) finish(ctx context.Context, result map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancel = nil
	if ctx.Err() != nil && result["subtype"] == "success" {
		result = aborted("aborted_streaming")
	}
	result["session_id"] = f.id
	f.emit(result)
}

func assistant(content []any) map[string]any {
	return map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "model": "fake", "content": content,
		"usage": map[string]any{"input_tokens": 10, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 1990, "output_tokens": 5}}}
}

func (f *fake) reply(ctx context.Context, text string) {
	if ctx.Err() != nil {
		f.finish(ctx, aborted("aborted_streaming"))
		return
	}
	content := []any{map[string]any{"type": "text", "text": text}}
	f.emit(assistant(content))
	f.record(map[string]any{"type": "assistant", "message": map[string]any{"role": "assistant", "model": "fake", "content": content}})
	f.emit(map[string]any{"type": "rate_limit_event", "session_id": f.id, "rate_limit_info": map[string]any{"status": "allowed",
		"unifiedWindows": map[string]any{"five_hour": map[string]any{"utilization": 0.25, "resetsAt": 1795665000, "status": "allowed"},
			"seven_day": map[string]any{"utilization": 0.5, "resetsAt": 1795928400, "status": "allowed"}}}})
	if text == "echo: replyhold" {
		<-ctx.Done() // held in the window between a reply and its result until an interrupt (a test's cleanup ends a fake left waiting)
	}
	f.finish(ctx, map[string]any{"type": "result", "subtype": "success", "is_error": false, "terminal_reason": "completed", "result": text,
		"session_id": f.id, "modelUsage": map[string]any{"fake": map[string]any{"contextWindow": 200000}}})
}

func aborted(reason string) map[string]any {
	return map[string]any{"type": "result", "subtype": "error_during_execution", "is_error": true, "terminal_reason": reason}
}

// ask: an AskUserQuestion, then (as when the permission tool isn't used) a can_use_tool
// request on stdout, answered on stdin.
func (f *fake) ask(ctx context.Context) {
	input := map[string]any{"questions": []any{map[string]any{"question": "Which fruit?", "header": "Fruit", "multiSelect": false,
		"options": []any{map[string]any{"label": "apple", "description": "red"}, map[string]any{"label": "cherry", "description": ""}}}}}
	f.emit(assistant([]any{map[string]any{"type": "tool_use", "id": "toolu_ask", "name": "AskUserQuestion", "input": input}}))
	id := "fake-ask-" + strconv.Itoa(os.Getpid())
	ch := make(chan map[string]any, 1)
	f.mu.Lock()
	f.answers[id] = ch
	f.mu.Unlock()
	f.emit(map[string]any{"type": "control_request", "request_id": id, "request": map[string]any{
		"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": input, "tool_use_id": "toolu_ask"}})
	result := "no answer"
	select {
	case resp := <-ch:
		b, _ := json.Marshal(resp)
		result = string(b)
	case <-ctx.Done():
	case <-time.After(60 * time.Second):
	}
	f.emit(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "tool_result", "tool_use_id": "toolu_ask", "content": result}}}})
}
