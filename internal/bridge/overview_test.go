package bridge

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestOverview(t *testing.T) {
	now := time.Date(2026, 11, 23, 12, 0, 0, 0, time.UTC).UnixMilli()
	snapshot := OverviewSnapshot{
		Workspaces: []RawWorkspace{{WorkspaceID: "w1", Label: "repo"}},
		Tabs:       []RawTab{{TabID: "t1", Label: json.RawMessage(`"fix-auth"`)}},
	}
	agent := func(paneID, status string) OverviewAgent {
		return OverviewAgent{PaneID: paneID, AgentStatus: &status, WorkspaceID: "w1", TabID: "t1"}
	}
	user := func(text string) TimelineItem { return TimelineItem{Kind: "user", Text: text} }
	asst := func(text string) TimelineItem { return TimelineItem{Kind: "assistant", Text: text} }
	tool := func(name, summary string) TimelineItem {
		return TimelineItem{Kind: "tool_use", ID: "x", Name: name, Summary: summary}
	}
	run := func(agents []OverviewAgent, details map[string]AgentDetail, self string) string {
		return formatOverview(agents, snapshot, details, self, now)
	}
	matches := func(t *testing.T, out, re string) {
		t.Helper()
		if !regexp.MustCompile(re).MatchString(out) {
			t.Errorf("%q does not match /%s/", out, re)
		}
	}
	noMatch := func(t *testing.T, out, re string) {
		t.Helper()
		if regexp.MustCompile(re).MatchString(out) {
			t.Errorf("%q matches /%s/", out, re)
		}
	}

	t.Run("formatOverview", func(t *testing.T) {
		t.Run(`prints "no other agents" when only the caller exists`, func(t *testing.T) {
			if got := run(nil, nil, ""); got != "no other agents" {
				t.Errorf("got %q", got)
			}
			if got := run([]OverviewAgent{agent("p0", "working")}, nil, "p0"); got != "no other agents" {
				t.Errorf("got %q", got)
			}
		})

		t.Run("orders blocked, working, done, idle, unknown (stable) and skips the caller", func(t *testing.T) {
			out := run([]OverviewAgent{
				agent("a", "idle"), agent("b", "unknown"), agent("c", "done"), agent("self", "blocked"),
				agent("d", "working"), agent("e", "blocked"), agent("f", "idle"), agent("g", "weird"),
			}, nil, "self")
			var names []string
			for _, l := range strings.Split(out, "\n") {
				if !strings.HasPrefix(l, " ") {
					names = append(names, strings.Split(l, "  ")[0])
				}
			}
			if !slices.Equal(names, []string{"e", "d", "c", "a", "f", "b", "g"}) {
				t.Errorf("got %q", names)
			}
		})

		t.Run("renders the header with name, labels, pane and last activity", func(t *testing.T) {
			a := agent("p2", "blocked")
			a.Name = "w-fix-auth"
			ts := now - 3*60_000
			out := run([]OverviewAgent{a}, map[string]AgentDetail{"p2": {Items: []TimelineItem{{Kind: "assistant", Text: "hi", TS: &ts}}}}, "")
			if got := strings.Split(out, "\n")[0]; got != "w-fix-auth  blocked  repo › fix-auth  (pane p2, last activity 3m ago)" {
				t.Errorf("got %q", got)
			}
		})

		t.Run("falls back to the pane id and omits unknown activity", func(t *testing.T) {
			if got := run([]OverviewAgent{agent("p2", "idle")}, nil, ""); got != "p2  idle  repo › fix-auth  (pane p2)" {
				t.Errorf("got %q", got)
			}
		})

		t.Run("names the launch dir", func(t *testing.T) {
			a := agent("p2", "idle")
			a.Cwd = "/src/repo"
			if got := run([]OverviewAgent{a}, nil, ""); got != "p2  idle  repo › fix-auth  (pane p2 in /src/repo)" {
				t.Errorf("got %q", got)
			}
		})

		t.Run("picks the last real user task and last main-thread assistant text", func(t *testing.T) {
			subTask, subReply := user("sub task"), asst("sub reply")
			subTask.Sidechain, subReply.Sidechain = true, true
			out := run([]OverviewAgent{agent("p", "idle")}, map[string]AgentDetail{"p": {Items: []TimelineItem{
				user("the real task"), asst("older reply"), asst("main reply"),
				user("<task-notification>done</task-notification>"), user("  <system-reminder>x"),
				subTask, subReply,
			}}}, "")
			matches(t, out, `\n {2}task: the real task\n`)
			matches(t, out, `\n {2}last: main reply$`)
		})

		t.Run("shows the call still open in this turn, not just the final item (parallel calls)", func(t *testing.T) {
			res := func(forID string) TimelineItem {
				return TimelineItem{Kind: "tool_result", ForID: &forID, Text: "ok"}
			}
			call := func(id, name string) TimelineItem {
				return TimelineItem{Kind: "tool_use", ID: id, Name: name, Summary: id}
			}
			with := func(status string, items ...TimelineItem) string {
				return run([]OverviewAgent{agent("p", status)}, map[string]AgentDetail{"p": {Items: items}}, "")
			}
			matches(t, with("blocked", user("t"), call("a", "Bash"), call("b", "Edit"), res("b")), `\n {2}pending: Bash a$`)
			noMatch(t, with("working", user("t"), call("a", "Bash"), res("a")), `doing`)
			// an injected turn doesn't end the turn
			matches(t, with("blocked", user("t"), call("a", "Bash"), call("b", "Edit"), res("b"), user("<task-notification>bg done</task-notification>")), `\n {2}pending: Bash a$`)
			// an earlier turn's unanswered call
			noMatch(t, with("working", user("t"), call("old", "Bash"), user("next"), asst("thinking about it")), `doing`)
		})

		t.Run("falls back to an older task found beyond the tail window", func(t *testing.T) {
			out := run([]OverviewAgent{agent("p", "working")}, map[string]AgentDetail{"p": {Items: []TimelineItem{asst("still going")}, OlderTask: "refactor the parser"}}, "")
			matches(t, out, `\n {2}task: refactor the parser\n`)
		})

		t.Run(`counts user text that merely starts with "<" (pastes, HTML) as the task`, func(t *testing.T) {
			for _, text := range []string{"<pasted_content>stack trace</pasted_content>", "<div> is broken"} {
				out := run([]OverviewAgent{agent("p", "idle")}, map[string]AgentDetail{"p": {Items: []TimelineItem{user("older"), user(text), user("<command-name>/clear</command-name>")}}}, "")
				if !strings.Contains(out, "  task: "+text) {
					t.Error(out)
				}
			}
		})

		t.Run(`adds "doing" for a working agent whose latest item is a tool_use`, func(t *testing.T) {
			items := map[string]AgentDetail{"p": {Items: []TimelineItem{user("t"), asst("looking"), tool("Bash", "npm test")}}}
			matches(t, run([]OverviewAgent{agent("p", "working")}, items, ""), `\n {2}doing: Bash npm test$`)
			matches(t, run([]OverviewAgent{agent("p", "blocked")}, items, ""), `\n {2}pending: Bash npm test$`)
			noMatch(t, run([]OverviewAgent{agent("p", "idle")}, items, ""), `doing|pending`)
		})

		t.Run("falls back to the last screen lines when there is no transcript", func(t *testing.T) {
			a := agent("p", "idle")
			a.Agent = "codex"
			out := run([]OverviewAgent{a}, map[string]AgentDetail{"p": {Screen: "old\nl1\n\n────\nl2  with   gaps\nl3\nl4\n   \n"}}, "")
			matches(t, out, `\n {2}screen: l1 ⏎ l2 with gaps ⏎ l3 ⏎ l4$`)
		})

		t.Run("prints only the header when nothing could be read", func(t *testing.T) {
			out := run([]OverviewAgent{agent("p", "idle")}, map[string]AgentDetail{"p": {}}, "")
			if n := len(strings.Split(out, "\n")); n != 1 {
				t.Errorf("%d lines: %q", n, out)
			}
		})

		t.Run("truncates and flattens long excerpts", func(t *testing.T) {
			out := run([]OverviewAgent{agent("p", "idle")}, map[string]AgentDetail{"p": {Items: []TimelineItem{
				user(strings.Repeat("x", 500)), asst(strings.Repeat("a\n\nb\tc ", 200)),
			}}}, "")
			var task, last string
			for _, l := range strings.Split(out, "\n") {
				if v, ok := strings.CutPrefix(l, "  task: "); ok && task == "" {
					task = v
				}
				if v, ok := strings.CutPrefix(l, "  last: "); ok && last == "" {
					last = v
				}
			}
			if utf8.RuneCountInString(task) != 160 || !strings.HasSuffix(task, "…") {
				t.Errorf("task %q", task)
			}
			if utf8.RuneCountInString(last) != 300 {
				t.Errorf("last has %d code points", utf8.RuneCountInString(last))
			}
			noMatch(t, last, `[\n\t]| {2}`)
		})
	})

	t.Run("clip", func(t *testing.T) {
		t.Run("strips control chars and never splits a surrogate pair", func(t *testing.T) {
			if got := clip("a\u001b[31mb", 10); got != "a [31mb" {
				t.Errorf("got %q", got)
			}
			if got := clip("😀😀😀", 2); got != "😀…" {
				t.Errorf("got %q", got)
			}
		})
	})
}
