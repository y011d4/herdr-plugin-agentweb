package fakeherdr

import (
	"fmt"
	"reflect"
	"sort"
	"time"
)

// Client is the bridge's herdr client as a scenario drives it.
type Client interface {
	Refresh()             // force a snapshot re-fetch, as the bridge does after agent.rename
	Jump(d time.Duration) // move its clock d on at once (it keeps the real time's pace otherwise)
}

// Env is what a scenario works with.
type Env struct {
	Srv    *Server
	World  *World
	Client Client
	Errorf func(format string, args ...any)
}

// Sleep waits ms milliseconds.
func (e *Env) Sleep(ms int) { time.Sleep(time.Duration(ms) * time.Millisecond) }

// Status changes a pane's status in the world and emits the event for it.
func (e *Env) Status(paneID, status string) {
	e.World.Set(paneID, status)
	e.Srv.Emit("pane.agent_status_changed", map[string]any{
		"pane_id": paneID, "workspace_id": "w1", "agent": "claude", "agent_status": status,
	})
}

// Count is how many requests of method the server has received.
func (e *Env) Count(method string) int {
	n := 0
	for _, r := range e.Srv.Requests() {
		if r.Method == method {
			n++
		}
	}
	return n
}

// WaitCount waits until the server has received n requests of method.
func (e *Env) WaitCount(method string, n int, timeout time.Duration) {
	e.waitFor(timeout, func() bool { return e.Count(method) >= n }, "%d %s requests", n, method)
}

// WaitSubscribed waits until n acked subscriptions are open.
func (e *Env) WaitSubscribed(n int, timeout time.Duration) {
	e.waitFor(timeout, func() bool { return e.Srv.Subscribed() >= n }, "%d subscriptions", n)
}

