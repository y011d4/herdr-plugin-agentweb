package bridge

// Pure state module, a port of server/state.ts: no I/O. Builds the normalized State
// from a herdr snapshot and applies events to it. Nothing here modifies its input:
// applyEvent and applyCompletionSeqs return new states that share the unchanged
// nodes (copy-on-write).

import (
	"strings"
	"time"
)

// paneSetChangingEvents change the workspace/tab/pane structure: the client
// re-fetches the snapshot and re-subscribes (per-pane status subscriptions must
// track the pane set). Every subscribed lifecycle event is either here or in
// appliedEvents (the routing test checks it).
var paneSetChangingEvents = map[string]bool{
	"pane_created": true, "pane_closed": true, "pane_moved": true, "pane_exited": true,
	// an agent appeared in / left an existing pane: status events carry no cwd, and a
	// shell may have cd-ed before launching, so re-snapshot (cwd, launchCwd, presence)
	"pane_agent_detected": true,
	"workspace_created":   true, "workspace_updated": true, "workspace_moved": true, "workspace_closed": true,
	"tab_created": true, "tab_closed": true, "tab_moved": true,
	"worktree_created": true, "worktree_opened": true, "worktree_removed": true,
}

// appliedEvents are applied in place by applyEvent (no re-snapshot).
var appliedEvents = map[string]bool{
	"pane_agent_status_changed": true,
	"workspace_focused":         true, "tab_focused": true, "pane_focused": true,
	"workspace_renamed": true, "tab_renamed": true,
}

func nowMs() int64 { return time.Now().UnixMilli() }

// statusOf is an agent's status, "unknown" for none (`agent?.status ?? 'unknown'`).
func statusOf(a *AgentInfo) string {
	if a == nil || a.Status == "" {
		return "unknown"
	}
	return a.Status
}

func normalizeAgent(p RawPane, now int64) *AgentInfo {
	if p.Agent == "" {
		return nil
	}
	return &AgentInfo{
		Name:         strp(p.Agent),
		DisplayName:  strp(firstNonEmpty(p.DisplayAgent, p.Agent)),
		Status:       firstNonEmpty(p.AgentStatus, "unknown"),
		CustomStatus: strp(p.CustomStatus),
		// snapshots carry no message; only events fill it in
		Message:     strp(p.AgentMessage),
		SinceUnixMs: now,
		// completionSeq and stateChangeSeq are not in snapshots: applyCompletionSeqs
	}
}

func normalizeWorktree(ws RawWorkspace) *WorktreeInfo {
	wt := ws.Worktree
	// a workspace has worktree context only when herdr resolved a repo for it;
	// repo_key is the grouping identity, so its absence means none
	if wt == nil || wt.RepoKey == "" {
		return nil
	}
	return &WorktreeInfo{
		RepoKey:          wt.RepoKey,
		RepoName:         wt.RepoName,
		RepoRoot:         wt.RepoRoot,
		CheckoutPath:     wt.CheckoutPath,
		IsLinkedWorktree: wt.IsLinkedWorktree != nil && *wt.IsLinkedWorktree,
		// herdr has no branch; worktree-resolve fills it in from git
	}
}

func normalizePane(p RawPane, now int64) *PaneNode {
	return &PaneNode{
		PaneID:    p.PaneID,
		Focused:   p.Focused,
		Cwd:       strp(firstNonEmpty(p.ForegroundCwd, p.Cwd)),
		LaunchCwd: strp(p.Cwd),
		Title:     strp(p.Title),
		Agent:     normalizeAgent(p, now),
	}
}

