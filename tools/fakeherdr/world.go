package fakeherdr

import (
	"encoding/json"
	"sync"
	"time"
)

// Pane is one pane of the fake session. Agent "" is a plain shell.
type Pane struct {
	ID, Tab, Workspace string
	Agent, Status      string
	completionSeq      int64
	stateChangeSeq     int64
}

// World is the herdr session a Server answers session.snapshot and agent.list
// from. Changing it doesn't emit events; scenarios do that themselves, so they can
// also change it without an event (a change the client must catch by snapshot).
type World struct {
	mu            sync.Mutex
	panes         []Pane
	changeSeq     int64
	snapshotDelay time.Duration
	snapshotLate  bool // read the world after the delay rather than before it
}

// NewWorld starts with three panes in one workspace: p1 (claude, idle), p2
// (claude, working) and p3 (a shell), each in its own tab.
func NewWorld() *World {
	return &World{panes: []Pane{
		{ID: "p1", Tab: "t1", Workspace: "w1", Agent: "claude", Status: "idle"},
		{ID: "p2", Tab: "t2", Workspace: "w1", Agent: "claude", Status: "working"},
		{ID: "p3", Tab: "t3", Workspace: "w1"},
	}}
}

// Set changes a pane's agent status and returns the old one. A change to done
// counts as a completion (completion_seq goes up); every change gets the next
// state_change_seq, as herdr's agent.list reports them.
func (w *World) Set(paneID, status string) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	for i := range w.panes {
		p := &w.panes[i]
		if p.ID != paneID {
			continue
		}
		from := p.Status
		if from != status {
			p.Status = status
			w.changeSeq++
			p.stateChangeSeq = w.changeSeq
			if status == "done" {
				p.completionSeq++
			}
		}
		return from
	}
	return ""
}

// Add puts a new pane into the world.
func (w *World) Add(p Pane) {
	w.mu.Lock()
	w.panes = append(w.panes, p)
	w.mu.Unlock()
}

// SetSnapshotDelay delays every session.snapshot answer by d. With late, the
// answer reflects the world after the delay (changes made meanwhile included);
// otherwise it reflects the world when the request arrived.
func (w *World) SetSnapshotDelay(d time.Duration, late bool) {
	w.mu.Lock()
	w.snapshotDelay, w.snapshotLate = d, late
	w.mu.Unlock()
}

// Handler answers session.snapshot and agent.list from the world and everything
// else with an empty result.
func (w *World) Handler() Handler {
	return func(method string, _ json.RawMessage) Reply {
		switch method {
		case "session.snapshot":
			w.mu.Lock()
			d, late := w.snapshotDelay, w.snapshotLate
			w.mu.Unlock()
			if late {
				time.Sleep(d)
				return Reply{Result: w.snapshot()}
			}
			return Reply{Result: w.snapshot(), Delay: d}
		case "agent.list":
			return Reply{Result: w.agentList()}
		}
		return Reply{}
	}
}

func (w *World) snapshot() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	var workspaces, tabs, panes []map[string]any
	seenWS := map[string]bool{}
	for _, p := range w.panes {
		if !seenWS[p.Workspace] {
			seenWS[p.Workspace] = true
			workspaces = append(workspaces, map[string]any{"workspace_id": p.Workspace, "label": p.Workspace, "active_tab_id": p.Tab})
		}
		tabs = append(tabs, map[string]any{"tab_id": p.Tab, "workspace_id": p.Workspace, "label": p.Tab})
		pane := map[string]any{"pane_id": p.ID, "tab_id": p.Tab, "workspace_id": p.Workspace, "focused": false}
		if p.Agent != "" {
			pane["agent"] = p.Agent
			pane["agent_status"] = p.Status
		}
		panes = append(panes, pane)
	}
	return map[string]any{"snapshot": map[string]any{
		"version": "0.9.5", "protocol": 22,
		"workspaces": workspaces, "tabs": tabs, "panes": panes,
	}}
}

func (w *World) agentList() map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	agents := []map[string]any{}
	for _, p := range w.panes {
		if p.Agent == "" {
			continue
		}
		a := map[string]any{"pane_id": p.ID, "agent": p.Agent, "agent_status": p.Status}
		if p.completionSeq > 0 {
			a["completion_seq"] = p.completionSeq
		}
		if p.stateChangeSeq > 0 {
			a["state_change_seq"] = p.stateChangeSeq
		}
		agents = append(agents, a)
	}
	return map[string]any{"agents": agents}
}
