package bridge

// The bridge's HTTP server, a port of server/http.ts: the REST routes under /api,
// /healthz and the web UI's static files. The /ws push channel is in ws.go.
//
// Concurrency: handlers run on their own goroutines. What they share is either
// read-only (the config), atomic (the herdr client's published State) or locked
// (the pane profile store, the account cache, the WS client set).

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	bodyLimit = 64 * 1024
	// Node's requestTimeout: the whole request must arrive within 5 minutes
	requestTimeout5m = 5 * time.Minute
	// how often the agents' accounts are looked at again even when nothing changes
	accountRefreshInterval = 60 * time.Second
	// Ctrl+U (0x15) kills to the start of the current composer line; repeating it
	// walks up and wipes a multi-line draft. Sent before a composed message so it
	// submits on its own instead of being concatenated with text the user had already
	// typed straight into the pane (which yoicks can't see). 30 covers any realistic
	// draft; it's a no-op once the composer is empty.
	composerClearKills = 30
)

var composerClearSeq = strings.Repeat("\u0015", composerClearKills)

// An explicit table (not mime.TypeByExtension, which reads the host's
// /etc/mime.types): the same answer on every host, the same as http.ts.
var mimeTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "application/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".png":         "image/png",
	".svg":         "image/svg+xml",
	".ico":         "image/x-icon",
}

// The encodings a web file can have a copy in, next to it under the suffix (the build writes
// them: vite.config.ts's precompress), best first.
var encodings = []struct{ coding, suffix string }{{"br", ".br"}, {"gzip", ".gz"}}

// pane routes: the id segment is any non-slash text (pane ids contain ':')
var (
	paneRoute   = regexp.MustCompile(`^/api/panes/([^/]+)/(\w+)$`)
	paneIDRoute = regexp.MustCompile(`^/api/panes/([^/]+)$`) // DELETE = stop the agent
	agentRoute  = regexp.MustCompile(`^/api/agents/([^/]+)/(\w+)$`)
	orchRoute   = regexp.MustCompile(`^/api/orchestrators/([^/]+)/(start|send|answer|interrupt|clear|stop|model|compact)$`)
	todoRoute   = regexp.MustCompile(`^/api/orchestrators/([^/]+)/todos/([^/]+)$`) // DELETE = the user did it (?dismiss=1: dropped it)
)

// server is the HTTP + WS server over one herdr client.
type server struct {
	cfg      Config
	client   *HerdrClient
	rpc      Rpc
	web      fs.FS
	rules    string // the bundled orchestrator/rules.md
	profiles *PaneProfileStore
	accounts *PaneAccountCache
	// each configured orchestrator's expectedAccount ("": not found yet), found in the
	// background (direnv can take seconds); nil until the first is found
	expected atomic.Pointer[[]string]
	// the headless orchestrators' runners, by name (none without a headless entry)
	headless map[string]*headlessRunner
	mcp      *mcpHost // their MCP listener (nil: none)
	// every Home's to-do list for the user (todo.go)
	todos *todoStore
	// what each worker is for, as its orchestrator said (purpose.go)
	purposes *purposeStore
	// the last claude check (<state>/canary.json; nil: none), read at the start and each minute
	claudeCheck atomic.Pointer[ClaudeCheck]
	// the PR watch (pr_watch, prwatch.go): gh's lookup (tests: a stand-in), the look in progress,
	// and (touched only by that look) the last error alerted to each Home and the PRs told unreadable
	prStates func(ctx context.Context, urls []string) (map[string]string, error)
	prBusy   atomic.Bool
	prErr    map[string]string // by Home
	prUnread map[string]bool
	stop     chan struct{}
	stopOnce sync.Once
	bg       sync.WaitGroup // the PC notifications (notification.show) in flight; tests wait for them
	// the time a WS client's pane and transcript watches poll on (tests: a fakeherdr.FakeClock)
	clock clock

	// broadcast lock: the WS client set and the last state message sent (ws.go)
	bmu       sync.Mutex
	clients   map[*wsClient]struct{}
	lastState []byte
	// the panes with an agent at the last push (agentsGone)
	agentPanes map[string]bool
	closeMu    sync.Mutex // closing finished workers' panes
}

func newServer(cfg Config, client *HerdrClient, web fs.FS, rules string) *server {
	s := &server{
		cfg: cfg, client: client, rpc: client.RPC, web: web, rules: rules,
		// Remember which launch profile started each pane so `clear` can relaunch the
		// exact variant: herdr's detected agent type can't tell "claude" from a custom
		// "claude-yolo". Durable (herdr keeps the panes across a bridge restart);
		// entries are dropped on stop/clear.
		profiles: createPaneProfileStore(path.Join(cfg.StateDir, "pane-profiles.json")),
		stop:     make(chan struct{}),
		clock:    realClock{},
		clients:  map[*wsClient]struct{}{},
		headless: map[string]*headlessRunner{},
		prStates: ghPRStates,
		prUnread: map[string]bool{},
		prErr:    map[string]string{},
	}
	var names []string
	for _, d := range cfg.Orchestrators {
		names = append(names, d.Name)
	}
	s.todos = newTodoStore(cfg.StateDir, names)
	s.todos.onChange = s.broadcastState
	s.purposes = newPurposeStore(path.Join(cfg.StateDir, "agent-purposes.json"))
	s.purposes.onChange = s.broadcastState
	for _, d := range cfg.Orchestrators {
		if d.Mode != "headless" {
			continue
		}
		h := newHeadlessRunner(d, cfg.StateDir, rules)
		h.rpc, h.waitRPC, h.profiles, h.todos, h.purposes = s.rpc, client.Wait, cfg.LaunchProfiles, s.todos, s.purposes
		h.slowRPC = func(method string, params map[string]any) (json.RawMessage, error) {
			return herdrCall(context.Background(), cfg.SocketPath, method, params, 60*time.Second)
		}
		h.onChange = s.broadcastState
		h.onAlert = func(kind, message string) { s.broadcastAlert(d, kind, message) }
		h.onStatus = func(from, to string) { s.headlessStatus(d, from, to) }
		s.headless[d.Name] = h
	}
	if len(s.headless) > 0 { // its MCP listener, only with a headless entry
		if m, err := startMCPHost(s.headless); err != nil {
			logf("[headless] could not open the MCP listener: %s", err)
		} else {
			s.mcp = m
		}
	}
	// Each agent pane's Claude account, so an orchestrator's agents list shows just
	// its own account's agents; looked at on each push and each minute even when
	// nothing changes (an unchanged push is deduped), and a changed answer re-pushes.
	s.accounts = newPaneAccountCache(func(id string) (string, error) { return paneAccount(s.rpc, id) },
		s.broadcastState, accountRefreshInterval, time.Now)
	// Each orchestrator's expectedAccount, found on its own (an env-set one is instant, a direnv
	// one can take seconds), published as found, and found again each refresh interval so an
	// edited .envrc catches up. A direnv that can't tell keeps the account read before (else the
	// default stands in).
	var emu sync.Mutex
	for i, d := range cfg.Orchestrators {
		go func() {
			for {
				a, read := expectedAccountRead(d)
				emu.Lock()
				next := withExpected(s.expected.Load(), len(cfg.Orchestrators), i, a, read)
				s.expected.Store(&next)
				emu.Unlock()
				s.broadcastState() // deduped when nothing changed
				select {
				case <-time.After(accountRefreshInterval):
				case <-s.stop:
					return
				}
			}
		}()
	}
	s.checkClaude()
	go func() {
		t := time.NewTicker(accountRefreshInterval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				s.checkClaude()
				s.remindTodos(nowMs())
				if s.prBusy.CompareAndSwap(false, true) {
					go func() { defer s.prBusy.Store(false); s.watchPRs() }()
				}
				s.broadcastState()
			case <-s.stop:
				return
			}
		}
	}()
	return s
}