// createState builds the State from a snapshot (result.snapshot of session.snapshot).
// An agent whose status is unchanged since prev keeps its sinceUnixMs and seqs, so
// re-snapshots (pane-set rebuilds) don't reset transition times.
func createState(snap RawSnapshot, now int64, prev *State) *State {
	s := &State{paneByID: map[string]*PaneNode{}, tabByID: map[string]*TabNode{}}
	for _, p := range snap.Panes {
		pane := normalizePane(p, now)
		if prev != nil {
			if pp := prev.paneByID[p.PaneID]; pane.Agent != nil && pp != nil && pp.Agent != nil {
				pane.Agent.HerdrName = pp.Agent.HerdrName // agent.list's, until it says otherwise
				if pp.Agent.Status == pane.Agent.Status {
					pane.Agent.SinceUnixMs = pp.Agent.SinceUnixMs
					pane.Agent.CompletionSeq = pp.Agent.CompletionSeq
					pane.Agent.StateChangeSeq = pp.Agent.StateChangeSeq
				}
			}
		}
		if _, dup := s.paneByID[p.PaneID]; !dup {
			s.paneOrder = append(s.paneOrder, p.PaneID)
		}
		s.paneByID[p.PaneID] = pane
	}
	for _, t := range snap.Tabs {
		s.tabByID[t.TabID] = &TabNode{TabID: t.TabID, Label: t.LabelOr(t.TabID), Panes: []*PaneNode{}}
	}
	// panes into their tabs, in snapshot order
	for _, p := range snap.Panes {
		if tab := s.tabByID[p.TabID]; tab != nil {
			if pane := s.paneByID[p.PaneID]; pane != nil {
				tab.Panes = append(tab.Panes, pane)
			}
		}
	}
	s.Workspaces = []*WorkspaceNode{}
	for _, ws := range snap.Workspaces {
		tabs := []*TabNode{}
		for _, t := range snap.Tabs {
			if t.WorkspaceID == ws.WorkspaceID {
				if tab := s.tabByID[t.TabID]; tab != nil {
					tabs = append(tabs, tab)
				}
			}
		}
		// a representative cwd: the focused pane of the active tab, else its first
		var cwd *string
		if ws.ActiveTabID != "" {
			if active := s.tabByID[ws.ActiveTabID]; active != nil {
				var pick *PaneNode
				for _, p := range active.Panes {
					if p.Focused {
						pick = p
						break
					}
				}
				if pick == nil && len(active.Panes) > 0 {
					pick = active.Panes[0]
				}
				if pick != nil && pick.Cwd != nil {
					cwd = pick.Cwd
				}
			}
		}
		s.Workspaces = append(s.Workspaces, &WorkspaceNode{
			WorkspaceID: ws.WorkspaceID,
			Label:       firstNonEmpty(ws.Label, ws.WorkspaceID),
			Cwd:         cwd,
			Worktree:    normalizeWorktree(ws),
			Tabs:        tabs,
		})
	}
	s.Connected = true
	s.Herdr = HerdrInfo{Version: strp(snap.Version)}
	if snap.Protocol != 0 {
		v := snap.Protocol
		s.Herdr.Protocol = &v
	}
	s.Focused = Focus{
		WorkspaceID: strp(snap.FocusedWorkspaceID),
		TabID:       strp(snap.FocusedTabID),
		PaneID:      strp(snap.FocusedPaneID),
	}
	return s
}

func str(data map[string]any, key string) (string, bool) {
	v, ok := data[key].(string)
	return v, ok
}

