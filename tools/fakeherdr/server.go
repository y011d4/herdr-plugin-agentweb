// Package fakeherdr is a scriptable stand-in for the herdr server socket, for
// recording what the TypeScript bridge does and checking the Go port does the same.
//
// Like herdr (protocol 22): one NDJSON request per connection, answered and closed,
// except events.subscribe, which acks and then streams the events its subscriptions
// match until either side closes. Subscriptions are future-only: an event emitted
// before a subscription is acked never reaches it. Every request is recorded.
package fakeherdr

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// Request is one request as the server received it.
type Request struct {
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

// Reply is how the server answers a request.
type Reply struct {
	Result  any           // the result object (ignored when Code is set)
	Code    string        // non-empty: answer with error {code, message}
	Message string        // error message
	Delay   time.Duration // wait this long before answering
	Close   bool          // close the connection without answering (like an invalid enum)
	Hang    bool          // never answer; the connection stays open until the client gives up
	// Wait (when set) answers later: it is called with a channel closed once the client leaves
	// (a held wait, like herdr's agent.wait), and what it returns is the answer
	Wait func(gone <-chan struct{}) Reply
}

// Handler answers every request except events.subscribe. It runs on the request's
// own goroutine, so it may block.
type Handler func(method string, params json.RawMessage) Reply

// Server is a fake herdr listening on a unix socket.
type Server struct {
	Path string

	ln      net.Listener
	handler Handler

	mu       sync.Mutex
	requests []Request
	conns    map[net.Conn]struct{}
	subs     map[*sub]struct{}
	ackDelay time.Duration
	noAck    int // how many upcoming subscriptions get no ack at all
	closed   bool
}

type sub struct {
	conn  net.Conn
	wmu   sync.Mutex
	match []subscription
}

type subscription struct {
	Type   string `json:"type"`
	PaneID string `json:"pane_id,omitempty"`
}

// Start listens on path (removing a stale socket first) and serves until Close.
func Start(path string, h Handler) (*Server, error) {
	_ = os.Remove(path)
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	s := &Server{Path: path, ln: ln, handler: h, conns: map[net.Conn]struct{}{}, subs: map[*sub]struct{}{}}
	go s.accept()
	return s, nil
}

// Close stops listening and closes every open connection.
func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	conns := make([]net.Conn, 0, len(s.conns))
	for c := range s.conns {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	s.ln.Close()
	for _, c := range conns {
		c.Close()
	}
	_ = os.Remove(s.Path)
}

// Requests returns a copy of every request received so far, in arrival order.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// SetAckDelay delays the ack of subscriptions that start from now on.
func (s *Server) SetAckDelay(d time.Duration) {
	s.mu.Lock()
	s.ackDelay = d
	s.mu.Unlock()
}

// WithholdAcks makes the next n subscriptions never get an ack.
func (s *Server) WithholdAcks(n int) {
	s.mu.Lock()
	s.noAck = n
	s.mu.Unlock()
}

// DropSubscriptions closes every acked subscription connection (one still waiting
// for its ack is left alone) and returns how many it closed.
func (s *Server) DropSubscriptions() int {
	s.mu.Lock()
	subs := make([]*sub, 0, len(s.subs))
	for x := range s.subs {
		subs = append(subs, x)
	}
	s.mu.Unlock()
	for _, x := range subs {
		x.conn.Close()
	}
	return len(subs)
}

// Subscribed reports how many acked subscriptions are open.
func (s *Server) Subscribed() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.subs)
}

// Emit sends an event to every acked subscription that matches it. kind is the
// subscription type in dot form (pane.agent_status_changed, pane.created, ...).
// herdr names typed subscription events in dot form on the wire and lifecycle
// events in underscore form, so this does the same.
func (s *Server) Emit(kind string, data map[string]any) {
	wire := kind
	if !typedEvents[kind] {
		wire = strings.ReplaceAll(kind, ".", "_")
	}
	line, _ := json.Marshal(map[string]any{"event": wire, "data": data})
	line = append(line, '\n')
	paneID, _ := data["pane_id"].(string)
	s.mu.Lock()
	var targets []*sub
	for x := range s.subs {
		for _, m := range x.match {
			if m.Type == kind && (m.PaneID == "" || m.PaneID == paneID) {
				targets = append(targets, x)
				break
			}
		}
	}
	s.mu.Unlock()
	for _, x := range targets {
		x.wmu.Lock()
		x.conn.Write(line)
		x.wmu.Unlock()
	}
}

// typed subscription events keep their dot form on the wire (schema SubscriptionEventKind)
var typedEvents = map[string]bool{
	"pane.output_matched":       true,
	"pane.agent_status_changed": true,
	"pane.scroll_changed":       true,
}

func (s *Server) accept() {
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			c.Close()
			return
		}
		s.conns[c] = struct{}{}
		s.mu.Unlock()
		go s.serve(c)
	}
}

func (s *Server) serve(c net.Conn) {
	defer func() {
		c.Close()
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
	}()
	r := bufio.NewReader(c)
	line, err := r.ReadBytes('\n')
	if err != nil {
		return
	}
	var req struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if json.Unmarshal(line, &req) != nil {
		return
	}
	s.mu.Lock()
	s.requests = append(s.requests, Request{Method: req.Method, Params: req.Params})
	s.mu.Unlock()

	if req.Method == "events.subscribe" {
		s.subscribe(c, r, req.ID, req.Params)
		return
	}
	rep := s.handler(req.Method, req.Params)
	if rep.Wait != nil {
		gone := make(chan struct{})
		go func() { io.Copy(io.Discard, r); close(gone) }() // the client closes, or Close does
		rep = rep.Wait(gone)
	}
	if rep.Delay > 0 {
		time.Sleep(rep.Delay)
	}
	switch {
	case rep.Hang:
		_, _ = r.ReadBytes('\n') // until the client hangs up
		return
	case rep.Close:
		return
	}
	writeReply(c, req.ID, rep)
}

func writeReply(c net.Conn, id json.RawMessage, rep Reply) {
	msg := map[string]any{"id": id}
	if rep.Code != "" {
		msg["error"] = map[string]string{"code": rep.Code, "message": rep.Message}
	} else {
		result := rep.Result
		if result == nil {
			result = map[string]any{}
		}
		msg["result"] = result
	}
	b, _ := json.Marshal(msg)
	c.Write(append(b, '\n'))
}

func (s *Server) subscribe(c net.Conn, r *bufio.Reader, id, params json.RawMessage) {
	var p struct {
		Subscriptions []subscription `json:"subscriptions"`
	}
	_ = json.Unmarshal(params, &p)
	s.mu.Lock()
	delay := s.ackDelay
	withhold := s.noAck > 0
	if withhold {
		s.noAck--
	}
	s.mu.Unlock()

	x := &sub{conn: c, match: p.Subscriptions}
	if !withhold {
		if delay > 0 {
			time.Sleep(delay)
		}
		// registered before the ack goes out, but holding the write lock: an event
		// emitted meanwhile waits and follows the ack instead of being lost
		x.wmu.Lock()
		s.mu.Lock()
		s.subs[x] = struct{}{}
		s.mu.Unlock()
		writeReply(c, id, Reply{Result: map[string]any{"type": "subscription_started"}})
		x.wmu.Unlock()
	}
	_, _ = r.ReadBytes('\n') // until either side closes
	s.mu.Lock()
	delete(s.subs, x)
	s.mu.Unlock()
}
