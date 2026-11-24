// Command shadowdiff compares the Go bridge, run beside the production Node bridge
// in P4a of docs/go-migration-plan.md, with that Node bridge:
//
//   - /api/state from both every 5 s. A difference counts only once the same JSON
//     path (e.g. workspaces[2].worktree.branch) has differed for 70 s: a worktree
//     refresh takes up to ~60 s and the account checks run every 60 s, and a path
//     rather than a value, so a field that keeps changing (completionSeq) and keeps
//     lagging still counts. sinceUnixMs is never compared: it lives in each
//     bridge's memory.
//   - agent_status on both /ws, as each pane's sequence of from→to. A pane whose
//     next transitions differ counts, and so does one that one side pushed and the
//     other didn't within 70 s. Order across panes isn't compared.
//
// Usage:
//
//	shadowdiff config -from NODE_CONFIG -data NODE_DATA_DIR
//	shadowdiff watch -dir DIR -go-token FILE [-node URL] [-node-token FILE] [-go URL]
//	shadowdiff report -dir DIR
//
// config prints the Go bridge's config: the Node one's, without ntfy, on 8391,
// with each orchestrator unmanaged at the dir Node uses. watch runs until killed:
// counted differences are appended to DIR/findings.jsonl, and DIR/status.json holds
// the totals and what differs right now. report prints them. It only reads both
// bridges (GET /api/state, a /ws that never asks to watch anything).
// tools/shadowdiff/shadow.sh starts and stops the whole P4a setup.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

