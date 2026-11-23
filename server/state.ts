/**
 * Pure state module. No I/O. Takes raw herdr snapshot/events and maintains
 * the normalized State JSON defined in the shared contract.
 *
 * createState and applyEvent never mutate their inputs; applyEvent returns a
 * new state built with copy-on-write internal indexes.
 *
 * State shape:
 * {
 *   connected: bool,
 *   herdr: { version, protocol },
 *   focused: { workspaceId, tabId, paneId },
 *   workspaces: [{ workspaceId, label, cwd,
 *     worktree: { repoKey, repoName, repoRoot, checkoutPath, isLinkedWorktree } | null,
 *     tabs: [{ tabId, label, panes: [{
 *     paneId, focused, cwd, title, agent: { name, displayName, status,
 *       customStatus, message, sinceUnixMs, completionSeq } | null
 *   }] }] }]
 * }
 */

import type { NormalizedState, PaneNode, TabNode, WorkspaceNode, WorktreeInfo, AgentInfo, StatusChange, RawSnapshot, RawPane, RawWorkspace, OrchestratorDef, OrchestratorView } from './types.ts';

// Events that change the workspace/tab/pane structure. The client reacts by
// re-fetching session.snapshot and re-subscribing (per-pane status
// subscriptions must track the pane set). Every subscribed lifecycle event
// must be either in this set or handled by applyEvent — see the routing test.
export const PANE_SET_CHANGING_EVENTS = new Set([
  'pane_created',
  'pane_closed',
  'pane_moved',
  'pane_exited',
  // An agent appeared in / left an existing pane. Status events carry no cwd, and a
  // shell may have `cd`-ed before launching, so re-snapshot: cwd/launchCwd
  // (orchestrator identity, git branch) and agent presence stay current.
  'pane_agent_detected',
  'workspace_created',
  'workspace_updated',
  'workspace_moved',
  'workspace_closed',
  'tab_created',
  'tab_closed',
  'tab_moved',
  'worktree_created',
  'worktree_opened',
  'worktree_removed',
]);

// Events applyEvent updates in place (no re-snapshot needed).
export const APPLIED_EVENTS = new Set([
  'pane_agent_status_changed',
  'workspace_focused',
  'tab_focused',
  'pane_focused',
  'workspace_renamed',
  'tab_renamed',
]);

function normalizeAgent(pane: RawPane, nowMs: number): AgentInfo | null {
  if (!pane.agent) return null;
  return {
    name: pane.agent || null,
    displayName: pane.display_agent || pane.agent || null,
    status: (pane.agent_status as AgentInfo['status']) || 'unknown',
    customStatus: pane.custom_status || null,
    // snapshots don't carry a message field; populated only via events when present
    message: pane.agent_message || null,
    sinceUnixMs: nowMs,
    completionSeq: null, // not in snapshots; filled from agent.list (applyCompletionSeqs)
    stateChangeSeq: null, // likewise
  };
}

function normalizeWorktree(ws: RawWorkspace): WorktreeInfo | null {
  const wt = ws.worktree;
  // A workspace carries worktree context only when herdr resolved a repo for it;
  // repo_key is the grouping identity, so treat its absence as "no worktree info".
  if (!wt || !wt.repo_key) return null;
  return {
    repoKey: wt.repo_key,
    repoName: wt.repo_name || '',
    repoRoot: wt.repo_root || '',
    checkoutPath: wt.checkout_path || '',
    isLinkedWorktree: wt.is_linked_worktree ?? false,
    // herdr's snapshot carries no branch; the branch is filled in later from git
    // (worktree-resolve, in the client I/O layer) so state.ts stays pure.
    branch: null,
  };
}

function normalizePane(pane: RawPane, nowMs: number): PaneNode {
  return {
    paneId: pane.pane_id,
    focused: pane.focused || false,
    cwd: pane.foreground_cwd || pane.cwd || null,
    launchCwd: pane.cwd || null,
    title: pane.title || null,
    agent: normalizeAgent(pane, nowMs),
  };
}

