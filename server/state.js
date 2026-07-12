/**
 * Pure state module. No I/O. Takes raw herdr snapshot/events and maintains
 * the normalized State JSON defined in the shared contract.
 *
 * State shape:
 * {
 *   connected: bool,
 *   herdr: { version, protocol },
 *   focused: { workspaceId, tabId, paneId },
 *   workspaces: [{ workspaceId, label, cwd, tabs: [{ tabId, label, panes: [{
 *     paneId, focused, cwd, title, agent: { name, displayName, status,
 *       customStatus, message, sinceUnixMs } | null
 *   }] }] }]
 * }
 */

// Events that indicate pane set has changed and we need to re-snapshot + re-subscribe
export const PANE_SET_CHANGING_EVENTS = new Set([
  'pane_created',
  'pane_closed',
  'pane_moved',
  'pane_exited',
  'workspace_closed',
  'worktree_created',
  'worktree_opened',
  'worktree_removed',
]);

function normalizeAgent(pane, nowMs) {
  if (!pane.agent) return null;
  return {
    name: pane.agent || null,
    displayName: pane.agent || null,
    status: pane.agent_status || 'unknown',
    customStatus: pane.custom_status || null,
    message: pane.agent_message || null,
    sinceUnixMs: nowMs,
  };
}

function normalizePane(pane, nowMs) {
  return {
    paneId: pane.pane_id,
    focused: pane.focused || false,
    cwd: pane.foreground_cwd || pane.cwd || null,
    title: pane.title || null,
    agent: normalizeAgent(pane, nowMs),
  };
}

/**
 * Build normalized State from a raw herdr session.snapshot result.
 * @param {object} snapshot  raw snapshot object (result.snapshot from session.snapshot RPC)
 * @param {number} [nowMs]   timestamp to use for sinceUnixMs (defaults to Date.now())
 * @param {object} [prevState]  previous normalized state; agent sinceUnixMs is
 *   carried over for panes whose status is unchanged, so periodic re-snapshots
 *   (pane set rebuilds) don't reset transition timestamps.
 * @returns {object}  normalized state (connected=true, herdr version set)
 */