// withExpected is cur (nil: none yet) with orchestrator i's account a: a fresh copy, so a
// published slice never changes. An account not read (direnv couldn't tell) replaces only
// an unknown one, so a refresh that fails keeps the account read before.
func withExpected(cur *[]string, n, i int, a string, read bool) []string {
	next := make([]string, n)
	if cur != nil {
		copy(next, *cur)
	}
	if read || next[i] == "" {
		next[i] = a
	}
	return next
}

func (s *server) close() {
	s.stopOnce.Do(func() {
		close(s.stop)
		if s.mcp != nil {
			s.mcp.Close()
		}
	})
}

// clientState is the JSON state sent to clients (REST + WS): the normalized tree plus
// which pane runs each orchestrator (the phone opens on their chats).
// orchestratorPaneId (the first running one) stays for clients of the
// single-orchestrator contract.
func (s *server) clientState(st *State) ClientState {
	accounts := s.accounts.Accounts()
	views := findOrchestrators(st, s.cfg.Orchestrators, accounts)
	for i := range views {
		views[i].Todos = s.todos.Items(views[i].Name)
		if r := s.headless[views[i].Name]; r != nil {
			v, running := r.view()
			views[i].Headless = &v
			if running {
				views[i].PaneID = new("hl:" + views[i].Name)
			}
		}
	}
	// a stopped orchestrator's Home lists the agents of the account it would run under, a
	// headless one's those of the account it runs under
	if expected := s.expected.Load(); expected != nil {
		for i := range views {
			if (views[i].PaneID == nil || views[i].Headless != nil) && (*expected)[i] != "" {
				views[i].Agents = agentsOfAccount(st, accounts, (*expected)[i])
			}
		}
	}
	var first *string // a pane, for clients that only know panes
	for _, v := range views {
		if v.PaneID != nil && v.Headless == nil {
			first = v.PaneID
			break
		}
	}
	return ClientState{State: st, Orchestrators: views, OrchestratorPaneID: first, ClaudeCheck: s.claudeCheck.Load(), Purposes: s.purposes.Purposes(), Version: Version}
}

func (s *server) workspaces() []*WorkspaceNode {
	if st := s.client.State(); st != nil {
		return st.Workspaces
	}
	return nil
}

// ── responses ────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, body any) {
	b, err := marshalRaw(body)
	if err != nil {
		status, b = http.StatusInternalServerError, []byte(`{"error":{"code":"error","message":"encoding failed"}}`)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b)
}

func jsonOK(w http.ResponseWriter, body any) { writeJSON(w, http.StatusOK, body) }

type errorBody struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func jsonError(w http.ResponseWriter, status int, code, message string) {
	var b errorBody
	b.Error.Code, b.Error.Message = code, message
	writeJSON(w, status, b)
}

// mapHerdrError is the HTTP status for a herdr RPC error. herdr answers an unsupported
// key name in pane.send_input with a clean error (not a dropped connection): a client
// error, not a 502.
func mapHerdrError(err error) int {
	switch herdrCode(err) {
	case "not_found":
		return http.StatusNotFound
	case "invalid_params", "invalid_request", "invalid_key":
		return http.StatusBadRequest
	}
	return http.StatusBadGateway
}

// herdrFailure answers a herdr RPC error (or a transport one) as http.ts does.
func herdrFailure(w http.ResponseWriter, err error) {
	jsonError(w, mapHerdrError(err), firstNonEmpty(herdrCode(err), "error"), err.Error())
}

// sendError answers a caught error: a LifecycleError carries its own status and code
// (validation, no profile); anything else is a herdr RPC error.
func sendError(w http.ResponseWriter, err error) {
	var le *LifecycleError
	if errors.As(err, &le) {
		jsonError(w, le.Status, le.Code, le.Message)
		return
	}
	herdrFailure(w, err)
}

// okWith is {ok: true, ...out}, out being a struct.
func okWith(out any) json.Marshaler { return okResponse{out} }

type okResponse struct{ out any }

func (o okResponse) MarshalJSON() ([]byte, error) {
	b, err := marshalRaw(o.out)
	if err != nil {
		return nil, err
	}
	if string(b) == "{}" {
		return []byte(`{"ok":true}`), nil
	}
	return append([]byte(`{"ok":true,`), b[1:]...), nil
}

// decodePathSegment is decodeURIComponent: false on a malformed escape or one that
// isn't UTF-8 (a URIError in JavaScript), so the route answers a clean 400.
func decodePathSegment(seg string) (string, bool) {
	s, err := url.PathUnescape(seg)
	if err != nil || !utf8.ValidString(s) {
		return "", false
	}
	return s, true
}

// readBody reads a JSON object body of at most 64 KB. On failure it has answered
// (413 too large, else 400) and returns nil.
func readBody(w http.ResponseWriter, r *http.Request) map[string]any {
	return readBodyMax(w, r, bodyLimit)
}

// readBodyMax is readBody with its own size limit.
func readBodyMax(w http.ResponseWriter, r *http.Request, limit int64) map[string]any {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			jsonError(w, http.StatusRequestEntityTooLarge, "bad_request", "request body too large")
		} else {
			jsonError(w, http.StatusBadRequest, "bad_request", err.Error())
		}
		return nil
	}
	if len(data) == 0 {
		return map[string]any{}
	}
	// a non-object (null, an array, a primitive) is refused too, so handlers can read
	// fields without checking
	var body map[string]any
	if json.Unmarshal(data, &body) != nil || body == nil {
		jsonError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return nil
	}
	return body
}

// ── routing ──────────────────────────────────────────────────────────────────

