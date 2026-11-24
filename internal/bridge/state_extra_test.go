package bridge

import (
	"encoding/json"
	"strings"
	"testing"
)

// Go-only checks of state.go (state_test.go holds the ported TypeScript tests).

func TestStateGoOnly(t *testing.T) {
	snap := RawSnapshot{
		Workspaces: []RawWorkspace{{WorkspaceID: "w1"}},
		Tabs:       []RawTab{{TabID: "t1", WorkspaceID: "w1"}, {TabID: "t2", WorkspaceID: "w1"}},
		Panes:      []RawPane{{PaneID: "p1", TabID: "t1", WorkspaceID: "w1", Agent: "claude", AgentStatus: "done"}},
	}

	t.Run("a tab without panes stays an empty array after an event", func(t *testing.T) {
		s, _ := applyEvent(createState(snap, 1, nil), "pane_focused", map[string]any{"pane_id": "p1"}, 2)
		b, _ := json.Marshal(s)
		if !strings.Contains(string(b), `{"tabId":"t2","label":"t2","panes":[]}`) {
			t.Errorf("the empty tab lost its [] panes: %s", b)
		}
	})

	t.Run("seqs from agent.list are copied, not shared with the reply", func(t *testing.T) {
		seq, change := int64(4), int64(9)
		reply := []RawAgentSeqs{{PaneID: "p1", AgentStatus: "done", CompletionSeq: &seq, StateChangeSeq: &change}}
		s := applyCompletionSeqs(createState(snap, 1, nil), reply, 2)
		seq, change = 99, 99 // the reply is changed afterwards
		if a := s.Pane("p1").Agent; *a.CompletionSeq != 4 || *a.StateChangeSeq != 9 {
			t.Errorf("state followed the reply: %d %d", *a.CompletionSeq, *a.StateChangeSeq)
		}
	})
}