/**
 * Build normalized State from a raw herdr session.snapshot result.
 * @param snapshot  raw snapshot object (result.snapshot from session.snapshot RPC)
 * @param nowMs   timestamp to use for sinceUnixMs (defaults to Date.now())
 * @param prevState  previous normalized state; agent sinceUnixMs is
 *   carried over for panes whose status is unchanged, so periodic re-snapshots
 *   (pane set rebuilds) don't reset transition timestamps.
 * @returns  normalized state (connected=true, herdr version set)
 */
export function createState(snapshot: RawSnapshot, nowMs = Date.now(), prevState: NormalizedState | null = null): NormalizedState {
  const paneList = snapshot.panes || [];
  const tabList = snapshot.tabs || [];
  const workspaceList = snapshot.workspaces || [];

  // index panes by pane_id
  const paneById = new Map<string, PaneNode>();
  for (const p of paneList) {
    const pane = normalizePane(p, nowMs);
    const prev = prevState?._paneById?.get(p.pane_id);
    if (pane.agent && prev?.agent && prev.agent.status === pane.agent.status) {
      pane.agent.sinceUnixMs = prev.agent.sinceUnixMs;
      pane.agent.completionSeq = prev.agent.completionSeq;
      pane.agent.stateChangeSeq = prev.agent.stateChangeSeq;
    }
    paneById.set(p.pane_id, pane);
  }

  // index tabs by tab_id
  const tabById = new Map<string, TabNode>();
  for (const t of tabList) {
    tabById.set(t.tab_id, {
      tabId: t.tab_id,
      label: t.label != null ? String(t.label) : t.tab_id,
      panes: [],
    });
  }

  // assign panes to their tabs preserving snapshot order
  for (const p of paneList) {
    const tab = tabById.get(p.tab_id ?? '');
    if (tab) {
      const pane = paneById.get(p.pane_id);
      if (pane) tab.panes.push(pane);
    }
  }

  // build workspaces; tabs listed in workspaces order
  const workspaces: WorkspaceNode[] = workspaceList.map(ws => {
    const wsTabs = tabList
      .filter(t => t.workspace_id === ws.workspace_id)
      .map(t => tabById.get(t.tab_id))
      .filter((t): t is TabNode => t !== undefined);

    // find a representative cwd from the focused pane in the active tab
    let cwd: string | null = null;
    const activeTabId = ws.active_tab_id;
    if (activeTabId) {
      const activeTab = tabById.get(activeTabId);
      if (activeTab) {
        const focusedPane = activeTab.panes.find(p => p.focused);
        cwd = (focusedPane || activeTab.panes[0])?.cwd || null;
      }
    }

    return {
      workspaceId: ws.workspace_id,
      label: ws.label || ws.workspace_id,
      cwd,
      worktree: normalizeWorktree(ws),
      tabs: wsTabs,
    };
  });

  return {
    connected: true,
    herdr: {
      version: snapshot.version || null,
      protocol: snapshot.protocol || null,
    },
    focused: {
      workspaceId: snapshot.focused_workspace_id || null,
      tabId: snapshot.focused_tab_id || null,
      paneId: snapshot.focused_pane_id || null,
    },
    workspaces,
    // internal index for fast event updates (not serialized to clients)
    _paneById: paneById,
    _tabById: tabById,
  };
}

/**
 * Apply a herdr event to the current state and return updated state + any
 * agent status changes. The input state is not mutated.
 *
 * @param state   current normalized state (from createState or prior applyEvent)
 * @param eventName  event name (dot or underscore form)
 * @param data    event data payload
 * @param nowMs
 * @returns { state, changes }
 */
