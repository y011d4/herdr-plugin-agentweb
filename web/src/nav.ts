/**
 * nav.ts — the moves more than one screen makes: opening an overlay and closing it. An agent (#/pane/<id>)
 * opens in a drawer (ui/AgentDrawer.tsx), Settings (#/settings) in a sheet (ui/SettingsSheet.tsx), in
 * front of the screen they were opened from (store.view.paneBackRoute), one at a time. Going from one
 * overlay to another replaces the history entry, so the phone's Back still closes it; a close goes back
 * to the entry under it when the overlay was opened on top of it here, else replaces itself with that
 * screen.
 */
import { showToast } from './notify.ts';
import { isOverlay, paneRoute } from './routes.ts';
import { store } from './store.ts';

/** To `hash`: from an overlay to an overlay in place, else as a new history entry. */
export function go(hash: string): void {
  if (isOverlay(hash) && isOverlay(location.hash)) location.replace(hash);
  else location.hash = hash;
}

/** Opens a pane: its drawer, or for an orchestrator's pane its Home. */
export const openAgent = (paneId: string): void => go(paneRoute(store.appState, paneId));

/** Opens the agent herdr names `name` (a [yoicks] notice's worker), or says none is: while an agent's
 *  name isn't known (agent.list fills names in a moment after an agent shows), it may be that one. */
export function openAgentNamed(name: string): void {
  const agents = (store.appState?.workspaces ?? []).flatMap((w) => w.tabs.flatMap((t) => t.panes)).filter((p) => p.agent);
  const pane = agents.find((p) => p.agent!.herdrName === name);
  if (pane) openAgent(pane.paneId);
  else if (agents.some((p) => p.agent!.herdrName === null)) showToast('Agent not found', `${name} isn't known yet, or is gone: try again in a moment.`);
  else showToast('Agent not found', `No running agent is named ${name}.`);
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

/** Whether a close of the overlay on show is under way (its Back not landed yet). */
export const closingDrawer = (): boolean => closing === location.href;

/** The app's every history.back(): one close waits for it to land. */
export function back(): void {
  traversing = true;
  history.back();
}

/** Closes the overlay on show (a drawer, Settings): back to the screen under it. An image preview open
 *  over a drawer (Modals.tsx) has an entry of its own at the same URL on top of the drawer's: Back takes
 *  it off (closing the preview), then the drawer closes; so with the preview's own Back under way. */
export function closeOverlay(): void {
  if (!isOverlay(location.hash) || closing === location.href) return;
  if (traversing || history.state?.imagePreview != null) {
    addEventListener('popstate', closeOverlay, { once: true });
    if (!traversing) back();
    return;
  }
  closing = location.href;
  if (store.view.paneOverBase) back();
  else location.replace(store.view.paneBackRoute);
}

/** The drawer's word for closeOverlay. */
export const closeAgent = closeOverlay;
