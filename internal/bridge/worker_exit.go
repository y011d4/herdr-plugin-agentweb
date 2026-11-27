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
// worktree_remove closes with its workspace. The last pane of a linked worktree's
// workspace stays too: closing it would close the workspace, and worktree_remove needs
// that open.

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"time"
)

const workerMark = "YOICKS_WORKER"

// how many times a finished worker's shell is looked at, waitAfterExit apart, before
// it is left as it is: an agent's hooks can report its end before its process is gone
const (
	exitChecks    = 10
	waitAfterExit = 500 * time.Millisecond
)

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

// closeFinishedWorker closes paneID (in st, without its agent) when it is a worker's
// pane (marked: its shell's environment has workerMark) whose shell is back in the
// foreground within exitChecks looks (wait between them), unless it is its linked
// worktree workspace's last pane; true when it closed it. Callers run one at a time,
// so two closing in one workspace can't both see the other's pane.
func closeFinishedWorker(rpc Rpc, st *State, paneID string, marked func(pid int) bool, wait func()) (bool, error) {
	ws := ""
	for _, w := range st.Workspaces {
		for _, t := range w.Tabs {
			for _, p := range t.Panes {
				if p.PaneID == paneID {
					ws = w.WorkspaceID
				}
			}
		}
	}
	if ws == "" {
		return false, nil
	}
	var fg, shell int
	var err error
	for i := 0; ; i++ {
		if fg, shell, err = paneProcessInfo(rpc, paneID); err == nil && shell != 0 {
			if !marked(shell) {
				return false, nil
			}
			if fg == shell {
				break
			}
		}
		if herdrCode(err) == "pane_not_found" || i == exitChecks-1 {
			return false, err
		}
		wait()
	}
	raw, err := rpc("workspace.get", map[string]any{"workspace_id": ws})
	if err != nil {
		return false, err
	}
	var got struct {
		Workspace struct {
			PaneCount int `json:"pane_count"`
			Worktree  *struct {
				IsLinkedWorktree bool `json:"is_linked_worktree"`
			} `json:"worktree"`
		} `json:"workspace"`
	}
	json.Unmarshal(raw, &got)
	if w := got.Workspace; w.Worktree != nil && w.Worktree.IsLinkedWorktree && w.PaneCount <= 1 {
		return false, nil
	}
	if _, err := rpc("pane.close", map[string]any{"pane_id": paneID}); err != nil {
		return false, err
	}
	return true, nil
}

// isWorker is whether process pid started with workerMark set, read by grep like
// projectsRootForPid, so no other variable is held.
func isWorker(pid int) bool {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "grep", "-qzxF", workerMark+"=1", "/proc/"+strconv.Itoa(pid)+"/environ").Run() == nil
}