export function applyEvent(state: NormalizedState, eventName: string, data: Record<string, unknown>, nowMs = Date.now()): { state: NormalizedState; changes: StatusChange[] } {
  const changes: StatusChange[] = [];

  // Copy-on-write: clone the internal indexes (and tab objects, whose panes
  // arrays are written below) so callers holding older generations never see
  // them change underneath.
  const paneById = new Map(state._paneById);
  const tabById = new Map<string, TabNode>();
  for (const [id, tab] of state._tabById) {
    tabById.set(id, { ...tab, panes: [...tab.panes] });
  }
  let focused = state.focused;
  let workspaces = state.workspaces;

  const replacePaneInTab = (updated: PaneNode) => {
    for (const tab of tabById.values()) {
      const idx = tab.panes.findIndex(p => p.paneId === updated.paneId);
      if (idx !== -1) {
        tab.panes[idx] = updated;
        break;
      }
    }
  };

  // Accept both herdr event name forms (dot and underscore).
  switch (eventName.replaceAll('.', '_')) {
    case 'pane_agent_status_changed': {
      const paneId = data.pane_id as string;
      const pane = paneById.get(paneId);
      if (!pane) break;

      const from = pane.agent?.status || 'unknown';
      const to = (data.agent_status as string) || 'unknown';

      if (from !== to) {
        // Merge optional fields present in the event payload so agents that start
        // after the initial snapshot get their name/displayName/customStatus filled in.
        const existingAgent: AgentInfo = pane.agent ?? { name: null, displayName: null, status: 'unknown', customStatus: null, message: null, sinceUnixMs: nowMs, completionSeq: null, stateChangeSeq: null };
        const updatedAgent: AgentInfo = {
          ...existingAgent,
          status: to as AgentInfo['status'],
          sinceUnixMs: nowMs,
          completionSeq: null, // a new status; agent.list fills these in again
          stateChangeSeq: null,
          ...(data.agent != null       && { name: data.agent as string }),
          ...(data.display_agent != null || data.agent != null
            ? { displayName: (data.display_agent ?? data.agent ?? existingAgent.displayName) as string | null }
            : {}),
          ...(data.custom_status != null && { customStatus: data.custom_status as string }),
        };
        const updated: PaneNode = {
          ...pane,
          ...(data.title != null && { title: data.title as string }),
          agent: updatedAgent,
        };
        paneById.set(paneId, updated);
        replacePaneInTab(updated);

        changes.push({ paneId, from, to, agent: updatedAgent });
      }
      break;
    }

    case 'workspace_focused': {
      focused = { ...focused, workspaceId: (data.workspace_id as string) || focused.workspaceId };
      break;
    }

    case 'tab_focused': {
      focused = { ...focused, tabId: (data.tab_id as string) || focused.tabId };
      break;
    }

    case 'pane_focused': {
      const newFocusedId = data.pane_id as string;
      for (const [id, pane] of paneById) {
        const shouldBeFocused = id === newFocusedId;
        if (pane.focused !== shouldBeFocused) {
          const updated = { ...pane, focused: shouldBeFocused };
          paneById.set(id, updated);
          replacePaneInTab(updated);
        }
      }
      focused = { ...focused, paneId: newFocusedId };
      break;
    }

    case 'workspace_renamed': {
      workspaces = workspaces.map(ws =>
        ws.workspaceId === data.workspace_id
          ? { ...ws, label: (data.label as string) || ws.label }
          : ws
      );
      break;
    }

    case 'tab_renamed': {
      const tab = tabById.get(data.tab_id as string);
      if (tab) {
        tabById.set(data.tab_id as string, { ...tab, label: (data.label as string) || tab.label });
      }
      break;
    }

    default:
      // unknown or pane-set-changing events — caller handles re-snapshot
      break;
  }

  // rebuild workspaces array against the (possibly updated) tab index
  const rebuiltWorkspaces = workspaces.map(ws => ({
    ...ws,
    tabs: ws.tabs.map(t => tabById.get(t.tabId) || t),
  }));

  const nextState: NormalizedState = {
    ...state,
    focused,
    workspaces: rebuiltWorkspaces,
    _paneById: paneById,
    _tabById: tabById,
  };
  return { state: nextState, changes };
}

