package fakeherdr

import (
	"encoding/json"
	"sync"
	"time"
)

// Pane is one pane of the fake session. Agent "" is a plain shell. For the agent calls:
// Name (an agent name, also a target), Cwd, Pid (pane.process_info's foreground process,
// whose /proc the account checks read) and NotReady (agent.prompt answers agent_not_ready).
type Pane struct {
	ID, Tab, Workspace string
	Agent, Status      string
	Name, Cwd          string
	Pid                int
	NotReady           bool
	completionSeq      int64
	stateChangeSeq     int64
}

// Prompt is an agent.prompt the world got.
type Prompt struct{ Pane, Text string }

// World is the herdr session a Server answers session.snapshot and agent.list
// from. Changing it doesn't emit events; scenarios do that themselves, so they can
// also change it without an event (a change the client must catch by snapshot).
type World struct {
	mu            sync.Mutex
	panes         []Pane
	changeSeq     int64
	snapshotDelay time.Duration
	snapshotLate  bool // read the world after the delay rather than before it

	// onPrompt (when set) runs on its own goroutine for each delivered agent.prompt: the
	// worker's script (Set its status over time). stallAfter is how long an agent.prompt
	// wait sees no change before it answers agent_prompt_stalled (herdr: 5 s).
	onPrompt      func(paneID, text string)
	stallAfter    time.Duration
	prompts       []Prompt
	notifications []map[string]any
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

// Remove takes a pane out of the world (its agent ended, the pane closed).
func (w *World) Remove(paneID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for i, p := range w.panes {
		if p.ID == paneID {
			w.panes = append(w.panes[:i], w.panes[i+1:]...)
			return
		}
	}
}

// OnPrompt sets the workers' script: f runs on its own goroutine for each delivered
// agent.prompt (and Sets the pane's status over time, say).
func (w *World) OnPrompt(f func(paneID, text string)) {
	w.mu.Lock()
	w.onPrompt = f
	w.mu.Unlock()
}

// StallAfter sets how long an agent.prompt wait sees no change before it answers
// agent_prompt_stalled (herdr: 5 s).
func (w *World) StallAfter(d time.Duration) {
	w.mu.Lock()
	w.stallAfter = d
	w.mu.Unlock()
}

// SetReady sets whether agent.prompt finds a pane's agent ready.
func (w *World) SetReady(paneID string, ready bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if p := w.find(paneID); p != nil {
		p.NotReady = !ready
	}
}

// Prompts is the agent.prompts delivered so far.
func (w *World) Prompts() []Prompt {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]Prompt(nil), w.prompts...)
}

// Notifications is the notification.show requests' params so far.
func (w *World) Notifications() []map[string]any {
	w.mu.Lock()
	defer w.mu.Unlock()
	return append([]map[string]any(nil), w.notifications...)
}

// find is the pane a target names (its id or its agent name); w.mu held.
func (w *World) find(target string) *Pane {
	for i := range w.panes {
		if p := &w.panes[i]; p.ID == target || p.Name != "" && p.Name == target {
			return p
		}
	}
	return nil
}

// agentInfo is agent.get's agent for p; w.mu held.
func agentInfo(p *Pane) map[string]any {
	return map[string]any{"pane_id": p.ID, "name": p.Name, "agent": p.Agent, "agent_status": p.Status, "cwd": p.Cwd,
		"interactive_ready": !p.NotReady, "state_change_seq": p.stateChangeSeq, "completion_seq": p.completionSeq}
}

// waitFor polls until ok (with w.mu held) says the pane's state answers, or the pane goes
// (not_found); after two minutes it hangs up (a fake's wait whose client left).
func (w *World) waitFor(target string, ok func(p *Pane) (Reply, bool)) Reply {
	for end := time.Now().Add(2 * time.Minute); time.Now().Before(end); {
		w.mu.Lock()
		p := w.find(target)
		if p == nil {
			w.mu.Unlock()
			return Reply{Code: "not_found", Message: "no agent " + target}
		}
		rep, done := ok(p)
		w.mu.Unlock()
		if done {
			return rep
		}
		time.Sleep(20 * time.Millisecond)
	}
	return Reply{Close: true}
}

