/**
 * nav.ts — the moves more than one screen makes: opening an overlay and closing it. An agent (#/pane/<id>)
 * opens in a drawer (ui/AgentDrawer.tsx; a click on its name on a PC, a notice's or a chip's, opens it in herdr instead: openAgent;
 * an agent row opens its menu, Dashboard.tsx's AgentRow), Settings (#/settings) in a sheet (ui/SettingsSheet.tsx), in
 * front of the screen they were opened from (store.view.paneBackRoute), one at a time. Going from one
 * overlay to another replaces the history entry, so the phone's Back still closes it; a close goes back
 * to the entry under it when the overlay was opened on top of it here, else replaces itself with that
 * screen.
 */
import { apiPost } from './api.ts';
import { showToast } from './notify.ts';
import { isOverlay, paneRoute } from './routes.ts';
import { store } from './store.ts';
import { WIDE_QUERY } from './theme.ts';

/** To `hash`: from an overlay to an overlay in place, else as a new history entry. */
export function go(hash: string): void {
  if (isOverlay(hash) && isOverlay(location.hash)) location.replace(hash);
  else location.hash = hash;
}

/** Opens an agent the way a click on it does: on a PC (WIDE_QUERY) in herdr (focusInHerdr: the PC's herdr switches to its
 *  pane), on a phone in its drawer (showAgent); an orchestrator's pane is its Home at every width. */
export function openAgent(paneId: string): void {
  const hash = paneRoute(store.appState, paneId);
  if (hash.startsWith('#/pane/') && matchMedia(WIDE_QUERY).matches) focusInHerdr(paneId);
  else go(hash);
}

/** Opens an agent in this app, its drawer (an orchestrator's pane: its Home), at every width: a PC's Show here. */
export const showAgent = (paneId: string): void => go(paneRoute(store.appState, paneId));

/** herdr's pane.focus: the PC's herdr switches to the pane's workspace, tab and pane; a toast says how it went (the
 *  browser can't bring the terminal to the front). */
export function focusInHerdr(paneId: string): void {
  apiPost(`/api/panes/${encodeURIComponent(paneId)}/focus`).then(
    () => showToast('Opened in herdr', 'Its pane has the focus in herdr'),
    (err: Error) => showToast('Could not open in herdr', err.message));
}

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

/** Whether `paneId` is the drawer's pane now, not closing. The hash, not view.activePaneId: it changes at
 *  once; a close going Back changes it only once that lands (closingDrawer). */
export const drawerShows = (paneId: string): boolean => location.hash === `#/pane/${encodeURIComponent(paneId)}` && !closingDrawer();

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
