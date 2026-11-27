/**
 * nav.ts — the moves more than one screen makes: opening an agent and closing it. An agent (#/pane/<id>)
 * opens in a drawer over the screen it was opened from (ui/AgentDrawer.tsx; that screen is
 * store.view.paneBackRoute). Going from one agent's drawer to another's replaces the history entry,
 * so the phone's Back still closes the drawer; a close goes back to the entry under it when the
 * drawer was opened on top of it here, else replaces itself with that screen.
 */
import { showToast } from './notify.ts';
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

/** Opens the agent herdr names `name` (a [yoicks] notice's worker), or says none is: it may be gone,
 *  or so new the bridge hasn't its name yet (agent.list, a moment after it shows). */
export function openAgentNamed(name: string): void {
  const pane = (store.appState?.workspaces ?? []).flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.agent?.herdrName === name);
  if (pane) openAgent(pane.paneId);
  else showToast('Agent not found', `No running agent is named ${name} now.`);
}

// The URL a close is under way from: a second close before the history moves (a tap on ✕ as an
// answer lands, say) would go back twice. And whether a Back of the app's is under way (`back`): a
// close waits for it, or the two would go back past the screen under the drawer. A Back onto an entry
// at the same URL (an image preview's) moves no hash, so popstate ends both.
let closing: string | null = null;
let traversing = false;
const moved = (): void => { closing = null; traversing = false; };
addEventListener('hashchange', moved);
addEventListener('popstate', moved); // first: before a close waiting on the same popstate

/** Whether a close of the drawer on show is under way (its Back not landed yet). */
export const closingDrawer = (): boolean => closing === location.href;

/** The app's every history.back(): one close waits for it to land. */
export function back(): void {
  traversing = true;
  history.back();
}

/** Closes the drawer on show: back to the screen under it. An image preview open over it (Modals.tsx)
 *  has an entry of its own at the same URL on top of the drawer's: Back takes it off (closing the
 *  preview), then the drawer closes; so with the preview's own Back under way. */
export function closeAgent(): void {
  if (!inDrawer(location.hash) || closing === location.href) return;
  if (traversing || history.state?.imagePreview != null) {
    addEventListener('popstate', closeAgent, { once: true });
    if (!traversing) back();
    return;
  }
  closing = location.href;
  if (store.view.paneOverBase) back();
  else location.replace(store.view.paneBackRoute);
}
