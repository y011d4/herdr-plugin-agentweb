package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDifferingByPathIgnoringSinceUnixMs(t *testing.T) {
	node := `{"connected":true,"workspaces":[{"worktree":{"branch":"main"},"tabs":[]},{"tabs":[{"panes":[{"agent":{"status":"done","sinceUnixMs":1,"completionSeq":4}}]}]}]}`
	goState := `{"connected":true,"workspaces":[{"worktree":{"branch":null},"tabs":[]},{"tabs":[{"panes":[{"agent":{"status":"done","sinceUnixMs":2,"completionSeq":4,"extra":[]}}]}]}]}`
	got, err := differing([]byte(node), []byte(goState))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][2]string{
		"workspaces[0].worktree.branch":              {`"main"`, "null"},
		"workspaces[1].tabs[0].panes[0].agent.extra": {absent, "[]"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if d, _ := differing([]byte(`{"a":[]}`), []byte(`{"a":null}`)); len(d) != 1 {
		t.Fatalf("[] vs null: %v", d)
	}
	if _, err := differing([]byte(`{`), []byte(`{}`)); err == nil {
		t.Fatal("broken JSON compared")
	}
}

func TestStateDifferencesCountOnlyOnceTheyLast(t *testing.T) {
	t0 := time.Now()
	tr := stateTracker{hold: 70 * time.Second, open: map[string]*openDiff{}}
	d := map[string][2]string{"a": {"1", "2"}}
	at := func(s int) time.Time { return t0.Add(time.Duration(s) * time.Second) }

	if f := tr.observe(at(0), d); len(f) != 0 {
		t.Fatal("counted at once")
	}
	if f := tr.observe(at(69), map[string][2]string{"a": {"1", "3"}}); len(f) != 0 {
		t.Fatal("counted before 70 s")
	}
	f := tr.observe(at(70), map[string][2]string{"a": {"1", "4"}}) // a new value, the same path: still one run
	if len(f) != 1 || f[0].Path != "a" || !f[0].Since.Equal(at(0)) || f[0].Go != "4" {
		t.Fatalf("at 70 s: %+v", f)
	}
	if f := tr.observe(at(100), d); len(f) != 0 {
		t.Fatal("counted twice")
	}
	tr.observe(at(105), nil) // equal again: the run ends
	if len(tr.open) != 0 {
		t.Fatal("still open")
	}
	tr.observe(at(110), d)
	if f := tr.observe(at(150), d); len(f) != 0 {
		t.Fatal("a new run counted before its own 70 s")
	}
}

func TestAgentStatusMatchedPerPane(t *testing.T) {
	t0 := time.Now()
	m := statusMatcher{hold: 70 * time.Second, queue: map[string]*[2][]transition{}}
	m.connected(0, true)
	m.connected(1, true)

	// the same transitions, interleaved across panes and sides
	for _, e := range []struct {
		side       int
		pane, step string
	}{{0, "p1", "idle→working"}, {0, "p2", "idle→working"}, {1, "p2", "idle→working"}, {0, "p1", "working→done"}, {1, "p1", "idle→working"}, {1, "p1", "working→done"}} {
		if f := m.add(e.side, e.pane, e.step, t0); len(f) != 0 {
			t.Fatalf("%+v: %+v", e, f)
		}
	}
	if m.matched != 3 || m.pending() != 0 {
		t.Fatalf("matched %d, pending %d", m.matched, m.pending())
	}

	// a pane whose next transitions differ
	m.add(0, "p1", "done→idle", t0)
	f := m.add(1, "p1", "done→working", t0)
	if len(f) != 1 || f[0].Pane != "p1" || f[0].Node != "done→idle" || f[0].Go != "done→working" {
		t.Fatalf("mismatch: %+v", f)
	}

	// one side never pushes it
	m.add(0, "p3", "working→blocked", t0)
	if f := m.expire(t0.Add(69 * time.Second)); len(f) != 0 {
		t.Fatal("expired early")
	}
	f = m.expire(t0.Add(70 * time.Second))
	if len(f) != 1 || f[0].Node != "working→blocked" || f[0].Go != "" || m.pending() != 0 {
		t.Fatalf("missing on go: %+v", f)
	}

	// while one side is down nothing queues, and a reconnect drops what was pending
	m.add(1, "p4", "idle→working", t0)
	m.connected(0, false)
	m.add(1, "p5", "idle→working", t0)
	if m.pending() != 0 {
		t.Fatal("queued while node was down")
	}
	m.connected(0, true)
	if m.pending() != 0 || len(m.expire(t0.Add(time.Hour))) != 0 {
		t.Fatal("counted across a disconnect")
	}
}

func TestReport(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	since := now.Add(-2 * time.Minute)
	st := status{StartedAt: now.Add(-time.Hour), UpdatedAt: now, Polls: 720, Compared: 719, LastComparedAt: now,
		Sides: map[string]*sideStatus{"node": {URL: "http://127.0.0.1:8390", WSConnected: true}, "go": {URL: "http://127.0.0.1:8391"}},
		Open: map[string]*openDiff{
			"workspaces[0].worktree.branch": {Since: since, Node: `"main"`, Go: "null", Counted: true},
			"connected":                     {Since: now.Add(-10 * time.Second), Node: "true", Go: "false"},
		}}
	b, _ := json.Marshal(st)
	os.WriteFile(filepath.Join(dir, "status.json"), b, 0o600)
	f, _ := json.Marshal(finding{At: since.Add(70 * time.Second), Kind: "state", Path: "workspaces[0].worktree.branch", Since: since, Node: `"main"`, Go: "null"})
	old, _ := json.Marshal(finding{At: st.StartedAt.Add(-time.Minute), Kind: "agent_status", Pane: "p9", Since: st.StartedAt.Add(-2 * time.Minute)})
	os.WriteFile(filepath.Join(dir, "findings.jsonl"), append(append(old, '\n'), append(f, '\n')...), 0o600)
	os.WriteFile(filepath.Join(dir, "watch.pid"), []byte("999999999"), 0o600)

	var out strings.Builder
	if err := report(&out, dir, now); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"watch: NOT RUNNING", "compared 719 of 720", "findings since the watch started: 1 (and 1 from earlier watches",
		`state workspaces[0].worktree.branch: node="main" go=null`, "[still differs]",
		"not yet counted: 1", "connected: node=true go=false (for 10s)"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("no %q in:\n%s", want, out.String())
		}
	}
}