// isUpgrade is whether Node would hand the request to the server's 'upgrade'
// handler: an Upgrade header with a Connection header that lists it.
func isUpgrade(r *http.Request) bool {
	if r.Header.Get("Upgrade") == "" {
		return false
	}
	for _, v := range r.Header.Values("Connection") {
		for _, tok := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(tok), "upgrade") {
				return true
			}
		}
	}
	return false
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// the path as sent, still percent-encoded (WHATWG URL's pathname): pane ids are
	// matched as one segment, then decoded
	pathname := r.URL.EscapedPath()
	if isUpgrade(r) {
		s.serveUpgrade(w, r, pathname)
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(requestTimeout5m))

	if pathname == "/healthz" { // no auth
		jsonOK(w, struct {
			OK             bool `json:"ok"`
			HerdrConnected bool `json:"herdrConnected"`
		}{true, s.client.IsConnected()})
		return
	}
	if !strings.HasPrefix(pathname, "/api") && !strings.HasPrefix(pathname, "/ws") { // no auth
		s.serveStatic(w, r, pathname)
		return
	}
	if strings.HasPrefix(pathname, "/api") && !verifyToken(extractToken(r)) {
		jsonError(w, http.StatusUnauthorized, "unauthorized", "missing or invalid token")
		return
	}
	s.route(w, r, pathname)
}

func (s *server) route(w http.ResponseWriter, r *http.Request, pathname string) {
	method := r.Method

	if pathname == "/api/state" && method == "GET" {
		st := s.client.State()
		if st == nil {
			jsonError(w, http.StatusBadGateway, "unavailable", "herdr not connected")
			return
		}
		jsonOK(w, s.clientState(st))
		return
	}

	// The user ticked an item of a Home's to-do list off, or dismissed it (?dismiss=1): removed
	// without being done, so its orchestrator takes no step from it.
	if m := todoRoute.FindStringSubmatch(pathname); m != nil && method == "DELETE" {
		name, ok := decodePathSegment(m[1])
		id, idOK := decodePathSegment(m[2])
		if !ok || !idOK || !slices.ContainsFunc(s.cfg.Orchestrators, func(d OrchestratorDef) bool { return d.Name == name }) {
			jsonError(w, http.StatusNotFound, "not_found", "no such orchestrator")
			return
		}
		dismiss := r.URL.Query().Get("dismiss")
		if dismiss != "" && dismiss != "1" { // never read as done: that wakes its next step
			jsonError(w, http.StatusBadRequest, "bad_request", "dismiss: 1 or absent")
			return
		}
		item, err := s.todos.Done(name, id)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "error", err.Error())
			return
		}
		if item == nil {
			jsonError(w, http.StatusNotFound, "not_found", "no item "+id+" on "+name+"'s list")
			return
		}
		if h := s.headless[name]; h != nil {
			h.tickedOff(*item, dismiss == "1")
		}
		jsonOK(w, okWith(struct{}{}))
		return
	}

	// Start a configured orchestrator by name (its dir and env come from config, never
	// from the request), in a new workspace; the client follows it via state. A headless
	// one is the bridge's child instead, which also takes send, interrupt, clear and stop.
	if m := orchRoute.FindStringSubmatch(pathname); m != nil && method == "POST" {
		name, ok := decodePathSegment(m[1])
		i := -1
		if ok {
			i = slices.IndexFunc(s.cfg.Orchestrators, func(d OrchestratorDef) bool { return d.Name == name })
		} else {
			name = "null"
		}
		if i == -1 {
			jsonError(w, http.StatusNotFound, "not_found", "no orchestrator named "+name)
			return
		}
		if h := s.headless[name]; h != nil {
			s.headlessRoute(w, r, h, m[2])
			return
		}
		if m[2] != "start" {
			jsonError(w, http.StatusNotFound, "not_found", "orchestrator "+name+" isn't headless")
			return
		}
		if pid := markedHeadlessChild(s.cfg.StateDir, name); pid != 0 {
			jsonError(w, http.StatusConflict, "already_running", fmt.Sprintf("orchestrator %s runs headless (pid %d): stop it first", name, pid))
			return
		}
		paneID, agent, err := startOrchestrator(s.rpc, s.cfg.Orchestrators[i], s.rules)
		if err != nil {
			sendError(w, err)
			return
		}
		jsonOK(w, struct {
			OK     bool   `json:"ok"`
			PaneID string `json:"paneId"`
			Name   string `json:"name"`
		}{true, paneID, agent})
		return
	}

	// Start a new agent from a named launch profile (fixed argv allowlist: a caller
	// never supplies a raw command). Optional cwd/name/workspace/task.
	if pathname == "/api/agents" && method == "POST" {
		s.startAgentRoute(w, r)
		return
	}

	// Stop an agent by closing its pane.
	if m := paneIDRoute.FindStringSubmatch(pathname); m != nil && method == "DELETE" {
		paneID, ok := decodePathSegment(m[1])
		if !ok {
			jsonError(w, http.StatusBadRequest, "invalid_params", "malformed pane id")
			return
		}
		if noHeadlessPane(w, paneID) {
			return
		}
		out, err := stopAgent(s.rpc, paneID)
		if err != nil {
			sendError(w, err)
			return
		}
		s.profiles.Delete(paneID)
		jsonOK(w, okWith(out))
		return
	}

	if m := paneRoute.FindStringSubmatch(pathname); m != nil {
		paneID, ok := decodePathSegment(m[1])
		if !ok {
			jsonError(w, http.StatusBadRequest, "invalid_params", "malformed pane id")
			return
		}
		if m[2] != "transcript" && noHeadlessPane(w, paneID) {
			return
		}
		s.paneRoute(w, r, paneID, m[2])
		return
	}

	if m := agentRoute.FindStringSubmatch(pathname); m != nil {
		target, ok := decodePathSegment(m[1])
		if !ok {
			jsonError(w, http.StatusBadRequest, "invalid_params", "malformed agent id")
			return
		}
		if noHeadlessPane(w, target) {
			return
		}
		s.agentRoute(w, r, target, m[2])
		return
	}

	jsonError(w, http.StatusNotFound, "not_found", "not found")
}

// noHeadlessPane answers 404 for a headless orchestrator's id (hl:<name>): it has no herdr
// pane, only a transcript; true when it answered.
func noHeadlessPane(w http.ResponseWriter, id string) bool {
	if !strings.HasPrefix(id, "hl:") {
		return false
	}
	jsonError(w, http.StatusNotFound, "not_found", id+" is a headless orchestrator: use /api/orchestrators/<name>/…")
	return true
}

// stringMap is a body's answers: an object of strings, or nil when absent; false for anything else.
func stringMap(v any) (map[string]any, bool) {
	if v == nil {
		return nil, true
	}
	m, ok := v.(map[string]any)
	for _, s := range m {
		if _, isText := s.(string); !isText {
			return nil, false
		}
	}
	return m, ok
}

