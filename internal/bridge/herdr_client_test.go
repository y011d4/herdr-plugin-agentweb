package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/y011d4/herdr-yoicks/tools/fakeherdr"
)

func TestMain(m *testing.M) {
	logf = log.New(io.Discard, "", 0).Printf
	os.Exit(m.Run())
}

// Every fakeherdr scenario, run against this client, must report what the
// TypeScript client it was ported from (since deleted) reported in testdata/scenarios.
func TestHerdrClientMatchesTypeScriptRecordings(t *testing.T) {
	for _, sc := range fakeherdr.Scenarios {
		t.Run(sc.Name, func(t *testing.T) {
			t.Parallel()
			b, err := os.ReadFile(filepath.Join("..", "..", "testdata", "scenarios", sc.Name+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var want fakeherdr.Recording
			if err := json.Unmarshal(b, &want); err != nil {
				t.Fatal(err)
			}
			got := runScenario(t, sc)
			for _, d := range fakeherdr.Compare(sc, want.Outputs, got) {
				t.Error(d)
			}
			if t.Failed() {
				for _, o := range got {
					j, _ := json.Marshal(o)
					t.Log(string(j))
				}
			}
		})
	}
}

type goClient struct{ c *HerdrClient }

func (g goClient) Refresh() { go g.c.Refresh() }

func runScenario(t *testing.T, sc fakeherdr.Scenario) []fakeherdr.Output {
	dir, err := os.MkdirTemp("", "fh") // unix socket paths must stay short
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	world := fakeherdr.NewWorld()
	srv, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), world.Handler())
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	env := &fakeherdr.Env{Srv: srv, World: world, Errorf: t.Errorf}
	if sc.Setup != nil {
		sc.Setup(env)
	}

	var mu sync.Mutex
	var outs []fakeherdr.Output
	t0 := time.Now()
	add := func(o fakeherdr.Output) {
		mu.Lock()
		o.T = time.Since(t0).Milliseconds()
		outs = append(outs, o)
		mu.Unlock()
	}
	c := NewHerdrClient(srv.Path, HerdrClientCallbacks{
		OnState: func(s *State) {
			add(summarize(s))
		},
		OnAgentStatus: func(ch StatusChange, _ *State) {
			add(fakeherdr.Output{Kind: "status", PaneID: ch.PaneID, From: ch.From, To: ch.To})
		},
		OnConnectionChange: func(v bool) { add(fakeherdr.Output{Kind: "conn", Connected: &v}) },
	})
	c.Start()
	env.Client = goClient{c}
	sc.Run(env)
	time.Sleep(fakeherdr.Settle)
	c.Destroy()
	mu.Lock()
	defer mu.Unlock()
	return append([]fakeherdr.Output(nil), outs...)
}

// summarize reduces a state push to what the recordings hold.
func summarize(s *State) fakeherdr.Output {
	m := map[string]*fakeherdr.PaneAgent{}
	for _, id := range s.PaneIDs() {
		a := s.Pane(id).Agent
		if a == nil {
			m[id] = nil
			continue
		}
		m[id] = &fakeherdr.PaneAgent{Status: a.Status, Seq: a.CompletionSeq, ChangeSeq: a.StateChangeSeq}
	}
	tabs := map[string]string{}
	for id, t := range s.tabByID {
		tabs[id] = t.Label
	}
	val := func(p *string) string {
		if p == nil {
			return ""
		}
		return *p
	}
	f := s.Focused
	conn := s.Connected
	return fakeherdr.Output{Kind: "state", Connected: &conn, Panes: m, Tabs: tabs,
		Focused: val(f.WorkspaceID) + "/" + val(f.TabID) + "/" + val(f.PaneID)}
}

func TestHerdrRPCReturnsHerdrErrorCode(t *testing.T) {
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	srv, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), func(method string, _ json.RawMessage) fakeherdr.Reply {
		switch method {
		case "agent.start":
			return fakeherdr.Reply{Code: "agent_pane_busy", Message: "pane busy"}
		case "pane.read":
			return fakeherdr.Reply{Close: true}
		}
		return fakeherdr.Reply{Result: map[string]any{"text": "日本語"}}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()

	_, err = herdrRPC(srv.Path, "agent.start", nil)
	if he, ok := err.(*HerdrError); !ok || he.Code != "agent_pane_busy" {
		t.Errorf("agent.start: want HerdrError agent_pane_busy, got %v", err)
	}
	if _, err := herdrRPC(srv.Path, "pane.read", nil); err == nil || err.Error() != "connection closed" {
		t.Errorf("pane.read: want connection closed, got %v", err)
	}
	res, err := herdrRPC(srv.Path, "pane.get", map[string]any{"pane_id": "p1"})
	if err != nil || string(res) != fmt.Sprintf(`{"text":%q}`, "日本語") {
		t.Errorf("pane.get: got %s %v", res, err)
	}
}

