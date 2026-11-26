package bridge

// The HTTP and WS server (http.go, ws.go) against a fake herdr: the token on every
// route, input limits, static files, WS behavior and the security invariants, beyond
// the wire recordings, which tools/fakeherdr/cmd/record-wire compares.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"github.com/y011d4/herdr-yoicks/tools/fakeherdr"
)

// override answers a request in place of the fake World (ok = handled).
type override func(method string, params json.RawMessage) (rep fakeherdr.Reply, ok bool)

type testBridge struct {
	fake  *fakeherdr.Server
	srv   *server
	http  *httptest.Server
	token string
}

var testWeb = fstest.MapFS{
	"index.html":         {Data: []byte("<!doctype html>")},
	"app.js":             {Data: []byte("app()")},
	"sw.js":              {Data: []byte("sw()")},
	"style.css":          {Data: []byte("body{}")},
	"icons/icon-192.png": {Data: []byte("png")},
	"notes.bin":          {Data: []byte("?")},

	"assets/index-abcd1234.js": {Data: []byte("app()")},
}

// startBridge runs the bridge on a fake herdr (World's three panes, plus over) and
// waits until it is connected. tweak (may be nil) runs before it serves.
func startBridge(t *testing.T, cfg Config, over override, tweak func(*server)) *testBridge {
	t.Helper()
	dir, err := os.MkdirTemp("", "fh") // unix socket paths must stay short
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	world := fakeherdr.NewWorld()
	worldH := world.Handler()
	fake, err := fakeherdr.Start(filepath.Join(dir, "h.sock"), func(m string, p json.RawMessage) fakeherdr.Reply {
		if over != nil {
			if rep, ok := over(m, p); ok {
				return rep
			}
		}
		return worldH(m, p)
	})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.StateDir == "" {
		cfg.StateDir = t.TempDir()
	}
	if cfg.LaunchProfiles == nil {
		cfg.LaunchProfiles = parseLaunchProfiles(nil)
	}
	token, err := initAuth(cfg.StateDir)
	if err != nil {
		t.Fatal(err)
	}
	var srv *server
	client := NewHerdrClient(fake.Path, HerdrClientCallbacks{
		OnState:       func(*State) { srv.broadcastState() },
		OnAgentStatus: func(ch StatusChange, st *State) { srv.broadcastAgentStatus(ch, st) },
	})
	srv = newServer(cfg, client, testWeb, "rules")
	if tweak != nil {
		tweak(srv)
	}
	client.Start()
	b := &testBridge{fake: fake, srv: srv, http: httptest.NewServer(srv), token: token}
	t.Cleanup(func() {
		b.http.Close()
		client.Destroy()
		srv.close()
		fake.Close()
	})
	waitUntil(t, 5*time.Second, "the bridge connects", func() bool { return client.IsConnected() && client.State() != nil })
	return b
}

func waitUntil(t *testing.T, timeout time.Duration, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(timeout); !ok(); time.Sleep(10 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("timed out waiting until %s", what)
		}
	}
}

// background requests the bridge sends on its own (state, seqs, accounts)
var backgroundMethods = []string{"events.subscribe", "session.snapshot", "agent.list", "pane.process_info"}

// sent is the methods of the requests herdr got from the n-th on, minus background ones.
func (b *testBridge) sent(n int) []string {
	var out []string
	for _, r := range b.fake.Requests()[n:] {
		if !slices.Contains(backgroundMethods, r.Method) {
			out = append(out, r.Method)
		}
	}
	return out
}

func (b *testBridge) do(t *testing.T, method, path, token string, body []byte) (int, string, http.Header) {
	t.Helper()
	req, err := http.NewRequest(method, b.http.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	out, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(out), res.Header
}

func (b *testBridge) dial(t *testing.T, opts *websocket.DialOptions) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(b.http.URL, "http")+"/ws?token="+b.token, opts)
}