// headlessRoute is POST /api/orchestrators/:name/<action> for a headless orchestrator.
func (s *server) headlessRoute(w http.ResponseWriter, r *http.Request, h *headlessRunner, action string) {
	var err error
	switch action {
	case "start":
		err = h.Start()
	case "clear":
		err = h.Clear()
	case "send":
		body := readBodyMax(w, r, bodyLimit+2*maxImageBytes) // base64 is 4/3 of the images
		if body == nil {
			return
		}
		text, _ := body["text"].(string)
		if len(text) > bodyLimit { // text keeps its own limit: the line must fit a chat read
			jsonError(w, http.StatusRequestEntityTooLarge, "bad_request", "text too large")
			return
		}
		images, ierr := imageBlocks(body["images"])
		if ierr != nil {
			sendError(w, ierr)
			return
		}
		// with question (the one open: its Chat about this), with answers (its panel's so far); without, 409 while one is open
		question, isText := body["question"].(string)
		answers, ok := stringMap(body["answers"])
		if jsTrim(text) == "" && len(images) == 0 || !ok || body["question"] != nil && !isText {
			jsonError(w, http.StatusBadRequest, "invalid_params", "text must be a non-empty string, or images given; question, if any, an id; answers, if any, question → label")
			return
		}
		err = h.Send(text, images, answers, question)
	case "answer":
		// {id, answers: {question: label(s)}} answers the pending question; {id, deny: message} refuses
		// it; {id, chat: true, answers?: those given so far} is Claude Code's "Chat about this"
		body := readBody(w, r)
		if body == nil {
			return
		}
		id, _ := body["id"].(string)
		answers, ok := stringMap(body["answers"])
		deny, isText := body["deny"].(string)
		chat := body["chat"] == true
		switch {
		case id == "" || !ok || chat && isText || !chat && (answers != nil) == isText:
			jsonError(w, http.StatusBadRequest, "invalid_params", "an id, and answers (question → label), deny (a message) or chat: true")
			return
		case chat:
			err = h.Chat(id, answers)
		default:
			err = h.Answer(id, answers, deny)
		}
	case "interrupt":
		err = h.Interrupt()
	case "model": // {model: one of headless.models' values}
		body := readBody(w, r)
		if body == nil {
			return
		}
		model, _ := body["model"].(string)
		err = h.SetModel(model)
	case "compact": // {focus?: its instructions}
		body := readBody(w, r)
		if body == nil {
			return
		}
		focus, ok := body["focus"].(string)
		if !ok && body["focus"] != nil {
			jsonError(w, http.StatusBadRequest, "invalid_params", "focus, if any, must be a string")
			return
		}
		err = h.Compact(focus)
	case "stop":
		err = h.Stop()
	}
	if err != nil {
		sendError(w, err)
		return
	}
	if action == "start" || action == "clear" { // like a TUI start: the pane to follow
		jsonOK(w, struct {
			OK     bool   `json:"ok"`
			PaneID string `json:"paneId"`
			Name   string `json:"name"`
		}{true, "hl:" + h.def.Name, h.def.Name})
		return
	}
	jsonOK(w, okWith(struct{}{}))
}

// broadcastAlert sends a headless orchestrator's new warning to every client, to ntfy and to
// the PC.
func (s *server) broadcastAlert(def OrchestratorDef, kind, message string) {
	if msg, err := marshalRaw(WsOrchestratorAlertMessage{Type: "orchestrator_alert", Name: def.Name, Kind: kind, Message: message}); err == nil {
		s.bmu.Lock()
		for c := range s.clients {
			c.queueMsg(msg)
		}
		s.bmu.Unlock()
	}
	if s.cfg.NotifyURL != nil && *s.cfg.NotifyURL != "" {
		go postNtfy(*s.cfg.NotifyURL, "yoicks "+def.Name+": "+kind, message)
	}
	s.showOnPC(def, firstNonEmpty(def.Label, def.Name)+": "+kind, message, "request")
}

// remindTodos reminds the user once of each to-do item that has come due (checked each minute): to
// every client (orchestrator_alert, kind todo), ntfy and the PC. One alert per Home, naming every
// item come due: a phone's notifications are tagged by Home, so a second would replace the first.
func (s *server) remindTodos(now int64) {
	for name, items := range s.todos.TakeDue(now) {
		i := slices.IndexFunc(s.cfg.Orchestrators, func(d OrchestratorDef) bool { return d.Name == name })
		message := items[0].Text
		if len(items) > 1 {
			var texts []string
			for _, it := range items {
				texts = append(texts, it.Text)
			}
			message = fmt.Sprintf("%d items: %s", len(items), strings.Join(texts, " · "))
		}
		s.broadcastAlert(s.cfg.Orchestrators[i], "todo", message)
	}
}

// checkClaude reads the last claude check (scripts/claude-canary.sh's <state>/canary.json):
// it goes into the state and to the headless orchestrators, and a failed one not seen before
// alerts once, to every client (orchestrator_alert, no name), ntfy and the PC. Only with a
// headless entry: without one the check concerns nothing here.
func (s *server) checkClaude() {
	if len(s.headless) == 0 {
		return
	}
	var c *ClaudeCheck
	if b, err := os.ReadFile(filepath.Join(s.cfg.StateDir, "canary.json")); err == nil && json.Unmarshal(b, &c) != nil {
		c = nil // not a whole check
	}
	if c != nil && c.Failed == nil {
		c.Failed = []string{}
	}
	old := s.claudeCheck.Swap(c)
	for _, h := range s.headless {
		h.setClaudeCheck(c)
	}
	if c == nil || c.OK || old != nil && old.At == c.At {
		return
	}
	message := "the Claude Code check " + c.describe() + ": a headless orchestrator may not work"
	if msg, err := marshalRaw(WsOrchestratorAlertMessage{Type: "orchestrator_alert", Kind: "canary", Message: message}); err == nil {
		s.bmu.Lock()
		for cl := range s.clients {
			cl.queueMsg(msg)
		}
		s.bmu.Unlock()
	}
	if s.cfg.NotifyURL != nil && *s.cfg.NotifyURL != "" {
		go postNtfy(*s.cfg.NotifyURL, "yoicks: claude check failed", message)
	}
	s.bg.Go(func() {
		s.rpc("notification.show", map[string]any{"title": "yoicks: claude check failed", "body": message, "sound": "request"})
	})
}

// headlessStatus tells a headless orchestrator's change to done or blocked like an agent's
// (WS agent_status, ntfy), and on the PC.
func (s *server) headlessStatus(def OrchestratorDef, from, to string) {
	label := firstNonEmpty(def.Label, def.Name)
	change := StatusChange{PaneID: "hl:" + def.Name, From: from, To: to, Agent: &AgentInfo{Name: &def.Name, DisplayName: &label, Status: to}}
	if st := s.client.State(); st != nil {
		s.broadcastAgentStatus(change, st)
		go sendNtfyNotification(change, st, s.cfg.NotifyURL)
	}
	sound := map[string]string{"done": "done", "blocked": "request"}[to]
	s.showOnPC(def, label+" → "+to, "headless orchestrator", sound)
}

