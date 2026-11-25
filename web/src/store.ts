/**
 * store.ts — the app's shared state: the last State, the WebSocket link, what is on
 * screen (`view`) and the done panes seen on this phone. Plain module state, mutated in
 * place (`store.view` is never replaced); emit() tells subscribers something changed.
 */
import { markSeen } from './dashboard-group.ts';
import type { SeenDone } from './dashboard-group.ts';
import type { AppState } from './types.ts';

const STORAGE_SEEN = 'herdr_seen_done'; // done panes already opened on this phone (SeenDone)

export interface View {
  /** what #screen shows */
  screen: 'loading' | 'token' | 'agents' | 'pane' | 'settings';
  /** the pane on screen (a pane view or a Home), else null */
  activePaneId: string | null;
  /** the pane on screen is an orchestrator's Home (#/home/<name>) */
  homeMode: boolean;
  paneViewMode: 'terminal' | 'chat';
  /** where a pane's Back goes: Home or an account's list when it was opened from there, else the list */
  paneBackRoute: string;
}

export const store: { appState: AppState | null; wsConnected: boolean; view: View; seenDone: SeenDone } = {
  appState: null,
  wsConnected: false,
  view: { screen: 'loading', activePaneId: null, homeMode: false, paneViewMode: 'terminal', paneBackRoute: '#/agents' },
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

/** A new State (null: signed out), with an emit(); app.ts's onStateUpdate stays its caller's job. */
export function setAppState(state: AppState | null): void {
  store.appState = state;
  emit();
}

/** Records a done pane as seen on this phone (see SeenDone). */
export function markPaneSeen(paneId: string): void {
  store.seenDone = markSeen(store.seenDone, store.appState?.workspaces ?? [], paneId);
  // best-effort: a storage failure must not stop the pane view from rendering
  try { localStorage.setItem(STORAGE_SEEN, JSON.stringify(store.seenDone)); } catch { /* memory-only */ }
}
