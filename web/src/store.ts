/**
 * store.ts — the app's shared state: the last State, the WebSocket link, what is on
 * screen (`view`) and the done panes seen on this phone. Plain module
 * state, mutated in place (`store.view` is never replaced); emit() tells subscribers
 * something changed. Also the lookups over it that more than one screen needs.
 */
import { markSeen } from './dashboard-group.ts';
import { pruneDrafts } from './drafts.ts';
import type { SeenDone } from './dashboard-group.ts';
import type { AgentStatus, AppState, PaneNode, WorkspaceNode } from './types.ts';

const STORAGE_SEEN = 'herdr_seen_done'; // done panes already opened on this phone (SeenDone)
export const STORAGE_HOME = 'herdr_home'; // the orchestrator whose Home was opened last

export interface View {
  /** what #screen shows */
  screen: 'loading' | 'token' | 'agents' | 'pane';
  /** the pane on screen (a pane view or a Home), else null */
  activePaneId: string | null;
  /** the pane on screen is an orchestrator's Home (#/home/<name>) */
  homeMode: boolean;
  paneViewMode: 'terminal' | 'chat';
  /** the screen under an overlay (a pane's drawer, Settings): Home or an account's list when it was
   *  opened from there, else the list */
  paneBackRoute: string;
  /** the overlay was opened on top of that screen's history entry here (its close goes back to it) */
  paneOverBase: boolean;
  /** Settings is open: the pane on show (a Home's) is out of sight under it */
  settingsOpen: boolean;
}

export const store: { appState: AppState | null; wsConnected: boolean; view: View; seenDone: SeenDone } = {
  appState: null,
  wsConnected: false,
  view: { screen: 'loading', activePaneId: null, homeMode: false, paneViewMode: 'terminal', paneBackRoute: '#/home', paneOverBase: false, settingsOpen: false },
  seenDone: (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_SEEN) ?? '{}') ?? {}; } catch { return {}; }
  })(),
};

const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emit(): void {
  for (const fn of listeners) fn();
}

/** A new State (null: signed out), with an emit(); the shell's onStateUpdate (ui/App.tsx) stays its caller's job. */
export function setAppState(state: AppState | null): void {
  store.appState = state;
  if (state) pruneDrafts(state);
  emit();
}

/** The orchestrator whose Home was opened last on this phone. */
export function lastHome(): string | null {
  try { return localStorage.getItem(STORAGE_HOME); } catch { return null; }
}

/** A running headless orchestrator (its paneId is hl:<name>) as a pane, the only place one is made:
 *  it has no herdr pane, but the views of a pane (findPane, markPaneSeen) take it like one. Never in
 *  appState.workspaces: the list's "No workspaces found" goes by those. */
function headlessWorkspaces(state: AppState): WorkspaceNode[] {
  return (state.orchestrators ?? []).flatMap((o) => {
    const h = o.headless;
    if (!h || !o.paneId) return [];
    const status: AgentStatus = h.status === 'stopped' || h.status === 'error' ? 'unknown' : h.status;
    const label = o.label || o.name;
    const pane: PaneNode = { paneId: o.paneId, focused: false, cwd: null, launchCwd: null, title: null, agent: { name: 'claude', displayName: label,
      status, sinceUnixMs: 0, completionSeq: h.completionSeq, stateChangeSeq: null, herdrName: null } };
    return [{ workspaceId: o.paneId, label, cwd: null, worktree: null, tabs: [{ tabId: o.paneId, label: '', panes: [pane] }] }];
  });
}

const paneWorkspaces = (state: AppState): WorkspaceNode[] => [...(state.workspaces ?? []), ...headlessWorkspaces(state)];

/** A pane of the State (a running headless orchestrator's too), with its workspace and tab. */
export function findPane(paneId: string) {
  if (!store.appState) return null;
  for (const ws of paneWorkspaces(store.appState)) {
    for (const tab of ws.tabs ?? []) {
      for (const pane of tab.panes ?? []) {
        if (pane.paneId === paneId) return { pane, ws, tab };
      }
    }
  }
  return null;
}

/** Records a done pane as seen on this phone (see SeenDone). */
export function markPaneSeen(paneId: string): void {
  store.seenDone = markSeen(store.seenDone, store.appState ? paneWorkspaces(store.appState) : [], paneId);
  // best-effort: a storage failure must not stop the pane view from rendering
  try { localStorage.setItem(STORAGE_SEEN, JSON.stringify(store.seenDone)); } catch { /* memory-only */ }
}
