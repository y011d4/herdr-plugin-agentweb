/**
 * nav.ts — the moves more than one screen makes: opening an agent and closing it. An agent (#/pane/<id>)
 * opens in a drawer over the screen it was opened from (ui/AgentDrawer.tsx; that screen is
 * store.view.paneBackRoute). Going from one agent's drawer to another's replaces the history entry,
 * so the phone's Back still closes the drawer; a close goes back to the entry under it when the
 * drawer was opened on top of it here, else replaces itself with that screen.
 */
import { paneRoute } from './routes.ts';
import { store } from './store.ts';

const inDrawer = (hash: string): boolean => hash.startsWith('#/pane/');

/** To `hash`: from a drawer to a drawer in place, else as a new history entry. */
export function go(hash: string): void {
  if (inDrawer(hash) && inDrawer(location.hash)) location.replace(hash);
  else location.hash = hash;
}

/** Opens a pane: its drawer, or for an orchestrator's pane its Home. */
export const openAgent = (paneId: string): void => go(paneRoute(store.appState, paneId));

// The URL a close is under way from: a second close before the hash changes (a tap on ✕ as an
// answer lands, say) would go back twice.
let closing: string | null = null;
addEventListener('hashchange', () => { closing = null; });

/** Closes the drawer on show: back to the screen under it. */
export function closeAgent(): void {
  if (!inDrawer(location.hash) || closing === location.href) return;
  closing = location.href;
  if (store.view.paneOverBase) history.back();
  else location.replace(store.view.paneBackRoute);
}
