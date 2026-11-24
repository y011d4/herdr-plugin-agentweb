package bridge

// The /ws push channel, the WebSocket half of server/http.ts: state and agent_status
// pushes to every client, plus per-client pane and transcript watches.
//
// Each connection has its own sender goroutine behind a bounded queue (coder/websocket
// writes block until written, where Node's ws.send just queues). A client that stops
// reading until its queue fills is dropped (divergences.md D3); the phone reconnects
// and gets the latest state.
//
// broadcastState reads the client's latest published State, builds the message,
// dedupes it and queues it to every client under one lock (bmu), so an older state
// can't be queued after a newer one. It calls the account cache's Refresh under bmu;
// the cache calls its onChange (broadcastState again) with no lock of its own held,
// so the two locks are only ever taken in that order.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	wsReadLimit               = 64 * 1024 // the only expected inbound message is a small ping
	wsSendQueue               = 256
	paneWatchInterval         = 800 * time.Millisecond // server-side poll rate for a watched pane
	transcriptWatchInterval   = time.Second            // poll rate for a watched chat transcript
	transcriptResolveInterval = 5 * time.Second        // re-resolve the session id at most this often
)

func (s *server) serveUpgrade(w http.ResponseWriter, r *http.Request, pathname string) {
	if pathname != "/ws" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if !verifyToken(extractToken(r)) {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The Origin isn't checked, as the ws library didn't: /ws needs the token, which
		// another site's page doesn't have, and a check would break a reverse proxy
		// that rewrites Host (README's public_url). Despite the name this has nothing
		// to do with TLS.
		InsecureSkipVerify: true,
		// permessage-deflate: pane_output resends the whole screen (~9 KB) on every
		// change and consecutive screens are near-identical, so context takeover cuts
		// a busy pane view ~40x. 1 KB is the ws library's threshold.
		CompressionMode:      websocket.CompressionContextTakeover,
		CompressionThreshold: 1024,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(wsReadLimit) // a bigger message closes the connection with 1009
	ctx, cancel := context.WithCancel(context.Background())
	c := &wsClient{srv: s, conn: conn, ctx: ctx, cancel: cancel, queue: make(chan []byte, wsSendQueue)}
	s.addClient(c)
	go c.sendLoop()
	defer func() {
		s.bmu.Lock()
		delete(s.clients, c)
		s.bmu.Unlock()
		c.mu.Lock()
		c.stopPaneWatch()
		c.stopTranscriptWatch()
		c.mu.Unlock()
		cancel()
		conn.CloseNow()
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		c.handle(data)
	}
}

// addClient registers c and queues it the current state, under the broadcast lock so
// no broadcast can come between (and arrive before) them.
func (s *server) addClient(c *wsClient) {
	s.bmu.Lock()
	defer s.bmu.Unlock()
	s.clients[c] = struct{}{}
	if st := s.client.State(); st != nil {
		c.send(WsStateMessage{Type: "state", State: s.clientState(st)})
	}
}

// broadcastState pushes the latest state to every client unless it is the same as
// the last one pushed. Focus churn in the TUI makes frequent no-op updates. The
// baseline moves even with no client connected, so a client that connects during a
// lull isn't left stale when the state later returns to an earlier value (its first
// state came straight from the current one).
func (s *server) broadcastState() {
	s.bmu.Lock()
	defer s.bmu.Unlock()
	st := s.client.State()
	if st == nil {
		return
	}
	var agentPanes []string
	for _, id := range st.paneOrder {
		if st.paneByID[id].Agent != nil {
			agentPanes = append(agentPanes, id)
		}
	}
	s.accounts.Refresh(agentPanes)
	msg, err := marshalRaw(WsStateMessage{Type: "state", State: s.clientState(st)})
	if err != nil || bytes.Equal(msg, s.lastState) {
		return
	}
	s.lastState = msg
	for c := range s.clients {
		c.queueMsg(msg)
	}
}

func (s *server) broadcastAgentStatus(change StatusChange, st *State) {
	s.bmu.Lock()
	defer s.bmu.Unlock()
	if len(s.clients) == 0 {
		return
	}
	msg, err := marshalRaw(buildAgentStatusMessage(change, st))
	if err != nil {
		return
	}
	for c := range s.clients {
		c.queueMsg(msg)
	}
}

// ── one connection ───────────────────────────────────────────────────────────

type wsClient struct {
	srv    *server
	conn   *websocket.Conn
	ctx    context.Context // done once the connection is finished with
	cancel context.CancelFunc
	queue  chan []byte

	// mu guards the watches: a poll queues its result only while its watch is still
	// the current one (its generation), as the TS checks its watched id after each await
	mu            sync.Mutex
	paneGen       int
	paneStop      context.CancelFunc
	transcriptGen int
	transcriptEnd context.CancelFunc
}

func (c *wsClient) sendLoop() {
	for {
		select {
		case <-c.ctx.Done():
			return
		case msg := <-c.queue:
			if c.conn.Write(c.ctx, websocket.MessageText, msg) != nil {
				c.cancel()
				return
			}
		}
	}
}

// queueMsg queues msg, or drops the connection when its queue is full.
func (c *wsClient) queueMsg(msg []byte) {
	select {
	case c.queue <- msg:
	default:
		c.cancel() // the read loop then ends and cleans up
	}
}

func (c *wsClient) send(v any) {
	if msg, err := marshalRaw(v); err == nil {
		c.queueMsg(msg)
	}
}

func (c *wsClient) handle(data []byte) {
	var msg map[string]any
	if json.Unmarshal(data, &msg) != nil {
		return
	}
	paneID, hasPane := msg["paneId"].(string)
	switch msg["type"] {
	case "ping":
		c.send(WsPongMessage{Type: "pong"})
	case "watch_pane":
		if hasPane {
			c.watchPane(paneID)
		}
	case "unwatch_pane":
		c.mu.Lock()
		c.stopPaneWatch()
		c.mu.Unlock()
	case "watch_transcript":
		if hasPane {
			c.watchTranscript(paneID)
		}
	case "unwatch_transcript":
		c.mu.Lock()
		c.stopTranscriptWatch()
		c.mu.Unlock()
	}
}

// every runs poll now and then every interval until ctx ends or poll returns false.
// A poll that overruns the interval skips the ticks it covered (the TS in-flight guard).
func every(ctx context.Context, interval time.Duration, poll func() bool) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for poll() {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// ── pane watch ───────────────────────────────────────────────────────────────

// stopPaneWatch ends the pane watch; c.mu held.
func (c *wsClient) stopPaneWatch() {
	c.paneGen++
	if c.paneStop != nil {
		c.paneStop()
		c.paneStop = nil
	}
}

// watchPane polls the pane server-side over the cheap unix socket while the client
// views it, and pushes its screen only when that changed: near-real-time keypress
// echo without client-side fast polling.
func (c *wsClient) watchPane(paneID string) {
	c.mu.Lock()
	c.stopPaneWatch()
	gen := c.paneGen
	ctx, stop := context.WithCancel(c.ctx)
	c.paneStop = stop
	c.mu.Unlock()
	var last *WsPaneOutputMessage // the last screen pushed
	go every(ctx, paneWatchInterval, func() bool { return c.pollPane(gen, paneID, &last) })
}

// pollPane is one look at the watched pane; false once the watch is over.
func (c *wsClient) pollPane(gen int, paneID string, last **WsPaneOutputMessage) bool {
	raw, err := c.srv.rpc("pane.read", map[string]any{"pane_id": paneID, "source": "visible", "lines": 200, "format": "ansi"})
	if err != nil {
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.paneGen != gen {
			return false
		}
		// A transient error must not end the watch (the client only falls back to HTTP
		// polling when the socket drops), but a pane gone from the state is gone for
		// good: stop, and tell the client to leave.
		if st := c.srv.client.State(); st != nil && st.Pane(paneID) == nil {
			c.stopPaneWatch()
			c.send(WsPaneGoneMessage{Type: "pane_gone", PaneID: paneID})
			return false
		}
		return true
	}
	var res struct {
		Read *struct {
			Text string `json:"text"`
		} `json:"read"`
	}
	json.Unmarshal(raw, &res)
	ansi := ""
	if res.Read != nil {
		ansi = res.Read.Text
	}
	// Fresh scroll metadata (pane.get) drives the app-scroll decision; if that fails
	// the screen already read still goes out, with the last decision (or false).
	appScroll := *last != nil && (*last).AppScroll
	if info, err := c.srv.paneInfo(paneID); err == nil {
		appScroll = computeAppScroll(info, ansi)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.paneGen != gen {
		return false
	}
	if *last == nil || (*last).Ansi != ansi || (*last).AppScroll != appScroll {
		*last = &WsPaneOutputMessage{Type: "pane_output", PaneID: paneID, Ansi: ansi, AppScroll: appScroll}
		c.send(*last)
	}
	return true
}

// ── transcript watch ─────────────────────────────────────────────────────────

// stopTranscriptWatch ends the transcript watch; c.mu held.
func (c *wsClient) stopTranscriptWatch() {
	c.transcriptGen++
	if c.transcriptEnd != nil {
		c.transcriptEnd()
		c.transcriptEnd = nil
	}
}

// transcriptWatch is one transcript watch's own state.
type transcriptWatch struct {
	sessionID *string // nil: not resolved yet; "": last resolved unavailable
	file      string
	cursor    int64
	resolveAt time.Time // last session-id resolution
}

// watchTranscript tails the pane's JSONL transcript while the client views it in chat
// mode and pushes new TimelineItems. The session id is re-resolved (pane.get + a
// projects-dir scan) only every 5 s, to catch a mid-session reset (/clear: a new
// session file); the resolved file is tailed cheaply on every tick.
func (c *wsClient) watchTranscript(paneID string) {
	c.mu.Lock()
	c.stopTranscriptWatch()
	gen := c.transcriptGen
	ctx, stop := context.WithCancel(c.ctx)
	c.transcriptEnd = stop
	c.mu.Unlock()
	tw := &transcriptWatch{}
	go every(ctx, transcriptWatchInterval, func() bool { return c.pollTranscript(gen, paneID, tw) })
}

func (c *wsClient) pollTranscript(gen int, paneID string, tw *transcriptWatch) bool {
	current := func() bool { return c.transcriptGen == gen } // c.mu held
	if time.Since(tw.resolveAt) >= c.srv.transcriptResolve {
		tw.resolveAt = time.Now()
		sessionID, file, err := c.srv.resolvePaneTranscript(paneID)
		c.mu.Lock()
		defer c.mu.Unlock()
		if !current() {
			return false
		}
		if err != nil {
			return true // transient: retried at the next resolve
		}
		if sessionID == "" || file == "" {
			// not a claude pane, or its transcript isn't on this host: tell the client
			// once so it falls back to the terminal
			if tw.sessionID == nil || *tw.sessionID != "" {
				tw.sessionID, tw.file = new(""), ""
				c.send(WsTranscriptItemsMessage{Type: "transcript_items", PaneID: paneID, Available: false, Reset: true, Items: []TimelineItem{}})
			}
			return true
		}
		if tw.sessionID == nil || *tw.sessionID != sessionID || tw.file != file {
			// the first resolve for this session (or a mid-session switch): the tail
			tw.sessionID, tw.file = &sessionID, file
			t := readTranscriptTail(file, transcriptInitialItems)
			tw.cursor = t.Cursor
			c.send(WsTranscriptItemsMessage{Type: "transcript_items", PaneID: paneID, Available: true,
				SessionID: &sessionID, Items: t.Items, Cursor: t.Cursor, Reset: true})
			return true
		}
		return c.tailTranscript(paneID, tw)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !current() {
		return false
	}
	return c.tailTranscript(paneID, tw)
}

// tailTranscript pushes what was appended to the resolved file since the cursor; c.mu held.
func (c *wsClient) tailTranscript(paneID string, tw *transcriptWatch) bool {
	if tw.file == "" || tw.sessionID == nil || *tw.sessionID == "" {
		return true
	}
	ch := readTranscriptFrom(tw.file, tw.cursor, transcriptInitialItems)
	tw.cursor = ch.Cursor
	if ch.Reset || len(ch.Items) > 0 {
		c.send(WsTranscriptItemsMessage{Type: "transcript_items", PaneID: paneID, Available: true,
			SessionID: tw.sessionID, Items: ch.Items, Cursor: ch.Cursor, Reset: ch.Reset})
	}
	return true
}
