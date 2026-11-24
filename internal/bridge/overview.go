package bridge

// Pure text overview of every herdr agent, a port of server/overview.ts, for an
// orchestrator agent to read via `agentwebctl overview`. No I/O: the CLI fetches
// agent.list / session.snapshot, each agent's transcript items or screen text,
// and passes them in. Output is plain, compact, ANSI-free text.

import (
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
)

// OverviewAgent is an agent.list entry (RawAgent in overview.ts).
type OverviewAgent struct {
	Name          string           `json:"name"`
	PaneID        string           `json:"pane_id"`
	Agent         string           `json:"agent"`
	AgentStatus   *string          `json:"agent_status"` // nil = absent ("unknown"); "" prints nothing
	WorkspaceID   string           `json:"workspace_id"`
	TabID         string           `json:"tab_id"`
	Cwd           string           `json:"cwd"`
	ForegroundCwd string           `json:"foreground_cwd"`
	AgentSession  *RawAgentSession `json:"agent_session"`
}

// OverviewSnapshot is the part of session.snapshot the overview reads (RawSnapshot
// in overview.ts).
type OverviewSnapshot struct {
	Workspaces []RawWorkspace `json:"workspaces"`
	Tabs       []RawTab       `json:"tabs"`
}

// AgentDetail is per-agent detail gathered by the CLI: transcript items (claude)
// or screen text. The zero value is "nothing read".
type AgentDetail struct {
	Items  []TimelineItem
	Screen string
	// the last real user request, found further back when it has scrolled out of Items
	OlderTask string
}

// User turns Claude Code writes itself (background-task wakeups, reminders, slash
// commands and their output, `!` shell runs) — not what the agent was asked to do.
// `<pasted_content>` is the user's own paste, so it counts. (Mirrors the web
// home chat's filter in web/src/transcript.ts; the two builds don't share code.)
var injectedUserTurn = regexp.MustCompile(`^[` + jsSpace + `]*<(task-notification|system-reminder|local-command-[\w-]+|command-(name|message|args)|bash-(input|stdout|stderr))>`)

// isTaskTurn: a request the user actually made (main thread, not a Claude Code
// injected turn).
func isTaskTurn(i TimelineItem) bool {
	return i.Kind == "user" && !i.Sidechain && !injectedUserTurn.MatchString(i.Text)
}

var statusOrder = []string{"blocked", "working", "done", "idle", "unknown"}

func statusRank(s *string) int {
	st := "unknown"
	if s != nil {
		st = *s
	}
	if i := slices.Index(statusOrder, st); i != -1 {
		return i
	}
	return len(statusOrder) - 1
}

var clipSpace = regexp.MustCompile(`[` + jsSpace + `\x00-\x1f\x7f]+`)

// clip collapses whitespace and control chars (incl. ESC) to single spaces, then
// caps by code points so a surrogate pair is never split.
func clip(s string, max int) string {
	flat := strings.Trim(clipSpace.ReplaceAllString(s, " "), " ") // every JS \s is a space by now
	cps := []rune(flat)
	if len(cps) > max {
		return string(cps[:max-1]) + "…"
	}
	return flat
}

func ago(ms int64) string {
	s := max(0, ms/1000) // floor: a negative ms ends at 0 either way
	switch {
	case s < 60:
		return fmt.Sprintf("%ds ago", s)
	case s < 3600:
		return fmt.Sprintf("%dm ago", s/60)
	case s < 172800:
		return fmt.Sprintf("%dh ago", s/3600)
	}
	return fmt.Sprintf("%dd ago", s/86400)
}

// orderAgents is the agents to report, in display order (status rank, stable),
// minus the caller's pane ("" = none).
func orderAgents(agents []OverviewAgent, selfPaneID string) []OverviewAgent {
	var out []OverviewAgent
	for _, a := range agents {
		if a.PaneID != selfPaneID {
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return statusRank(out[i].AgentStatus) < statusRank(out[j].AgentStatus) })
	return out
}

