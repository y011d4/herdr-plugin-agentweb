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
	"testing"

	"github.com/y011d4/herdr-plugin-agentweb/tools/fakeherdr"
)

const repoRoot = "../../../.."

// The Go bridge (agentwebctl serve), driven through every REST and WS operation the
// TypeScript one was recorded doing, must send herdr the same requests and answer
// the same (testdata/wire, compared as in testdata/README.md). The CLI operations
// come with the Go CLI (plan P3).
func TestGoBridgeMatchesWireRecordings(t *testing.T) {
	if testing.Short() {
		t.Skip("drives a real bridge for ~30 s")
	}
	if runtime.GOOS != "linux" {
		// recorded on Linux, where the account checks read /proc (elsewhere a clear skips them)
		t.Skip("the recordings and the stand-in agents need Linux /proc")
	}
	// go test caches a pass by the files the test itself looked at, and the build
	// below reads the bridge's sources in another process: stat them here, so a
	// change to any of them reruns this test
	filepath.WalkDir(repoRoot, func(p string, d os.DirEntry, err error) error {
		if d != nil && d.IsDir() && slices.Contains([]string{".git", "node_modules", "dist", "testdata"}, d.Name()) {
			return filepath.SkipDir
		}
		if err == nil && !d.IsDir() {
			os.Stat(p)
		}
		return nil
	})
	bin := filepath.Join(t.TempDir(), "agentwebctl")
	build := exec.Command("go", "build", "-o", bin, "./cmd/agentwebctl")
	build.Dir = repoRoot
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("building agentwebctl (needs `npm run build:web` first): %v\n%s", err, out)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	ln.Close()

	defer func(p, o string, b []string) { port, outDir, bridgeCmd = p, o, b }(port, outDir, bridgeCmd)
	port, outDir, bridgeCmd = p, t.TempDir(), []string{bin, "serve"}
	if err := run(); err != nil {
		t.Fatal(err)
	}

	// the same operations on both sides: none recorded only for one bridge
	ops := func(dir string) (names []string) {
		files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
		for _, f := range files {
			if name := strings.TrimSuffix(filepath.Base(f), ".json"); !strings.HasPrefix(name, "cli-") {
				names = append(names, name)
			}
		}
		return names
	}
	wantOps, gotOps := ops(filepath.Join(repoRoot, "testdata", "wire")), ops(outDir)
	if len(wantOps) == 0 || !slices.Equal(wantOps, gotOps) {
		t.Fatalf("operations recorded:\n TypeScript %v\n Go         %v", wantOps, gotOps)
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

func requests(r record) []string {
	var out []string
	for _, q := range r.Herdr {
		out = append(out, q.Method+" "+canonical(q.Params))
	}
	return out
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
