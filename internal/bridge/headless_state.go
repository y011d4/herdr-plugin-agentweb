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
	"regexp"
	"slices"
	"strings"
	"time"
)

// verifiedClaudeVersion is the Claude Code version headless mode was checked against. Another
// one runs, with a warning.
const verifiedClaudeVersion = "2.1.322"

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
	"auth": {"tui"}, "version": {"tui"}, "start": {"tui"}, "question_route": {"interrupt"},
	"mcp_call": {"clear"}, "canary": {"tui"},
}

// hlModel is what a headless child's stream has said so far.
type hlModel struct {
	Status        string
	CompletionSeq int64
	Usage         *HeadlessUsage
	expectTools   []string          // the exact tools its init must report (nil: AskUserQuestion)
	expectMCP     bool              // and the yoicks MCP server connected
	inited        bool              // this child's first init was checked
	model         string            // the model of the last assistant message
	ctxTokens     float64           // its context: input + cache tokens
	unreadableRun int               // lines in a row that couldn't be read
	unknown       map[string]bool   // event kinds already warned about this session
	yoicksUses    map[string]string // the yoicks tool_use ids awaiting their result → the tool
	check         *ClaudeCheck      // the last claude check (the version warning tells it)
	version       string            // the Claude Code version it last reported (the version warning's)
	models        []HeadlessModel   // the models Claude Code offers (its answer to initRequest)
	// the model in effect, Claude Code's id: get_settings' answer at the start, set_model's, each
	// turn's init. A resumed session keeps the model it last ran on, whatever the default says.
	active string
}

// initRequest is the request_id of the initialize control request each child gets at its start:
// its answer lists the models Claude Code offers this account (and the account's email: only
// the models are read).
const initRequest = "yoicks-init"

// settingsRequest is the get_settings control request each child gets at its start: its answer's
// applied.model is the model in effect, known before any turn.
const settingsRequest = "yoicks-settings"