func (e *Env) waitFor(timeout time.Duration, ok func() bool, what string, args ...any) {
	deadline := time.Now().Add(timeout)
	for !ok() {
		if time.Now().After(deadline) {
			e.Errorf("timed out waiting for "+what, args...)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Scenario is one situation for the herdr client. Setup runs before the client
// starts, Run after; the client is stopped once Run returns and Settle has passed.
type Scenario struct {
	Name string
	// CountStates: the number of state pushes is comparable (the scenario's events
	// are further apart than the client's 250 ms broadcast debounce).
	CountStates bool
	Setup       func(e *Env)
	Run         func(e *Env)
}

// Settle is how long a client keeps running after a scenario's Run returns.
const Settle = 800 * time.Millisecond

const wait = 5 * time.Second

func newPane(id, status string) Pane {
	return Pane{ID: id, Tab: "t" + id[1:], Workspace: "w1", Agent: "claude", Status: status}
}

// Scenarios are the situations recorded from the TypeScript client (P0) and replayed
// against the Go one. Each targets a path of the client.
var Scenarios = []Scenario{
	{
		// plain live events, and agent.list's completion/state-change seqs after each
		Name: "status-changes", CountStates: true,
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			e.Status("p1", "working")
			e.Sleep(400)
			e.Status("p1", "done")
			e.Sleep(400)
			e.Status("p2", "blocked")
			e.Sleep(400)
		},
	},
	{
		// a status event arrives while a rebuild snapshot is in flight, and the
		// snapshot still shows the old status: the buffered event must be emitted once
		Name: "status-during-snapshot-old",
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			e.World.SetSnapshotDelay(400*time.Millisecond, false)
			n := e.Count("session.snapshot")
			e.World.Add(newPane("p4", "idle"))
			e.Srv.Emit("pane.created", map[string]any{"pane_id": "p4", "workspace_id": "w1"})
			e.WaitCount("session.snapshot", n+1, wait)
			e.Sleep(150)
			e.Status("p1", "working")
			e.Sleep(1500)
		},
	},
	{
		// same, but the snapshot already shows the new status: the transition must
		// still be emitted (once), not swallowed as working -> working
		Name: "status-during-snapshot-new",
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			e.World.SetSnapshotDelay(400*time.Millisecond, true)
			n := e.Count("session.snapshot")
			e.World.Add(newPane("p4", "idle"))
			e.Srv.Emit("pane.created", map[string]any{"pane_id": "p4", "workspace_id": "w1"})
			e.WaitCount("session.snapshot", n+1, wait)
			e.Sleep(150)
			e.Status("p1", "working")
			e.Sleep(1500)
		},
	},
	{
		// a change between the pre-subscribe snapshot and the ack reaches neither:
		// the snapshot after the ack must replay it
		Name: "gap-before-ack",
		Setup: func(e *Env) {
			e.Srv.SetAckDelay(400 * time.Millisecond)
		},
		Run: func(e *Env) {
			e.WaitCount("events.subscribe", 1, wait)
			e.Sleep(100)
			e.World.Set("p1", "done")
			e.WaitSubscribed(1, wait)
			e.Sleep(800)
		},
	},
	{
		// refresh() while the post-ack snapshot is still in flight (two snapshots
		// at once), with a status event arriving during both
		Name: "overlapping-snapshots",
		Setup: func(e *Env) {
			e.World.SetSnapshotDelay(300*time.Millisecond, true)
		},
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Client.Refresh()
			e.Sleep(100)
			e.Status("p1", "working")
			e.Sleep(1500)
		},
	},
	{
		// a new pane: rebuild, resubscribe with it, then its own live event
		Name: "new-pane-subscribed",
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			n := e.Count("events.subscribe")
			e.World.Add(newPane("p4", "working"))
			e.Srv.Emit("pane.created", map[string]any{"pane_id": "p4", "workspace_id": "w1"})
			e.WaitCount("events.subscribe", n+1, wait)
			e.Sleep(300)
			e.Status("p4", "done")
			e.Sleep(600)
		},
	},
	{
		// the old subscription drops while its replacement still waits for its ack:
		// a change in that gap must be replayed
		Name: "old-sub-drops-before-new-ack",
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			e.Srv.SetAckDelay(600 * time.Millisecond)
			n := e.Count("events.subscribe")
			e.World.Add(newPane("p4", "idle"))
			e.Srv.Emit("pane.created", map[string]any{"pane_id": "p4", "workspace_id": "w1"})
			e.WaitCount("events.subscribe", n+1, wait)
			e.Sleep(50)
			if e.Srv.DropSubscriptions() != 1 {
				e.Errorf("expected to drop exactly the old subscription")
			}
			e.World.Set("p2", "done")
			e.Sleep(2500)
		},
	},
	{
		// the subscription drops: disconnected state, reconnect after the backoff,
		// and a change made meanwhile replayed from the snapshot
		Name: "subscription-drop-reconnect",
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			e.Srv.DropSubscriptions()
			e.Sleep(100)
			e.World.Set("p2", "blocked")
			e.WaitSubscribed(1, wait)
			e.Sleep(800)
		},
	},
	{
		// the first subscription is never acked: give up after the request timeout
		// (10 s, jumped over: the ack's timer runs from before the request) and reconnect
		Name: "ack-timeout",
		Setup: func(e *Env) {
			e.Srv.WithholdAcks(1)
		},
		Run: func(e *Env) {
			e.WaitCount("events.subscribe", 1, wait)
			e.Client.Jump(10 * time.Second)
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			e.Status("p1", "done")
			e.Sleep(500)
		},
	},
	{
		// focus events update the model without a push; renames push
		Name: "focus-and-rename", CountStates: true,
		Run: func(e *Env) {
			e.WaitSubscribed(1, wait)
			e.Sleep(400)
			e.Srv.Emit("pane.focused", map[string]any{"pane_id": "p2", "workspace_id": "w1"})
			e.Sleep(400)
			e.Srv.Emit("tab.renamed", map[string]any{"tab_id": "t1", "workspace_id": "w1", "label": "renamed"})
			e.Sleep(400)
		},
	},
}

