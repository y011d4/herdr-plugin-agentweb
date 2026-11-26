/**
 * store.ts — the app's shared state: the last State, the WebSocket link, what is on
 * screen (`view`), the done panes seen on this phone and the kept first tasks. Plain module
 * state, mutated in place (`store.view` is never replaced); emit() tells subscribers
 * something changed. Also the lookups over it that more than one screen needs.
 */
import { markSeen } from './dashboard-group.ts';
import type { SeenDone } from './dashboard-group.ts';
import { KeptTasks } from './kept-tasks.ts';
import type { AppState } from './types.ts';

const STORAGE_SEEN = 'herdr_seen_done'; // done panes already opened on this phone (SeenDone)
export const STORAGE_HOME = 'herdr_home'; // the orchestrator whose Home was opened last

/** First tasks the bridge couldn't deliver to a just-started agent (New agent keeps them);
 *  each pane's composer keeps its task, with the user's edits, until it is sent. */
export const keptTasks = new KeptTasks();

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
  /** where Settings' Back goes: the Home or list that opened it, else the list */
  settingsBackRoute: string;
}

export const store: {
  appState: AppState | null; wsConnected: boolean; view: View; seenDone: SeenDone;
  /** an orchestrator started from the list (its Start button shows it): its Home opens once the State shows it running */
  startingHome: string | null;
} = {
  appState: null,
  wsConnected: false,
  startingHome: null,
  view: { screen: 'loading', activePaneId: null, homeMode: false, paneViewMode: 'terminal', paneBackRoute: '#/agents', settingsBackRoute: '#/agents' },
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
  emit();
}

export function setStartingHome(name: string | null): void {
  store.startingHome = name;
  emit();
}

/** The orchestrator whose Home was opened last on this phone. */
export function lastHome(): string | null {
  try { return localStorage.getItem(STORAGE_HOME); } catch { return null; }
}

/** A pane of the State, with its workspace and tab. */
export function findPane(paneId: string) {
  if (!store.appState) return null;
  for (const ws of store.appState.workspaces ?? []) {
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
  store.seenDone = markSeen(store.seenDone, store.appState?.workspaces ?? [], paneId);
  // best-effort: a storage failure must not stop the pane view from rendering
  try { localStorage.setItem(STORAGE_SEEN, JSON.stringify(store.seenDone)); } catch { /* memory-only */ }
}
