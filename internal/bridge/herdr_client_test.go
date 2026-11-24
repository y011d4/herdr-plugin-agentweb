package bridge

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/y011d4/herdr-plugin-agentweb/tools/fakeherdr"
)

func TestMain(m *testing.M) {
	logf = log.New(io.Discard, "", 0).Printf
	os.Exit(m.Run())
}

// Every fakeherdr scenario, run against this client, must report what the
// TypeScript client reported in testdata/scenarios (recorded with
// tools/fakeherdr/cmd/record-scenarios).
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
			conn := s.Connected
			add(fakeherdr.Output{Kind: "state", Connected: &conn, Panes: summarize(s)})
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

func summarize(s *State) map[string]*fakeherdr.PaneAgent {
	m := map[string]*fakeherdr.PaneAgent{}
	for _, id := range s.order {
		a := s.panes[id]
		if a == nil {
			m[id] = nil
			continue
		}
		m[id] = &fakeherdr.PaneAgent{Status: a.Status, Seq: a.CompletionSeq, ChangeSeq: a.StateChangeSeq}
	}
	return m
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