// Output is one thing the client reported: a status change, a state push (reduced
// to what the comparison needs) or a connection change.
type Output struct {
	T         int64                 `json:"t"`
	Kind      string                `json:"kind"` // status | state | conn
	PaneID    string                `json:"paneId,omitempty"`
	From      string                `json:"from,omitempty"`
	To        string                `json:"to,omitempty"`
	Connected *bool                 `json:"connected,omitempty"`
	Panes     map[string]*PaneAgent `json:"panes,omitempty"`   // nil value: no agent in the pane
	Focused   string                `json:"focused,omitempty"` // workspace/tab/pane ids
	Tabs      map[string]string     `json:"tabs,omitempty"`    // tab id → label
}

// PaneAgent is a pane's agent in a state push.
type PaneAgent struct {
	Status    string `json:"status"`
	Seq       *int64 `json:"seq"`
	ChangeSeq *int64 `json:"changeSeq"`
}

// Recording is a scenario's outputs from one client.
type Recording struct {
	Scenario string   `json:"scenario"`
	Outputs  []Output `json:"outputs"`
}

// Compare reports how got differs from want: each pane's status transitions in
// order, the connection changes in order, the last state, and (when the scenario
// allows it) the number of state pushes. Timing and how transitions of different
// panes interleave are not compared.
func Compare(sc Scenario, want, got []Output) []string {
	var diffs []string
	if a, b := transitions(want), transitions(got); !reflect.DeepEqual(a, b) {
		diffs = append(diffs, fmt.Sprintf("status transitions: want %v, got %v", a, b))
	}
	if a, b := conns(want), conns(got); !reflect.DeepEqual(a, b) {
		diffs = append(diffs, fmt.Sprintf("connection changes: want %v, got %v", a, b))
	}
	a, b := lastState(want), lastState(got)
	if !reflect.DeepEqual(a, b) {
		diffs = append(diffs, fmt.Sprintf("last state: want %s, got %s", show(a), show(b)))
	}
	if sc.CountStates {
		if a, b := count(want, "state"), count(got, "state"); a != b {
			diffs = append(diffs, fmt.Sprintf("state pushes: want %d, got %d", a, b))
		}
	}
	return diffs
}

func transitions(outs []Output) map[string][]string {
	m := map[string][]string{}
	for _, o := range outs {
		if o.Kind == "status" {
			m[o.PaneID] = append(m[o.PaneID], o.From+">"+o.To)
		}
	}
	return m
}

func conns(outs []Output) []bool {
	var c []bool
	for _, o := range outs {
		if o.Kind == "conn" && o.Connected != nil {
			c = append(c, *o.Connected)
		}
	}
	return c
}

func lastState(outs []Output) *Output {
	for i := len(outs) - 1; i >= 0; i-- {
		if outs[i].Kind == "state" {
			o := outs[i]
			o.T = 0
			return &o
		}
	}
	return nil
}

func count(outs []Output, kind string) int {
	n := 0
	for _, o := range outs {
		if o.Kind == kind {
			n++
		}
	}
	return n
}

func show(o *Output) string {
	if o == nil {
		return "none"
	}
	s := fmt.Sprintf("connected=%v", o.Connected != nil && *o.Connected)
	ids := make([]string, 0, len(o.Panes))
	for id := range o.Panes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := o.Panes[id]
		if p == nil {
			s += fmt.Sprintf(" %s:-", id)
			continue
		}
		s += fmt.Sprintf(" %s:%s", id, p.Status)
		if p.Seq != nil {
			s += fmt.Sprintf("#%d", *p.Seq)
		}
		if p.ChangeSeq != nil {
			s += fmt.Sprintf("@%d", *p.ChangeSeq)
		}
	}
	if o.Focused != "" || o.Tabs != nil {
		s += fmt.Sprintf(" focused=%s tabs=%v", o.Focused, o.Tabs)
	}
	return s
}