// agentCall answers the agent calls: agent.get, agent.read, agent.prompt (its wait is edge:
// the change the prompt brings), agent.wait (level: the state as it is, matched exactly).
func (w *World) agentCall(method string, raw json.RawMessage) Reply {
	var params struct {
		Target    string   `json:"target"`
		TimeoutMs int      `json:"timeout_ms"`
		Text      string   `json:"text"`
		Until     []string `json:"until"`
		Wait      *struct {
			Until []string `json:"until"`
		} `json:"wait"`
	}
	json.Unmarshal(raw, &params)
	has := func(list []string, s string) bool {
		for _, x := range list {
			if x == s {
				return true
			}
		}
		return false
	}
	w.mu.Lock()
	p := w.find(params.Target)
	if p == nil {
		w.mu.Unlock()
		return Reply{Code: "not_found", Message: "no agent " + params.Target}
	}
	switch method {
	case "agent.get":
		defer w.mu.Unlock()
		return Reply{Result: map[string]any{"type": "agent_info", "agent": agentInfo(p)}}
	case "agent.read":
		defer w.mu.Unlock()
		return Reply{Result: map[string]any{"type": "pane_read", "read": map[string]any{"text": "the screen of " + p.ID}}}
	case "agent.wait":
		w.mu.Unlock()
		deadline := time.Now().Add(time.Duration(params.TimeoutMs) * time.Millisecond)
		return w.waitFor(params.Target, func(p *Pane) (Reply, bool) {
			if params.TimeoutMs > 0 && time.Now().After(deadline) && !has(params.Until, p.Status) {
				return Reply{Code: "timeout", Message: "agent.wait timed out"}, true
			}
			return Reply{Result: map[string]any{"type": "agent_info", "agent": agentInfo(p)}}, has(params.Until, p.Status)
		})
	}
	// agent.prompt
	if p.NotReady {
		w.mu.Unlock()
		return Reply{Code: "agent_not_ready", Message: "agent is not ready"}
	}
	id, seq := p.ID, p.stateChangeSeq
	w.prompts = append(w.prompts, Prompt{id, params.Text})
	hook, stall := w.onPrompt, w.stallAfter
	w.mu.Unlock()
	if hook != nil {
		go hook(id, params.Text)
	}
	if params.Wait == nil {
		w.mu.Lock()
		defer w.mu.Unlock()
		return Reply{Result: map[string]any{"type": "agent_prompted", "agent": agentInfo(w.find(id))}}
	}
	if stall == 0 {
		stall = 5 * time.Second
	}
	deadline := time.Now().Add(stall)
	return w.waitFor(id, func(p *Pane) (Reply, bool) {
		if p.stateChangeSeq == seq {
			if time.Now().After(deadline) {
				return Reply{Code: "agent_prompt_stalled", Message: "the agent didn't start working"}, true
			}
			return Reply{}, false
		}
		return Reply{Result: map[string]any{"type": "agent_prompted", "agent": agentInfo(p)}}, has(params.Wait.Until, p.Status)
	})
}

// SetSnapshotDelay delays every session.snapshot answer by d. With late, the
// answer reflects the world after the delay (changes made meanwhile included);
// otherwise it reflects the world when the request arrived.
func (w *World) SetSnapshotDelay(d time.Duration, late bool) {
	w.mu.Lock()
	w.snapshotDelay, w.snapshotLate = d, late
	w.mu.Unlock()
}

// Handler answers session.snapshot, agent.list, the agent calls (agentCall), pane.process_info
// (a pane's Pid) and notification.show (recorded) from the world, and everything else with an
// empty result.
func (w *World) Handler() Handler {
	return func(method string, params json.RawMessage) Reply {
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
		case "agent.get", "agent.read", "agent.prompt", "agent.wait":
			return w.agentCall(method, params)
		case "pane.process_info":
			var q struct {
				PaneID string `json:"pane_id"`
			}
			json.Unmarshal(params, &q)
			w.mu.Lock()
			defer w.mu.Unlock()
			if p := w.find(q.PaneID); p != nil && p.Pid > 0 {
				return Reply{Result: map[string]any{"process_info": map[string]any{"shell_pid": 1, "foreground_process_group_id": p.Pid,
					"foreground_processes": []any{map[string]any{"pid": p.Pid, "name": "claude", "argv": []string{"claude"}}}}}}
			}
		case "notification.show":
			var n map[string]any
			json.Unmarshal(params, &n)
			w.mu.Lock()
			w.notifications = append(w.notifications, n)
			w.mu.Unlock()
			return Reply{Result: map[string]any{"type": "notification_show", "shown": true}}
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
		if p.Cwd != "" {
			pane["cwd"] = p.Cwd
		}
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
