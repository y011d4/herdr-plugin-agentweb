package bridge

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"slices"
	"testing"
)

// workerSnap is w1 (a plain checkout: tab t1 with p1 and p2), w2 (a linked worktree
// with one pane, p3) and w3 (a linked worktree with two, p4 and p5); agents in the
// panes named.
func workerSnap(withAgent ...string) *State {
	linked := true
	wt := &RawWorktree{RepoKey: "/r/.git", RepoRoot: "/r", IsLinkedWorktree: &linked}
	snap := RawSnapshot{
		Workspaces: []RawWorkspace{{WorkspaceID: "w1"}, {WorkspaceID: "w2", Worktree: wt}, {WorkspaceID: "w3", Worktree: wt}},
		Tabs:       []RawTab{{TabID: "t1", WorkspaceID: "w1"}, {TabID: "t2", WorkspaceID: "w2"}, {TabID: "t3", WorkspaceID: "w3"}, {TabID: "t4", WorkspaceID: "w3"}},
	}
	for _, p := range []struct{ id, tab string }{{"p1", "t1"}, {"p2", "t1"}, {"p3", "t2"}, {"p4", "t3"}, {"p5", "t4"}} {
		pane := RawPane{PaneID: p.id, TabID: p.tab}
		if slices.Contains(withAgent, p.id) {
			pane.Agent = "claude"
		}
		snap.Panes = append(snap.Panes, pane)
	}
	return createState(snap, 0, nil)
}

func TestAgentsGone(t *testing.T) {
	had, gone := agentsGone(nil, workerSnap("p1", "p2"))
	if len(gone) != 0 || !had["p1"] || !had["p2"] || len(had) != 2 {
		t.Fatalf("the first state: %v %v", had, gone)
	}
	// p1's agent exited, p2's pane closed (gone from the state: nothing to close)
	st := workerSnap("p4")
	st.paneOrder = slices.DeleteFunc(st.paneOrder, func(id string) bool { return id == "p2" })
	delete(st.paneByID, "p2")
	if now, gone := agentsGone(had, st); !slices.Equal(gone, []string{"p1"}) || !now["p4"] || len(now) != 1 {
		t.Errorf("%v %v", now, gone)
	}
	// disconnected: nothing is known to have ended, and a reconnect starts afresh
	if now, gone := agentsGone(had, workerSnap().withConnected(false)); now != nil || len(gone) != 0 {
		t.Errorf("disconnected: %v %v", now, gone)
	}
}

func TestCloseFinishedWorker(t *testing.T) {
	st := workerSnap()
	for _, c := range []struct {
		name, pane, info string
		marked, closed   bool
	}{
		{"a worker's idle shell", "p1", `{"shell_pid":10,"foreground_process_group_id":10}`, true, true},
		{"one of two in a worktree", "p4", `{"shell_pid":10,"foreground_process_group_id":10}`, true, true},
		{"not a worker's", "p1", `{"shell_pid":10,"foreground_process_group_id":10}`, false, false},
		{"something runs in the shell", "p1", `{"shell_pid":10,"foreground_process_group_id":11}`, true, false},
		{"no shell pid", "p1", `{"foreground_process_group_id":10}`, true, false},
		{"alone in a worktree's workspace", "p3", `{"shell_pid":10,"foreground_process_group_id":10}`, true, false},
	} {
		var closes []any
		rpc := func(method string, params map[string]any) (json.RawMessage, error) {
			switch method {
			case "pane.process_info":
				return json.RawMessage(`{"process_info":` + c.info + `}`), nil
			case "pane.close":
				closes = append(closes, params["pane_id"])
				return json.RawMessage(`{}`), nil
			}
			return nil, fmt.Errorf("unexpected %s", method)
		}
		closed, err := closeFinishedWorker(rpc, st, c.pane, func(pid int) bool { return c.marked && pid == 10 })
		if err != nil || closed != c.closed || len(closes) != map[bool]int{true: 1}[c.closed] {
			t.Errorf("%s: closed %v, %v, pane.close %v", c.name, closed, err, closes)
		}
	}
}

func TestIsWorker(t *testing.T) {
	needsAccounts(t)
	for env, want := range map[string]bool{workerMark + "=1": true, workerMark + "=10": false, "X" + workerMark + "=1": false, "": false} {
		p := exec.Command("sleep", "30")
		p.Env = []string{env}
		if err := p.Start(); err != nil {
			t.Fatal(err)
		}
		if got := isWorker(p.Process.Pid); got != want {
			t.Errorf("%q: %v", env, got)
		}
		p.Process.Kill()
		p.Wait()
	}
}
