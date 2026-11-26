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
	watchers      map[*watcher]struct{} // the held waits
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
			w.tell(change{pane: p.ID, to: status, agent: agentInfo(p)})
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
			w.tell(change{pane: paneID})
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

// change is one status change of a pane, with its agent then and when it came; to "" is the
// pane leaving.
type change struct {
	pane, to string
	agent    map[string]any
	at       time.Time
}

// watcher is a held wait: it gets every change from its registration on, in order (w.mu).
type watcher struct {
	changes []change
	signal  chan struct{} // cap 1: new changes are there
}

// tell gives every held wait the change, stamped now; w.mu held.
func (w *World) tell(c change) {
	c.at = time.Now()
	for x := range w.watchers {
		x.changes = append(x.changes, c)
		select {
		case x.signal <- struct{}{}:
		default:
		}
	}
}

// await holds a wait on pane, registered now (w.mu held: no change can come between the
// caller's look at the pane and it): step judges each of its changes in order until it gives
// the answer. The pane leaving answers not_found, the client leaving ends it. deadline (zero:
// none) takes its place among the changes by time, whenever the wait gets to look: changes
// before it are judged first, then onDeadline (which may answer, or let it go on without
// one), then the changes after it.
func (w *World) await(pane string, deadline time.Time, onDeadline func() (Reply, bool), step func(c change) (Reply, bool)) Reply {
	x := &watcher{signal: make(chan struct{}, 1)}
	if w.watchers == nil {
		w.watchers = map[*watcher]struct{}{}
	}
	w.watchers[x] = struct{}{}
	return Reply{Wait: func(gone <-chan struct{}) Reply {
		defer func() {
			w.mu.Lock()
			delete(w.watchers, x)
			w.mu.Unlock()
		}()
		timing := !deadline.IsZero()
		var timer <-chan time.Time
		if timing {
			t := time.NewTimer(time.Until(deadline))
			defer t.Stop()
			timer = t.C
		}
		due := func() (Reply, bool) { // the deadline's turn: once
			timing = false
			return onDeadline()
		}
		for {
			w.mu.Lock() // what came so far, and whether the deadline is past, as of one moment
			cs := x.changes
			x.changes = nil
			past := timing && !time.Now().Before(deadline)
			w.mu.Unlock()
			for _, c := range cs {
				if c.pane != pane {
					continue
				}
				if timing && c.at.After(deadline) {
					if rep, done := due(); done {
						return rep
					}
				}
				if c.to == "" {
					return Reply{Code: "not_found", Message: "no agent " + pane}
				}
				if rep, done := step(c); done {
					return rep
				}
			}
			if past && timing {
				if rep, done := due(); done {
					return rep
				}
			}
			select {
			case <-x.signal:
			case <-gone:
				return Reply{Close: true}
			case <-timer: // the next look settles it
				timer = nil
			}
		}
	}}
}

// agentCall answers the agent calls: agent.get, agent.read, agent.prompt (its wait is edge:
// it needs a working or blocked after the delivery, within stallAfter, else
// agent_prompt_stalled, then ends on an until status) and agent.wait (level: the state as it
// is, matched exactly; timeout_ms). Waits see every change, held until they match.
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
	defer w.mu.Unlock()
	p := w.find(params.Target)
	if p == nil {
		return Reply{Code: "not_found", Message: "no agent " + params.Target}
	}
	info := func(kind string, agent map[string]any) Reply {
		return Reply{Result: map[string]any{"type": kind, "agent": agent}}
	}
	switch method {
	case "agent.get":
		return info("agent_info", agentInfo(p))
	case "agent.read":
		return Reply{Result: map[string]any{"type": "pane_read", "read": map[string]any{"text": "the screen of " + p.ID}}}
	case "agent.wait":
		if has(params.Until, p.Status) {
			return info("agent_info", agentInfo(p))
		}
		var deadline time.Time
		if params.TimeoutMs > 0 {
			deadline = time.Now().Add(time.Duration(params.TimeoutMs) * time.Millisecond)
		}
		return w.await(p.ID, deadline, func() (Reply, bool) { return Reply{Code: "timeout", Message: "agent.wait timed out"}, true },
			func(c change) (Reply, bool) { return info("agent_info", c.agent), has(params.Until, c.to) })
	}
	// agent.prompt
	if p.NotReady {
		return Reply{Code: "agent_not_ready", Message: "agent is not ready"}
	}
	if p.Status == "blocked" { // herdr 0.9.5: an agent at a dialog takes no prompt
		return Reply{Code: "agent_blocked", Message: "agent " + p.ID + " is blocked and requires interactive input"}
	}
	w.prompts = append(w.prompts, Prompt{p.ID, params.Text})
	if hook := w.onPrompt; hook != nil {
		id := p.ID
		defer func() { go hook(id, params.Text) }() // after the wait is registered
	}
	if params.Wait == nil {
		return info("agent_prompted", agentInfo(p))
	}
	stall := w.stallAfter
	if stall == 0 {
		stall = 5 * time.Second
	}
	seen := p.Status == "working" || p.Status == "blocked" // the prompt was taken up
	return w.await(p.ID, time.Now().Add(stall),
		func() (Reply, bool) {
			return Reply{Code: "agent_prompt_stalled", Message: "no working or blocked state within the stall time"}, !seen
		},
		func(c change) (Reply, bool) {
			if c.to == "working" || c.to == "blocked" {
				seen = true
			}
			return info("agent_prompted", c.agent), seen && has(params.Wait.Until, c.to)
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
