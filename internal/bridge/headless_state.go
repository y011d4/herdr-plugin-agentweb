package bridge

// A headless orchestrator's stream (claude -p --output-format stream-json, measured on
// Claude Code 2.1.322): each stdout line → its status, completion count, usage and the
// warnings it raises. Pure (no I/O): headless.go feeds it the lines and acts on what
// apply reports (a reply to write, a failed init to stop on).

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"slices"
	"strings"
)

// verifiedClaudeVersion is the Claude Code version headless mode was checked against. Another
// one runs, with a warning.
const verifiedClaudeVersion = "2.1.322"

// headlessTools is the exact tool set a headless child must report at init.
var headlessTools = []string{"AskUserQuestion"}

// knownEvents is the stream's event types (Claude Code 2.1.322 and the Agent SDK's list),
// each with its known subtypes; nil = any subtype.
var knownEvents = map[string][]string{
	"system": {"init", "hook_started", "hook_progress", "hook_response", "thinking_tokens", "api_retry",
		"compact_boundary", "status", "local_command_output", "files_persisted", "task_started", "task_progress", "task_notification"},
	"result":    {"success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"},
	"assistant": nil, "user": nil, "rate_limit_event": nil, "tool_progress": nil, "stream_event": nil,
	"control_request": nil, "control_response": nil, "control_cancel_request": nil, "keep_alive": nil,
	"auth_status": nil, "tool_use_summary": nil, "prompt_suggestion": nil,
}

// warningActions is what the Home offers for each kind of warning (none for the rest).
var warningActions = map[string][]string{
	"silent": {"interrupt", "clear"}, "permission_route": {"interrupt"}, "stream_broken": {"clear", "tui"},
	"restart_limit": {"clear", "tui"}, "panic": {"clear", "tui"}, "init": {"tui"}, "billing": {"tui"}, "env": {"tui"},
	"auth": {"tui"}, "version": {"tui"}, "start": {"tui"},
}

// hlModel is what a headless child's stream has said so far.
type hlModel struct {
	Status        string
	CompletionSeq int64
	Usage         *HeadlessUsage
	inited        bool            // this child's first init was checked
	model         string          // the model of the last assistant message
	ctxTokens     float64         // its context: input + cache tokens
	unreadableRun int             // lines in a row that couldn't be read
	unknown       map[string]bool // event kinds already warned about this session
}

type hlWarning struct{ Kind, Message string }

// hlStep is what one line asks of the supervisor.
type hlStep struct {
	Warnings []hlWarning
	Fatal    string // the init check failed: stop the child (status error)
	Init     string // the first init's log line
	Reply    any    // a control_response to write back
	Acked    string // the request_id a control_response answered
	Log      string // a line for bridge.log (keys and kinds only, never content)
}

// apply reads one stdout line. now is ms.
func (m *hlModel) apply(line []byte, now int64) (st hlStep) {
	var ev map[string]any
	if json.Unmarshal(line, &ev) != nil || ev == nil {
		return m.unreadable(fmt.Sprintf("a line that isn't a JSON object (%d bytes)", len(line)))
	}
	typ, _ := ev["type"].(string)
	sub, _ := ev["subtype"].(string)
	kind := typ
	if sub != "" {
		kind += "/" + sub
	}
	if subs, known := knownEvents[typ]; !known || subs != nil && !slices.Contains(subs, sub) {
		m.unreadableRun = 0
		if m.unknown == nil {
			m.unknown = map[string]bool{}
		}
		if !m.unknown[kind] {
			m.unknown[kind] = true
			st.Warnings = []hlWarning{{"unknown_event", "Claude Code sent an event yoicks doesn't know (" + kind + "); it keeps running"}}
			st.Log = fmt.Sprintf("unknown event %s, keys %v", kind, slices.Sorted(maps.Keys(ev)))
		}
		return st
	}
	if f := missingField(typ, sub, ev); f != "" {
		return m.unreadable("a " + kind + " event without " + f)
	}
	m.unreadableRun = 0
	switch typ {
	case "system":
		if sub == "init" {
			m.Status = "working" // init opens every turn
			if !m.inited {
				m.inited = true
				return m.checkInit(ev)
			}
		}
	case "assistant":
		msg := ev["message"].(map[string]any)
		m.model, _ = msg["model"].(string)
		if u, ok := msg["usage"].(map[string]any); ok {
			m.ctxTokens = num(u["input_tokens"]) + num(u["cache_creation_input_tokens"]) + num(u["cache_read_input_tokens"])
		}
	case "result":
		if reason, _ := ev["terminal_reason"].(string); strings.HasPrefix(reason, "aborted") {
			m.Status = "idle" // interrupted: no completion to report
		} else {
			m.Status = "done"
			m.CompletionSeq++
		}
		usage, _ := ev["modelUsage"].(map[string]any)
		mu, _ := usage[m.model].(map[string]any)
		if len(usage) == 1 {
			for _, v := range usage {
				mu, _ = v.(map[string]any)
			}
		}
		if window := num(mu["contextWindow"]); window > 0 && m.ctxTokens > 0 {
			m.usage().ContextPct = new(math.Round(1000*m.ctxTokens/window) / 10)
		}
	case "rate_limit_event":
		windows, _ := ev["rate_limit_info"].(map[string]any)["unifiedWindows"].(map[string]any)
		read := func(name string) *UsageWindow {
			w, ok := windows[name].(map[string]any)
			if !ok {
				return nil
			}
			return &UsageWindow{Utilization: num(w["utilization"]), ResetsAt: int64(num(w["resetsAt"])) * 1000}
		}
		u := m.usage()
		u.FiveHour, u.SevenDay, u.At = read("five_hour"), read("seven_day"), now
	case "control_request":
		id := ev["request_id"]
		req := ev["request"].(map[string]any)
		if req["subtype"] == "can_use_tool" {
			// the permission tool is the documented route; this one is answered so the turn goes on
			tool, _ := req["tool_name"].(string)
			st.Warnings = []hlWarning{{"permission_route", "a permission request (" + tool + ") came over stdio instead of the permission tool; it was denied"}}
			st.Log = "can_use_tool " + tool + ": denied"
			st.Reply = controlResponse(id, map[string]any{"subtype": "success", "response": map[string]any{
				"behavior": "deny", "message": "yoicks: permission requests go through the permission tool; denied"}})
		} else {
			st.Log = fmt.Sprintf("control_request %v: answered with an error", req["subtype"])
			st.Reply = controlResponse(id, map[string]any{"subtype": "error", "error": fmt.Sprintf("yoicks: unsupported control request %v", req["subtype"])})
		}
	case "control_response":
		st.Acked, _ = ev["response"].(map[string]any)["request_id"].(string)
	}
	return st
}

