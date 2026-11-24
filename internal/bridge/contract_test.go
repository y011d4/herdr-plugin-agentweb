package bridge

// The JSON contract with the web UI: this test writes
// what the Go bridge sends, for a representative state, every WS message type and
// every timeline item kind, to testdata/contract/*.json, and the same values as
// typed TypeScript literals to web/test/contract.gen.ts. `npm run check:contract`
// (tsc) then fails when the web's hand-written types and the Go JSON disagree:
// a missing or extra field, a wrong union member, null where an array is expected.
// Run with -update after changing either side's types, and commit the result.

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/contract and web/test/contract.gen.ts")

func contractState() ClientState {
	raw := RawSnapshot{
		Version: "0.9.5", Protocol: 22,
		FocusedWorkspaceID: "w1", FocusedTabID: "t1", FocusedPaneID: "p1",
		Workspaces: []RawWorkspace{
			{WorkspaceID: "w1", Label: "repo", ActiveTabID: "t1", Worktree: &RawWorktree{
				RepoKey: "/home/u/repo/.git", RepoName: "repo", RepoRoot: "/home/u/repo", CheckoutPath: "/home/u/repo"}},
			{WorkspaceID: "w2", Label: "repo-wt-feat", ActiveTabID: "t3", Worktree: &RawWorktree{
				RepoKey: "/home/u/repo/.git", RepoName: "repo", RepoRoot: "/home/u/repo", CheckoutPath: "/home/u/repo-wt-feat",
				IsLinkedWorktree: new(true)}},
			{WorkspaceID: "w3", ActiveTabID: "t4"},
		},
		Tabs: []RawTab{
			{TabID: "t1", WorkspaceID: "w1", Label: json.RawMessage(`"one"`)},
			{TabID: "t2", WorkspaceID: "w1", Label: json.RawMessage(`2`)},
			{TabID: "t3", WorkspaceID: "w2", Label: json.RawMessage(`"feat"`)},
			{TabID: "t4", WorkspaceID: "w3"},
		},
		Panes: []RawPane{
			{PaneID: "p1", TabID: "t1", WorkspaceID: "w1", Agent: "claude", AgentStatus: "working", Focused: true,
				Cwd: "/home/u/repo", ForegroundCwd: "/home/u/repo/sub", Title: "one"},
			{PaneID: "p2", TabID: "t2", WorkspaceID: "w1", Cwd: "/home/u/repo"},
			{PaneID: "p3", TabID: "t3", WorkspaceID: "w2", Agent: "claude", DisplayAgent: "Claude Code", AgentStatus: "done",
				CustomStatus: "reviewing", Cwd: "/home/u/repo-wt-feat"},
			{PaneID: "p4", TabID: "t1", WorkspaceID: "w1", Agent: "claude", AgentStatus: "idle",
				Cwd: "/home/u/.local/share/herdr-yoicks/orchestrators/personal"},
			{PaneID: "p5", TabID: "t4", WorkspaceID: "w3"},
			{PaneID: "p6", TabID: "t3", WorkspaceID: "w2", Agent: "claude", AgentStatus: "blocked", Cwd: "/home/u/repo-wt-feat"},
			{PaneID: "p7", TabID: "t2", WorkspaceID: "w1", Agent: "codex", Cwd: "/home/u/repo"}, // no status: unknown
		},
	}
	const now = 1795478400000
	s := createState(raw, now, nil)
	seq, change := int64(4), int64(9)
	s = applyCompletionSeqs(s, []RawAgentSeqs{{PaneID: "p3", AgentStatus: "done", CompletionSeq: &seq, StateChangeSeq: &change}}, now+1)
	// worktree-resolve adds the branch; the linked worktree is detached (null)
	for i, b := range []*string{strp("main"), nil} {
		wt := *s.Workspaces[i].Worktree
		wt.Branch = b
		ws := *s.Workspaces[i]
		ws.Worktree = &wt
		s.Workspaces[i] = &ws
	}
	account := "/home/u/.claude/projects"
	defs := []OrchestratorDef{
		{Name: "personal", Label: "Personal", Dir: "/home/u/.local/share/herdr-yoicks/orchestrators/personal", Managed: true},
		{Name: "work", Label: "", Dir: "/home/u/.local/share/herdr-yoicks/orchestrators/work", Managed: true},
	}
	views := findOrchestrators(s, defs, map[string]*string{"p1": &account, "p3": &account, "p4": &account})
	return ClientState{State: s, Orchestrators: views, OrchestratorPaneID: views[0].PaneID}
}

