package bridge

// The herdr client: one-shot RPCs plus a persistent event subscription that keeps a
// normalized State current, with reconnect. A port of server/herdr-client.ts.
//
// Concurrency: one goroutine (the actor) owns every piece of mutable client state and
// runs the same steps, in the same order, as the single-threaded TypeScript client.
// Nothing else touches that state: socket reads, RPCs and timers run on their own
// goroutines and post a closure back to the actor. The actor never blocks on I/O.
// The State last handed to a callback is also published through an atomic pointer
// for readers: the state the server reads (a focus event updates the model but not
// that, until the next push).

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	requestTimeout         = 10 * time.Second
	backoffInitial         = time.Second
	backoffMax             = 30 * time.Second
	paneRebuildDebounce    = 250 * time.Millisecond
	stateBroadcastDebounce = 250 * time.Millisecond
	// short, so the seq reaches the phone with (or right after) the done status itself:
	// the phone records a "seen" only against a known seq
	completionSeqDebounce   = 50 * time.Millisecond
	agentListRetry          = 2 * time.Second
	worktreeRefreshInterval = 30 * time.Second
)

var logf = log.Printf

var rpcSeq atomic.Int64

// Only non-sensitive identifiers reach the logs, never text/keys/prompts.
func safeParamsForLog(params map[string]any) string {
	var parts []string
	for _, k := range []string{"pane_id", "target", "source", "format"} {
		if v, ok := params[k].(string); ok {
			parts = append(parts, k+"="+strconv.Quote(v))
		}
	}
	return strings.Join(parts, " ")
}

// herdrRPC sends one request on its own connection: herdr answers one request per
// connection and closes it.
func herdrRPC(socketPath, method string, params map[string]any) (json.RawMessage, error) {
	return herdrCall(context.Background(), socketPath, method, params, requestTimeout)
}