// showOnPC is herdr's notification.show, never for e2e's wc- orchestrators.
func (s *server) showOnPC(def OrchestratorDef, title, body, sound string) {
	if strings.HasPrefix(def.Name, "wc-") {
		return
	}
	s.bg.Go(func() { s.rpc("notification.show", map[string]any{"title": title, "body": body, "sound": sound}) })
}

// startHeadless starts the headless orchestrators that ran when the bridge last stopped; for
// the rest it only stops the children an earlier bridge left. wait (for tests) returns once
// each has started, been refused or been reaped.
func (s *server) startHeadless() (wait func()) {
	var wg sync.WaitGroup
	for _, h := range s.headless {
		if !h.wantsToRun() {
			wg.Go(h.reap)
			continue
		}
		wg.Go(func() {
			if err := h.Start(); err != nil {
				h.failed(err)
			}
		})
	}
	return wg.Wait
}

// shutdownHeadless ends every headless child, in parallel (yoicks stop waits 5 s in all).
func (s *server) shutdownHeadless() {
	var wg sync.WaitGroup
	for _, h := range s.headless {
		wg.Go(h.Shutdown)
	}
	wg.Wait()
}

// worktreeInput is a placed worktree spec (decoded JSON) as createWorktree's input.
func worktreeInput(m map[string]any) CreateWorktreeInput {
	return CreateWorktreeInput{Repo: jsField(m, "repo"), Workspace: jsField(m, "workspace"),
		Branch: jsField(m, "branch"), Base: jsField(m, "base"), Path: jsField(m, "path")}
}

func (s *server) startAgentRoute(w http.ResponseWriter, r *http.Request) {
	body := readBody(w, r)
	if body == nil {
		return
	}
	// A `worktree` object means: create a worktree first, then start the agent in it
	// (atomic, with rollback). A present-but-malformed one is refused rather than
	// ignored, which would start in the default location.
	wt, hasWorktree := body["worktree"]
	if _, isObject := wt.(map[string]any); hasWorktree && !isObject {
		jsonError(w, http.StatusBadRequest, "invalid_params", "worktree must be an object")
		return
	}
	in := StartAgentInput{Profile: jsField(body, "profile"), Cwd: jsField(body, "cwd"), Name: jsField(body, "name"),
		Workspace: jsField(body, "workspace"), Task: jsField(body, "task")}
	if hasWorktree {
		placed, err := placeWorktreeNextToRepo(wt.(map[string]any), s.workspaces(), nil)
		if err != nil {
			sendError(w, err)
			return
		}
		spec := worktreeInput(placed)
		in.Worktree = &spec
	}
	out, err := startAgent(s.rpc, s.cfg.LaunchProfiles, in, StartAgentOptions{})
	if err != nil {
		sendError(w, err)
		return
	}
	if profile, ok := body["profile"].(string); ok {
		s.profiles.Set(out.PaneID, profile)
	}
	jsonOK(w, okWith(out))
}

// ── /api/panes/:id/:action ───────────────────────────────────────────────────

func (s *server) paneRoute(w http.ResponseWriter, r *http.Request, paneID, action string) {
	method := r.Method
	switch {
	case action == "read" && method == "GET":
		s.readPane(w, r, paneID)
	case action == "input" && method == "POST":
		s.inputPane(w, r, paneID)
	case action == "focus" && method == "POST":
		if _, err := s.rpc("pane.focus", map[string]any{"pane_id": paneID}); err != nil {
			herdrFailure(w, err)
			return
		}
		jsonOK(w, okWith(struct{}{}))
	case action == "scroll" && method == "POST":
		s.scrollPane(w, r, paneID)
	case action == "transcript" && method == "GET":
		s.paneTranscript(w, r, paneID)
	case action == "rename" && method == "POST":
		// rename the agent running in this pane (herdr agent.rename; target = pane id)
		body := readBody(w, r)
		if body == nil {
			return
		}
		out, err := renameAgent(s.rpc, paneID, jsField(body, "name"))
		if err != nil {
			sendError(w, err)
			return
		}
		// herdr emits no rename event the bridge subscribes to, so re-snapshot to push
		// the new name to /api/state + WS clients (best-effort)
		_ = s.client.Refresh()
		jsonOK(w, okWith(out))
	default:
		jsonError(w, http.StatusNotFound, "not_found", "unknown pane endpoint")
	}
}

var readSources = []string{"visible", "recent", "recent_unwrapped", "detection"}

// paneReadText is a pane.read result's text: herdr wraps it as {type, read: {text}}
// (format=ansi means the text holds ANSI escapes). nil when there is none.
func paneReadText(raw json.RawMessage) any {
	var res map[string]any
	json.Unmarshal(raw, &res)
	inner := res
	if v, ok := res["read"]; ok && v != nil {
		inner, _ = v.(map[string]any)
	}
	return inner["text"]
}

func (s *server) readPane(w http.ResponseWriter, r *http.Request, paneID string) {
	q := r.URL.RawQuery
	source := firstNonEmpty(queryParam(q, "source"), "visible")
	linesParam := queryParam(q, "lines")
	format := firstNonEmpty(queryParam(q, "format"), "text")
	// enums are checked here: herdr drops the connection without a response on an
	// invalid request variant (an opaque "connection closed"), so answer a clear 400
	if !slices.Contains(readSources, source) {
		jsonError(w, http.StatusBadRequest, "invalid_params", "invalid source: "+source)
		return
	}
	if format != "text" && format != "ansi" {
		jsonError(w, http.StatusBadRequest, "invalid_params", "invalid format: "+format)
		return
	}
	params := map[string]any{"pane_id": paneID, "source": source, "format": format}
	if linesParam != "" {
		lines := jsParseInt(linesParam) // NaN reads as -1
		if lines < 0 {
			jsonError(w, http.StatusBadRequest, "invalid_params", "invalid lines: "+linesParam)
			return
		}
		params["lines"] = lines
	}
	if queryParam(q, "strip_ansi") == "true" {
		params["strip_ansi"] = true
	}
	var info *rawPaneInfo
	if source == "visible" {
		info, _ = s.paneInfo(paneID) // best-effort
		screenRead(params, info)
	}
	raw, err := s.rpc("pane.read", params)
	if err != nil {
		herdrFailure(w, err)
		return
	}
	text := paneReadText(raw)
	out := map[string]any{}
	if format == "ansi" {
		out["ansi"] = text
	} else {
		out["text"] = text
	}
	// The live screen carries the same app-scroll decision the WS watch pushes, so the
	// HTTP fallback (used while the socket is down) keeps wheel forwarding right.
	if info != nil {
		str, _ := text.(string)
		out["appScroll"] = computeAppScroll(info, str)
	}
	jsonOK(w, out)
}

