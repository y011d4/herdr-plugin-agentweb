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
	lineRateLimit = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"seven_day","resetsAt":1795928400,"unifiedWindows":{"five_hour":{"resetsAt":1795665000,"status":"allowed","utilization":0.35},"seven_day":{"resetsAt":1795928400,"status":"allowed_warning","surpassedThreshold":0.75,"utilization":0.79}},"utilization":0.79},"session_id":"00000000-0000-4000-8000-000000000001","uuid":"u6"}`
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
			u.SevenDay == nil || u.SevenDay.Utilization != 0.79 || u.At != 1795478400000 {
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

	t.Run("a can_use_tool over stdio is denied and warned about; another request gets an error", func(t *testing.T) {
		m := hlModel{}
		st := m.apply([]byte(lineCanUse), 0)
		reply, _ := json.Marshal(st.Reply)
		if !strings.Contains(string(reply), `"behavior":"deny"`) || !strings.Contains(string(reply), `"request_id":"c1"`) ||
			warningKinds([]hlStep{st})[0] != "permission_route" {
			t.Errorf("%s %+v", reply, st)
		}
		st = m.apply([]byte(`{"type":"control_request","request_id":"c2","request":{"subtype":"mcp_message"}}`), 0)
		reply, _ = json.Marshal(st.Reply)
		if !strings.Contains(string(reply), `"subtype":"error"`) || !strings.Contains(string(reply), `"request_id":"c2"`) {
			t.Errorf("%s", reply)
		}
	})

	t.Run("a control_response names the request it answers", func(t *testing.T) {
		m := hlModel{}
		if st := m.apply([]byte(lineIntAck), 0); st.Acked != "yoicks-interrupt-1" {
			t.Errorf("%+v", st)
		}
	})
}
