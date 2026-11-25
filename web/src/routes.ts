/**
 * routes.ts — what a hash shows, decided from the State alone (pure; app.ts renders it):
 *   #/agents         the list; #/agents/<name> one orchestrator's account's agents
 *   #/home/<name>    an orchestrator's Home; #/home opens the default one
 *   #/pane/<id>      a pane (an orchestrator's pane opens as its Home)
 *   #/settings
 * An empty hash (a fresh open) goes to the default Home, else the list, once a State exists.
 */
import type { AppState, OrchestratorView } from './types.ts';

export type Route =
  | { kind: 'redirect'; hash: string; replace: boolean }
  | { kind: 'loading' } // a Home before the first State: the first State re-routes
  | { kind: 'home'; name: string; paneId: string }
  | { kind: 'agents' }
  | { kind: 'pane'; paneId: string }
  | { kind: 'settings' };

const orchestrators = (state: AppState | null): OrchestratorView[] => state?.orchestrators ?? [];

export const homeHash = (name: string): string => `#/home/${encodeURIComponent(name)}`;
export const isAgentsRoute = (hash: string): boolean => hash === '#/agents' || hash.startsWith('#/agents/');
// From a Home (#/home/<name>), the agents list is #/agents/<name>: just that orchestrator's account's agents.
export const homeAgentsHash = (hash: string): string => hash.replace(/^#\/home\//, '#/agents/');

export function orchestratorOfPane(state: AppState | null, paneId: string | null): OrchestratorView | undefined {
  return paneId === null ? undefined : orchestrators(state).find((o) => o.paneId === paneId);
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

/** The Home to open by default: the one last opened here (`lastHome`) while it runs, else the first running one. */
export function defaultHome(state: AppState | null, lastHome: string | null): OrchestratorView | undefined {
  const running = orchestrators(state).filter((o) => o.paneId);
  return running.find((o) => o.name === lastHome) ?? running[0];
}

/** The list #/agents/<name> shows: that orchestrator's account (undefined: every agent). */
export const agentsScope = (hash: string, state: AppState | null): OrchestratorView | undefined =>
  hash.startsWith('#/agents/') ? homeOf(hash, state) : undefined;

// An orchestrator's pane opens as its Home; every other pane as its own view.
export function paneRoute(state: AppState | null, paneId: string): string {
  const o = orchestratorOfPane(state, paneId);
  return o ? homeHash(o.name) : `#/pane/${encodeURIComponent(paneId)}`;
}

// Where to go when the open pane goes away: the list it came from (an account's included).
export const paneGoneRoute = (view: { homeMode: boolean; paneBackRoute: string }): string =>
  (!view.homeMode && view.paneBackRoute.startsWith('#/agents/') ? view.paneBackRoute : '#/agents');

/** A pane's Back after arriving from `fromHash`: a Home or an account's list it came from; pane → pane keeps it. */
export function nextPaneBackRoute(fromHash: string | null, prev: string): string {
  if (fromHash?.startsWith('#/home/') || fromHash?.startsWith('#/agents/')) return fromHash;
  return fromHash?.startsWith('#/pane/') ? prev : '#/agents';
}

export function resolveRoute(hash: string, state: AppState | null, lastHome: string | null): Route {
  // Opening the app without a route (the PWA's start_url) lands on an orchestrator's
  // chat when one is running, and on the agents list otherwise. Replaced either way, so
  // an orchestrator that starts later never yanks the user off the list.
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
    return o?.paneId ? { kind: 'home', name: o.name, paneId: o.paneId } : { kind: 'redirect', hash: '#/agents', replace: false };
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
