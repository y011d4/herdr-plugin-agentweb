package fakeherdr

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// call sends one request and reads its answer (the error code, or the result's agent status).
func call(t *testing.T, conn net.Conn, method string, params map[string]any) (code, status string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"id": "1", "method": method, "params": params})
	conn.Write(append(b, '\n'))
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return "closed", ""
	}
	var m struct {
		Result struct {
			Agent struct {
				Status string `json:"agent_status"`
			} `json:"agent"`
		} `json:"result"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	json.Unmarshal(line, &m)
	if m.Error != nil {
		return m.Error.Code, ""
	}
	return "", m.Result.Agent.Status
}

func startWorld(t *testing.T) (*World, *Server, func() net.Conn) {
	t.Helper()
	dir, _ := os.MkdirTemp("", "fh")
	t.Cleanup(func() { os.RemoveAll(dir) })
	w := NewWorld()
	w.Add(Pane{ID: "w1", Tab: "t9", Workspace: "w1", Agent: "claude", Status: "idle", Name: "w1"})
	s, err := Start(filepath.Join(dir, "h.sock"), w.Handler())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return w, s, func() net.Conn {
		c, err := net.Dial("unix", s.Path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
}

func (w *World) held() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.watchers)
}

func waitHeld(t *testing.T, w *World, n int) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); w.held() != n; time.Sleep(5 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("%d held waits, want %d", w.held(), n)
		}
	}
}

// Every change reaches a wait, however quick: blocked then working at once still answers blocked.
func TestWorldWaitSeesEveryChange(t *testing.T) {
	w, _, dial := startWorld(t)
	got := make(chan string, 1)
	go func() {
		_, st := call(t, dial(), "agent.wait", map[string]any{"target": "w1", "until": []string{"blocked"}})
		got <- st
	}()
	waitHeld(t, w, 1)
	w.Set("w1", "blocked")
	w.Set("w1", "working")
	if st := <-got; st != "blocked" {
		t.Errorf("got %q", st)
	}
}

// agent.prompt's wait needs a working or blocked after the delivery: done then idle without
// one is agent_prompt_stalled; working then done answers done.
func TestWorldPromptWaitIsEdge(t *testing.T) {
	w, _, dial := startWorld(t)
	w.StallAfter(300 * time.Millisecond)
	wait := map[string]any{"until": []string{"done", "idle", "blocked"}}
	w.OnPrompt(func(pane, _ string) { w.Set(pane, "done"); w.Set(pane, "idle") })
	if code, _ := call(t, dial(), "agent.prompt", map[string]any{"target": "w1", "text": "x", "wait": wait}); code != "agent_prompt_stalled" {
		t.Errorf("no working: %q", code)
	}
	w.OnPrompt(func(pane, _ string) { w.Set(pane, "working"); w.Set(pane, "done") })
	if code, st := call(t, dial(), "agent.prompt", map[string]any{"target": "w1", "text": "x", "wait": wait}); code != "" || st != "done" {
		t.Errorf("working then done: %q %q", code, st)
	}
}

// A held wait lasts until it matches or the client leaves (no limit of its own), and a pane
// that goes answers not_found.
func TestWorldWaitHeldUntilTheClientLeaves(t *testing.T) {
	w, _, dial := startWorld(t)
	c := dial()
	go call(t, c, "agent.wait", map[string]any{"target": "w1", "until": []string{"done"}})
	waitHeld(t, w, 1)
	c.Close()
	waitHeld(t, w, 0)

	got := make(chan string, 1)
	go func() {
		code, _ := call(t, dial(), "agent.wait", map[string]any{"target": "w1", "until": []string{"done"}})
		got <- code
	}()
	waitHeld(t, w, 1)
	w.Remove("w1")
	if code := <-got; code != "not_found" {
		t.Errorf("removed: %q", code)
	}
}

// A prompt without a wait answers from the pane as it was, even if the worker's script
// removes the pane at once.
func TestWorldPromptWithoutWaitOutlivesItsPane(t *testing.T) {
	w, _, dial := startWorld(t)
	w.OnPrompt(func(pane, _ string) { w.Remove(pane) })
	for range 20 {
		if code, st := call(t, dial(), "agent.prompt", map[string]any{"target": "w1", "text": "x"}); code != "" || st != "idle" {
			t.Fatalf("%q %q", code, st)
		}
		for end := time.Now().Add(5 * time.Second); ; time.Sleep(time.Millisecond) {
			w.mu.Lock()
			gone := w.find("w1") == nil
			w.mu.Unlock()
			if gone {
				break
			}
			if time.Now().After(end) {
				t.Fatal("the script never removed it")
			}
		}
		w.Add(Pane{ID: "w1", Tab: "t9", Workspace: "w1", Agent: "claude", Status: "idle", Name: "w1"})
	}
}