// joinTruthy is `[...].filter(Boolean).join(sep)` over strings.
func joinTruthy(sep string, parts ...string) string {
	return strings.Join(slices.DeleteFunc(parts, func(p string) bool { return p == "" }), sep)
}

func lastMatch(items []TimelineItem, pred func(TimelineItem) bool) *TimelineItem {
	for i := len(items) - 1; i >= 0; i-- {
		if pred(items[i]) {
			return &items[i]
		}
	}
	return nil
}

func formatOverview(agents []OverviewAgent, snapshot OverviewSnapshot, details map[string]AgentDetail, selfPaneID string, now int64) string {
	ordered := orderAgents(agents, selfPaneID)
	if len(ordered) == 0 {
		return "no other agents"
	}
	wsLabel := map[string]string{}
	for _, w := range snapshot.Workspaces {
		wsLabel[w.WorkspaceID] = w.Label
	}
	tabLabel := map[string]string{}
	for _, t := range snapshot.Tabs {
		tabLabel[t.TabID] = t.LabelOr("")
	}

	out := make([]string, 0, len(ordered))
	for _, a := range ordered {
		status := "unknown"
		if a.AgentStatus != nil {
			status = *a.AgentStatus
		}
		detail := details[a.PaneID]
		items := detail.Items
		var main []TimelineItem
		for _, i := range items {
			if !i.Sidechain {
				main = append(main, i)
			}
		}
		newest := lastMatch(items, func(i TimelineItem) bool { return i.TS != nil })
		where := joinTruthy(" › ", wsLabel[a.WorkspaceID], tabLabel[a.TabID])
		// the launch dir tells the orchestrator where to start more work on the same repo
		meta := "pane " + a.PaneID
		if a.Cwd != "" {
			meta += " in " + a.Cwd
		}
		if newest != nil {
			meta += ", last activity " + ago(now-*newest.TS)
		}
		lines := []string{joinTruthy("  ", firstNonEmpty(a.Name, a.PaneID), status, where, "("+meta+")")}

		taskText := detail.OlderTask
		if task := lastMatch(main, isTaskTurn); task != nil {
			taskText = task.Text
		}
		if taskText != "" {
			lines = append(lines, "  task: "+clip(taskText, 160))
		}
		if last := lastMatch(main, func(i TimelineItem) bool { return i.Kind == "assistant" }); last != nil {
			lines = append(lines, "  last: "+clip(last.Text, 300))
		}
		// The call still open in the current turn — the newest tool_use since the last
		// real user request with no result yet (parallel calls finish out of order, so
		// the final item can be another call's result). Injected turns (a background
		// task's notification, a reminder) land mid-turn and don't end it.
		turn := main
		for i := len(main) - 1; i >= 0; i-- {
			if isTaskTurn(main[i]) {
				turn = main[i+1:]
				break
			}
		}
		resolved := map[string]bool{}
		for _, i := range turn {
			if i.Kind == "tool_result" && i.ForID != nil {
				resolved[*i.ForID] = true
			}
		}
		open := lastMatch(turn, func(i TimelineItem) bool { return i.Kind == "tool_use" && !resolved[i.ID] })
		if open != nil && (status == "working" || status == "blocked") {
			verb := "doing"
			if status == "blocked" {
				verb = "pending"
			}
			lines = append(lines, "  "+verb+": "+clip(open.Name+" "+open.Summary, 300))
		}

		if len(items) == 0 && detail.Screen != "" {
			// Keep lines with a letter/digit, dropping blank lines and box-drawing rules.
			var kept []string
			for _, l := range strings.Split(detail.Screen, "\n") {
				if letterOrDigit.MatchString(l) {
					kept = append(kept, l)
				}
			}
			kept = kept[max(0, len(kept)-4):]
			for i, l := range kept {
				kept[i] = jsTrim(l)
			}
			if text := strings.Join(kept, " ⏎ "); text != "" {
				lines = append(lines, "  screen: "+clip(text, 300))
			}
		}
		out = append(out, strings.Join(lines, "\n"))
	}
	return strings.Join(out, "\n")
}

var letterOrDigit = regexp.MustCompile(`[\p{L}\p{N}]`)
