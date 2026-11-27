package bridge

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

// Lines in the shapes Claude Code 2.1.322 sent in S0 (.omc/headless/s0/logs), scrubbed:
// ids, paths, plugin lists and rate values replaced, the rest of each event cut.
const (
	lineInit      = `{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001","cwd":"/home/u/orch","tools":["AskUserQuestion"],"mcp_servers":[],"model":"claude-haiku-5-5","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.322","capabilities":["interrupt_receipt_v1"],"uuid":"u1"}`
	lineHook      = `{"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"SessionStart:startup","hook_event":"SessionStart","session_id":"00000000-0000-4000-8000-000000000001","uuid":"u2"}`
	lineThinking  = `{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"estimated_tokens_delta":50,"session_id":"00000000-0000-4000-8000-000000000001","uuid":"u3"}`
	lineAssistant = `{"type":"assistant","message":{"model":"claude-haiku-5-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"OK"}],"stop_reason":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":22468,"cache_read_input_tokens":5165,"output_tokens":4}},"parent_tool_use_id":null,"session_id":"00000000-0000-4000-8000-000000000001","uuid":"u4"}`
	lineProgress  = `{"type":"tool_progress","tool_name":"mcp__yoicks__slow","tool_use_id":"toolu_1-heartbeat-0","parent_tool_use_id":"toolu_1","elapsed_time_seconds":30,"heartbeat":true,"session_id":"00000000-0000-4000-8000-000000000001","uuid":"u5"}`
	lineRateLimit = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","resetsAt":1795928400,"unifiedWindows":{"five_hour":{"resetsAt":1795665000,"status":"allowed","utilization":0.35},"seven_day":{"resetsAt":1795928400,"status":"allowed_warning","surpassedThreshold":0.75,"utilization":0.79},"seven_day_overage_included":{"resetsAt":1795928400,"status":"allowed","utilization":0.04}},"utilization":0.79},"session_id":"00000000-0000-4000-8000-000000000001","uuid":"u6"}`
	lineResult    = `{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","stop_reason":"end_turn","num_turns":1,"result":"OK","modelUsage":{"claude-haiku-5-5":{"contextWindow":1000000,"inputTokens":2,"outputTokens":4}},"session_id":"00000000-0000-4000-8000-000000000001","uuid":"u7"}`
	lineAborted   = `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_tools","stop_reason":"tool_use","errors":["[ede_diagnostic] result_type=user"],"session_id":"00000000-0000-4000-8000-000000000001","uuid":"u8"}`
	lineIntAck    = `{"type":"control_response","response":{"request_id":"yoicks-interrupt-1","response":{"still_queued":[]},"subtype":"success"}}`
	lineCanUse    = `{"type":"control_request","request_id":"c1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[]},"tool_use_id":"toolu_2","requires_user_interaction":true}}`
)

func applyAll(m *hlModel, lines ...string) []hlStep {
	var steps []hlStep
	for _, l := range lines {
		steps = append(steps, m.apply([]byte(l), 1795478400000))
	}
	return steps
}

func warningKinds(steps []hlStep) []string {
	kinds := []string{}
	for _, s := range steps {
		for _, w := range s.Warnings {
			kinds = append(kinds, w.Kind)
		}
	}
	return kinds
}