var apiRoutes = []struct{ method, path string }{
	{"GET", "/api/state"}, {"GET", "/api/profiles"}, {"POST", "/api/agents"}, {"POST", "/api/worktrees"},
	{"POST", "/api/orchestrators/x/start"}, {"POST", "/api/orchestrators/x/send"}, {"POST", "/api/orchestrators/x/interrupt"},
	{"POST", "/api/orchestrators/x/clear"}, {"POST", "/api/orchestrators/x/stop"}, {"DELETE", "/api/panes/p1"}, {"GET", "/api/panes/p1/read"},
	{"POST", "/api/panes/p1/input"}, {"POST", "/api/panes/p1/focus"}, {"POST", "/api/panes/p1/scroll"},
	{"GET", "/api/panes/p1/transcript"}, {"POST", "/api/panes/p1/rename"}, {"POST", "/api/agents/p1/send"},
	{"POST", "/api/agents/p1/clear"}, {"GET", "/api/nope"},
}

func TestEveryAPIRouteAndTheWSNeedTheToken(t *testing.T) {
	b := startBridge(t, Config{}, nil, nil)
	n := len(b.fake.Requests())
	wrong := strings.Repeat("0", len(b.token))
	for _, r := range apiRoutes {
		for _, tok := range []string{"", wrong} {
			if status, body, _ := b.do(t, r.method, r.path, tok, []byte(`{}`)); status != 401 || !strings.Contains(body, `"unauthorized"`) {
				t.Errorf("%s %s with token %q: %d %s, want 401", r.method, r.path, tok, status, body)
			}
		}
	}
	if got := b.sent(n); len(got) != 0 {
		t.Errorf("herdr got %v from unauthorized requests", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(b.http.URL, "http")+"/ws", nil); err == nil || res == nil || res.StatusCode != 401 {
		t.Errorf("/ws without a token: %v %v, want a 401", res, err)
	}
	// open on purpose: the health check and the web UI
	if status, body, _ := b.do(t, "GET", "/healthz", "", nil); status != 200 || body != `{"ok":true,"herdrConnected":true}` {
		t.Errorf("/healthz: %d %s", status, body)
	}
	if status, _, _ := b.do(t, "GET", "/api/state", b.token, nil); status != 200 {
		t.Errorf("/api/state with the token: %d", status)
	}
	if status, _, _ := b.do(t, "GET", "/api/state?token="+b.token, "", nil); status != 200 {
		t.Errorf("/api/state with ?token=: %d", status)
	}
}

// herdr drops the connection without an answer on an invalid enum, so these are
// refused before herdr sees anything.
func TestInvalidRequestsNeverReachHerdr(t *testing.T) {
	b := startBridge(t, Config{}, nil, nil)
	n := len(b.fake.Requests())
	for _, c := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/api/panes/p1/read?source=bogus", "", 400},
		{"GET", "/api/panes/p1/read?format=html", "", 400},
		{"GET", "/api/panes/p1/read?lines=-1", "", 400},
		{"GET", "/api/panes/p1/read?lines=abc", "", 400},
		{"POST", "/api/panes/p1/input", `{"press":"12"}`, 400},
		{"POST", "/api/panes/p1/input", `{"press":2}`, 400},
		{"POST", "/api/panes/p1/input", `{"press":"1","expect_prompt":3}`, 400},
		{"POST", "/api/panes/p1/input", `{"keys":"enter"}`, 400},
		{"POST", "/api/panes/p1/input", `{"keys":[1]}`, 400},
		{"POST", "/api/panes/p1/input", `{"text":5}`, 400},
		{"POST", "/api/panes/p1/input", `{"enter":"true"}`, 400},
		{"POST", "/api/panes/p1/input", `{"clear":null}`, 400},
		{"POST", "/api/panes/p1/input", `{`, 400},
		{"POST", "/api/panes/p1/input", `[]`, 400},
		{"POST", "/api/panes/p1/scroll", `{"direction":"left"}`, 400},
		{"POST", "/api/panes/p1/scroll", `{"direction":{}}`, 400},
		{"POST", "/api/panes/p1/rename", `{"name":"!!!"}`, 400},
		{"POST", "/api/agents", `{"profile":"bash"}`, 400},
		{"POST", "/api/agents", `{"profile":"claude","worktree":"x"}`, 400},
		{"POST", "/api/agents", `{"profile":"claude","name":5}`, 400},
		{"POST", "/api/agents/p1/send", `{"text":""}`, 400},
		{"GET", "/api/panes/%FF/read", "", 400},
		{"POST", "/api/orchestrators/nope/start", "", 404},
		{"GET", "/api/panes/p1/input", "", 404},
	} {
		if status, body, _ := b.do(t, c.method, c.path, b.token, []byte(c.body)); status != c.status {
			t.Errorf("%s %s %s: %d %s, want %d", c.method, c.path, c.body, status, body, c.status)
		}
	}
	if got := b.sent(n); len(got) != 0 {
		t.Errorf("herdr got %v", got)
	}
}