// applyEvent applies a herdr event (dot or underscore name) and returns the new
// state and any agent status changes. s is not modified.
func applyEvent(s *State, name string, data map[string]any, now int64) (*State, []StatusChange) {
	var changes []StatusChange
	paneByID := make(map[string]*PaneNode, len(s.paneByID))
	for k, v := range s.paneByID {
		paneByID[k] = v
	}
	// tabs are copied (with their pane slices) because their panes may be replaced
	tabByID := make(map[string]*TabNode, len(s.tabByID))
	for k, t := range s.tabByID {
		c := *t
		c.Panes = append(make([]*PaneNode, 0, len(t.Panes)), t.Panes...) // [] stays [] in the json
		tabByID[k] = &c
	}
	focused := s.Focused
	workspaces := s.Workspaces

	replacePaneInTab := func(updated *PaneNode) {
		for _, tab := range tabByID {
			for i, p := range tab.Panes {
				if p.PaneID == updated.PaneID {
					tab.Panes[i] = updated
					return
				}
			}
		}
	}

	switch strings.ReplaceAll(name, ".", "_") {
	case "pane_agent_status_changed":
		paneID, _ := str(data, "pane_id")
		pane := paneByID[paneID]
		if pane == nil {
			break
		}
		from := statusOf(pane.Agent)
		to, _ := str(data, "agent_status")
		if to == "" {
			to = "unknown"
		}
		if from == to {
			break
		}
		// optional fields in the event fill in agents that started after the snapshot
		agent := &AgentInfo{Status: "unknown", SinceUnixMs: now}
		if pane.Agent != nil {
			c := *pane.Agent
			agent = &c
		}
		agent.Status, agent.SinceUnixMs = to, now
		agent.CompletionSeq, agent.StateChangeSeq = nil, nil // a new status; agent.list fills them in
		if v, ok := str(data, "agent"); ok {
			agent.Name = &v
		}
		if da, ok := str(data, "display_agent"); ok {
			agent.DisplayName = &da
		} else if v, ok := str(data, "agent"); ok {
			agent.DisplayName = &v
		}
		if v, ok := str(data, "custom_status"); ok {
			agent.CustomStatus = &v
		}
		updated := *pane
		if v, ok := str(data, "title"); ok {
			updated.Title = &v
		}
		updated.Agent = agent
		paneByID[paneID] = &updated
		replacePaneInTab(&updated)
		changes = append(changes, StatusChange{PaneID: paneID, From: from, To: to, Agent: agent})

	case "workspace_focused":
		if v, _ := str(data, "workspace_id"); v != "" {
			focused.WorkspaceID = &v
		}

	case "tab_focused":
		if v, _ := str(data, "tab_id"); v != "" {
			focused.TabID = &v
		}

	case "pane_focused":
		newID, _ := str(data, "pane_id")
		for id, p := range paneByID {
			if should := id == newID; p.Focused != should {
				u := *p
				u.Focused = should
				paneByID[id] = &u
				replacePaneInTab(&u)
			}
		}
		focused.PaneID = strp(newID)

	case "workspace_renamed":
		wsID, _ := str(data, "workspace_id")
		label, _ := str(data, "label")
		next := make([]*WorkspaceNode, len(workspaces))
		for i, ws := range workspaces {
			next[i] = ws
			if ws.WorkspaceID == wsID && label != "" {
				c := *ws
				c.Label = label
				next[i] = &c
			}
		}
		workspaces = next

	case "tab_renamed":
		tabID, _ := str(data, "tab_id")
		if tab := tabByID[tabID]; tab != nil {
			if label, _ := str(data, "label"); label != "" {
				tab.Label = label // tab is already this event's own copy
			}
		}
	}

	return &State{
		Connected: s.Connected, Herdr: s.Herdr, Focused: focused,
		Workspaces: rebuildWorkspaces(workspaces, tabByID),
		paneByID:   paneByID, paneOrder: s.paneOrder, tabByID: tabByID,
	}, changes
}

// rebuildWorkspaces points each workspace at the current version of its tabs.
func rebuildWorkspaces(workspaces []*WorkspaceNode, tabByID map[string]*TabNode) []*WorkspaceNode {
	out := make([]*WorkspaceNode, len(workspaces))
	for i, ws := range workspaces {
		c := *ws
		c.Tabs = make([]*TabNode, len(ws.Tabs))
		for j, t := range ws.Tabs {
			if cur := tabByID[t.TabID]; cur != nil {
				c.Tabs[j] = cur
			} else {
				c.Tabs[j] = t
			}
		}
		out[i] = &c
	}
	return out
}