// rawPaneInfo is what the bridge reads of a pane.get answer. Decoding keeps the
// fields that have the expected type (the TS checks each with typeof).
type rawPaneInfo struct {
	Agent  string `json:"agent"`
	Scroll *struct {
		MaxOffsetFromBottom *float64 `json:"max_offset_from_bottom"`
		ViewportRows        *float64 `json:"viewport_rows"`
	} `json:"scroll"`
	// the claude session identity and cwd, which locate the transcript
	AgentSession *struct {
		Value  any `json:"value"`
		Source any `json:"source"`
	} `json:"agent_session"`
	Cwd           string `json:"cwd"`
	ForegroundCwd string `json:"foreground_cwd"`
}

// screenRead makes a visible read (params) read the pane's live screen. herdr's
// visible is the desktop's viewport: scrolled up there (to read a long reply, say), it
// keeps returning that old text while a new prompt waits at the bottom, so the phone
// found no prompt at all. The bottom is read whatever the scroll, not only when
// pane.get says scrolled, which leaves no gap for a scroll between the two calls.
// Text: detection, herdr's own bottom screen. ANSI (detection has none): the bottom
// viewport_rows rows of recent. A recent *text* read for more rows than an idle
// alt-screen agent's screen makes herdr scroll the app to capture history, and the
// screen can shrink after pane.get; ANSI reads never do that. info nil (pane.get
// failed): an ANSI read is left as visible.
func screenRead(params map[string]any, info *rawPaneInfo) {
	if params["format"] != "ansi" {
		params["source"] = "detection"
		return
	}
	if info == nil || info.Scroll == nil || info.Scroll.ViewportRows == nil || *info.Scroll.ViewportRows < 1 {
		return
	}
	rows := *info.Scroll.ViewportRows
	params["source"] = "recent"
	if lines, ok := params["lines"].(int); !ok || float64(lines) > rows {
		params["lines"] = int(rows)
	}
}

func (s *server) paneInfo(paneID string) (*rawPaneInfo, error) {
	raw, err := s.rpc("pane.get", map[string]any{"pane_id": paneID})
	if err != nil {
		return nil, err
	}
	var res struct {
		Pane *rawPaneInfo `json:"pane"`
	}
	json.Unmarshal(raw, &res)
	return res.Pane, nil
}

// computeAppScroll is whether a pane should get forwarded SGR wheel events: it runs
// an agent, has no terminal scrollback (a full-screen alt-screen app keeps none),
// and actually paints most of the viewport. A normal pane whose output merely fits
// the screen has few filled rows and keeps local scrolling, so wheel bytes aren't
// injected as unexpected mouse sequences.
func computeAppScroll(p *rawPaneInfo, ansi string) bool {
	if p == nil || p.Agent == "" || p.Scroll == nil {
		return false
	}
	max, rows := p.Scroll.MaxOffsetFromBottom, p.Scroll.ViewportRows
	if max == nil || *max != 0 || rows == nil || *rows <= 0 {
		return false
	}
	nonEmpty := 0
	for _, l := range strings.Split(ansi, "\n") {
		if jsTrim(l) != "" {
			nonEmpty++
		}
	}
	return float64(nonEmpty) >= *rows*0.6
}

func (s *server) inputPane(w http.ResponseWriter, r *http.Request, paneID string) {
	body := readBody(w, r)
	if body == nil {
		return
	}
	keysV, hasKeys := body["keys"]
	var keys []string
	if hasKeys {
		arr, ok := keysV.([]any)
		for _, k := range arr {
			if k, isString := k.(string); isString {
				keys = append(keys, k)
			} else {
				ok = false
			}
		}
		if !ok {
			jsonError(w, http.StatusBadRequest, "invalid_params", "keys must be an array of strings")
			return
		}
	}
	text, hasText := body["text"]
	if _, ok := text.(string); text != nil && !ok {
		jsonError(w, http.StatusBadRequest, "invalid_params", "text must be a string")
		return
	}
	for _, f := range []string{"enter", "clear"} {
		if v, ok := body[f]; ok {
			if _, isBool := v.(bool); !isBool {
				jsonError(w, http.StatusBadRequest, "invalid_params", f+" must be a boolean")
				return
			}
		}
	}
	// A single digit goes as a raw keystroke (pane.send_text, NOT send_input): a
	// numbered menu selects that option directly, while send_input would wrap it in
	// bracketed paste, which the menu ignores. Only ever one digit.
	if press, ok := body["press"]; ok {
		digit, _ := press.(string)
		if len(digit) != 1 || digit[0] < '0' || digit[0] > '9' {
			jsonError(w, http.StatusBadRequest, "invalid_params", "press must be a single digit")
			return
		}
		expect, hasExpect := body["expect_prompt"]
		expected, isString := expect.(string)
		if hasExpect && !isString {
			jsonError(w, http.StatusBadRequest, "invalid_params", "expect_prompt must be a string")
			return
		}
		// Verify-and-send: read the live screen and confirm its prompt identity still
		// matches what the client last rendered, THEN press, back to back. herdr has no
		// conditional input (and is never modified), so this is a pane.get (to find the
		// live screen), then the read and the press back to back; the window left is
		// the local compute between those two.
		if hasExpect {
			// Unlike the display reads, no best-effort here: without the screen's size
			// it would read visible, which can be a stale menu on a scrolled-up desktop.
			info, err := s.paneInfo(paneID)
			if err != nil {
				herdrFailure(w, err)
				return
			}
			params := map[string]any{"pane_id": paneID, "source": "visible", "format": "ansi"}
			screenRead(params, info)
			raw, err := s.rpc("pane.read", params)
			if err != nil {
				herdrFailure(w, err)
				return
			}
			screen, _ := paneReadText(raw).(string)
			stripped := stripAnsi(screen)
			// gated on parsePrompt like the client: a screen it would no longer treat as
			// an answerable menu yields "", which never matches a non-empty expect_prompt
			live := ""
			if parsePrompt(stripped) != nil {
				live = promptIdentity(stripped)
			}
			if live != expected {
				jsonError(w, http.StatusConflict, "prompt_changed", "the prompt changed before the answer was sent")
				return
			}
		}
		if _, err := s.rpc("pane.send_text", map[string]any{"pane_id": paneID, "text": digit}); err != nil {
			herdrFailure(w, err)
			return
		}
		jsonOK(w, okWith(struct{}{}))
		return
	}
	if body["enter"] == true { // strict: a string like "false" must not submit
		keys = append(keys, "enter")
	}
	params := map[string]any{"pane_id": paneID}
	if hasText && text != nil {
		params["text"] = text
	}
	if len(keys) > 0 {
		params["keys"] = keys
	}
	// `clear` wipes the composer (raw Ctrl+U bytes, not a bracketed-paste send_input)
	// before the text lands, so a message composed in yoicks submits alone instead
	// of appended to a draft left in the pane. The clear is answered before send_input
	// goes out, and the app consumes pty input in order.
	if body["clear"] == true {
		if _, err := s.rpc("pane.send_text", map[string]any{"pane_id": paneID, "text": composerClearSeq}); err != nil {
			herdrFailure(w, err)
			return
		}
	}
	if _, err := s.rpc("pane.send_input", params); err != nil {
		herdrFailure(w, err)
		return
	}
	jsonOK(w, okWith(struct{}{}))
}

