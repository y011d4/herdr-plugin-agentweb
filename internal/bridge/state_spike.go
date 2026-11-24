package bridge

// ponytail: the P0 spike's State keeps only what the herdr client's buffering and
// replay logic reads (each pane's agent status and seqs). P1 replaces this file with
// the full port of server/state.ts (workspaces, tabs, focus, labels, worktrees).

import "time"

// AgentInfo is a pane's agent.
type AgentInfo struct {
	Name           string
	Status         string
	SinceUnixMs    int64
	CompletionSeq  *int64
	StateChangeSeq *int64
}

// State is a normalized herdr session. Treat it as immutable: every change makes a
// new one.
type State struct {
	Connected bool
	panes     map[string]*AgentInfo // nil: the pane has no agent
	order     []string              // pane ids in snapshot order
}

type rawSnapshot struct {
	Version  string    `json:"version"`
	Protocol int       `json:"protocol"`
	Panes    []rawPane `json:"panes"`
}

type rawPane struct {
	PaneID      string `json:"pane_id"`
	Agent       string `json:"agent"`
	AgentStatus string `json:"agent_status"`
}

type rawAgent struct {
	PaneID         string `json:"pane_id"`
	AgentStatus    string `json:"agent_status"`
	CompletionSeq  *int64 `json:"completion_seq"`
	StateChangeSeq *int64 `json:"state_change_seq"`
}

// Events that change the pane set: the client re-snapshots and re-subscribes.
var paneSetChangingEvents = map[string]bool{
	"pane_created": true, "pane_closed": true, "pane_moved": true, "pane_exited": true,
	"pane_agent_detected": true,
	"workspace_created":   true, "workspace_updated": true, "workspace_moved": true, "workspace_closed": true,
	"tab_created": true, "tab_closed": true, "tab_moved": true,
	"worktree_created": true, "worktree_opened": true, "worktree_removed": true,
}

func nowMs() int64 { return time.Now().UnixMilli() }

func statusOf(a *AgentInfo) string {
	if a == nil || a.Status == "" {
		return "unknown"
	}
	return a.Status
}

// Pane returns a pane's agent (nil: none) and whether the pane exists.
func (s *State) Pane(id string) (*AgentInfo, bool) {
	a, ok := s.panes[id]
	return a, ok
}

func (s *State) paneIDs() []string { return append([]string(nil), s.order...) }

func (s *State) withConnected(v bool) *State {
	n := *s
	n.Connected = v
	return &n
}

// createState builds a State from a snapshot. An agent whose status is unchanged
// since prev keeps its sinceUnixMs and seqs.
func createState(raw rawSnapshot, now int64, prev *State) *State {
	s := &State{Connected: true, panes: map[string]*AgentInfo{}}
	for _, p := range raw.Panes {
		s.order = append(s.order, p.PaneID)
		if p.Agent == "" {
			s.panes[p.PaneID] = nil
			continue
		}
		a := &AgentInfo{Name: p.Agent, Status: p.AgentStatus, SinceUnixMs: now}
		if a.Status == "" {
			a.Status = "unknown"
		}
		if prev != nil {
			if pa := prev.panes[p.PaneID]; pa != nil && pa.Status == a.Status {
				a.SinceUnixMs, a.CompletionSeq, a.StateChangeSeq = pa.SinceUnixMs, pa.CompletionSeq, pa.StateChangeSeq
			}
		}
		s.panes[p.PaneID] = a
	}
	return s
}

// applyEvent applies an event to s, returning the new state and any status changes.
// s is not modified.
func applyEvent(s *State, name string, data map[string]any, now int64) (*State, []StatusChange) {
	if name != "pane_agent_status_changed" {
		return s, nil
	}
	id, _ := data["pane_id"].(string)
	old, ok := s.panes[id]
	if !ok {
		return s, nil
	}
	from := statusOf(old)
	to, _ := data["agent_status"].(string)
	if to == "" {
		to = "unknown"
	}
	if from == to {
		return s, nil
	}
	a := &AgentInfo{Status: "unknown", SinceUnixMs: now}
	if old != nil {
		*a = *old
	}
	a.Status, a.SinceUnixMs, a.CompletionSeq, a.StateChangeSeq = to, now, nil, nil
	if name, ok := data["agent"].(string); ok {
		a.Name = name
	}
	n := *s
	n.panes = make(map[string]*AgentInfo, len(s.panes))
	for k, v := range s.panes {
		n.panes[k] = v
	}
	n.panes[id] = a
	return &n, []StatusChange{{PaneID: id, From: from, To: to, Agent: a}}
}

// applyCompletionSeqs fills in seqs from agent.list for agents whose status matches
// the reply and hasn't changed since the request went out. Returns s itself when
// nothing changed.
func applyCompletionSeqs(s *State, agents []rawAgent, requestedAt int64) *State {
	var n *State
	for _, ag := range agents {
		a := s.panes[ag.PaneID]
		if a == nil || a.Status != ag.AgentStatus || a.SinceUnixMs >= requestedAt {
			continue
		}
		if eqSeq(a.CompletionSeq, ag.CompletionSeq) && eqSeq(a.StateChangeSeq, ag.StateChangeSeq) {
			continue
		}
		if n == nil {
			c := *s
			c.panes = make(map[string]*AgentInfo, len(s.panes))
			for k, v := range s.panes {
				c.panes[k] = v
			}
			n = &c
		}
		u := *a
		u.CompletionSeq, u.StateChangeSeq = ag.CompletionSeq, ag.StateChangeSeq
		n.panes[ag.PaneID] = &u
	}
	if n == nil {
		return s
	}
	return n
}

func eqSeq(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
