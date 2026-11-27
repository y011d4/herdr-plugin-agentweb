package bridge

// Closing the panes of finished workers. herdr can't close a pane when its agent
// exits (agent.start types the agent's command into an idle shell, and no API takes a
// close-on-exit), so a worker that ended (an orchestrator's /exit, or one that exited
// on its own) left its tab behind with an idle shell.
//
// startOwnAgent marks the shell of each tab or workspace it opens for a worker with
// workerMark in herdr's tab.create/workspace.create env. Once a pane that had an agent
// has none, the bridge closes it when its shell carries the mark and is back in the
// foreground: the agent's process is gone, not just its hooks' report. Nothing else is
// marked: panes the user opens, the orchestrators' own (startOrchestrator), the phone's
// New agent, and a new worktree's root pane (worktree.create takes no env), which
// worktree_remove closes with its workspace. A marked pane alone in a linked worktree's
// workspace stays too: closing it would close the workspace, and worktree_remove needs
// that open.

import (
	"context"
	"os/exec"
	"strconv"
	"time"
)

const workerMark = "YOICKS_WORKER"

// agentsGone is the panes of st with an agent (nil when st isn't connected, so a
// reconnect starts afresh: what changed meanwhile is unknown), and those of had that
// st still has, without an agent. had nil = nothing seen yet.
func agentsGone(had map[string]bool, st *State) (now map[string]bool, gone []string) {
	if st.Connected {
		now = map[string]bool{}
	}
	for _, id := range st.paneOrder {
		if st.paneByID[id].Agent != nil {
			if now != nil {
				now[id] = true
			}
		} else if had[id] && now != nil {
			gone = append(gone, id)
		}
	}
	return now, gone
}

// closeFinishedWorker closes paneID, whose agent st no longer shows, when it is a
// worker's pane (marked: its shell's environment has workerMark) with its shell back
// in the foreground; true when it closed it.
func closeFinishedWorker(rpc Rpc, st *State, paneID string, marked func(pid int) bool) (bool, error) {
	if soleWorktreePane(st, paneID) {
		return false, nil
	}
	fg, shell, err := paneProcessInfo(rpc, paneID)
	if err != nil || shell == 0 || fg != shell || !marked(shell) {
		return false, err
	}
	if _, err := rpc("pane.close", map[string]any{"pane_id": paneID}); err != nil {
		return false, err
	}
	return true, nil
}

// soleWorktreePane is whether paneID is the only pane of a linked worktree's workspace.
func soleWorktreePane(st *State, paneID string) bool {
	for _, ws := range st.Workspaces {
		n, in := 0, false
		for _, t := range ws.Tabs {
			for _, p := range t.Panes {
				n++
				in = in || p.PaneID == paneID
			}
		}
		if in {
			return ws.Worktree != nil && ws.Worktree.IsLinkedWorktree && n == 1
		}
	}
	return false
}

// isWorker is whether process pid started with workerMark set, read by grep like
// projectsRootForPid, so no other variable is held.
func isWorker(pid int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "grep", "-qzxF", workerMark+"=1", "/proc/"+strconv.Itoa(pid)+"/environ").Run() == nil
}
