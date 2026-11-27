package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/y011d4/herdr-yoicks/tools/fakeherdr"
)

const repoRoot = "../../../.."

// The Go yoicks (its bridge, `serve`, and its CLI commands), driven through every
// operation recorded in testdata/wire (first from the TypeScript bridge), must send
// herdr the same requests and answer, print and exit the same (compared as in
// testdata/README.md).
func TestGoMatchesWireRecordings(t *testing.T) {
	if testing.Short() {
		t.Skip("drives real bridges for ~5 s")
	}
	if runtime.GOOS != "linux" {
		// recorded on Linux, where the account checks read /proc (elsewhere a clear skips them)
		t.Skip("the recordings and the stand-in agents need Linux /proc")
	}
	t.Parallel() // beside TestGoLifecycleCommands: their own dirs, ports and fake herdrs
	bin := buildYoicks(t)
	defer func(p, o, b string, e func(string) (int, bool)) { port, outDir, goBin, expected = p, o, b, e }(port, outDir, goBin, expected)
	port, outDir, goBin = freePort(t), t.TempDir(), bin
	expected = func(op string) (int, bool) {
		r, err := loadRecord(filepath.Join(repoRoot, "testdata", "wire", op+".json"))
		return len(r.Herdr), err == nil
	}
	if err := run(); err != nil {
		t.Fatal(err)
	}

	// the same operations on both sides: none recorded for one only
	ops := func(dir string) (names []string) {
		files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
		for _, f := range files {
			names = append(names, strings.TrimSuffix(filepath.Base(f), ".json"))
		}
		return names
	}
	wantOps, gotOps := ops(filepath.Join(repoRoot, "testdata", "wire")), ops(outDir)
	if len(wantOps) == 0 || !slices.Equal(wantOps, gotOps) {
		t.Fatalf("operations recorded:\n testdata %v\n this build %v", wantOps, gotOps)
	}
	for _, name := range wantOps {
		t.Run(name, func(t *testing.T) {
			want, err := loadRecord(filepath.Join(repoRoot, "testdata", "wire", name+".json"))
			if err != nil {
				t.Fatal(err)
			}
			got, err := loadRecord(filepath.Join(outDir, name+".json"))
			if err != nil {
				t.Fatal(err)
			}
			for _, d := range compareRecords(want, got) {
				t.Error(d)
			}
		})
	}
}

func TestMain(m *testing.M) {
	code := m.Run()
	if yoicksDir != "" {
		os.RemoveAll(yoicksDir)
	}
	os.Exit(code)
}

// the Go yoicks, built once for the package into yoicksDir (TestMain removes it)
var (
	yoicksOnce sync.Once
	yoicksDir  string
	yoicksErr  error
)

// buildYoicks builds the Go yoicks (named yoicks: the CLI knows a bridge by that name).
func buildYoicks(t *testing.T) string {
	t.Helper()
	yoicksOnce.Do(func() {
		// go test caches a pass by the files the test itself looked at, and the build
		// below reads the sources in another process: stat them here, so a change to any
		// of them reruns the test
		filepath.WalkDir(repoRoot, func(p string, d os.DirEntry, err error) error {
			if d != nil && d.IsDir() && slices.Contains([]string{".git", "node_modules", "dist", "testdata"}, d.Name()) {
				return filepath.SkipDir
			}
			if err == nil && !d.IsDir() {
				os.Stat(p)
			}
			return nil
		})
		if yoicksDir, yoicksErr = os.MkdirTemp("", "record-wire-yoicks"); yoicksErr != nil {
			return
		}
		build := exec.Command("go", "build", "-o", filepath.Join(yoicksDir, "yoicks"), "./cmd/yoicks")
		build.Dir = repoRoot
		if out, err := build.CombinedOutput(); err != nil {
			yoicksErr = fmt.Errorf("%v\n%s", err, out)
		}
	})
	if yoicksErr != nil {
		t.Fatalf("building yoicks: %v", yoicksErr)
	}
	return filepath.Join(yoicksDir, "yoicks")
}

func freePort(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	return p
}

func loadRecord(path string) (record, error) {
	var r record
	b, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(b, &r)
	}
	return r, err
}