func TestAFailedPollBreaksTheRun(t *testing.T) {
	w := newWatcher(t.TempDir(), [2]side{}, 30*time.Second, 70*time.Second) // a gap over 90 s breaks a run
	a, b := []byte(`{"x":1}`), []byte(`{"x":2}`)
	t0 := time.Now()
	w.compare(t0, [2][]byte{a, b}, [2]error{})
	w.compare(t0.Add(35*time.Second), [2][]byte{a, nil}, [2]error{nil, errors.New("down")})
	w.compare(t0.Add(70*time.Second), [2][]byte{a, b}, [2]error{})
	if w.st.Findings != 0 {
		t.Fatal("counted across a poll that compared nothing")
	}
	w.compare(t0.Add(100*time.Second), [2][]byte{a, []byte(`{`)}, [2]error{}) // undecodable counts as a failure too
	w.compare(t0.Add(110*time.Second), [2][]byte{a, b}, [2]error{})
	w.compare(t0.Add(180*time.Second), [2][]byte{a, b}, [2]error{})
	if w.st.Findings != 1 || w.st.Sides["go"].FetchErrors != 1 || w.st.Compared != 4 || w.st.Polls != 6 {
		t.Fatalf("%+v", w.st)
	}

	// no comparison for 120 s (a paused watch): the run since 110 s breaks, and a new
	// one is counted once it lasts
	w.compare(t0.Add(300*time.Second), [2][]byte{a, b}, [2]error{})
	w.compare(t0.Add(370*time.Second), [2][]byte{a, b}, [2]error{})
	if w.st.Findings != 2 {
		t.Fatal("a run continued across a gap")
	}
}

func TestShadowConfig(t *testing.T) {
	for _, c := range []struct{ name, in, want string }{
		{"orchestrators get the dir Node uses, a set dir stays, blank counts as unset",
			`{"port":8390,"notify_url":"https://ntfy.sh/x","public_url":"https://p","launch_profiles":{},"orchestrators":[{"name":"a","env":{"K":"v"}},{"name":"b","dir":"~/x"},{"name":"c","dir":"  "},"junk"]}`,
			`{"launch_profiles":{},"orchestrators":[{"dir":"/D/orchestrators/a","env":{"K":"v"},"name":"a"},{"dir":"~/x","name":"b"},{"dir":"/D/orchestrators/c","name":"c"},"junk"],"port":8391}`},
		{"no valid entry: the legacy dispatcher", `{"orchestrators":[{"name":"bad name"},{"name":1}]}`,
			`{"orchestrator_dir":"/D/dispatcher","orchestrators":[{"name":"bad name"},{"name":1}],"port":8391}`},
		{"blank as JavaScript trims: U+FEFF is, U+0085 is not", `{"orchestrators":[{"name":"a","dir":"\ufeff"},{"name":"b","dir":"\u0085"}]}`,
			`{"orchestrators":[{"dir":"/D/orchestrators/a","name":"a"},{"dir":"\u0085","name":"b"}],"port":8391}`},
		{"a blank orchestrator_dir is unset", `{"orchestrators":[],"orchestrator_dir":" "}`,
			`{"orchestrator_dir":"/D/dispatcher","orchestrators":[],"port":8391}`},
		{"a set orchestrator_dir stays", `{"orchestrator_dir":"~/mine"}`, `{"orchestrator_dir":"~/mine","port":8391}`},
	} {
		var cfg map[string]any
		json.Unmarshal([]byte(c.in), &cfg)
		got, _ := json.Marshal(shadowConfig(cfg, "/D", true))
		var g, w any // decoded, so an escape in want (\u0085) equals the character
		json.Unmarshal(got, &g)
		json.Unmarshal([]byte(c.want), &w)
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%s:\n got %s\nwant %s", c.name, got, c.want)
		}
	}
	got, _ := json.Marshal(shadowConfig(map[string]any{}, "/D", false))
	if want := `{"orchestrator_dir":"/D/orchestrators/default","port":8391}`; string(got) != want {
		t.Errorf("no dispatcher: got %s", got)
	}
}