export function createState(snapshot, nowMs = Date.now(), prevState = null) {
  const paneList = snapshot.panes || [];
  const tabList = snapshot.tabs || [];
  const workspaceList = snapshot.workspaces || [];

  // index panes by pane_id
  const paneById = new Map();
  for (const p of paneList) {
    const pane = normalizePane(p, nowMs);
    const prev = prevState?._paneById?.get(p.pane_id);
    if (pane.agent && prev?.agent && prev.agent.status === pane.agent.status) {
      pane.agent.sinceUnixMs = prev.agent.sinceUnixMs;
    }
    paneById.set(p.pane_id, pane);
  }

  // index tabs by tab_id
  const tabById = new Map();
  for (const t of tabList) {
    tabById.set(t.tab_id, {
      tabId: t.tab_id,
      label: t.label != null ? String(t.label) : t.tab_id,
      panes: [],
    });
  }

  // assign panes to their tabs preserving snapshot order
  for (const p of paneList) {
    const tab = tabById.get(p.tab_id);
    if (tab) {
      tab.panes.push(paneById.get(p.pane_id));
    }
  }

  // build workspaces; tabs listed in workspaces order
  const workspaces = workspaceList.map(ws => {
    const wsTabs = tabList
      .filter(t => t.workspace_id === ws.workspace_id)
      .map(t => tabById.get(t.tab_id))
      .filter(Boolean);

    // find a representative cwd from the focused pane in the active tab
    let cwd = null;
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
 * agent status changes.
 *
 * @param {object} state   current normalized state (from createState or prior applyEvent)
 * @param {string} eventName  underscore_form event name
 * @param {object} data    event data payload
 * @param {number} [nowMs]
 * @returns {{ state: object, changes: Array<{paneId, from, to, agent}> }}
 */
export function applyEvent(state, eventName, data, nowMs = Date.now()) {
  const changes = [];

  // Accept both herdr event name forms (dot and underscore).
  switch (eventName.replaceAll('.', '_')) {
    case 'pane_agent_status_changed': {
      const paneId = data.pane_id;
      const pane = state._paneById.get(paneId);
      if (!pane) break;

      const from = pane.agent?.status || 'unknown';
      const to = data.agent_status || 'unknown';

      if (from !== to) {
        // Merge optional fields present in the event payload so agents that start
        // after the initial snapshot get their name/displayName/customStatus filled in.
        const existingAgent = pane.agent ?? { name: null, displayName: null, status: 'unknown', customStatus: null, message: null, sinceUnixMs: nowMs };
        const updatedAgent = {
          ...existingAgent,
          status: to,
          sinceUnixMs: nowMs,
          ...(data.agent != null       && { name: data.agent }),
          ...(data.display_agent != null || data.agent != null
            ? { displayName: data.display_agent ?? data.agent ?? existingAgent.displayName }
            : {}),
          ...(data.custom_status != null && { customStatus: data.custom_status }),
        };
        const updated = {
          ...pane,
          ...(data.title != null && { title: data.title }),
          agent: updatedAgent,
        };
        state._paneById.set(paneId, updated);

        // update the pane in its tab
        for (const tab of state._tabById.values()) {
          const idx = tab.panes.findIndex(p => p.paneId === paneId);
          if (idx !== -1) {
            tab.panes = [
              ...tab.panes.slice(0, idx),
              updated,
              ...tab.panes.slice(idx + 1),
            ];
            break;
          }
        }

        changes.push({ paneId, from, to, agent: updated.agent });
      }
      break;
    }

    case 'workspace_focused': {
      state = { ...state, focused: { ...state.focused, workspaceId: data.workspace_id || state.focused.workspaceId } };
      break;
    }

    case 'tab_focused': {
      state = { ...state, focused: { ...state.focused, tabId: data.tab_id || state.focused.tabId } };
      break;
    }

    case 'pane_focused': {
      const newFocusedId = data.pane_id;
      // update focused flag on panes
      for (const [id, pane] of state._paneById) {
        const shouldBeFocused = id === newFocusedId;
        if (pane.focused !== shouldBeFocused) {
          state._paneById.set(id, { ...pane, focused: shouldBeFocused });
        }
      }
      for (const tab of state._tabById.values()) {
        tab.panes = tab.panes.map(p => ({ ...p, focused: p.paneId === newFocusedId }));
      }
      state = { ...state, focused: { ...state.focused, paneId: newFocusedId } };
      break;
    }

    case 'workspace_renamed': {
      state = {
        ...state,
        workspaces: state.workspaces.map(ws =>
          ws.workspaceId === data.workspace_id
            ? { ...ws, label: data.label || ws.label }
            : ws
        ),
      };
      break;
    }

    case 'tab_renamed': {
      const tab = state._tabById.get(data.tab_id);
      if (tab) {
        state._tabById.set(data.tab_id, { ...tab, label: data.label || tab.label });
      }
      break;
    }

    default:
      // unknown or pane-set-changing events — caller handles re-snapshot
      break;
  }

  // rebuild workspaces array from current tab/pane index state
  const rebuildWorkspaces = state.workspaces.map(ws => ({
    ...ws,
    tabs: ws.tabs.map(t => state._tabById.get(t.tabId) || t),
  }));

  const nextState = { ...state, workspaces: rebuildWorkspaces };
  return { state: nextState, changes };
}

/**
 * Return a client-safe copy of state (strips internal index fields).
 */
export function toClientState(state) {
  const { _paneById, _tabById, ...safe } = state;
  return safe;
}

/**
 * Collect all pane IDs currently tracked in state.
 */
export function getPaneIds(state) {
  return [...state._paneById.keys()];
}