/**
 * Fill in each agent's completionSeq and stateChangeSeq from herdr's agent.list.
 * herdr carries them only there (not in snapshots or status events); the phone keys
 * its "seen done" record on the first and orders its lists by the second, as both
 * survive a bridge restart. A pane is updated only if its
 * status matches the reply and hasn't changed since the request went out
 * (`requestedAtMs`): after done -> working -> done mid-request the reply would
 * carry the previous completion's seq (that newer done schedules its own fetch).
 * Per pane, so overlapping requests can't overwrite a newer seq with an older one.
 * Returns the same state when nothing changed.
 */
export function applyCompletionSeqs(
  state: NormalizedState,
  agents: Array<{ pane_id: string; agent_status?: string; completion_seq?: number | null; state_change_seq?: number | null }>,
  requestedAtMs: number,
): NormalizedState {
  const paneById = new Map(state._paneById);
  let changed = false;
  for (const a of agents) {
    const pane = paneById.get(a.pane_id);
    const seq = a.completion_seq ?? null;
    const changeSeq = a.state_change_seq ?? null;
    const agent = pane?.agent;
    if (!agent || agent.status !== a.agent_status || agent.sinceUnixMs >= requestedAtMs) continue;
    if (agent.completionSeq === seq && agent.stateChangeSeq === changeSeq) continue;
    paneById.set(a.pane_id, { ...pane!, agent: { ...agent, completionSeq: seq, stateChangeSeq: changeSeq } });
    changed = true;
  }
  if (!changed) return state;
  const tabById = new Map<string, TabNode>();
  for (const [id, tab] of state._tabById) {
    tabById.set(id, { ...tab, panes: tab.panes.map(p => paneById.get(p.paneId) ?? p) });
  }
  const workspaces = state.workspaces.map(ws => ({ ...ws, tabs: ws.tabs.map(t => tabById.get(t.tabId) ?? t) }));
  return { ...state, workspaces, _paneById: paneById, _tabById: tabById };
}

/**
 * Return a client-safe copy of state (strips internal index fields).
 */
export function toClientState(state: NormalizedState): Omit<NormalizedState, '_paneById' | '_tabById'> {
  const { _paneById: _p, _tabById: _t, ...safe } = state;
  return safe;
}

/**
 * The orchestrators: each one is the first agent pane launched in its `dir` (or
 * below it). The phone opens on their chats (Home) and leaves them out of its agents
 * lists. herdr's snapshot carries no agent names, so the launch dir is the identity —
 * the shell's cwd, not the mutable foreground cwd, so neither an orchestrator
 * wandering off nor another agent wandering in changes which pane it is. A pane
 * under nested dirs belongs to the deepest one only. Given each agent pane's Claude
 * account (`accounts`), each also lists the agents of its own account (itself
 * included), or null when its account isn't known.
 */
export function findOrchestrators(state: NormalizedState, defs: OrchestratorDef[], accounts?: ReadonlyMap<string, string | null>): OrchestratorView[] {
  const paneIds: Array<string | null> = defs.map(() => null);
  for (const ws of state.workspaces) {
    for (const tab of ws.tabs) {
      for (const pane of tab.panes) {
        const cwd = pane.launchCwd;
        if (!pane.agent || !cwd) continue;
        let best = -1;
        defs.forEach((d, i) => {
          if ((cwd === d.dir || cwd.startsWith(d.dir + '/')) && (best === -1 || d.dir.length > defs[best].dir.length)) best = i;
        });
        if (best !== -1) paneIds[best] ??= pane.paneId;
      }
    }
  }
  const agentPanes = getPaneIds(state).filter((id) => state._paneById.get(id)!.agent);
  return defs.map((d, i) => {
    const account = paneIds[i] && accounts?.get(paneIds[i]);
    const agents = account ? agentPanes.filter((id) => accounts!.get(id) === account) : null;
    return { name: d.name, label: d.label, paneId: paneIds[i], agents };
  });
}

/**
 * Collect all pane IDs currently tracked in state.
 */
export function getPaneIds(state: NormalizedState): string[] {
  return [...state._paneById.keys()];
}