func TestBodyLimitIs64KB(t *testing.T) {
	b := startBridge(t, Config{}, nil, nil)
	n := len(b.fake.Requests())
	text := func(size int) []byte { return []byte(`{"text":"` + strings.Repeat("x", size-11) + `"}`) }
	if status, body, _ := b.do(t, "POST", "/api/panes/p1/input", b.token, text(64*1024+1)); status != 413 {
		t.Errorf("64 KB + 1: %d %s, want 413", status, body)
	}
	if got := b.sent(n); len(got) != 0 {
		t.Errorf("herdr got %v from a refused body", got)
	}
	if status, body, _ := b.do(t, "POST", "/api/panes/p1/input", b.token, text(64*1024)); status != 200 {
		t.Errorf("64 KB: %d %s, want 200", status, body)
	}
}

func TestStaticFiles(t *testing.T) {
	b := startBridge(t, Config{}, nil, nil)
	for _, c := range []struct {
		path        string
		status      int
		mime, cache string
	}{
		{"/", 200, "text/html; charset=utf-8", "no-cache"},
		{"/app.js", 200, "application/javascript; charset=utf-8", ""},
		{"/sw.js", 200, "application/javascript; charset=utf-8", "no-cache"},
		{"/style.css", 200, "text/css; charset=utf-8", ""},
		{"/icons/icon-192.png", 200, "image/png", ""},
		{"/notes.bin", 200, "application/octet-stream", ""},
		{"/assets/index-abcd1234.js", 200, "application/javascript; charset=utf-8", "public, max-age=31536000, immutable"},
		{"/icons", 404, "application/json", ""},
		{"/missing.js", 404, "application/json", ""},
	} {
		status, _, h := b.do(t, "GET", c.path, "", nil) // no token
		if status != c.status || h.Get("Content-Type") != c.mime || h.Get("Cache-Control") != c.cache {
			t.Errorf("%s: %d %q %q, want %d %q %q", c.path, status, h.Get("Content-Type"), h.Get("Cache-Control"), c.status, c.mime, c.cache)
		}
	}
	// a path as sent, not cleaned by a client
	for raw, want := range map[string]int{"/../secret": 403, "/icons/../../x": 403, "/%2e%2e/secret": 404} {
		rec := httptest.NewRecorder()
		b.srv.ServeHTTP(rec, httptest.NewRequest("GET", raw, nil))
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", raw, rec.Code, want)
		}
	}
}

func readMsg(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("reading a WS message: %v", err)
	}
	var m map[string]any
	json.Unmarshal(data, &m)
	return m
}

// readUntil reads WS messages until one of type typ arrives.
func readUntil(t *testing.T, c *websocket.Conn, typ string) map[string]any {
	t.Helper()
	for {
		if m := readMsg(t, c); m["type"] == typ {
			return m
		}
	}
}

func write(t *testing.T, c *websocket.Conn, msg string) {
	t.Helper()
	if err := c.Write(context.Background(), websocket.MessageText, []byte(msg)); err != nil {
		t.Fatal(err)
	}
}

func TestWSDeflatePingAndReadLimit(t *testing.T) {
	b := startBridge(t, Config{}, nil, nil)
	c, res, err := b.dial(t, &websocket.DialOptions{CompressionMode: websocket.CompressionContextTakeover})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if ext := res.Header.Get("Sec-WebSocket-Extensions"); !strings.Contains(ext, "permessage-deflate") {
		t.Errorf("deflate not negotiated: %q", ext)
	}
	if m := readMsg(t, c); m["type"] != "state" {
		t.Errorf("first message: %v, want the state", m["type"])
	}
	write(t, c, `{"type":"ping"}`)
	readUntil(t, c, "pong")
	write(t, c, strings.Repeat(" ", 64*1024+1))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
				t.Errorf("a message over 64 KB: %v, want close 1009", err)
			}
			return
		}
	}
}