// scrollPane scrolls a full-screen app's own view (claude etc.) with real SGR mouse
// wheel events. They go through pane.send_text as raw bytes: send_input wraps text
// in bracketed paste when the app enables it, and the app then discards them.
func (s *server) scrollPane(w http.ResponseWriter, r *http.Request, paneID string) {
	body := readBody(w, r)
	if body == nil {
		return
	}
	direction := jsField(body, "direction")
	d, _ := direction.(string)
	wheel := map[string]string{"up": "\u001b[<64;10;5M", "down": "\u001b[<65;10;5M"}[d]
	if wheel == "" {
		jsonError(w, http.StatusBadRequest, "invalid_params", "invalid direction: "+jsString(direction))
		return
	}
	steps := 1.0
	if n, ok := body["steps"].(float64); ok {
		steps = n
	}
	steps = max(1, min(30, math.Floor(steps)))
	if _, err := s.rpc("pane.send_text", map[string]any{"pane_id": paneID, "text": strings.Repeat(wheel, int(steps))}); err != nil {
		herdrFailure(w, err)
		return
	}
	jsonOK(w, okWith(struct{}{}))
}

// ── transcript ───────────────────────────────────────────────────────────────

const transcriptInitialItems = 300 // last-N items sent on an initial chat load

// resolvePaneTranscript locates a pane's Claude Code transcript from its session id
// and cwd (pane.get). "" for both only when the lookup worked and proves the pane
// isn't a claude session or its transcript isn't on this host (chat unavailable); a
// herdr RPC failure is an error instead, so callers retry and keep their view rather
// than mistake a flaky pane.get for "no transcript".
func (s *server) resolvePaneTranscript(paneID string) (sessionID, file string, err error) {
	// a headless orchestrator's: its session, in its account's projects, from its dir
	if name, ok := strings.CutPrefix(paneID, "hl:"); ok {
		h := s.headless[name]
		if h == nil || h.session() == "" {
			return "", "", nil
		}
		return h.session(), h.transcriptFile(), nil
	}
	p, err := s.paneInfo(paneID)
	if err != nil {
		return "", "", err
	}
	if p == nil || p.AgentSession == nil {
		return "", "", nil
	}
	source, _ := p.AgentSession.Source.(string)
	sessionID, _ = p.AgentSession.Value.(string)
	if !strings.HasPrefix(source, "herdr:claude") || sessionID == "" {
		return "", "", nil
	}
	cwd := firstNonEmpty(p.ForegroundCwd, p.Cwd)
	// the safe filesystem roots first (default + ~/.config/claude/*): no process
	// environment read in the common case
	file = resolveTranscriptPath(sessionID, cwd, nil)
	// last resort: follow the pane's claude to a non-standard CLAUDE_CONFIG_DIR via /proc
	if file == "" {
		roots, err := s.claudeConfigRoots(paneID)
		if err != nil {
			return "", "", err
		}
		if len(roots) > 0 {
			file = resolveTranscriptPath(sessionID, cwd, roots)
		}
	}
	return sessionID, file, nil
}

// claudeConfigRoots finds the pane's local claude processes and derives their
// transcript roots from /proc. A pane.process_info failure is an error (transient:
// the caller retries); a pid /proc can't answer for just adds no root.
func (s *server) claudeConfigRoots(paneID string) ([]string, error) {
	raw, err := s.rpc("pane.process_info", map[string]any{"pane_id": paneID})
	if err != nil {
		return nil, err
	}
	var res struct {
		ProcessInfo *struct {
			ForegroundProcesses []struct {
				Pid  *float64 `json:"pid"`
				Name string   `json:"name"`
				Argv []any    `json:"argv"`
			} `json:"foreground_processes"`
		} `json:"process_info"`
	}
	json.Unmarshal(raw, &res)
	var roots []string
	if res.ProcessInfo == nil {
		return nil, nil
	}
	for _, p := range res.ProcessInfo.ForegroundProcesses {
		claude := p.Name == "claude" || len(p.Argv) > 0 && p.Argv[0] == "claude"
		if !claude || p.Pid == nil || *p.Pid != math.Trunc(*p.Pid) || math.Abs(*p.Pid) > math.MaxInt32 {
			continue
		}
		if root := projectsRootForPid(int(*p.Pid)); root != "" {
			roots = append(roots, root)
		}
	}
	return roots, nil
}

// paneTranscript is the structured chat view: the pane's Claude Code JSONL transcript
// as TimelineItems. ?session=<id>&after=<cursor> fetches only the items past a byte
// cursor of the same session (HTTP-fallback polling); otherwise the recent tail, with
// reset. available=false: not a claude pane, or its transcript isn't on this host.
func (s *server) paneTranscript(w http.ResponseWriter, r *http.Request, paneID string) {
	sessionID, file, err := s.resolvePaneTranscript(paneID)
	if err != nil {
		// transient: an error, NOT available:false, so the client retries and keeps its view
		herdrFailure(w, err)
		return
	}
	if sessionID == "" || file == "" {
		jsonOK(w, struct {
			Available bool `json:"available"`
		}{false})
		return
	}
	q := r.URL.RawQuery
	after := int64(-1) // NaN
	if a := queryParam(q, "after"); a != "" {
		after = int64(jsParseInt(a))
	}
	if queryParam(q, "session") == sessionID && after >= 0 {
		// reset when `after` is too far behind: a rebuilt tail the client replaces
		c := readTranscriptFrom(file, after, transcriptInitialItems)
		jsonOK(w, struct {
			Available bool           `json:"available"`
			SessionID string         `json:"sessionId"`
			Items     []TimelineItem `json:"items"`
			Cursor    int64          `json:"cursor"`
			Reset     bool           `json:"reset"`
		}{true, sessionID, c.Items, c.Cursor, c.Reset})
		return
	}
	t := readTranscriptTail(file, transcriptInitialItems)
	jsonOK(w, struct {
		Available bool           `json:"available"`
		SessionID string         `json:"sessionId"`
		Items     []TimelineItem `json:"items"`
		Cursor    int64          `json:"cursor"`
		Reset     bool           `json:"reset"`
		Truncated bool           `json:"truncated"`
	}{true, sessionID, t.Items, t.Cursor, true, t.Truncated})
}