// herdrCall is herdrRPC with a deadline of timeout (0: none, for herdr's waits, which have
// none of their own); ctx's end closes the connection, so a wait can be given up.
func herdrCall(ctx context.Context, socketPath, method string, params map[string]any, timeout time.Duration) (json.RawMessage, error) {
	if params == nil {
		params = map[string]any{}
	}
	id := fmt.Sprintf("yoicks:%d:%d", time.Now().UnixMilli(), rpcSeq.Add(1))
	dialCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	conn, err := (&net.Dialer{}).DialContext(dialCtx, "unix", socketPath)
	cancel()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		logf("[herdr-client] rpc %s error: %s %s", method, err, safeParamsForLog(params))
		return nil, err
	}
	defer conn.Close()
	// the request goes out only while ctx stands: the cancellation closes the connection at
	// once, a write in progress or not (a blocked write then fails; half a line is no request
	// to herdr), and a write after the close sends nothing
	defer context.AfterFunc(ctx, func() { conn.Close() })()
	if timeout > 0 {
		_ = conn.SetDeadline(time.Now().Add(timeout))
	} else {
		_ = conn.SetWriteDeadline(time.Now().Add(requestTimeout)) // a wait's request still goes out promptly
	}
	line, err := json.Marshal(map[string]any{"type": "request", "id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	if ctx.Err() == nil {
		_, err = conn.Write(append(line, '\n'))
	}
	if ctx.Err() != nil { // given up: nothing more goes to herdr
		return nil, ctx.Err()
	}
	if err != nil {
		logf("[herdr-client] rpc %s error: %s %s", method, err, safeParamsForLog(params))
		return nil, err
	}
	// whole lines only: a multi-byte character split across reads stays intact
	r := bufio.NewReader(conn)
	for {
		b, err := r.ReadBytes('\n')
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				return nil, fmt.Errorf("RPC timeout: %s", method)
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			logf("[herdr-client] rpc %s closed without response %s", method, safeParamsForLog(params))
			return nil, errors.New("connection closed")
		}
		var msg struct {
			ID     string          `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(b, &msg) != nil || msg.ID != id {
			continue
		}
		if msg.Error != nil {
			m := msg.Error.Message
			if m == "" {
				m = "herdr error"
			}
			return nil, &HerdrError{Code: msg.Error.Code, Message: m}
		}
		return msg.Result, nil
	}
}

// HerdrClientCallbacks run on the client's actor goroutine, so they must not call
// Refresh (it waits for that goroutine) or block for long.
type HerdrClientCallbacks struct {
	OnState            func(*State)
	OnAgentStatus      func(StatusChange, *State)
	OnConnectionChange func(bool)
}

// HerdrClient keeps a State in step with herdr. Create with NewHerdrClient, then Start.
type HerdrClient struct {
	socketPath string
	cb         HerdrClientCallbacks
	inbox      chan func()
	quit       chan struct{}
	quitOnce   sync.Once
	published  atomic.Pointer[State]
	isConn     atomic.Bool

	// owned by the actor goroutine
	cur           *State
	subConn       *subscription
	connected     bool
	destroyed     bool
	backoff       time.Duration
	rebuildT      debounce
	broadcastT    debounce
	completionT   debounce
	listSent      int64 // agent.list requests sent, and the number of the one whose answer was applied last:
	listApplied   int64 // an older answer is dropped (a count, not the clock, which can step back)
	coverageEpoch int // bumped whenever live event coverage is lost
	// pane IDs covered by the currently acknowledged subscription; snapshot status
	// replays skip these (live events deliver their changes) and cover the rest
	subscribed map[string]bool
	// live events are held while a snapshot is in flight (see dispatchEvent)
	snapshotDepth   int
	eventBuffer     []herdrEvent
	preBufferStatus map[string]string
	replayedPanes   map[string]bool
}

type herdrEvent struct {
	name string
	data map[string]any
}

// NewHerdrClient creates a client for the herdr socket at socketPath.
func NewHerdrClient(socketPath string, cb HerdrClientCallbacks) *HerdrClient {
	if cb.OnState == nil {
		cb.OnState = func(*State) {}
	}
	if cb.OnAgentStatus == nil {
		cb.OnAgentStatus = func(StatusChange, *State) {}
	}
	if cb.OnConnectionChange == nil {
		cb.OnConnectionChange = func(bool) {}
	}
	c := &HerdrClient{
		socketPath: socketPath, cb: cb,
		inbox: make(chan func(), 1024), quit: make(chan struct{}),
		backoff: backoffInitial, subscribed: map[string]bool{},
	}
	go func() {
		for {
			select {
			case f := <-c.inbox:
				f()
			case <-c.quit:
				return
			}
		}
	}()
	return c
}

// post runs f on the actor goroutine. Dropped once the client is destroyed.
func (c *HerdrClient) post(f func()) {
	select {
	case c.inbox <- f:
	case <-c.quit:
	}
}

// Start connects (and keeps reconnecting). Call it once.
func (c *HerdrClient) Start() {
	// catch branch changes (git checkout) that don't produce a herdr snapshot
	go func() {
		t := time.NewTicker(worktreeRefreshInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				c.post(c.refreshWorktreesSoon)
			case <-c.quit:
				return
			}
		}
	}()
	c.post(c.connect)
}

// IsConnected reports whether the event subscription is acknowledged and open.
func (c *HerdrClient) IsConnected() bool { return c.isConn.Load() }

// State is the state last pushed to the callbacks (nil before the first snapshot).
// Never modify it.
func (c *HerdrClient) State() *State { return c.published.Load() }

// RPC sends one request to herdr.
func (c *HerdrClient) RPC(method string, params map[string]any) (json.RawMessage, error) {
	return herdrRPC(c.socketPath, method, params)
}

// Wait is RPC with no deadline (herdr's agent.wait and agent.prompt's wait), ended by ctx.
func (c *HerdrClient) Wait(ctx context.Context, method string, params map[string]any) (json.RawMessage, error) {
	return herdrCall(ctx, c.socketPath, method, params, 0)
}

// Refresh re-fetches the snapshot now and pushes it, for changes herdr sends no
// subscribed event for (e.g. agent.rename). It waits for the client's goroutine:
// never call it from a callback, which runs on that goroutine and would deadlock.
func (c *HerdrClient) Refresh() error {
	done := make(chan error, 1)
	c.post(func() {
		if c.destroyed {
			done <- nil
			return
		}
		c.fetchSnapshot(false, c.subscribed, func(err error) { done <- err })
	})
	select {
	case err := <-done:
		return err
	case <-c.quit:
		return nil
	}
}

// Destroy stops the client for good.
func (c *HerdrClient) Destroy() {
	c.post(func() {
		c.destroyed = true
		c.rebuildT.cancel()
		c.broadcastT.cancel()
		c.completionT.cancel()
		if c.subConn != nil {
			c.subConn.destroy()
		}
		c.quitOnce.Do(func() { close(c.quit) })
	})
}

func (c *HerdrClient) setState(s *State) { c.cur = s }

func (c *HerdrClient) emitState(s *State) {
	c.published.Store(s)
	c.cb.OnState(s)
}

func (c *HerdrClient) emitStatus(ch StatusChange, s *State) {
	c.published.Store(s)
	c.cb.OnAgentStatus(ch, s)
}

func (c *HerdrClient) setConnected(v bool) {
	if c.connected != v {
		c.connected = v
		c.isConn.Store(v)
		c.cb.OnConnectionChange(v)
	}
}

// ── debounced timers ─────────────────────────────────────────────────────────

// debounce is a restartable timer like setTimeout/clearTimeout: a fire that was
// already queued when the timer was restarted or cancelled is ignored.
type debounce struct {
	gen int
	t   *time.Timer
}

func (c *HerdrClient) schedule(d *debounce, after time.Duration, f func()) {
	d.cancel()
	g := d.gen
	d.t = time.AfterFunc(after, func() {
		c.post(func() {
			if d.gen == g {
				d.t = nil
				f()
			}
		})
	})
}

func (d *debounce) cancel() {
	d.gen++
	if d.t != nil {
		d.t.Stop()
		d.t = nil
	}
}

// ── snapshot ─────────────────────────────────────────────────────────────────

// fetchSnapshot re-fetches the session and calls done (on the actor) once the
// snapshot is applied and the events held meanwhile are drained. With replay, it
// also emits the status changes live subscriptions missed: those of panes outside
// coverage (every pane right after a reconnect; panes created during a rebuild
// until the new subscription acks).
func (c *HerdrClient) fetchSnapshot(replay bool, coverage map[string]bool, done func(error)) {
	// Hold live events while the snapshot RPC is in flight so applying it can't
	// clobber a status a concurrent event just set.
	if c.snapshotDepth == 0 {
		c.preBufferStatus = map[string]string{}
		c.replayedPanes = map[string]bool{}
		if c.cur != nil {
			// a baseline for every pane (agentless as unknown), so a pane that gains
			// an agent while events are held replays its real transition
			for _, id := range c.cur.paneOrder {
				c.preBufferStatus[id] = statusOf(c.cur.paneByID[id].Agent)
			}
		}
	}
	c.snapshotDepth++
	go func() {
		res, err := herdrRPC(c.socketPath, "session.snapshot", nil)
		c.post(func() {
			if err == nil {
				err = c.applySnapshot(res, replay, coverage)
			}
			c.snapshotDepth--
			if c.snapshotDepth == 0 {
				c.drainEvents()
				c.preBufferStatus = nil
				c.replayedPanes = nil
			}
			if done != nil {
				done(err)
			}
		})
	}()
}

func (c *HerdrClient) applySnapshot(res json.RawMessage, replay bool, coverage map[string]bool) error {
	var wrap struct {
		Snapshot json.RawMessage `json:"snapshot"`
	}
	if err := json.Unmarshal(res, &wrap); err != nil {
		return err
	}
	snap := wrap.Snapshot
	if snap == nil {
		snap = res
	}
	var raw RawSnapshot
	if err := json.Unmarshal(snap, &raw); err != nil {
		return err
	}
	prev := c.cur
	// plus the git context herdr omits (the branch, and worktree info for untagged
	// checkouts), from the cache: git itself runs in refreshWorktreesSoon below
	next := enrichStateWorktrees(createState(raw, nowMs(), prev), nil)
	c.setState(next)
	if replay && prev != nil {
		for _, id := range next.paneOrder {
			a := next.paneByID[id].Agent
			if a == nil || coverage[id] {
				continue
			}
			from := "unknown"
			if pp := prev.paneByID[id]; pp != nil {
				from = statusOf(pp.Agent)
			}
			if from != a.Status {
				c.emitStatus(StatusChange{PaneID: id, From: from, To: a.Status, Agent: a}, next)
				c.replayedPanes[id] = true // the drain must not emit this one again
			}
		}
	}
	// delivered at once (not debounced), so a flood of held events can't starve it
	c.emitState(next)
	c.refreshWorktreesSoon()
	c.refreshCompletionSeqsSoon()
	return nil
}

// refreshWorktreesSoon resolves the workspaces' git info off the actor (after each
// snapshot, and every 30 s for a `git checkout` that makes no snapshot) and, when
// it changed, re-enriches the latest state and pushes it.
func (c *HerdrClient) refreshWorktreesSoon() {
	if c.destroyed || c.cur == nil {
		return
	}
	// each workspace's stable path, the key enrichStateWorktrees looks up
	var cwds []string
	for _, ws := range c.cur.Workspaces {
		if cwd := resolveCwdFor(ws); cwd != "" {
			cwds = append(cwds, cwd)
		}
	}
	refreshWorktrees(cwds, func() {
		c.post(func() {
			if c.destroyed || c.cur == nil {
				return
			}
			c.setState(enrichStateWorktrees(c.cur, nil))
			c.emitState(c.cur)
		})
	})
}

// ── events ───────────────────────────────────────────────────────────────────

func (c *HerdrClient) dispatchEvent(name string, data map[string]any) {
	if c.snapshotDepth > 0 {
		c.eventBuffer = append(c.eventBuffer, herdrEvent{name, data})
		return
	}
	c.handleEvent(name, data)
}

// drainEvents replays the events held during a snapshot. Each pane with held status
// changes is first reset to its status from before the hold, without emitting, so
// replaying its events emits every real transition once and lands on the final
// status, even when the snapshot already shows it. Panes the snapshot's own replay
// emitted for stay as the snapshot left them. Same accepted limitation as the
// TypeScript client: 2+ changes of one pane within one snapshot window can overlap.
func (c *HerdrClient) drainEvents() {
	buffered := c.eventBuffer
	c.eventBuffer = nil
	reset := map[string]bool{}
	for _, e := range buffered {
		id, _ := e.data["pane_id"].(string)
		if e.name != "pane_agent_status_changed" || id == "" || reset[id] {
			continue
		}
		reset[id] = true
		if c.replayedPanes[id] {
			continue
		}
		pre, ok := c.preBufferStatus[id]
		if !ok || c.cur == nil {
			continue // new pane / no baseline
		}
		st, _ := applyEvent(c.cur, "pane_agent_status_changed", map[string]any{"pane_id": id, "agent_status": pre}, nowMs())
		c.setState(st) // reset only; the change is intentionally not emitted
	}
	for _, e := range buffered {
		c.handleEvent(e.name, e.data)
	}
}

func (c *HerdrClient) handleEvent(name string, data map[string]any) {
	if paneSetChangingEvents[name] {
		c.schedulePaneRebuild()
		return
	}
	if c.cur == nil {
		return
	}
	next, changes := applyEvent(c.cur, name, data, nowMs())
	c.setState(next)
	for _, ch := range changes {
		c.emitStatus(ch, next)
	}
	if len(changes) > 0 {
		c.refreshCompletionSeqsSoon()
	}
	// focus events (~10/s during desktop activity) update the model without a push
	if len(changes) > 0 || name == "workspace_renamed" || name == "tab_renamed" {
		c.scheduleBroadcast()
	}
}

// ── subscription ─────────────────────────────────────────────────────────────

// subscription is one events.subscribe connection. Its read loop runs on its own
// goroutine and posts each line, then the close, to the actor.
type subscription struct {
	mu         sync.Mutex
	conn       net.Conn
	destroyed  bool
	acked      bool     // actor-owned
	closed     bool     // actor-owned
	closeHooks []func() // actor-owned; like conn.once('close')
}

func (s *subscription) destroy() {
	s.mu.Lock()
	s.destroyed = true
	if s.conn != nil {
		s.conn.Close()
	}
	s.mu.Unlock()
}

func (s *subscription) onClose(f func()) { s.closeHooks = append(s.closeHooks, f) }

func buildSubscriptions(paneIDs []string) []map[string]string {
	subs := []map[string]string{}
	for _, t := range []string{
		"workspace.created", "workspace.updated", "workspace.renamed", "workspace.moved",
		"workspace.closed", "workspace.focused",
		"tab.created", "tab.closed", "tab.focused", "tab.renamed", "tab.moved",
		"pane.created", "pane.closed", "pane.focused", "pane.moved", "pane.exited",
		// fires when an agent is detected in a pane and when it exits: re-snapshot both ways
		"pane.agent_detected",
		"worktree.created", "worktree.opened", "worktree.removed",
	} {
		subs = append(subs, map[string]string{"type": t})
	}
	for _, id := range paneIDs {
		subs = append(subs, map[string]string{"type": "pane.agent_status_changed", "pane_id": id})
	}
	return subs
}

func (c *HerdrClient) openSubscription(paneIDs []string, onReady func()) *subscription {
	if c.destroyed {
		return nil
	}
	s := &subscription{}
	id := fmt.Sprintf("yoicks:sub:%d", time.Now().UnixMilli())
	go func() {
		conn, err := net.Dial("unix", c.socketPath)
		if err != nil {
			c.post(func() { c.onSubClose(s) })
			return
		}
		s.mu.Lock()
		s.conn = conn
		if s.destroyed {
			conn.Close()
		}
		s.mu.Unlock()
		// a socket that connects but never acks would otherwise hang forever
		ackTimer := time.AfterFunc(requestTimeout, func() {
			c.post(func() {
				if !s.acked {
					s.destroy()
				}
			})
		})
		req, _ := json.Marshal(map[string]any{"type": "request", "id": id, "method": "events.subscribe",
			"params": map[string]any{"subscriptions": buildSubscriptions(paneIDs)}})
		if _, err := conn.Write(append(req, '\n')); err == nil {
			r := bufio.NewReader(conn)
			for {
				line, err := r.ReadBytes('\n')
				if err != nil {
					break
				}
				c.post(func() { c.onSubLine(s, line, paneIDs, onReady) })
			}
		}
		ackTimer.Stop()
		conn.Close()
		c.post(func() { c.onSubClose(s) })
	}()
	return s
}

func (c *HerdrClient) onSubLine(s *subscription, line []byte, paneIDs []string, onReady func()) {
	if c.destroyed {
		return
	}
	if !s.acked {
		var msg struct {
			Result struct {
				Type string `json:"type"`
			} `json:"result"`
		}
		if json.Unmarshal(line, &msg) != nil || msg.Result.Type != "subscription_started" {
			return
		}
		s.acked = true
		c.setConnected(true)
		c.backoff = backoffInitial
		// Subscriptions are future-only: a change between the pre-subscribe snapshot
		// and this ack reached neither subscription. Replay one more snapshot against
		// the coverage live before this ack, then adopt this one's. On failure, drop
		// this subscription so the reconnect's snapshot replays the gap instead.
		prevCoverage := c.subscribed
		c.subscribed = map[string]bool{}
		for _, id := range paneIDs {
			c.subscribed[id] = true
		}
		c.fetchSnapshot(true, prevCoverage, func(err error) {
			if err != nil {
				logf("[herdr-client] subscription reconcile failed: %s", err)
				if s == c.subConn && !c.destroyed {
					s.destroy()
				}
			}
		})
		if onReady != nil {
			onReady()
		}
		return
	}
	// herdr mixes name forms: lifecycle events in underscore form (pane_created),
	// typed subscription events in dot form (pane.agent_status_changed)
	var ev struct {
		Event string         `json:"event"`
		Data  map[string]any `json:"data"`
	}
	if json.Unmarshal(line, &ev) != nil {
		return
	}
	name := strings.ReplaceAll(ev.Event, ".", "_")
	if name == "" {
		return
	}
	if ev.Data == nil {
		ev.Data = map[string]any{}
	}
	c.dispatchEvent(name, ev.Data)
}

func (c *HerdrClient) onSubClose(s *subscription) {
	if s.closed {
		return
	}
	s.closed = true
	if !c.destroyed && s == c.subConn {
		c.subConn = nil
		c.subscribed = map[string]bool{} // no live coverage until we resubscribe
		c.coverageEpoch++
		c.setConnected(false)
		// stop showing stale data as connected; the next snapshot restores it
		if c.cur != nil {
			c.setState(c.cur.withConnected(false))
			c.emitState(c.cur)
		}
		c.scheduleReconnect()
	}
	for _, f := range s.closeHooks {
		f()
	}
}

// ── rebuild, broadcast, completion seqs, reconnect ───────────────────────────

func (c *HerdrClient) schedulePaneRebuild() {
	c.schedule(&c.rebuildT, paneRebuildDebounce, func() {
		// replay status for panes the acknowledged subscription doesn't cover yet
		c.fetchSnapshot(true, c.subscribed, func(err error) {
			if err != nil {
				logf("[herdr-client] rebuild failed: %s", err)
				c.scheduleReconnect()
				return
			}
			// Keep the old subscription until the new one is acknowledged, so no events
			// are lost in between; drop it then, or when the new one dies first.
			oldConn := c.subConn
			oldDropped, newAcked := false, false
			dropOld := func() {
				if !oldDropped && oldConn != nil {
					oldDropped = true
					oldConn.destroy()
				}
			}
			newConn := c.openSubscription(c.cur.PaneIDs(), func() { newAcked = true; dropOld() })
			c.subConn = newConn
			if newConn != nil {
				newConn.onClose(dropOld)
			} else {
				dropOld()
			}
			// The old subscription dropping on its own before the new one acks loses
			// coverage of the existing panes: force a reconnect, which replays the gap.
			if oldConn != nil {
				oldConn.onClose(func() {
					if !oldDropped && !newAcked && !c.destroyed {
						c.subscribed = map[string]bool{}
						c.coverageEpoch++
						c.scheduleReconnect()
					}
				})
			}
		})
	})
}

func (c *HerdrClient) scheduleBroadcast() {
	c.schedule(&c.broadcastT, stateBroadcastDebounce, func() {
		if c.cur != nil {
			c.emitState(c.cur)
		}
	})
}

// refreshCompletionSeqsSoon fetches agent.list (the only place herdr reports
// completion_seq and state_change_seq) after each snapshot and status change.
// Trailing debounce: the request always goes out after the change that asked for
// it, which applyCompletionSeqs' requestedAt guard relies on. Best-effort.
func (c *HerdrClient) refreshCompletionSeqsSoon() { c.refreshAgentList(false) }

// refreshAgentList is refreshCompletionSeqsSoon's; `retry`: this is a failed one's second try, which
// isn't tried again (each trigger gets one retry; the debounce merges a retry into a trigger's).
func (c *HerdrClient) refreshAgentList(retry bool) {
	if c.destroyed {
		return
	}
	c.schedule(&c.completionT, completionSeqDebounce, func() {
		requestedAt := nowMs()
		epoch := c.coverageEpoch
		c.listSent++
		n := c.listSent
		go func() {
			res, err := herdrRPC(c.socketPath, "agent.list", nil)
			c.post(func() {
				// coverage lost meanwhile: the reconnect snapshot schedules a fresh fetch
				if c.destroyed || c.cur == nil || !c.cur.Connected || epoch != c.coverageEpoch {
					return
				}
				// failed: asked again once, a while later (or the names and seqs would wait for the
				// next status change or snapshot)
				if err != nil {
					if !retry {
						time.AfterFunc(agentListRetry, func() { c.post(func() { c.refreshAgentList(true) }) })
					}
					return
				}
				var r struct {
					Agents []RawAgentSeqs `json:"agents"`
				}
				// answers can land out of order: an older one would put back what the newer one
				// replaced (a renamed agent's old name)
				if json.Unmarshal(res, &r) != nil || n < c.listApplied {
					return
				}
				c.listApplied = n
				next := applyCompletionSeqs(c.cur, r.Agents, requestedAt)
				if next == c.cur {
					return
				}
				c.setState(next)
				c.emitState(next)
			})
		}()
	})
}

func (c *HerdrClient) scheduleReconnect() {
	if c.destroyed {
		return
	}
	delay := c.backoff
	c.backoff = min(c.backoff*2, backoffMax)
	time.AfterFunc(delay, func() { c.post(c.connect) })
}

func (c *HerdrClient) connect() {
	if c.destroyed {
		return
	}
	// replays changes missed while the subscription was down (nothing to diff
	// against on the very first connect)
	c.fetchSnapshot(true, c.subscribed, func(err error) {
		if err != nil {
			logf("[herdr-client] connect failed: %s", err)
			c.scheduleReconnect()
			return
		}
		if c.subConn != nil {
			c.subConn.destroy()
		}
		c.subConn = c.openSubscription(c.cur.PaneIDs(), nil)
	})
}