// actorValue reads something the client's actor owns.
func actorValue[T any](c *HerdrClient, f func() T) T {
	ch := make(chan T, 1)
	c.post(func() { ch <- f() })
	return <-ch
}

// The wait before a reconnect doubles after each failure, up to 30 s, and starts over
// once a subscription is acknowledged.
func TestHerdrClientReconnectBackoff(t *testing.T) {
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "h.sock") // nothing listens yet
	clock := fakeherdr.NewFakeClock()
	c := NewHerdrClient(sock, HerdrClientCallbacks{})
	c.clock = clock
	defer c.Destroy()
	c.post(func() { c.backoff = 5 * time.Millisecond })
	c.Start()
	for _, ms := range []time.Duration{5, 10, 20} { // each failure waits twice the one before
		pass(t, clock, "the reconnect", ms*time.Millisecond)
	}
	clockWaiting(t, clock, "the reconnect", 40*time.Millisecond)
	srv, err := fakeherdr.Start(sock, fakeherdr.NewWorld().Handler())
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	clock.Advance(40 * time.Millisecond)
	waitUntil(t, 5*time.Second, "connected", c.IsConnected)
	if b := actorValue(c, func() time.Duration { return c.backoff }); b != backoffInitial {
		t.Errorf("connected, the wait is %v, want it back at %v", b, backoffInitial)
	}

	capped := NewHerdrClient(filepath.Join(dir, "none.sock"), HerdrClientCallbacks{})
	capped.clock = fakeherdr.NewFakeClock()
	defer capped.Destroy()
	capped.post(func() { capped.backoff = 20 * time.Second })
	capped.Start()
	clockWaiting(t, capped.clock.(*fakeherdr.FakeClock), "the reconnect", 20*time.Second) // failed once
	if b := actorValue(capped, func() time.Duration { return capped.backoff }); b != backoffMax {
		t.Errorf("doubling 20 s gave %v, want the %v cap", b, backoffMax)
	}
}

// An agent.list answer to a request sent before the subscription dropped may predate
// changes the bridge never saw: it is ignored, even when it lands after the reconnect
// (coverageEpoch).
func TestHerdrClientIgnoresAnAgentListFromBeforeADrop(t *testing.T) {
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	world := fakeherdr.NewWorld()
	worldH := world.Handler()
	var mu sync.Mutex
	calls := 0
	stale := make(chan struct{}) // the first answer goes out when closed
	srv, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), func(m string, p json.RawMessage) fakeherdr.Reply {
		if m != "agent.list" {
			return worldH(m, p)
		}
		mu.Lock()
		calls++
		first := calls == 1
		mu.Unlock()
		list := func(seq int) fakeherdr.Reply {
			return fakeherdr.Reply{Result: map[string]any{"agents": []any{
				map[string]any{"pane_id": "p1", "agent": "claude", "agent_status": "idle", "completion_seq": seq}}}}
		}
		if !first {
			return list(2)
		}
		return fakeherdr.Reply{Wait: func(gone <-chan struct{}) fakeherdr.Reply { // answered after the drop and the reconnect
			select {
			case <-stale:
				return list(1)
			case <-gone:
				return fakeherdr.Reply{Close: true}
			}
		}}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	clock := fakeherdr.NewFakeClock()
	c := NewHerdrClient(srv.Path, HerdrClientCallbacks{})
	c.clock = clock
	handled := make(chan struct{}, 2)
	c.agentListHook = func() { handled <- struct{}{} }
	defer c.Destroy()
	c.Start()
	seq := func() int64 {
		s := c.State()
		if s == nil || s.Pane("p1") == nil || s.Pane("p1").Agent.CompletionSeq == nil {
			return 0
		}
		return *s.Pane("p1").Agent.CompletionSeq
	}
	pass(t, clock, "agent.list's debounce", completionSeqDebounce)
	env := &fakeherdr.Env{Srv: srv, World: world, Errorf: t.Errorf}
	env.WaitCount("agent.list", 1, 5*time.Second)
	if srv.DropSubscriptions() != 1 {
		t.Fatal("expected to drop one subscription")
	}
	pass(t, clock, "the reconnect", backoffInitial)
	pass(t, clock, "agent.list's debounce", completionSeqDebounce)
	<-handled // the reconnect's
	if got := seq(); got != 2 {
		t.Fatalf("p1's completion seq after the reconnect: %d, want 2", got)
	}
	close(stale)
	<-handled // the one from before the drop
	if got := seq(); got != 2 {
		t.Errorf("p1's completion seq: want 2 from after the reconnect, got %d", got)
	}
}