// applyCompletionSeqs fills in each agent's completionSeq and stateChangeSeq, and its herdr
// name, from herdr's agent.list (the only place herdr reports them). The seqs only where the
// pane's status matches the reply and hasn't changed since the request went out
// (requestedAt): after done -> working -> done mid-request the reply would carry
// the previous completion's seq. The name whatever the status. Returns s itself when
// nothing changed.
func applyCompletionSeqs(s *State, agents []RawAgentSeqs, requestedAt int64) *State {
	paneByID := make(map[string]*PaneNode, len(s.paneByID))
	for k, v := range s.paneByID {
		paneByID[k] = v
	}
	changed := false
	for _, a := range agents {
		pane := paneByID[a.PaneID]
		if pane == nil || pane.Agent == nil {
			continue
		}
		ag := pane.Agent
		seqs := ag.Status == a.AgentStatus && ag.SinceUnixMs < requestedAt &&
			!(eqSeq(ag.CompletionSeq, a.CompletionSeq) && eqSeq(ag.StateChangeSeq, a.StateChangeSeq))
		name := a.Name != "" && (ag.HerdrName == nil || *ag.HerdrName != a.Name)
		if !seqs && !name {
			continue
		}
		u := *pane
		na := *ag
		if seqs {
			na.CompletionSeq, na.StateChangeSeq = copySeq(a.CompletionSeq), copySeq(a.StateChangeSeq) // not the reply's own pointers
		}
		if name {
			na.HerdrName = strp(a.Name)
		}
		u.Agent = &na
		paneByID[a.PaneID] = &u
		changed = true
	}
	if !changed {
		return s
	}
	tabByID := make(map[string]*TabNode, len(s.tabByID))
	for k, t := range s.tabByID {
		c := *t
		c.Panes = make([]*PaneNode, len(t.Panes))
		for i, p := range t.Panes {
			if cur := paneByID[p.PaneID]; cur != nil {
				c.Panes[i] = cur
			} else {
				c.Panes[i] = p
			}
		}
		tabByID[k] = &c
	}
	return &State{
		Connected: s.Connected, Herdr: s.Herdr, Focused: s.Focused,
		Workspaces: rebuildWorkspaces(s.Workspaces, tabByID),
		paneByID:   paneByID, paneOrder: s.paneOrder, tabByID: tabByID,
	}
}

func copySeq(p *int64) *int64 {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func eqSeq(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// findOrchestrators finds each orchestrator's pane: the first agent pane launched in
// its dir (or below). herdr's snapshot has no agent names, so the launch dir (the
// shell's cwd, not the mutable foreground cwd) is the identity; with nested dirs the
// deepest wins. Given each agent pane's account (nil value: unknown), each also lists
// the agent panes of its own account (itself included), or null when its account
// isn't known. A headless one has no pane (clientState fills in its child).
func findOrchestrators(s *State, defs []OrchestratorDef, accounts map[string]*string) []OrchestratorView {
	paneIDs := make([]*string, len(defs))
	for _, ws := range s.Workspaces {
		for _, tab := range ws.Tabs {
			for _, pane := range tab.Panes {
				if pane.Agent == nil || pane.LaunchCwd == nil {
					continue
				}
				cwd := *pane.LaunchCwd
				best := -1
				for i, d := range defs {
					if d.Mode == "headless" { // runs as the bridge's child, never in a pane
						continue
					}
					if (cwd == d.Dir || strings.HasPrefix(cwd, d.Dir+"/")) && (best == -1 || len(d.Dir) > len(defs[best].Dir)) {
						best = i
					}
				}
				if best != -1 && paneIDs[best] == nil {
					id := pane.PaneID
					paneIDs[best] = &id
				}
			}
		}
	}
	views := make([]OrchestratorView, len(defs))
	for i, d := range defs {
		var account *string
		if paneIDs[i] != nil && accounts != nil {
			account = accounts[*paneIDs[i]]
		}
		var agents []string // null: its account isn't known
		if account != nil && *account != "" {
			agents = agentsOfAccount(s, accounts, *account)
		}
		views[i] = OrchestratorView{Name: d.Name, Label: d.Label, PaneID: paneIDs[i], Agents: agents, Mode: firstNonEmpty(d.Mode, "tui")}
	}
	return views
}

// agentsOfAccount lists the agent panes of account (never null), in pane order.
func agentsOfAccount(s *State, accounts map[string]*string, account string) []string {
	agents := []string{}
	for _, id := range s.paneOrder {
		if a := accounts[id]; s.paneByID[id].Agent != nil && a != nil && *a == account {
			agents = append(agents, id)
		}
	}
	return agents
}