// modelRe is a model value fit for --model: one of Claude Code's aliases or ids (opus,
// claude-opus-4-8, opus[1m]), never a flag.
var modelRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$`)

type hlWarning struct{ Kind, Message string }

// hlStep is what one line asks of the supervisor.
type hlStep struct {
	Warnings []hlWarning
	Fatal    string // the init check failed: stop the child (status error)
	Init     string // the first init's log line
	Reply    any    // a control_response to write back
	Acked    string // the request_id a control_response answered
	AckError string // its error, when it is one
	Log      string // a line for bridge.log (keys and kinds only, never content)
	Ask      string // the tool_use id of an AskUserQuestion it asked
	CanUse   *hlCanUse
	Results  []hlToolResult // the yoicks tools' results it carries
}

// hlToolResult is a yoicks tool's result in the stream: its tool_use id, the tool, whether it
// is an error, and then the first line of its text.
type hlToolResult struct {
	ID, Tool string
	IsError  bool
	Error    string
}

// hlCanUse is a permission request over stdio (can_use_tool), which the supervisor answers.
type hlCanUse struct {
	RequestID any
	Tool      string
	ToolUseID string
	Input     map[string]any
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
			if model, _ := ev["model"].(string); model != "" {
				m.active = model
			}
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
		content, _ := msg["content"].([]any)
		for _, b := range content {
			b, _ := b.(map[string]any)
			name, _ := b["name"].(string)
			id, _ := b["id"].(string)
			switch {
			case b["type"] != "tool_use":
			case name == "AskUserQuestion":
				st.Ask = id
			case strings.HasPrefix(name, "mcp__yoicks__") && id != "":
				if m.yoicksUses == nil {
					m.yoicksUses = map[string]string{}
				}
				m.yoicksUses[id] = strings.TrimPrefix(name, "mcp__yoicks__")
			}
		}
	case "user":
		content, _ := ev["message"].(map[string]any)["content"].([]any)
		for _, b := range content {
			b, _ := b.(map[string]any)
			id, _ := b["tool_use_id"].(string)
			tool, ours := m.yoicksUses[id]
			if b["type"] != "tool_result" || !ours {
				continue
			}
			delete(m.yoicksUses, id)
			res := hlToolResult{ID: id, Tool: tool, IsError: b["is_error"] == true}
			if res.IsError {
				text := strings.NewReplacer("<tool_use_error>", "", "</tool_use_error>", "").Replace(toolResultText(b["content"]))
				first, _, _ := strings.Cut(strings.TrimSpace(text), "\n")
				res.Error, _ = truncateUnits(firstNonEmpty(strings.TrimSpace(first), "no error text"), 200)
			}
			st.Results = append(st.Results, res)
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
		u.FiveHour, u.SevenDay, u.Fable, u.At = read("five_hour"), read("seven_day"), read("seven_day_overage_included"), now
	case "control_request":
		id := ev["request_id"]
		req := ev["request"].(map[string]any)
		if req["subtype"] == "can_use_tool" {
			// the permission tool is the documented route; this one is answered as it would be
			cu := &hlCanUse{RequestID: id}
			cu.Tool, _ = req["tool_name"].(string)
			cu.ToolUseID, _ = req["tool_use_id"].(string)
			cu.Input, _ = req["input"].(map[string]any)
			st.CanUse = cu
			st.Warnings = []hlWarning{{"permission_route", "a permission request (" + cu.Tool + ") came over stdio instead of the permission tool"}}
			st.Log = "can_use_tool " + cu.Tool
		} else {
			st.Log = fmt.Sprintf("control_request %v: answered with an error", req["subtype"])
			st.Reply = controlResponse(id, map[string]any{"subtype": "error", "error": fmt.Sprintf("yoicks: unsupported control request %v", req["subtype"])})
		}
	case "control_response":
		resp := ev["response"].(map[string]any)
		st.Acked, _ = resp["request_id"].(string)
		if resp["subtype"] == "error" {
			st.AckError, _ = resp["error"].(string)
			st.AckError = firstNonEmpty(st.AckError, "an error")
		}
		inner, _ := resp["response"].(map[string]any)
		applied, _ := inner["applied"].(map[string]any)
		for _, model := range []any{inner["model"], applied["model"]} { // set_model's answer, get_settings'
			if model, _ := model.(string); model != "" && st.AckError == "" {
				m.active = model
			}
		}
		if list, ok := inner["models"].([]any); ok && st.Acked == initRequest {
			m.models = nil
			var def *HeadlessModel
			for _, it := range list {
				it, _ := it.(map[string]any)
				str := func(k string) string { s, _ := it[k].(string); return s }
				model := HeadlessModel{str("value"), str("displayName"), str("description"), str("resolvedModel")}
				switch {
				case model.Value == "default": // not offered as such: the Home offers the models themselves
					def = &model
				case modelRe.MatchString(model.Value):
					m.models = append(m.models, model)
				}
			}
			// the default's model stays pickable when no other entry stands for it: as its own id,
			// named by its description's head ("Opus 5.5 · Best for …")
			if def != nil && modelRe.MatchString(def.ResolvedModel) &&
				!slices.ContainsFunc(m.models, func(x HeadlessModel) bool { return x.ResolvedModel == def.ResolvedModel }) {
				name, _, _ := strings.Cut(def.Description, " · ")
				m.models = append([]HeadlessModel{{def.ResolvedModel, firstNonEmpty(name, def.ResolvedModel), def.Description, def.ResolvedModel}}, m.models...)
			}
		}
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
	m.version = version
	want := m.expectTools
	if want == nil {
		want = []string{"AskUserQuestion"}
	}
	connected := false
	servers, _ := ev["mcp_servers"].([]any)
	for _, s := range servers {
		if s, _ := s.(map[string]any); s["name"] == "yoicks" && s["status"] == "connected" {
			connected = true
		}
	}
	st.Init = fmt.Sprintf("init session=%v version=%s apiKeySource=%s tools=%v mcp=%v", ev["session_id"], version, source, tools, connected)
	switch {
	case source != "none":
		st.Fatal = "init: apiKeySource is " + source + ", not none (it would bill an API key); stopped"
	case !slices.Equal(slices.Sorted(slices.Values(tools)), slices.Sorted(slices.Values(want))):
		st.Fatal = fmt.Sprintf("init: tools %v, not %v; stopped", tools, want)
	case m.expectMCP && !connected:
		st.Fatal = "init: the yoicks MCP server isn't connected; stopped"
	}
	if version != verifiedClaudeVersion {
		st.Warnings = []hlWarning{{"version", versionWarning(version, m.check)}}
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

// versionWarning is the warning for a Claude Code version headless wasn't verified on, with
// the last check's result (check nil: none has run).
func versionWarning(version string, check *ClaudeCheck) string {
	last := "no check has run (scripts/claude-canary.sh)"
	if check != nil {
		last = "the last check " + check.describe()
	}
	return "Claude Code " + version + " is not verified (verified: " + verifiedClaudeVersion + "); it keeps running; " + last
}

// describe is how the check went, when, and on which version.
func (c *ClaudeCheck) describe() string {
	when := time.UnixMilli(c.At).Format("2006-01-02 15:04")
	if c.OK {
		return "passed on " + when + " (" + c.Version + ")"
	}
	return "failed on " + when + " (" + c.Version + ": " + strings.Join(c.Failed, ", ") + ")"
}