// ── /api/agents/:target/:action ──────────────────────────────────────────────

func (s *server) agentRoute(w http.ResponseWriter, r *http.Request, target, action string) {
	switch {
	case action == "send" && r.Method == "POST":
		body := readBody(w, r)
		if body == nil {
			return
		}
		// agent.prompt submits the text (with Enter) and refuses an empty one
		text, _ := body["text"].(string)
		if text == "" {
			jsonError(w, http.StatusBadRequest, "invalid_params", "text must be a non-empty string")
			return
		}
		if _, err := s.rpc("agent.prompt", map[string]any{"target": target, "text": text}); err != nil {
			herdrFailure(w, err)
			return
		}
		jsonOK(w, okWith(struct{}{}))
	case action == "clear" && r.Method == "POST":
		s.clearAgentRoute(w, target)
	default:
		jsonError(w, http.StatusNotFound, "not_found", "unknown agent endpoint")
	}
}

// clearAgentRoute launches a fresh replacement (same profile + cwd) and closes the old
// pane. The pane id changes: the client re-follows the new pane.
//
// The replacement keeps the old agent's Claude account, which a plain new pane
// wouldn't have. Accounts are read from /proc (Linux): unknown, the clear is refused;
// not what came up, the old agent is kept. An orchestrator with a configured env
// restarts with it, so it keeps its account without /proc (macOS) too; other agents
// there go on as before this check existed.
func (s *server) clearAgentRoute(w http.ResponseWriter, target string) {
	readable := runtime.GOOS == "linux"
	account := ""
	// the store is keyed by pane id but target may be an agent name, so clearAgent
	// resolves the pane id and reports it (out.OldPaneID)
	out, err := clearAgent(s.rpc, s.cfg.LaunchProfiles, target, func(id string) string {
		p, _ := s.profiles.Get(id)
		return p
	}, ClearAgentOptions{
		EnvFor: func(oldPaneID string) (map[string]string, error) {
			if readable {
				account, _ = paneAccount(s.rpc, oldPaneID)
				if account == "" {
					return nil, &LifecycleError{Status: 409, Code: "account_unknown", Message: "can't tell this agent's Claude account, so it was left as is"}
				}
			}
			if st := s.client.State(); st != nil {
				for i, o := range findOrchestrators(st, s.cfg.Orchestrators, nil) {
					if o.PaneID != nil && *o.PaneID == oldPaneID {
						if env := s.cfg.Orchestrators[i].Env; len(env) > 0 {
							return env, nil
						}
						break
					}
				}
			}
			return accountEnv(account, ""), nil
		},
		Verify: func(paneID string) error {
			if account == "" {
				return nil
			}
			if err := waitForDetectedAgent(s.rpc, paneID); err != nil {
				return err
			}
			got, err := paneAccount(s.rpc, paneID)
			if err != nil {
				return err
			}
			if got != account {
				return &LifecycleError{Status: 409, Code: "account_mismatch", Message: "the fresh session came up under another Claude account"}
			}
			return nil
		},
	})
	if err != nil {
		sendError(w, err)
		return
	}
	// the old mapping goes only once the old pane is gone: if the close failed it
	// still exists and keeps its recorded profile
	if out.ClosedOld {
		s.profiles.Delete(out.OldPaneID)
	}
	s.profiles.Set(out.PaneID, out.Profile)
	jsonOK(w, okWith(out))
}

// ── static files ─────────────────────────────────────────────────────────────

// serveStatic serves the web UI (no auth). urlPath is still percent-encoded, as in
// http.ts, which looks files up by the encoded name. A file with an encoded copy (the
// build's .br and .gz) goes in the best one the client accepts, under its own ETag;
// http.ServeContent does HEAD, ranges and If-None-Match on whichever body is sent.
func (s *server) serveStatic(w http.ResponseWriter, r *http.Request, urlPath string) {
	rel := urlPath
	if rel == "/" {
		rel = "/index.html"
	}
	// path traversal guard: the resolved path must stay inside the web root
	full := path.Join("/web", rel)
	if full != "/web" && !strings.HasPrefix(full, "/web/") {
		jsonError(w, http.StatusForbidden, "forbidden", "forbidden")
		return
	}
	name := strings.TrimPrefix(strings.TrimPrefix(full, "/web"), "/")
	if name == "" {
		name = "."
	}
	f, err := s.web.Open(name)
	if err != nil {
		jsonError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	defer f.Close()
	// directories (and other non-files) are not found
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		jsonError(w, http.StatusNotFound, "not_found", "not found")
		return
	}
	ext := path.Ext(name)
	if mime, ok := mimeTypes[ext]; ok {
		w.Header().Set("Content-Type", mime)
	} else {
		w.Header().Set("Content-Type", "application/octet-stream")
	}
	// Always revalidate the service worker and the HTML shell so a new build is
	// detected without a manual cache clear (the SW versions the other assets).
	if path.Base(name) == "sw.js" || ext == ".html" {
		w.Header().Set("Cache-Control", "no-cache")
	}
	// The build names everything under assets/ by its content hash: a new build has new names.
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	data, err := io.ReadAll(f)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	sum := sha256.Sum256(data)
	body, etag := data, fmt.Sprintf("%x", sum[:8])
	accept, best, bestQ := r.Header.Get("Accept-Encoding"), -1, 0.0
	for i, enc := range encodings {
		if _, err := fs.Stat(s.web, name+enc.suffix); err != nil {
			continue
		}
		w.Header().Set("Vary", "Accept-Encoding")
		if q := quality(accept, enc.coding); q > bestQ { // a tie keeps the earlier, better one
			best, bestQ = i, q
		}
	}
	if best >= 0 {
		enc := encodings[best]
		if encoded, err := fs.ReadFile(s.web, name+enc.suffix); err == nil {
			body, etag = encoded, etag+"-"+enc.coding
			w.Header().Set("Content-Encoding", enc.coding)
		}
	}
	w.Header().Set("ETag", `"`+etag+`"`)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(body))
}

// quality is the q an Accept-Encoding value gives coding: 1 when listed without one, 0 when
// not listed or unreadable. A bare * doesn't count: identity is always acceptable, so that
// client gets the plain file.
func quality(header, coding string) float64 {
	for _, part := range strings.Split(header, ",") {
		c, params, _ := strings.Cut(part, ";")
		if !strings.EqualFold(strings.TrimSpace(c), coding) {
			continue
		}
		for _, p := range strings.Split(params, ";") {
			if k, v, _ := strings.Cut(strings.TrimSpace(p), "="); strings.EqualFold(k, "q") {
				if q, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
					return q
				}
				return 0
			}
		}
		return 1
	}
	return 0
}
