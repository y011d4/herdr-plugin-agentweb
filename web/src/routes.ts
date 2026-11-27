/**
 * routes.ts — what a hash shows, decided from the State alone (pure; ui/App.tsx renders it):
 *   #/agents         the list; #/agents/<name> one orchestrator's account's agents
 *   #/home/<name>    an orchestrator's Home, running or stopped (Start); #/home opens the default one
 *   #/pane/<id>      a pane, in a drawer over the screen it came from (an orchestrator's pane opens as its Home)
 *   #/settings
 * An empty hash (a fresh open) goes to the default Home once a State exists.
 */
import type { AppState, OrchestratorView } from './types.ts';

export type Route =
  | { kind: 'redirect'; hash: string; replace: boolean }
  | { kind: 'loading' } // a Home before the first State: the first State re-routes
  | { kind: 'home'; name: string; paneId: string | null } // null: stopped
  | { kind: 'agents' }
  | { kind: 'pane'; paneId: string }
  | { kind: 'settings' };

const orchestrators = (state: AppState | null): OrchestratorView[] => state?.orchestrators ?? [];

export const homeHash = (name: string): string => `#/home/${encodeURIComponent(name)}`;
export const isAgentsRoute = (hash: string): boolean => hash === '#/agents' || hash.startsWith('#/agents/');
// From a Home (#/home/<name>), the agents list is #/agents/<name>: just that orchestrator's account's agents.
export const homeAgentsHash = (hash: string): string => hash.replace(/^#\/home\//, '#/agents/');

/** The orchestrator a pane is: its pane, or a headless one's hl:<name> (stopped too: a late link opens its Home). */
export function orchestratorOfPane(state: AppState | null, paneId: string | null): OrchestratorView | undefined {
  return paneId === null ? undefined : orchestrators(state).find((o) => o.paneId === paneId || (o.mode === 'headless' && paneId === `hl:${o.name}`));
}

/** The orchestrator a #/home/<name> or #/agents/<name> route names. */
export function homeOf(hash: string, state: AppState | null): OrchestratorView | undefined {
  let name: string;
  try {
    name = decodeURIComponent(hash.replace(/^#\/(?:home|agents)\//, ''));
  } catch {
    return undefined;
  }
  return orchestrators(state).find((o) => o.name === name);
}

/** The Home to open by default: the one last opened here (`lastHome`), running or not, else the
 *  first running one, else the first configured. */
export function defaultHome(state: AppState | null, lastHome: string | null): OrchestratorView | undefined {
  const all = orchestrators(state);
  return all.find((o) => o.name === lastHome) ?? all.find((o) => o.paneId) ?? all[0];
}

/** The list #/agents/<name> shows: that orchestrator's account (undefined: every agent). */
export const agentsScope = (hash: string, state: AppState | null): OrchestratorView | undefined =>
  hash.startsWith('#/agents/') ? homeOf(hash, state) : undefined;

// An orchestrator's pane opens as its Home; every other pane as its own view.
export function paneRoute(state: AppState | null, paneId: string): string {
  const o = orchestratorOfPane(state, paneId);
  return o ? homeHash(o.name) : `#/pane/${encodeURIComponent(paneId)}`;
}

/** The screen under a pane's drawer after arriving from `fromHash`: a Home or an account's list it came
 *  from; pane → pane keeps it; else (a fresh open, Settings) the list. */
export function nextPaneBackRoute(fromHash: string | null, prev: string): string {
  if (fromHash?.startsWith('#/home/') || fromHash?.startsWith('#/agents/')) return fromHash;
  return fromHash?.startsWith('#/pane/') ? prev : '#/agents';
}

/** Whether the drawer's history entry sits right on its screen's (`base`), so a close can go back to it:
 *  opened from that screen; pane → pane (a replace) keeps it; else (a fresh open, a reload) not. */
export function nextPaneOverBase(fromHash: string | null, base: string, prev: boolean): boolean {
  if (fromHash === base) return true;
  return fromHash?.startsWith('#/pane/') ? prev : false;
}

/** Settings' Back after arriving from `fromHash`: the Home or list it was opened from, else the list.
 *  No hash change (a re-render, a reload on #/settings) keeps `prev`. */
export function nextSettingsBackRoute(fromHash: string | null, prev: string): string {
  if (fromHash === null) return prev;
  return fromHash.startsWith('#/home/') || fromHash.startsWith('#/agents') ? fromHash : '#/agents';
}

export function resolveRoute(hash: string, state: AppState | null, lastHome: string | null): Route {
  // Opening the app without a route (the PWA's start_url) lands on the default Home (a stopped
  // one shows Start), replaced so the empty-hash entry stays out of history.
  if (!hash && state) {
    const home = defaultHome(state, lastHome);
    return { kind: 'redirect', hash: home ? homeHash(home.name) : '#/agents', replace: true };
  }
  const h = hash || '#/agents';
  if (h === '#/home' && state) {
    // no name (older links): the default Home
    const home = defaultHome(state, lastHome);
    return { kind: 'redirect', hash: home ? homeHash(home.name) : '#/agents', replace: true };
  }
  if (h === '#/home' || h.startsWith('#/home/')) {
    if (!state) return { kind: 'loading' };
    const o = homeOf(h, state);
    return o ? { kind: 'home', name: o.name, paneId: o.paneId } : { kind: 'redirect', hash: '#/agents', replace: false };
  }
  if (isAgentsRoute(h) || h === '#/') return { kind: 'agents' };
  if (h.startsWith('#/pane/')) {
    let paneId: string;
    try {
      paneId = decodeURIComponent(h.slice('#/pane/'.length));
    } catch {
      return { kind: 'redirect', hash: '#/agents', replace: false }; // malformed pane hash — don't break routing
    }
    // an orchestrator always opens as its Home (notification clicks, stale links, …)
    const o = orchestratorOfPane(state, paneId);
    return o ? { kind: 'redirect', hash: homeHash(o.name), replace: true } : { kind: 'pane', paneId };
  }
  if (h === '#/settings') return { kind: 'settings' };
  return { kind: 'redirect', hash: '#/agents', replace: false };
}