func contractItems() []TimelineItem {
	ts := int64(1795478400000)
	forID := "toolu_01"
	return []TimelineItem{
		{Kind: "user", Text: "fix the bug", TS: &ts},
		{Kind: "assistant", Text: "Done: **fixed** <it> & more.", Sidechain: true},
		{Kind: "thinking", Text: "let me look", Truncated: true, TS: &ts},
		{Kind: "tool_use", ID: "toolu_01", Name: "Bash", Summary: "npm test", TS: &ts},
		{Kind: "tool_use", ID: "toolu_02", Name: "TodoWrite", Summary: "2 todos",
			Todos: []TodoEntry{{Content: "port state", Status: "completed"}, {Content: "port http", Status: "pending"}}},
		{Kind: "tool_use", ID: "toolu_03", Name: "AskUserQuestion", Summary: "Which fruit?",
			Ask: []AskQuestion{{Question: "Which fruit?", Header: "Fruit", MultiSelect: false,
				Options: []AskOption{{Label: "apple", Description: "red"}, {Label: "cherry", Description: ""}}}}},
		{Kind: "tool_result", ForID: &forID, Text: "ok", TS: &ts},
		{Kind: "tool_result", Text: "boom", Truncated: true, IsError: true},
	}
}

func contractMessages(state ClientState, items []TimelineItem) []any {
	session := "0b9f3c1e-2d4a-4e8b-9c7d-5f6a7b8c9d0e"
	return []any{
		WsStateMessage{Type: "state", State: state},
		WsAgentStatusMessage{Type: "agent_status", PaneID: "p3", Agent: strp("Claude Code"), From: "working", To: "done",
			WorkspaceLabel: strp("repo-wt-feat"), TabLabel: strp("feat")},
		WsAgentStatusMessage{Type: "agent_status", PaneID: "p9", From: "unknown", To: "blocked"},
		WsPongMessage{Type: "pong"},
		WsPaneOutputMessage{Type: "pane_output", PaneID: "p1", Ansi: "\u001b[1m❯\u001b[0m hi <b>&", AppScroll: true},
		WsPaneGoneMessage{Type: "pane_gone", PaneID: "p2"},
		WsTranscriptItemsMessage{Type: "transcript_items", PaneID: "p1", Available: true, SessionID: &session,
			Items: items, Cursor: 249, Reset: true},
		WsTranscriptItemsMessage{Type: "transcript_items", PaneID: "p2", Available: false, Items: []TimelineItem{}, Reset: true},
	}
}

// contractJSON is the bridge's wire encoding: no HTML escaping (TypeScript's
// JSON.stringify doesn't escape <, > or &), indented for review.
func contractJSON(t *testing.T, v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", " ")
	if err := enc.Encode(v); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestContract(t *testing.T) {
	state := contractState()
	items := contractItems()
	msgs := contractMessages(state, items)
	stateJSON, itemsJSON, msgsJSON := contractJSON(t, state), contractJSON(t, items), contractJSON(t, msgs)

	var ts bytes.Buffer
	ts.WriteString(`// Generated by internal/bridge/contract_test.go (go test ./internal/bridge -run TestContract -update).
// Don't edit: it is the Go bridge's JSON as typed literals, so that tsc (npm run
// check:contract) fails when web/src's types and the Go bridge disagree.
import type { AppState, WsMessage } from '../src/types.ts';
import type { TimelineItem } from '../src/transcript.ts';

`)
	for _, c := range []struct {
		name, typ string
		json      []byte
	}{{"state", "AppState", stateJSON}, {"messages", "WsMessage[]", msgsJSON}, {"items", "TimelineItem[]", itemsJSON}} {
		ts.WriteString("export const " + c.name + ": " + c.typ + " = " + string(bytes.TrimSpace(c.json)) + ";\n\n")
	}

	root := filepath.Join("..", "..")
	files := map[string][]byte{
		filepath.Join(root, "testdata", "contract", "client-state.json"):   stateJSON,
		filepath.Join(root, "testdata", "contract", "ws-messages.json"):    msgsJSON,
		filepath.Join(root, "testdata", "contract", "timeline-items.json"): itemsJSON,
		filepath.Join(root, "web", "test", "contract.gen.ts"):              bytes.TrimRight(ts.Bytes(), "\n"),
	}
	for path, want := range files {
		if *update {
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, append(bytes.TrimRight(want, "\n"), '\n'), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%v (run with -update to create it)", err)
		}
		if !bytes.Equal(got, append(bytes.TrimRight(want, "\n"), '\n')) {
			t.Errorf("%s is out of date: the Go JSON changed; run with -update, then npm run check:contract", path)
		}
	}
}