// checkInit checks a child's first init: never billed by an API key, and exactly the tools
// it was given.
func (m *hlModel) checkInit(ev map[string]any) (st hlStep) {
	source, _ := ev["apiKeySource"].(string)
	var tools []string
	for _, t := range ev["tools"].([]any) {
		s, _ := t.(string)
		tools = append(tools, s)
	}
	version, _ := ev["claude_code_version"].(string)
	st.Init = fmt.Sprintf("init session=%v version=%s apiKeySource=%s tools=%v", ev["session_id"], version, source, tools)
	switch {
	case source != "none":
		st.Fatal = "init: apiKeySource is " + source + ", not none (it would bill an API key); stopped"
	case !slices.Equal(slices.Sorted(slices.Values(tools)), headlessTools):
		st.Fatal = fmt.Sprintf("init: tools %v, not %v; stopped", tools, headlessTools)
	}
	if version != verifiedClaudeVersion {
		st.Warnings = []hlWarning{{"version", "Claude Code " + version + " is not verified (verified: " + verifiedClaudeVersion + "); it keeps running"}}
	}
	return st
}

// unreadable counts a line that couldn't be read: a warning for each of the first three in
// a row, the third escalated.
func (m *hlModel) unreadable(what string) (st hlStep) {
	m.unreadableRun++
	if m.unreadableRun > 3 {
		return st
	}
	st.Log = "unreadable: " + what
	st.Warnings = []hlWarning{{"unreadable", "Claude Code sent " + what + "; it keeps running"}}
	if m.unreadableRun == 3 {
		st.Warnings = append(st.Warnings, hlWarning{"stream_broken", "3 lines in a row couldn't be read: reading the headless stream is broken (did Claude Code change?)"})
	}
	return st
}

// missingField is a required field a known event lacks ("" = none).
func missingField(typ, sub string, ev map[string]any) string {
	isObj := func(v any) bool { _, ok := v.(map[string]any); return ok }
	isStr := func(v any) bool { _, ok := v.(string); return ok }
	switch {
	case typ == "system" && sub == "init":
		if _, ok := ev["tools"].([]any); !ok {
			return "tools"
		}
		if !isStr(ev["apiKeySource"]) {
			return "apiKeySource"
		}
	case typ == "assistant" || typ == "user":
		if !isObj(ev["message"]) {
			return "message"
		}
	case typ == "rate_limit_event":
		if !isObj(ev["rate_limit_info"]) {
			return "rate_limit_info"
		}
	case typ == "control_request":
		if !isStr(ev["request_id"]) || !isObj(ev["request"]) {
			return "request_id/request"
		}
	case typ == "control_response":
		if !isObj(ev["response"]) {
			return "response"
		}
	}
	return ""
}

func (m *hlModel) usage() *HeadlessUsage {
	if m.Usage == nil {
		m.Usage = &HeadlessUsage{}
	}
	return m.Usage
}

func num(v any) float64 { f, _ := v.(float64); return f }

func controlResponse(id any, response map[string]any) map[string]any {
	response["request_id"] = id
	return map[string]any{"type": "control_response", "response": response}
}
