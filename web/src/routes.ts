/**
 * routes.ts — what a hash shows, decided from the State alone (pure; ui/App.tsx renders it):
 *   #/home/<name>    an orchestrator's Home, running or stopped (Start); #/home opens the default one
 *   #/pane/<id>      a pane, in a drawer over the screen it came from (an orchestrator's pane opens as its Home)
 *   #/settings       Settings, in front of the screen it came from
 * An empty hash (a fresh open) goes to the default Home once a State exists, and so does a hash that names nothing
 * (#/home: the default Home; an overlay opened with no screen under it closes to it). The agents list's old routes
 * (#/agents, #/agents/<name>) go to the default Home and to that Home.
 */
import type { AppState, OrchestratorView } from './types.ts';

export type Route =
  | { kind: 'redirect'; hash: string; replace: boolean }
  | { kind: 'loading' } // a Home before the first State: the first State re-routes
  | { kind: 'home'; name: string; paneId: string | null } // null: stopped
  | { kind: 'pane'; paneId: string }
  | { kind: 'settings' };

const orchestrators = (state: AppState | null): OrchestratorView[] => state?.orchestrators ?? [];

export const homeHash = (name: string): string => `#/home/${encodeURIComponent(name)}`;

/** The orchestrator a pane is: its pane, or a headless one's hl:<name> (stopped too: a late link opens its Home). */
export function orchestratorOfPane(state: AppState | null, paneId: string | null): OrchestratorView | undefined {
  return paneId === null ? undefined : orchestrators(state).find((o) => o.paneId === paneId || (o.mode === 'headless' && paneId === `hl:${o.name}`));
}

/** The orchestrator a #/home/<name> route names (or the agents list's old #/agents/<name>). */
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

// An orchestrator's pane opens as its Home; every other pane as its own view.
export function paneRoute(state: AppState | null, paneId: string): string {
  const o = orchestratorOfPane(state, paneId);
  return o ? homeHash(o.name) : `#/pane/${encodeURIComponent(paneId)}`;
}

/** The routes shown in front of another screen: a pane's drawer, Settings. */
export const isOverlay = (hash: string): boolean => hash.startsWith('#/pane/') || hash === '#/settings';

/** The screen under an overlay after arriving from `fromHash`: a Home it came from; from another overlay (which it
 *  replaced) the same; else (a fresh open, a reload) none: #/home, the default Home it closes to. */
export function nextOverlayBase(fromHash: string | null, prev: string): string {
  if (fromHash?.startsWith('#/home/')) return fromHash;
  return fromHash && isOverlay(fromHash) ? prev : '#/home';
}

/** Whether the overlay's history entry sits right on its screen's (`base`), so a close can go back to it:
 *  opened from that screen; from another overlay (a replace) the same; else (a fresh open, a reload) not. */
export function nextOverlayOverBase(fromHash: string | null, base: string, prev: boolean): boolean {
  if (fromHash === base) return true;
  return fromHash && isOverlay(fromHash) ? prev : false;
}

export function resolveRoute(hash: string, state: AppState | null, lastHome: string | null): Route {
  // Opening the app without a route (the PWA's start_url) lands on the default Home (a stopped
  // one shows Start), replaced so the empty-hash entry stays out of history; before a State, the first one routes it.
  // #/home (older links) too. None configured can't be (the bridge has its `default` then): a spinner.
  if ((!hash || hash === '#/home') && state) {
    const home = defaultHome(state, lastHome);
    return home ? { kind: 'redirect', hash: homeHash(home.name), replace: true } : { kind: 'loading' };
  }
  if (!hash) return { kind: 'loading' };
  if (hash === '#/home' || hash.startsWith('#/home/')) {
    if (!state) return { kind: 'loading' };
    const o = homeOf(hash, state);
    return o ? { kind: 'home', name: o.name, paneId: o.paneId } : { kind: 'redirect', hash: '#/home', replace: true }; // gone: the default one
  }
  // the agents list's old routes: #/agents/<name> its Home, #/agents the default one
  if (hash === '#/agents' || hash.startsWith('#/agents/')) {
    if (!state) return { kind: 'loading' };
    const o = homeOf(hash, state);
    return { kind: 'redirect', hash: o ? homeHash(o.name) : '#/home', replace: true };
  }
  if (hash.startsWith('#/pane/')) {
    let paneId: string;
    try {
      paneId = decodeURIComponent(hash.slice('#/pane/'.length));
    } catch {
      return { kind: 'redirect', hash: '#/home', replace: true }; // malformed pane hash — don't break routing
    }
    // an orchestrator always opens as its Home (notification clicks, stale links, …)
    const o = orchestratorOfPane(state, paneId);
    return o ? { kind: 'redirect', hash: homeHash(o.name), replace: true } : { kind: 'pane', paneId };
  }
  if (hash === '#/settings') return { kind: 'settings' };
  return { kind: 'redirect', hash: '#/home', replace: true }; // #/ and anything else: the default Home
}