func TestWSPaneWatch(t *testing.T) {
	b := startBridge(t, Config{}, func(m string, p json.RawMessage) (fakeherdr.Reply, bool) {
		if m == "pane.read" {
			if strings.Contains(string(p), `"gone"`) {
				return fakeherdr.Reply{Code: "not_found", Message: "no pane"}, true
			}
			return fakeherdr.Reply{Result: map[string]any{"read": map[string]any{"text": "screen"}}}, true
		}
		return fakeherdr.Reply{}, false
	}, nil)
	c, _, err := b.dial(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	write(t, c, `{"type":"watch_pane","paneId":"p1"}`)
	if m := readUntil(t, c, "pane_output"); m["paneId"] != "p1" || m["ansi"] != "screen" || m["appScroll"] != false {
		t.Errorf("pane_output: %v", m)
	}
	write(t, c, `{"type":"unwatch_pane"}`)
	time.Sleep(200 * time.Millisecond)
	reads := func() int { return len(slices.DeleteFunc(b.sent(0), func(m string) bool { return m != "pane.read" })) }
	before := reads()
	time.Sleep(2 * paneWatchInterval)
	if after := reads(); after != before {
		t.Errorf("pane.read went on after unwatch_pane: %d, then %d", before, after)
	}
	// a pane that fails to read and is gone from the state: told once, watch over
	write(t, c, `{"type":"watch_pane","paneId":"gone"}`)
	if m := readUntil(t, c, "pane_gone"); m["paneId"] != "gone" {
		t.Errorf("pane_gone: %v", m)
	}
}

// A pane scrolled up on the desktop (to read a long reply, say): herdr's visible read
// is that old viewport, not the prompt waiting at the bottom. Every screen read (REST,
// the press verify, the WS watch) takes the bottom viewport_rows rows instead, also
// when pane.get said unscrolled (the desktop may scroll between the two calls).
func TestScrolledPaneReadsTheBottomScreen(t *testing.T) {
	for _, offset := range []int{30, 0} {
		t.Run(strconv.Itoa(offset), func(t *testing.T) { testBottomScreen(t, offset) })
	}
}

func testBottomScreen(t *testing.T, offset int) {
	menu := " ☐ Pick\n\nWhich?\n\n❯ 1. apple\n  2. banana\n\nEnter to select · Esc to cancel"
	b := startBridge(t, Config{}, func(m string, p json.RawMessage) (fakeherdr.Reply, bool) {
		switch m {
		case "pane.get":
			return fakeherdr.Reply{Result: map[string]any{"pane": map[string]any{"pane_id": "p1", "agent": "claude",
				"scroll": map[string]any{"offset_from_bottom": offset, "max_offset_from_bottom": 69, "viewport_rows": 8}}}}, true
		case "pane.read":
			text := "| row 12 of a long table |" // the scrolled-up viewport
			if strings.Contains(string(p), `"source":"recent"`) && strings.Contains(string(p), `"lines":8`) && strings.Contains(string(p), `"format":"ansi"`) ||
				strings.Contains(string(p), `"source":"detection"`) {
				text = menu
			}
			return fakeherdr.Reply{Result: map[string]any{"read": map[string]any{"text": text}}}, true
		}
		return fakeherdr.Reply{}, false
	}, nil)
	if _, body, _ := b.do(t, "GET", "/api/panes/p1/read?source=visible&format=ansi", b.token, nil); !strings.Contains(body, "Which?") {
		t.Errorf("read: %s, want the bottom screen", body)
	}
	// text: herdr's detection, never a recent text read (which can capture history)
	if _, body, _ := b.do(t, "GET", "/api/panes/p1/read?source=visible", b.token, nil); !strings.Contains(body, "Which?") {
		t.Errorf("text read: %s, want the bottom screen", body)
	}
	press, _ := json.Marshal(map[string]any{"press": "1", "expect_prompt": promptIdentity(menu)})
	if status, body, _ := b.do(t, "POST", "/api/panes/p1/input", b.token, press); status != 200 {
		t.Errorf("press: %d %s, want the bottom screen's prompt verified", status, body)
	}
	c, _, err := b.dial(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	write(t, c, `{"type":"watch_pane","paneId":"p1"}`)
	if m := readUntil(t, c, "pane_output"); m["ansi"] != menu {
		t.Errorf("pane_output: %v, want the bottom screen", m["ansi"])
	}
}

// Without pane.get (the screen's size) the press can't read the live screen, and
// visible may be a stale viewport, so it refuses instead of verifying against that.
func TestPressRefusedWithoutScrollState(t *testing.T) {
	menu := " ☐ Pick\n\nWhich?\n\n❯ 1. apple\n  2. banana\n\nEnter to select · Esc to cancel"
	b := startBridge(t, Config{}, func(m string, p json.RawMessage) (fakeherdr.Reply, bool) {
		switch m {
		case "pane.get":
			return fakeherdr.Reply{Code: "internal", Message: "boom"}, true
		case "pane.read":
			return fakeherdr.Reply{Result: map[string]any{"read": map[string]any{"text": menu}}}, true
		}
		return fakeherdr.Reply{}, false
	}, nil)
	n := len(b.fake.Requests())
	press, _ := json.Marshal(map[string]any{"press": "1", "expect_prompt": promptIdentity(menu)})
	if status, _, _ := b.do(t, "POST", "/api/panes/p1/input", b.token, press); status == 200 {
		t.Error("press verified without the pane's scroll state")
	}
	if slices.Contains(b.sent(n), "pane.send_text") {
		t.Error("the digit went out")
	}
}

func TestWSTranscriptWatch(t *testing.T) {
	defer func(h string) { claudeHome = h }(claudeHome)
	claudeHome = t.TempDir()
	cwd := "/work/repo"
	dir := filepath.Join(claudeHome, ".claude", "projects", slugForCwd(cwd))
	os.MkdirAll(dir, 0o755)
	line := func(text string) string {
		return `{"type":"user","timestamp":"2026-11-24T00:00:00.000Z","message":{"role":"user","content":"` + text + `"}}` + "\n"
	}
	sessA, sessB := "aaaa-1", "bbbb-2"
	os.WriteFile(filepath.Join(dir, sessA+".jsonl"), []byte(line("one")), 0o644)
	os.WriteFile(filepath.Join(dir, sessB+".jsonl"), []byte(line("fresh")), 0o644)
	var mu sync.Mutex
	session := sessA
	b := startBridge(t, Config{}, func(m string, _ json.RawMessage) (fakeherdr.Reply, bool) {
		if m != "pane.get" {
			return fakeherdr.Reply{}, false
		}
		mu.Lock()
		defer mu.Unlock()
		pane := map[string]any{"pane_id": "p1", "agent": "claude", "cwd": cwd}
		if session != "" {
			pane["agent_session"] = map[string]any{"source": "herdr:claude", "value": session}
		}
		return fakeherdr.Reply{Result: map[string]any{"pane": pane}}, true
	}, func(s *server) { s.transcriptResolve = 1500 * time.Millisecond })
	c, _, err := b.dial(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		c.CloseNow()
		waitUntil(t, 5*time.Second, "the WS client is gone", func() bool {
			b.srv.bmu.Lock()
			defer b.srv.bmu.Unlock()
			return len(b.srv.clients) == 0
		})
		time.Sleep(transcriptWatchInterval) // a poll in flight finishes before claudeHome is restored
	}()
	texts := func(m map[string]any) (out []string) {
		items, _ := m["items"].([]any)
		for _, it := range items {
			out = append(out, it.(map[string]any)["text"].(string))
		}
		return out
	}
	write(t, c, `{"type":"watch_transcript","paneId":"p1"}`)
	if m := readUntil(t, c, "transcript_items"); m["reset"] != true || m["sessionId"] != sessA || !slices.Equal(texts(m), []string{"one"}) {
		t.Errorf("first: %v", m)
	}
	f, _ := os.OpenFile(filepath.Join(dir, sessA+".jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(line("two"))
	f.Close()
	if m := readUntil(t, c, "transcript_items"); m["reset"] != false || !slices.Equal(texts(m), []string{"two"}) {
		t.Errorf("appended: %v", m)
	}
	mu.Lock()
	session = sessB // /clear: a new session file
	mu.Unlock()
	if m := readUntil(t, c, "transcript_items"); m["reset"] != true || m["sessionId"] != sessB || !slices.Equal(texts(m), []string{"fresh"}) {
		t.Errorf("after a session switch: %v", m)
	}
	mu.Lock()
	session = ""
	mu.Unlock()
	if m := readUntil(t, c, "transcript_items"); m["available"] != false || m["reset"] != true {
		t.Errorf("no session: %v", m)
	}
}

// A client that stops reading is dropped once its queue is full; the others keep
// getting every message.
func TestAStuckWSClientIsDroppedAndOthersAreNot(t *testing.T) {
	b := startBridge(t, Config{}, nil, nil)
	newClient := func() *wsClient {
		ctx, cancel := context.WithCancel(context.Background())
		return &wsClient{srv: b.srv, ctx: ctx, cancel: cancel, queue: make(chan []byte, wsSendQueue)}
	}
	stuck, live := newClient(), newClient()
	b.srv.bmu.Lock()
	b.srv.clients[stuck], b.srv.clients[live] = struct{}{}, struct{}{}
	b.srv.bmu.Unlock()
	st := b.srv.client.State()
	got := 0
	for i := 0; i < wsSendQueue+10; i++ {
		b.srv.broadcastAgentStatus(StatusChange{PaneID: "p1", From: "idle", To: "working"}, st)
		// live reads everything queued so far (a state push may have come in too)
		for drained := false; !drained; {
			select {
			case <-live.queue:
				got++
			default:
				drained = true
			}
		}
	}
	if stuck.ctx.Err() == nil {
		t.Error("the stuck client is still connected")
	}
	if live.ctx.Err() != nil || got < wsSendQueue+10 {
		t.Errorf("the reading client: cancelled %v, got %d of %d", live.ctx.Err(), got, wsSendQueue+10)
	}
}

// Broadcasts racing each other (an event push, the minute timer, an account answer)
// still leave the newest state as the last one sent.
func TestConcurrentBroadcastsEndWithTheLatestState(t *testing.T) {
	b := startBridge(t, Config{}, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := &wsClient{srv: b.srv, ctx: ctx, cancel: cancel, queue: make(chan []byte, 1000)}
	b.srv.bmu.Lock()
	b.srv.clients[c] = struct{}{}
	b.srv.bmu.Unlock()
	base := b.srv.client.State()
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Go(func() {
			label := strings.Repeat("x", i+1)
			n := *base
			n.Workspaces = []*WorkspaceNode{{WorkspaceID: "w1", Label: label, Tabs: []*TabNode{}}}
			b.srv.client.published.Store(&n)
			b.srv.broadcastState()
		})
	}
	wg.Wait()
	var last []byte
	for len(c.queue) > 0 {
		last = <-c.queue
	}
	want, _ := marshalRaw(WsStateMessage{Type: "state", State: b.srv.clientState(b.srv.client.State())})
	if !bytes.Equal(last, want) {
		t.Errorf("the last state sent isn't the latest:\n%s\nwant\n%s", last, want)
	}
}

// An agent whose Claude account can't be told is left as it is: nothing opened or closed.
func TestClearRefusesAnAgentOfUnknownAccount(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("accounts are read from /proc")
	}
	b := startBridge(t, Config{}, func(m string, _ json.RawMessage) (fakeherdr.Reply, bool) {
		switch m {
		case "agent.get":
			return fakeherdr.Reply{Result: map[string]any{"agent": map[string]any{"pane_id": "p1", "agent": "claude", "cwd": "/tmp"}}}, true
		case "pane.process_info": // the shell itself in the foreground: no agent process to read
			return fakeherdr.Reply{Result: map[string]any{"process_info": map[string]any{"shell_pid": 7, "foreground_process_group_id": 7}}}, true
		}
		return fakeherdr.Reply{}, false
	}, nil)
	n := len(b.fake.Requests())
	status, body, _ := b.do(t, "POST", "/api/agents/p1/clear", b.token, nil)
	if status != 409 || !strings.Contains(body, `"account_unknown"`) {
		t.Errorf("clear: %d %s, want 409 account_unknown", status, body)
	}
	if got := b.sent(n); !slices.Equal(got, []string{"agent.get"}) {
		t.Errorf("herdr got %v, want only the agent.get", got)
	}
}

// The program an agent runs comes from its named launch profile only, never from
// the request.
func TestStartAgentRunsOnlyTheProfilesProgram(t *testing.T) {
	var mu sync.Mutex
	var started map[string]any
	b := startBridge(t, Config{LaunchProfiles: map[string]LaunchProfile{"claude": {Argv: []string{"claude", "--flag"}, Label: "C"}}},
		func(m string, p json.RawMessage) (fakeherdr.Reply, bool) {
			switch m {
			case "tab.create":
				return fakeherdr.Reply{Result: map[string]any{"root_pane": map[string]any{"pane_id": "p10"}}}, true
			case "agent.start":
				mu.Lock()
				json.Unmarshal(p, &started)
				mu.Unlock()
				return fakeherdr.Reply{Result: map[string]any{"agent": map[string]any{"pane_id": "p10", "agent": "claude"}}}, true
			}
			return fakeherdr.Reply{}, false
		}, nil)
	status, body, _ := b.do(t, "POST", "/api/agents", b.token,
		[]byte(`{"profile":"claude","argv":["sh"],"command":"rm -rf /","args":["x"],"kind":"sh","cwd":"/tmp"}`))
	if status != 200 {
		t.Fatalf("start: %d %s", status, body)
	}
	mu.Lock()
	defer mu.Unlock()
	if started["kind"] != "claude" || !slices.Equal(toStrings(started["args"]), []string{"--flag"}) {
		t.Errorf("agent.start got %v", started)
	}
	if p, _ := b.srv.profiles.Get("p10"); p != "claude" {
		t.Errorf("the pane's profile wasn't recorded: %q", p)
	}
}

func toStrings(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// The New agent picker preselects the first profile, so /api/profiles must keep the
// TS's localeCompare order. The want order is Node's (en-US) for these names.
func TestProfilesSortLikeLocaleCompare(t *testing.T) {
	want := []string{"a b", "a_b", "a-b", "ab", "aB", "Ab", "AB", "ab-", "Ab-", "b10", "B2", "claude", "Claude",
		"claude_fast", "claude-yolo", "codex", "opencode", "x.y", "z10", "z9", "Zoo"}
	got := slices.Clone(want)
	for i := range got { // a fixed shuffle
		j := (i*7 + 3) % len(got)
		got[i], got[j] = got[j], got[i]
	}
	slices.SortFunc(got, func(a, b string) int {
		if localeLess(a, b) {
			return -1
		}
		if localeLess(b, a) {
			return 1
		}
		return 0
	})
	if !slices.Equal(got, want) {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

// A stopped orchestrator's Home lists the agents of the account it would run under: once
// that account is found (in the background), its agents are a list, never null.
func TestStoppedOrchestratorAgents(t *testing.T) {
	dir := t.TempDir()
	b := startBridge(t, Config{Orchestrators: []OrchestratorDef{{Name: "o", Dir: dir, Env: map[string]string{"CLAUDE_CONFIG_DIR": dir}}}}, nil, nil)
	waitUntil(t, 5*time.Second, "the stopped orchestrator's agents are known", func() bool {
		v := b.srv.clientState(b.srv.client.State()).Orchestrators[0]
		return v.PaneID == nil && v.Agents != nil
	})
}

// A lookup that couldn't read the account keeps the one read before; a read one replaces it.
func TestWithExpected(t *testing.T) {
	cur := withExpected(nil, 2, 1, "/work/projects", true)
	checkEq(t, jsonOf(t, cur), `["","/work/projects"]`)
	cur = withExpected(&cur, 2, 1, "/default/projects", false) // direnv failed: kept
	checkEq(t, jsonOf(t, cur), `["","/work/projects"]`)
	cur = withExpected(&cur, 2, 0, "/default/projects", false) // unknown before: the default stands in
	checkEq(t, jsonOf(t, cur), `["/default/projects","/work/projects"]`)
	prev := cur
	cur = withExpected(&prev, 2, 1, "/other/projects", true) // read: replaced, in a fresh copy
	checkEq(t, jsonOf(t, cur), `["/default/projects","/other/projects"]`)
	checkEq(t, prev[1], "/work/projects")
}