func TestHeadlessStream(t *testing.T) {
	t.Run("a turn: init makes it working, the result done and counts a completion", func(t *testing.T) {
		m := hlModel{Status: "idle"}
		steps := applyAll(&m, lineInit, lineHook, lineThinking, lineAssistant, lineProgress)
		if m.Status != "working" || m.CompletionSeq != 0 || steps[0].Fatal != "" || !strings.Contains(steps[0].Init, "apiKeySource=none") {
			t.Fatalf("after init: %+v %+v", m, steps[0])
		}
		applyAll(&m, lineRateLimit, lineResult)
		if m.Status != "done" || m.CompletionSeq != 1 {
			t.Fatalf("after result: %+v", m)
		}
		applyAll(&m, lineInit, lineAssistant, lineResult)
		if m.CompletionSeq != 2 {
			t.Errorf("second turn: seq %d", m.CompletionSeq)
		}
		if k := warningKinds(steps); len(k) != 0 {
			t.Errorf("warnings %v", k)
		}
	})

	t.Run("an interrupted turn ends idle, with no completion", func(t *testing.T) {
		m := hlModel{}
		applyAll(&m, lineInit, lineAssistant, lineAborted)
		if m.Status != "idle" || m.CompletionSeq != 0 {
			t.Errorf("%+v", m)
		}
	})

	t.Run("usage: the rate limits, and the context of the last message", func(t *testing.T) {
		m := hlModel{}
		applyAll(&m, lineInit, lineAssistant, lineRateLimit, lineResult)
		u := m.Usage
		if u == nil || u.FiveHour == nil || u.FiveHour.Utilization != 0.35 || u.FiveHour.ResetsAt != 1795665000000 ||
			u.SevenDay == nil || u.SevenDay.Utilization != 0.79 || u.Fable == nil || u.Fable.Utilization != 0.04 ||
			u.Fable.ResetsAt != 1795928400000 || u.At != 1795478400000 {
			t.Fatalf("usage %+v", u)
		}
		// (2 + 22468 + 5165) / 1,000,000
		if u.ContextPct == nil || *u.ContextPct != 2.8 {
			t.Errorf("contextPct %v", u.ContextPct)
		}
	})

	t.Run("the first init must be unbilled and have exactly its tools; a newer version only warns", func(t *testing.T) {
		for _, c := range []struct{ name, from, to, fatal string }{
			{"api key", `"apiKeySource":"none"`, `"apiKeySource":"ANTHROPIC_API_KEY"`, "apiKeySource is ANTHROPIC_API_KEY"},
			{"more tools", `"tools":["AskUserQuestion"]`, `"tools":["AskUserQuestion","Bash"]`, "tools [AskUserQuestion Bash]"},
			{"no tools", `"tools":["AskUserQuestion"]`, `"tools":[]`, "tools []"},
		} {
			m := hlModel{}
			st := m.apply([]byte(strings.Replace(lineInit, c.from, c.to, 1)), 0)
			if !strings.Contains(st.Fatal, c.fatal) {
				t.Errorf("%s: fatal %q", c.name, st.Fatal)
			}
		}
		m := hlModel{}
		st := m.apply([]byte(strings.Replace(lineInit, `"2.1.322"`, `"2.2.0"`, 1)), 0)
		if st.Fatal != "" || warningKinds([]hlStep{st})[0] != "version" {
			t.Errorf("version: %+v", st)
		}
		// later inits (each turn has one) aren't checked again
		if st := m.apply([]byte(strings.Replace(lineInit, `"apiKeySource":"none"`, `"apiKeySource":"x"`, 1)), 0); st.Fatal != "" {
			t.Errorf("second init: %+v", st)
		}
	})

	t.Run("an unknown type or subtype warns once per kind, and the stream goes on", func(t *testing.T) {
		m := hlModel{}
		steps := applyAll(&m, `{"type":"mystery"}`, `{"type":"mystery"}`, `{"type":"system","subtype":"brand_new"}`, lineInit)
		if k := warningKinds(steps); !slices.Equal(k, []string{"unknown_event", "unknown_event"}) {
			t.Errorf("warnings %v", k)
		}
		if !strings.Contains(steps[2].Warnings[0].Message, "system/brand_new") || !strings.Contains(steps[0].Log, "keys [type]") {
			t.Errorf("%+v", steps)
		}
		if m.Status != "working" {
			t.Errorf("status %s", m.Status)
		}
	})

	t.Run("unreadable lines warn, three in a row escalate, then it's quiet until a good line", func(t *testing.T) {
		m := hlModel{}
		steps := applyAll(&m, "not json", `[1]`, `{"type":"assistant"}`, "again", lineHook, "once more")
		if k := warningKinds(steps); !slices.Equal(k, []string{"unreadable", "unreadable", "unreadable", "stream_broken", "unreadable"}) {
			t.Errorf("warnings %v", k)
		}
		if !strings.Contains(steps[2].Warnings[0].Message, "assistant event without message") || strings.Contains(steps[0].Log, "not json") {
			t.Errorf("%+v", steps[:3])
		}
	})

	t.Run("a can_use_tool over stdio goes to the supervisor, warned about; another request gets an error", func(t *testing.T) {
		m := hlModel{}
		st := m.apply([]byte(lineCanUse), 0)
		if cu := st.CanUse; cu == nil || cu.RequestID != "c1" || cu.Tool != "AskUserQuestion" || cu.ToolUseID != "toolu_2" || cu.Input == nil ||
			st.Reply != nil || warningKinds([]hlStep{st})[0] != "permission_route" {
			t.Errorf("%+v", st)
		}
		st = m.apply([]byte(`{"type":"control_request","request_id":"c2","request":{"subtype":"mcp_message"}}`), 0)
		reply, _ := json.Marshal(st.Reply)
		if !strings.Contains(string(reply), `"subtype":"error"`) || !strings.Contains(string(reply), `"request_id":"c2"`) {
			t.Errorf("%s", reply)
		}
	})

	t.Run("an AskUserQuestion in the stream is reported (to check it reaches the Home)", func(t *testing.T) {
		m := hlModel{}
		st := m.apply([]byte(`{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"let me ask"},{"type":"tool_use","id":"toolu_9","name":"AskUserQuestion","input":{}}]}}`), 0)
		if st.Ask != "toolu_9" {
			t.Errorf("%+v", st)
		}
	})

	t.Run("with the bridge's tools: init must list them and have yoicks connected", func(t *testing.T) {
		tools := headlessTools(true)
		good := strings.Replace(strings.Replace(lineInit, `"tools":["AskUserQuestion"]`, `"tools":["mcp__yoicks__overview","mcp__yoicks__agent_get","mcp__yoicks__agent_read","mcp__yoicks__agent_prompt","mcp__yoicks__agent_start","mcp__yoicks__worktree_remove","AskUserQuestion"]`, 1),
			`"mcp_servers":[]`, `"mcp_servers":[{"name":"yoicks","source":"dynamic","status":"connected"}]`, 1)
		for line, fatal := range map[string]string{
			good: "",
			strings.Replace(good, `"status":"connected"`, `"status":"failed"`, 1): "isn't connected",
			strings.Replace(good, `"mcp__yoicks__overview",`, ``, 1):              "tools",
			lineInit: "tools",
		} {
			m := hlModel{expectTools: tools, expectMCP: true}
			if st := m.apply([]byte(line), 0); !strings.Contains(st.Fatal, fatal) || fatal == "" && st.Fatal != "" {
				t.Errorf("%s: fatal %q", line, st.Fatal)
			}
		}
	})

	t.Run("a control_response names the request it answers", func(t *testing.T) {
		m := hlModel{}
		if st := m.apply([]byte(lineIntAck), 0); st.Acked != "yoicks-interrupt-1" || st.AckError != "" {
			t.Errorf("%+v", st)
		}
		// set_model's refusal, as 2.1.322 answers an unknown model
		if st := m.apply([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"yoicks-model-2","error":"Model 'x' not found","error_code":"not_found","model":"claude-haiku-5-5"}}`), 0); st.Acked != "yoicks-model-2" || st.AckError != "Model 'x' not found" {
			t.Errorf("%+v", st)
		}
	})

	t.Run("the initialize answer lists the models (values fit for --model only, not default); no other answer does", func(t *testing.T) {
		m := hlModel{}
		models := `"models":[{"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default (recommended)","description":"Opus 5.5 · Best for everyday, complex tasks","supportsEffort":true},` +
			`{"value":"--dangerously-skip-permissions","displayName":"x"},{"value":"claude-haiku-4-5-20251001","resolvedModel":"claude-haiku-4-5-20251001","displayName":"Haiku 4.5","description":"Fastest"}]`
		m.apply([]byte(`{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{`+models+`}}}`), 0)
		if m.models != nil {
			t.Errorf("another answer: %+v", m.models)
		}
		m.apply([]byte(`{"type":"control_response","response":{"subtype":"success","request_id":"yoicks-init","response":{"commands":[],`+models+`,"account":{"email":"someone@example.com"}}}}`), 0)
		want := []HeadlessModel{{"claude-haiku-4-5-20251001", "Haiku 4.5", "Fastest", "claude-haiku-4-5-20251001"}}
		if !slices.Equal(m.models, want) {
			t.Errorf("models %+v", m.models)
		}
	})

	t.Run("the model in effect: get_settings' answer, set_model's, each init; not a refusal or a synthetic message", func(t *testing.T) {
		m := hlModel{}
		active := func(line, want string) {
			t.Helper()
			m.apply([]byte(line), 0)
			if m.active != want {
				t.Errorf("%s: active %q, want %q", line, m.active, want)
			}
		}
		active(`{"type":"control_response","response":{"subtype":"success","request_id":"yoicks-settings","response":{"effective":{},"sources":[],"applied":{"model":"claude-fable-5-2","effort":"medium"}}}}`, "claude-fable-5-2")
		active(`{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"You've reached your Fable limit."}]}}`, "claude-fable-5-2")
		active(`{"type":"control_response","response":{"subtype":"error","request_id":"yoicks-model-1","error":"Model 'x' not found","model":"claude-fable-5-2"}}`, "claude-fable-5-2")
		active(`{"type":"control_response","response":{"subtype":"success","request_id":"yoicks-model-2","response":{"model":"claude-opus-5-5"}}}`, "claude-opus-5-5")
		active(lineInit, "claude-haiku-5-5")
	})

	t.Run("a yoicks tool's result is reported with its tool_use, an error's first line with it (or that it has none)", func(t *testing.T) {
		m := hlModel{}
		use := `{"type":"assistant","message":{"model":"m","content":[{"type":"tool_use","id":"toolu_y1","name":"mcp__yoicks__overview","input":{}},` +
			`{"type":"tool_use","id":"toolu_y2","name":"mcp__yoicks__agent_get","input":{}},{"type":"tool_use","id":"toolu_y3","name":"mcp__yoicks__agent_read","input":{}},` +
			`{"type":"tool_use","id":"toolu_b1","name":"Bash","input":{}}]}}`
		results := `{"type":"user","message":{"role":"user","content":[` +
			`{"type":"tool_result","tool_use_id":"toolu_y1","is_error":true,"content":"<tool_use_error>Error calling tool (overview): HTTP 401\nmore</tool_use_error>"},` +
			`{"type":"tool_result","tool_use_id":"toolu_y2","content":[{"type":"text","text":"{}"}]},` +
			`{"type":"tool_result","tool_use_id":"toolu_y3","is_error":true,"content":"  \n"},` +
			`{"type":"tool_result","tool_use_id":"toolu_b1","is_error":true,"content":"no"}]}}`
		steps := applyAll(&m, lineInit, use, results, results)
		want := []hlToolResult{{ID: "toolu_y1", Tool: "overview", IsError: true, Error: "Error calling tool (overview): HTTP 401"},
			{ID: "toolu_y2", Tool: "agent_get"}, {ID: "toolu_y3", Tool: "agent_read", IsError: true, Error: "no error text"}}
		if !slices.Equal(steps[2].Results, want) || len(steps[3].Results) != 0 || len(m.yoicksUses) != 0 {
			t.Errorf("results %+v, then %+v; left %v", steps[2].Results, steps[3].Results, m.yoicksUses)
		}
	})
}