var sides = [2]string{"node", "go"}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "config":
		fs := flag.NewFlagSet("config", flag.ExitOnError)
		from := fs.String("from", "", "the Node bridge's config.json")
		data := fs.String("data", "", "the Node bridge's data dir (…/herdr-agentweb)")
		fs.Parse(os.Args[2:])
		if *from == "" || *data == "" {
			usage()
		}
		b, err := os.ReadFile(*from)
		if err != nil {
			log.Fatal(err)
		}
		var cfg map[string]any
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.UseNumber()
		if err := dec.Decode(&cfg); err != nil || cfg == nil {
			log.Fatalf("%s: not a JSON object", *from)
		}
		_, err = os.Stat(filepath.Join(*data, "dispatcher"))
		out, _ := json.MarshalIndent(shadowConfig(cfg, *data, err == nil), "", "  ")
		fmt.Println(string(out))
	case "watch":
		watch(os.Args[2:])
	case "report":
		fs := flag.NewFlagSet("report", flag.ExitOnError)
		dir := fs.String("dir", "", "the watch's output dir")
		fs.Parse(os.Args[2:])
		if *dir == "" {
			usage()
		}
		if err := report(os.Stdout, *dir, time.Now()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: shadowdiff config -from NODE_CONFIG -data NODE_DATA_DIR
       shadowdiff watch -dir DIR -go-token FILE [-node URL] [-node-token FILE] [-go URL]
       shadowdiff report -dir DIR`)
	os.Exit(2)
}

var slug = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// shadowConfig turns the Node bridge's config into the Go one's: no ntfy (notify_url)
// and no public_url, port 8391, and each orchestrator at the dir the Node bridge
// resolves for it (parseOrchestrators in server/config.ts), given as its own dir so
// the Go bridge leaves it unmanaged and writes nothing there. A dir counts when it is
// a string with more than spaces, an entry when its name is a slug. Without one, the
// legacy setups become orchestrator_dir, unmanaged with the same empty label.
func shadowConfig(cfg map[string]any, data string, dispatcherExists bool) map[string]any {
	set := func(v any) bool { s, ok := v.(string); return ok && strings.TrimSpace(s) != "" }
	delete(cfg, "notify_url")
	delete(cfg, "public_url")
	cfg["port"] = 8391
	entries, _ := cfg["orchestrators"].([]any)
	valid := slices.ContainsFunc(entries, func(e any) bool {
		m, _ := e.(map[string]any)
		name, _ := m["name"].(string)
		return slug.MatchString(name)
	})
	switch {
	case valid:
		for _, e := range entries {
			if m, ok := e.(map[string]any); ok && !set(m["dir"]) {
				m["dir"] = filepath.Join(data, "orchestrators", fmt.Sprint(m["name"]))
			}
		}
	case set(cfg["orchestrator_dir"]):
	case dispatcherExists:
		cfg["orchestrator_dir"] = filepath.Join(data, "dispatcher")
	default:
		cfg["orchestrator_dir"] = filepath.Join(data, "orchestrators", "default")
	}
	return cfg
}

// ── comparing states ─────────────────────────────────────────────────────────

// flatten maps each JSON leaf, and each empty object or array, to its path.
func flatten(path string, v any, out map[string]string) {
	switch v := v.(type) {
	case map[string]any:
		if len(v) == 0 {
			out[path] = "{}"
		}
		for k, x := range v {
			if k == "sinceUnixMs" {
				continue
			}
			p := k
			if path != "" {
				p = path + "." + k
			}
			flatten(p, x, out)
		}
	case []any:
		if len(v) == 0 {
			out[path] = "[]"
		}
		for i, x := range v {
			flatten(path+"["+strconv.Itoa(i)+"]", x, out)
		}
	default:
		b, _ := json.Marshal(v)
		out[path] = string(b)
	}
}

const absent = "(absent)"

// differing returns each path whose value differs, as [node, go].
func differing(node, goState []byte) (map[string][2]string, error) {
	var leaves [2]map[string]string
	for i, raw := range [][]byte{node, goState} {
		dec := json.NewDecoder(bytes.NewReader(raw))
		dec.UseNumber()
		var v any
		if err := dec.Decode(&v); err != nil {
			return nil, fmt.Errorf("%s state: %w", sides[i], err)
		}
		leaves[i] = map[string]string{}
		flatten("", v, leaves[i])
	}
	out := map[string][2]string{}
	for p, a := range leaves[0] {
		if b, ok := leaves[1][p]; !ok {
			out[p] = [2]string{a, absent}
		} else if a != b {
			out[p] = [2]string{a, b}
		}
	}
	for p, b := range leaves[1] {
		if _, ok := leaves[0][p]; !ok {
			out[p] = [2]string{absent, b}
		}
	}
	return out, nil
}

type finding struct {
	At    time.Time `json:"at"`             // when it was counted
	Kind  string    `json:"kind"`           // state | agent_status
	Path  string    `json:"path,omitempty"` // state
	Pane  string    `json:"pane,omitempty"` // agent_status
	Since time.Time `json:"since"`          // when the difference began
	Node  string    `json:"node"`
	Go    string    `json:"go"`
}

type openDiff struct {
	Since   time.Time `json:"since"`
	Node    string    `json:"node"`
	Go      string    `json:"go"`
	Counted bool      `json:"counted"`
}

// stateTracker follows each differing path from comparison to comparison.
type stateTracker struct {
	hold time.Duration
	open map[string]*openDiff
}

// observe takes one comparison's differences and returns those that have just
// lasted hold. A path that stops differing starts over.
func (t *stateTracker) observe(now time.Time, diffs map[string][2]string) []finding {
	for p := range t.open {
		if _, ok := diffs[p]; !ok {
			delete(t.open, p)
		}
	}
	var out []finding
	for p, v := range diffs {
		d := t.open[p]
		if d == nil {
			d = &openDiff{Since: now}
			t.open[p] = d
		}
		d.Node, d.Go = v[0], v[1]
		if !d.Counted && now.Sub(d.Since) >= t.hold {
			d.Counted = true
			out = append(out, finding{At: now, Kind: "state", Path: p, Since: d.Since, Node: d.Node, Go: d.Go})
		}
	}
	slices.SortFunc(out, func(a, b finding) int { return strings.Compare(a.Path, b.Path) })
	return out
}

// ── comparing agent_status ───────────────────────────────────────────────────

type transition struct {
	step string // from→to
	at   time.Time
}

// statusMatcher pairs each pane's transitions from the two sides in order. While
// either side is disconnected nothing is queued: the other one couldn't have seen it.
type statusMatcher struct {
	hold    time.Duration
	live    [2]bool
	queue   map[string]*[2][]transition
	matched int
}

// connected marks a side up or down. Either way the queues restart: what was
// pending may have been pushed while one side wasn't listening.
func (m *statusMatcher) connected(side int, up bool) {
	m.live[side] = up
	m.queue = map[string]*[2][]transition{}
}

func (m *statusMatcher) add(side int, pane, step string, now time.Time) []finding {
	if !m.live[0] || !m.live[1] {
		return nil
	}
	q := m.queue[pane]
	if q == nil {
		q = &[2][]transition{}
		m.queue[pane] = q
	}
	q[side] = append(q[side], transition{step, now})
	for len(q[0]) > 0 && len(q[1]) > 0 {
		if q[0][0].step != q[1][0].step {
			return []finding{m.drop(pane, now)}
		}
		q[0], q[1] = q[0][1:], q[1][1:]
		m.matched++
	}
	if len(q[0]) == 0 && len(q[1]) == 0 {
		delete(m.queue, pane)
	}
	return nil
}

// expire counts the panes with a transition the other side hasn't matched in hold.
func (m *statusMatcher) expire(now time.Time) []finding {
	var out []finding
	for pane, q := range m.queue {
		for _, s := range q {
			if len(s) > 0 && now.Sub(s[0].at) >= m.hold {
				out = append(out, m.drop(pane, now))
				break
			}
		}
	}
	slices.SortFunc(out, func(a, b finding) int { return strings.Compare(a.Pane, b.Pane) })
	return out
}

func (m *statusMatcher) pending() int {
	n := 0
	for _, q := range m.queue {
		n += len(q[0]) + len(q[1])
	}
	return n
}

// drop records a pane's unmatched transitions as a finding and starts it over.
func (m *statusMatcher) drop(pane string, now time.Time) finding {
	q := m.queue[pane]
	delete(m.queue, pane)
	f := finding{At: now, Kind: "agent_status", Pane: pane, Since: now}
	var steps [2][]string
	for i, s := range q {
		for _, t := range s {
			steps[i] = append(steps[i], t.step)
			if t.at.Before(f.Since) {
				f.Since = t.at
			}
		}
	}
	f.Node, f.Go = strings.Join(steps[0], ", "), strings.Join(steps[1], ", ")
	return f
}

// ── watching ─────────────────────────────────────────────────────────────────

type sideStatus struct {
	URL              string    `json:"url"`
	FetchErrors      int       `json:"fetchErrors"`
	LastFetchError   string    `json:"lastFetchError,omitempty"`
	LastFetchErrorAt time.Time `json:"lastFetchErrorAt,omitzero"`
	WSConnected      bool      `json:"wsConnected"`
	WSConnects       int       `json:"wsConnects"`
	WSConnectedAt    time.Time `json:"wsConnectedAt,omitzero"`
	WSLastError      string    `json:"wsLastError,omitempty"`
	AgentStatus      int       `json:"agentStatus"` // agent_status pushes received
}

type status struct {
	StartedAt          time.Time              `json:"startedAt"`
	UpdatedAt          time.Time              `json:"updatedAt"`
	Polls              int                    `json:"polls"`
	Compared           int                    `json:"compared"`
	LastComparedAt     time.Time              `json:"lastComparedAt,omitzero"`
	Sides              map[string]*sideStatus `json:"sides"`
	TransitionsMatched int                    `json:"transitionsMatched"`
	TransitionsPending int                    `json:"transitionsPending"`
	Findings           int                    `json:"findings"`
	Open               map[string]*openDiff   `json:"open"` // the paths that differ right now
}

type side struct {
	url, tokenFile string
}

type watcher struct {
	dir    string
	sides  [2]side
	client *http.Client
	maxGap time.Duration // between comparisons, beyond which a run breaks

	mu      sync.Mutex
	st      status
	state   stateTracker
	matcher statusMatcher
}

func watch(args []string) {
	fs := flag.NewFlagSet("watch", flag.ExitOnError)
	dir := fs.String("dir", "", "output dir (findings.jsonl, status.json, watch.pid)")
	nodeURL := fs.String("node", "http://127.0.0.1:8390", "the Node bridge")
	nodeToken := fs.String("node-token", filepath.Join(os.Getenv("HOME"), ".local/state/herdr/plugins/y011d4.agentweb/token"), "the Node bridge's token file")
	goURL := fs.String("go", "http://127.0.0.1:8391", "the Go bridge")
	goToken := fs.String("go-token", "", "the Go bridge's token file")
	interval := fs.Duration("interval", 5*time.Second, "how often to compare /api/state")
	hold := fs.Duration("hold", 70*time.Second, "how long a difference must last to count")
	fs.Parse(args)
	if *dir == "" || *goToken == "" {
		usage()
	}
	w := newWatcher(*dir, [2]side{{*nodeURL, *nodeToken}, {*goURL, *goToken}}, *interval, *hold)
	if err := os.WriteFile(filepath.Join(*dir, "watch.pid"), []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
		log.Fatal(err)
	}
	for i := range sides {
		go w.follow(i)
	}
	for range time.Tick(*interval) {
		w.poll()
	}
}

func newWatcher(dir string, s [2]side, interval, hold time.Duration) *watcher {
	now := time.Now()
	return &watcher{
		dir:    dir,
		sides:  s,
		client: &http.Client{Timeout: interval},
		maxGap: 3 * interval,
		st: status{StartedAt: now, UpdatedAt: now, Open: map[string]*openDiff{},
			Sides: map[string]*sideStatus{"node": {URL: s[0].url}, "go": {URL: s[1].url}}},
		state:   stateTracker{hold: hold, open: map[string]*openDiff{}},
		matcher: statusMatcher{hold: hold, queue: map[string]*[2][]transition{}},
	}
}

func (w *watcher) token(i int) (string, error) {
	b, err := os.ReadFile(w.sides[i].tokenFile) // each time: the Go bridge makes its token on its first start
	return strings.TrimSpace(string(b)), err
}

func (w *watcher) fetchState(i int) ([]byte, error) {
	tok, err := w.token(i)
	if err != nil {
		return nil, err
	}
	req, _ := http.NewRequest("GET", w.sides[i].url+"/api/state", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	res, err := w.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err == nil && res.StatusCode != http.StatusOK {
		err = fmt.Errorf("HTTP %d: %.200s", res.StatusCode, body)
	}
	return body, err
}

func (w *watcher) poll() {
	var bodies [2][]byte
	var errs [2]error
	var wg sync.WaitGroup
	for i := range sides {
		wg.Go(func() { bodies[i], errs[i] = w.fetchState(i) })
	}
	wg.Wait()

	w.mu.Lock()
	defer w.mu.Unlock()
	w.compare(time.Now(), bodies, errs)
	w.writeStatus()
}

// compare takes one poll's states. Called with mu held.
func (w *watcher) compare(now time.Time, bodies [2][]byte, errs [2]error) {
	w.st.Polls++
	for i, e := range errs {
		if e != nil {
			s := w.st.Sides[sides[i]]
			s.FetchErrors++
			s.LastFetchError, s.LastFetchErrorAt = e.Error(), now
		}
	}
	err := errors.Join(errs[:]...)
	var diffs map[string][2]string
	if err == nil {
		if diffs, err = differing(bodies[0], bodies[1]); err != nil {
			log.Print(err)
		}
	}
	// A poll that compared nothing breaks every difference's run: it can't be told to
	// have lasted through it. So does a gap between comparisons (each fetch times out
	// after an interval, so only a paused watch makes one). A suspend of the machine
	// adds nothing to a run: the times carry Go's monotonic reading, which stands
	// still while suspended (CLOCK_MONOTONIC on Linux), as do both bridges.
	if err != nil || now.Sub(w.st.LastComparedAt) > w.maxGap {
		clear(w.state.open)
	}
	if err == nil {
		w.st.Compared++
		w.st.LastComparedAt = now
		w.record(w.state.observe(now, diffs))
	}
	w.record(w.matcher.expire(now))
	w.st.TransitionsMatched, w.st.TransitionsPending = w.matcher.matched, w.matcher.pending()
	w.st.Open = w.state.open
	w.st.UpdatedAt = now
}

// follow keeps a /ws connection to side i, reconnecting every 5 s.
func (w *watcher) follow(i int) {
	for {
		err := w.followOnce(i)
		w.mu.Lock()
		s := w.st.Sides[sides[i]]
		if s.WSConnected {
			w.matcher.connected(i, false)
		}
		s.WSConnected, s.WSLastError = false, err.Error()
		w.mu.Unlock()
		log.Printf("%s /ws: %v", sides[i], err)
		time.Sleep(5 * time.Second)
	}
}

func (w *watcher) followOnce(i int) error {
	tok, err := w.token(i)
	if err != nil {
		return err
	}
	ctx := context.Background()
	u := "ws" + strings.TrimPrefix(w.sides[i].url, "http") + "/ws"
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + tok}}})
	if err != nil {
		return err
	}
	defer c.CloseNow()
	c.SetReadLimit(-1) // state pushes outgrow the 32 KB default
	w.mu.Lock()
	s := w.st.Sides[sides[i]]
	s.WSConnected, s.WSConnectedAt = true, time.Now()
	s.WSConnects++
	w.matcher.connected(i, true)
	w.mu.Unlock()
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		var m struct {
			Type   string `json:"type"`
			PaneID string `json:"paneId"`
			From   string `json:"from"`
			To     string `json:"to"`
		}
		if json.Unmarshal(data, &m) != nil || m.Type != "agent_status" {
			continue
		}
		w.mu.Lock()
		s.AgentStatus++
		w.record(w.matcher.add(i, m.PaneID, m.From+"→"+m.To, time.Now()))
		w.mu.Unlock()
	}
}

// record appends findings to findings.jsonl. Called with mu held.
func (w *watcher) record(fs []finding) {
	if len(fs) == 0 {
		return
	}
	w.st.Findings += len(fs)
	f, err := os.OpenFile(filepath.Join(w.dir, "findings.jsonl"), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		log.Print(err)
		return
	}
	defer f.Close()
	enc := json.NewEncoder(f)
	enc.SetEscapeHTML(false)
	for _, x := range fs {
		enc.Encode(x)
	}
}

// writeStatus replaces status.json in one rename, so report never reads half of it.
func (w *watcher) writeStatus() {
	b, _ := json.MarshalIndent(w.st, "", " ")
	tmp := filepath.Join(w.dir, "status.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Print(err)
		return
	}
	if err := os.Rename(tmp, filepath.Join(w.dir, "status.json")); err != nil {
		log.Print(err)
	}
}

// ── report ───────────────────────────────────────────────────────────────────

func report(out io.Writer, dir string, now time.Time) error {
	var st status
	b, err := os.ReadFile(filepath.Join(dir, "status.json"))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return err
	}
	// findings.jsonl outlives a restart of the watch, as do the earlier runs' findings
	var findings []finding
	earlier := 0
	if b, err := os.ReadFile(filepath.Join(dir, "findings.jsonl")); err == nil {
		for line := range strings.Lines(string(b)) {
			var f finding
			if json.Unmarshal([]byte(line), &f) != nil {
				continue
			}
			if f.At.Before(st.StartedAt) {
				earlier++
			} else {
				findings = append(findings, f)
			}
		}
	}

	running := "NOT RUNNING"
	if pid, err := strconv.Atoi(readTrim(filepath.Join(dir, "watch.pid"))); err == nil && syscall.Kill(pid, 0) == nil && now.Sub(st.UpdatedAt) < 30*time.Second {
		running = fmt.Sprintf("running (pid %d)", pid)
	}
	at := func(t time.Time) string {
		if t.IsZero() {
			return "never"
		}
		return t.Local().Format("01-02 15:04:05") + " (" + ago(now.Sub(t)) + " ago)"
	}
	fmt.Fprintf(out, "watch: %s, started %s, last update %s\n", running, at(st.StartedAt), at(st.UpdatedAt))
	fmt.Fprintf(out, "state: compared %d of %d polls, last %s\n", st.Compared, st.Polls, at(st.LastComparedAt))
	for _, name := range sides {
		s := st.Sides[name]
		if s == nil {
			continue
		}
		ws := "ws disconnected (" + s.WSLastError + ")"
		if s.WSConnected {
			ws = "ws connected since " + at(s.WSConnectedAt)
		}
		fmt.Fprintf(out, "  %-4s %s: %d fetch errors", name, s.URL, s.FetchErrors)
		if s.LastFetchError != "" {
			fmt.Fprintf(out, " (last %s: %s)", at(s.LastFetchErrorAt), s.LastFetchError)
		}
		fmt.Fprintf(out, "; %s, %d connects, %d agent_status\n", ws, s.WSConnects, s.AgentStatus)
	}
	fmt.Fprintf(out, "agent_status: %d transitions matched, %d waiting for the other side\n", st.TransitionsMatched, st.TransitionsPending)

	fmt.Fprintf(out, "\nfindings since the watch started: %d", len(findings))
	if earlier > 0 {
		fmt.Fprintf(out, " (and %d from earlier watches, in findings.jsonl)", earlier)
	}
	fmt.Fprintln(out)
	if n := len(findings) - 50; n > 0 {
		fmt.Fprintf(out, "  (%d older ones in %s)\n", n, filepath.Join(dir, "findings.jsonl"))
		findings = findings[n:]
	}
	for _, f := range findings {
		what, state := f.Path, ""
		if f.Kind == "agent_status" {
			what = "pane " + f.Pane
		} else if o := st.Open[f.Path]; o != nil && o.Counted && o.Since.Equal(f.Since) {
			state = " [still differs]"
		}
		fmt.Fprintf(out, "  %s %s %s: node=%s go=%s (from %s)%s\n", f.At.Local().Format("01-02 15:04:05"), f.Kind, what,
			short(f.Node), short(f.Go), f.Since.Local().Format("15:04:05"), state)
	}

	var pending []string
	for p, o := range st.Open {
		if !o.Counted {
			pending = append(pending, p)
		}
	}
	slices.Sort(pending)
	fmt.Fprintf(out, "differing now, not yet counted: %d\n", len(pending))
	for _, p := range pending[:min(len(pending), 20)] {
		o := st.Open[p]
		fmt.Fprintf(out, "  %s: node=%s go=%s (for %s)\n", p, short(o.Node), short(o.Go), ago(st.UpdatedAt.Sub(o.Since)))
	}
	return nil
}

func readTrim(path string) string {
	b, _ := os.ReadFile(path)
	return strings.TrimSpace(string(b))
}

func short(s string) string {
	if r := []rune(s); len(r) > 80 {
		return string(r[:80]) + "…"
	}
	return s
}

func ago(d time.Duration) string {
	switch d = d.Round(time.Second); {
	case d >= 24*time.Hour:
		return fmt.Sprintf("%dd%dh", d/(24*time.Hour), d%(24*time.Hour)/time.Hour)
	case d >= time.Hour:
		return fmt.Sprintf("%dh%dm", d/time.Hour, d%time.Hour/time.Minute)
	}
	return d.String()
}