// herdr's waits have no deadline of their own, so HerdrClient.Wait gives its answer none: a
// wait outlasts a request sent after it whose deadline has passed. (The request timeout is
// shortened; a socket deadline runs on the real time, so this is the one wait on it.)
func TestHerdrWaitHasNoDeadline(t *testing.T) {
	old := requestTimeoutNs.Load()
	requestTimeoutNs.Store(int64(100 * time.Millisecond))
	t.Cleanup(func() { requestTimeoutNs.Store(old) })
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	release := make(chan struct{})
	srv, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), func(string, json.RawMessage) fakeherdr.Reply {
		return fakeherdr.Reply{Wait: func(gone <-chan struct{}) fakeherdr.Reply {
			select {
			case <-release:
				return fakeherdr.Reply{Result: map[string]any{"type": "agent_info"}}
			case <-gone:
				return fakeherdr.Reply{Close: true}
			}
		}}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Close()
	waited := make(chan error, 1)
	go func() {
		_, err := NewHerdrClient(srv.Path, HerdrClientCallbacks{}).Wait(context.Background(), "agent.wait", map[string]any{"target": "w1"})
		waited <- err
	}()
	waitUntil(t, 5*time.Second, "the wait at herdr", func() bool { return len(srv.Requests()) == 1 })
	if _, err := herdrRPC(srv.Path, "agent.wait", map[string]any{"target": "w1"}); err == nil || !strings.Contains(err.Error(), "RPC timeout") {
		t.Fatalf("a request with the deadline: %v", err)
	}
	select {
	case err := <-waited:
		t.Fatalf("the wait ended with the request's deadline: %v", err)
	default:
	}
	close(release)
	if err := <-waited; err != nil {
		t.Errorf("the wait: %v", err)
	}
}

// A no-deadline call (herdr's waits) is given up by its context: one cancelled already sends
// nothing (not even a connection), one cancelled while herdr says nothing returns at once.
func TestHerdrCallCancellation(t *testing.T) {
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	var mu sync.Mutex
	conns, got := 0, 0
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns++
			mu.Unlock()
			go func() { // reads, never answers
				b := make([]byte, 4096)
				for {
					n, err := c.Read(b)
					mu.Lock()
					got += n
					mu.Unlock()
					if err != nil {
						return
					}
				}
			}()
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := herdrCall(ctx, sock, "agent.wait", map[string]any{"target": "p1"}, 0); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled before: %v", err)
	}
	// a connection of its own with one byte: by the time that byte is read, one made before it
	// was accepted too
	sentinel, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer sentinel.Close()
	sentinel.Write([]byte("x"))
	waitUntil(t, 5*time.Second, "the byte", func() bool { mu.Lock(); defer mu.Unlock(); return got > 0 })
	mu.Lock()
	extraConns, extraBytes := conns-1, got-1
	mu.Unlock()
	if extraConns != 0 || extraBytes != 0 {
		t.Fatalf("cancelled before: %d connections, %d bytes besides the one", extraConns, extraBytes)
	}

	ctx, cancel = context.WithCancel(context.Background())
	cancelled := make(chan time.Time, 1)
	go func() { // once herdr has the request, which it never answers
		for end := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
			mu.Lock()
			in := conns == 2 && got > 1
			mu.Unlock()
			if in {
				break
			}
			if time.Now().After(end) {
				t.Error("herdr never got the request")
				break
			}
		}
		cancelled <- time.Now()
		cancel()
	}()
	if _, err := herdrCall(ctx, sock, "agent.wait", map[string]any{"target": "p1"}, 0); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled while waiting: %v", err)
	}
	if d := time.Since(<-cancelled); d > time.Second {
		t.Errorf("returned %s after the cancel", d)
	}
}

// A cancel during a write blocked on a herdr that stopped reading closes the connection at
// once: the call returns, and herdr never gets a whole request line.
func TestHerdrCallCancelDuringABlockedWrite(t *testing.T) {
	dir, _ := os.MkdirTemp("", "fh")
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "h.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			accepted <- c // and doesn't read, for now
		}
	}()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { // a request far bigger than the socket's buffers
		_, err := herdrCall(ctx, sock, "agent.prompt", map[string]any{"target": "p1", "text": strings.Repeat("x", 8<<20)}, 0)
		done <- err
	}()
	peer := <-accepted
	defer peer.Close()
	first := make([]byte, 1) // the write has begun
	if _, err := io.ReadFull(peer, first); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond) // and fills the buffers: blocked
	began := time.Now()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("err %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the call didn't return after the cancel")
	}
	if d := time.Since(began); d > time.Second {
		t.Errorf("returned %s after the cancel", d)
	}
	rest, _ := io.ReadAll(peer) // what reached herdr, now that it reads again
	got := append(first, rest...)
	if bytes.IndexByte(got, '\n') >= 0 {
		t.Errorf("herdr got a whole request line (%d bytes)", len(got))
	}
}