// canonical is JSON re-encoded with sorted keys, so key order doesn't count.
func canonical(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return string(raw)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

// requests is r's herdr requests in order, except that a run of the same method (a
// fan-out, sent concurrently) is sorted.
func requests(r record) []string {
	var out []string
	start := 0
	for i, q := range r.Herdr {
		if i > 0 && q.Method != r.Herdr[i-1].Method {
			slices.Sort(out[start:])
			start = i
		}
		out = append(out, q.Method+" "+canonical(q.Params))
	}
	slices.Sort(out[start:])
	return out
}

// tsUsage: the recordings taken from the TypeScript CLI name it yoicks.js in
// usage lines; the Go one says yoicks.
var tsUsage = strings.NewReplacer("yoicks.js", "yoicks")

// beforeEnvironment is status output up to its troubleshooting lines.
func beforeEnvironment(stdout string) string {
	if i := strings.Index(stdout, "yoicks "); i >= 0 {
		return stdout[:i]
	}
	return stdout
}

func distinct(xs []string) []string {
	var out []string
	for _, x := range xs {
		if !slices.Contains(out, x) {
			out = append(out, x)
		}
	}
	slices.Sort(out)
	return out
}

// compareRecords lists how got differs from want: the HTTP exchange (JSON compared
// as values), the WS messages sent (in order) and received (as a set), and the herdr
// requests, in order except for the WS watches, which poll on a timer and so are
// compared as the set of distinct requests.
func compareRecords(want, got record) []string {
	var diffs []string
	differ := func(what string, w, g any) {
		diffs = append(diffs, fmt.Sprintf("%s:\n want %v\n  got %v", what, w, g))
	}
	switch {
	case (want.HTTP == nil) != (got.HTTP == nil):
		differ("http", want.HTTP, got.HTTP)
	case want.HTTP != nil:
		w, g := *want.HTTP, *got.HTTP
		if w.Method != g.Method || w.Path != g.Path || canonical(w.Body) != canonical(g.Body) {
			differ("request", w.Method+" "+w.Path+" "+canonical(w.Body), g.Method+" "+g.Path+" "+canonical(g.Body))
		}
		if w.Status != g.Status || canonical(w.Response) != canonical(g.Response) {
			differ("response", fmt.Sprint(w.Status, " ", canonical(w.Response)), fmt.Sprint(g.Status, " ", canonical(g.Response)))
		}
	}
	switch {
	case (want.CLI == nil) != (got.CLI == nil):
		differ("cli", want.CLI, got.CLI)
	case want.CLI != nil:
		w, g := *want.CLI, *got.CLI
		if !slices.Equal(w.Args, g.Args) || w.Exit != g.Exit {
			differ("command and exit", fmt.Sprint(w.Args, " → ", w.Exit), fmt.Sprint(g.Args, " → ", g.Exit))
		}
		wantStdout, gotStdout := w.Stdout, g.Stdout
		if len(g.Args) > 0 && g.Args[0] == "status" {
			// status ends with troubleshooting lines (version, herdr, optional commands;
			// printEnvironment in cli.go) that depend on the machine, and that the
			// TypeScript recordings lack
			wantStdout, gotStdout = beforeEnvironment(wantStdout), beforeEnvironment(gotStdout)
		}
		if ws := tsUsage.Replace(wantStdout); ws != gotStdout {
			differ("stdout", fmt.Sprintf("%q", ws), fmt.Sprintf("%q", gotStdout))
		}
		if ws := tsUsage.Replace(w.Stderr); ws != g.Stderr {
			differ("stderr", fmt.Sprintf("%q", ws), fmt.Sprintf("%q", g.Stderr))
		}
	}
	if !slices.Equal(want.HerdrCLI, got.HerdrCLI) {
		differ("herdr/gh CLI calls", want.HerdrCLI, got.HerdrCLI)
	}
	split := func(msgs []string) (sent, received []string) {
		for _, m := range msgs {
			if s, ok := strings.CutPrefix(m, "> "); ok {
				sent = append(sent, s)
			} else {
				received = append(received, canonical(json.RawMessage(m)))
			}
		}
		return sent, distinct(received)
	}
	ws, wr := split(want.WS)
	gs, gr := split(got.WS)
	if !slices.Equal(ws, gs) {
		differ("ws sent", ws, gs)
	}
	if !slices.Equal(wr, gr) {
		differ("ws received", wr, gr)
	}
	wq, gq := requests(want), requests(got)
	if got.CLI != nil && len(got.CLI.Args) > 0 && got.CLI.Args[0] == "status" {
		isPing := func(r string) bool { return strings.HasPrefix(r, "ping ") }
		wq, gq = slices.DeleteFunc(wq, isPing), slices.DeleteFunc(gq, isPing)
	}
	if strings.HasPrefix(want.Op, "ws-") {
		wq, gq = distinct(wq), distinct(gq)
	}
	if !slices.Equal(wq, gq) {
		differ("herdr requests", strings.Join(wq, "\n      "), strings.Join(gq, "\n      "))
	}
	return diffs
}

func TestCompareRecordsCatchesDifferences(t *testing.T) {
	base := func() record {
		return record{Op: "x",
			HTTP:  &httpCall{Method: "POST", Path: "/api/x", Status: 200, Response: json.RawMessage(`{"ok":true,"a":1}`)},
			Herdr: []fakeherdr.Request{{Method: "pane.read", Params: json.RawMessage(`{"pane_id":"p1","lines":2}`)}}}
	}
	same := base()
	same.HTTP.Response = json.RawMessage(`{"a":1,"ok":true}`) // key order doesn't count
	same.Herdr[0].Params = json.RawMessage(`{"lines":2,"pane_id":"p1"}`)
	if d := compareRecords(base(), same); len(d) != 0 {
		t.Errorf("equal records differ: %v", d)
	}
	for name, change := range map[string]func(*record){
		"status":   func(r *record) { r.HTTP.Status = 400 },
		"response": func(r *record) { r.HTTP.Response = json.RawMessage(`{"ok":true,"a":2}`) },
		"params":   func(r *record) { r.Herdr[0].Params = json.RawMessage(`{"pane_id":"p2","lines":2}`) },
		"extra request": func(r *record) {
			r.Herdr = append(r.Herdr, fakeherdr.Request{Method: "pane.get"})
		},
		"ws message": func(r *record) { r.WS = []string{`{"type":"pong"}`} },
	} {
		got := base()
		change(&got)
		if len(compareRecords(base(), got)) == 0 {
			t.Errorf("%s: a difference went unnoticed", name)
		}
	}
}

func TestCompareRecordsCatchesCLIDifferences(t *testing.T) {
	base := func() record {
		return record{Op: "cli-x",
			CLI:      &cliCall{Args: []string{"agent"}, Exit: 2, Stderr: "usage: yoicks.js agent …\n"},
			HerdrCLI: []string{"herdr agent get p1"},
			Herdr: []fakeherdr.Request{{Method: "agent.list"},
				{Method: "pane.process_info", Params: json.RawMessage(`{"pane_id":"p1"}`)},
				{Method: "pane.process_info", Params: json.RawMessage(`{"pane_id":"p5"}`)}}}
	}
	same := base()
	same.CLI.Stderr = "usage: yoicks agent …\n"                 // the Go CLI's name
	same.Herdr[1], same.Herdr[2] = same.Herdr[2], same.Herdr[1] // a fan-out in another order
	if d := compareRecords(base(), same); len(d) != 0 {
		t.Errorf("equal records differ: %v", d)
	}
	for name, change := range map[string]func(*record){
		"exit":      func(r *record) { r.CLI.Exit = 1 },
		"stderr":    func(r *record) { r.CLI.Stderr = "usage: yoicks agent\n" },
		"stdout":    func(r *record) { r.CLI.Stdout = "x\n" },
		"herdr cli": func(r *record) { r.HerdrCLI = []string{"herdr agent get w-named"} },
		"no cli":    func(r *record) { r.CLI = nil },
		"order across methods": func(r *record) {
			r.Herdr[0], r.Herdr[1] = r.Herdr[1], r.Herdr[0]
		},
	} {
		got := base()
		change(&got)
		if len(compareRecords(base(), got)) == 0 {
			t.Errorf("%s: a difference went unnoticed", name)
		}
	}
}
