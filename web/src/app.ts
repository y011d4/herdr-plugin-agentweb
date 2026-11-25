/**
 * app.ts — Yoicks PWA
 *
 * Single-page application with hash routing:
 *   #/agents    — dashboard (default; ui/Dashboard.tsx)
 *   #/agents/:name — the dashboard of one orchestrator's Claude account (from its Home)
 *   #/home/:name — an orchestrator's chat (Home); #/home opens the last one used
 *   #/pane/:id  — pane terminal detail
 *   #/settings  — settings
 *
 * A pane or a Home is ui/Pane.tsx (its body: pane-view.ts); this shell routes to it and leaves it.
 */

import type { AppState, ClearResponse, OrchestratorView, WsMessage } from './types.ts';
import { apiDelete, apiGet, apiPost, getToken, loadToken, onUnauthorized, setToken } from './api.ts';
import { STORAGE_HOME, findPane, lastHome, markPaneSeen, setAppState, setStartingHome, store, subscribe } from './store.ts';
import { dismissNotificationsForPane, dismissToastsForPane, notifyAgentStatus, showToast } from './notify.ts';
import { onWsMessage, wsConnect, wsSendWatch } from './ws.ts';
import { homeHash, homeOf, isAgentsRoute, nextPaneBackRoute, paneGoneRoute, paneRoute, resolveRoute } from './routes.ts';
import { createElement } from 'react';
import { Dashboard, dashboardTopbar } from './ui/Dashboard.tsx';
import { confirmModal, openAgentMenu } from './ui/Modals.tsx';
import { mountOverlays, mountScreen, setConnIndicator, setLegacyScreen } from './ui/mount.tsx';
import { closePaneView, Pane, paneTopbar, paneViewOnState } from './ui/Pane.tsx';
import { Settings, settingsTopbar } from './ui/Settings.tsx';
import { Token } from './ui/Token.tsx';

// ── Module-level state ────────────────────────────────────────────────────────

// What is on screen (store.ts): the pane shown (activePaneId), whether it is a Home,
// its terminal/chat mode and where its Back goes. Mutated in place.
const { view } = store;

// Opening a done pane (or watching it finish) with the page visible counts as
// seeing it, like viewing it in herdr. Kept on the phone only: herdr can only mark
// a pane seen by focusing it, which would switch the PC's screen. Recorded against
// herdr's completionSeq, which follows the done status by a moment; until then each
// state push while the pane is open retries. Not while the bridge is cut off from
// herdr: the pane state shown may be stale.
function markActivePaneSeen(): void {
  if (!view.activePaneId || document.hidden || !store.appState?.connected) return;
  const agent = findPane(view.activePaneId)?.pane.agent;
  if (agent?.status !== 'done' || agent.completionSeq == null || store.seenDone[view.activePaneId] === agent.completionSeq) return;
  markPaneSeen(view.activePaneId);
}

/** source toggle: 'visible' | 'recent' */

// ── DOM refs (populated after DOMContentLoaded) ───────────────────────────────
let elApp: HTMLElement | null;

// ── Server messages ───────────────────────────────────────────────────────────

// Every WS message lands here, a fallback-polled state as a `state` message (ws.ts);
// the open pane's view hears its own (pane-view.ts).
function handleWsMessage(msg: WsMessage): void {
  if (msg.type === 'state') {
    setAppState(msg.state);
    onStateUpdate();
  } else if (msg.type === 'agent_status') {
    notifyAgentStatus(msg); // a toast; for blocked/done also an OS notification while hidden
  } else if (msg.type === 'pane_gone') {
    onPaneGone(msg.paneId);
  }
  // pane_output, transcript_items: the open pane's view (pane-view.ts); pong — no-op
}

// The badge reflects end-to-end connectivity: the WebSocket to the bridge AND
// the bridge's own link to herdr (store.appState.connected). herdr can drop while the
// WS stays open, so a green dot requires both to be up.
function updateConnBadge(): void {
  setConnIndicator(store.wsConnected && (store.appState?.connected ?? true));
}

// ── The open pane going away (the shell's transitions) ────────────────────────
// Pane views only show a pane; leaving it when it closes, and holding a Home while
// its orchestrator is replaced, happen here.

/** The open pane no longer exists: say so and go back to the list it came from. */
function leaveClosedPane(): void {
  showToast('Pane closed', 'This pane no longer exists.');
  navigate(paneGoneRoute(view));
}

/** herdr closed a pane (pane_gone): the open one leaves, or, on a Home, holds for a replacement. */
function onPaneGone(paneId: string): void {
  if (paneId !== view.activePaneId) return;
  if (view.homeMode) holdHomeForReplacement(); // the orchestrator may be mid-replacement; state decides
  else leaveClosedPane();
}

/** A state on a Home: without its orchestrator's pane it holds for a replacement, with a
 *  new pane it re-routes onto it (true: either happened). */
function homeReplaced(hash: string): boolean {
  const id = homeOf(hash, store.appState)?.paneId ?? null;
  if (id === view.activePaneId) { stopHoldingHome(); return false; }
  if (id) { stopHoldingHome(); handleRoute(); } // replaced (e.g. cleared): re-resolve Home onto the new pane
  else holdHomeForReplacement(); // gone — maybe being replaced
  return true;
}

// ── State update handler ──────────────────────────────────────────────────────

// Every state — WS push, startup/sign-in fetch, fallback poll — lands here, so
// this is also where a first state routes the app, whichever source wins the race.
function onStateUpdate(): void {
  if (goHomeToOrchestrator()) return; // first state of a fresh open: decide home
  // an orchestrator started from the list is up: open its Home, if the list is still on screen
  const started = store.startingHome ? orchestrators().find((o) => o.name === store.startingHome && o.paneId) : undefined;
  if (started) {
    setStartingHome(null);
    if (isAgentsRoute(location.hash)) { navigate(homeHash(started.name)); return; }
  }
  // Nothing rendered yet (startup), or the token was just (re-)entered and the
  // token screen is still up: render the current route.
  if (!routeRendered || view.screen === 'token') { handleRoute(); return; }
  // (the list follows the store itself: ui/Dashboard.tsx)
  const hash = location.hash;
  if (hash.startsWith('#/pane/')) {
    // If the pane vanished (e.g. seen via /api/state polling while the WS is
    // down, so the pane_gone push can't fire), leave the now-stale view.
    if (view.activePaneId && !findPane(view.activePaneId)) {
      leaveClosedPane();
      return;
    }
    markActivePaneSeen(); // it may have just finished while on screen
    paneViewOnState(); // the answer panel: the agent may have just become (un)blocked (the rest follows the store: ui/Pane.tsx)
  } else if (hash.startsWith('#/home/')) {
    if (homeReplaced(hash)) return;
    markActivePaneSeen(); // the orchestrator may have just finished while on screen
    paneViewOnState();
  }
}

// ── Routing ───────────────────────────────────────────────────────────────────
// What a hash shows is decided in routes.ts (resolveRoute); this shell renders it.

function navigate(hash: string): void {
  location.hash = hash;
}

// Orchestrators (one per Claude account, say) each have a Home: #/home/<name>.
const orchestrators = (): OrchestratorView[] => store.appState?.orchestrators ?? [];

// Opening the app without a route (the PWA's start_url) is decided once, on the first
// state (resolveRoute): location.replace keeps the empty-hash entry out of history.
function goHomeToOrchestrator(): boolean {
  if (location.hash) return false;
  const route = resolveRoute('', store.appState, lastHome());
  if (route.kind !== 'redirect') return false; // no state yet
  location.replace(route.hash);
  return true;
}

// Set once a route has been rendered: until then, the first state (WS push or
// fetch, whichever lands first) renders it (onStateUpdate).
let routeRendered = false;

// Home (#/home) is the orchestrator's chat as the app's main screen: the pane view
// (view.homeMode) with its own chrome — a status bar of its account's agents,
// dialogue-only chat (no tool calls or injected notifications), a "doing now" line
// while it works, and a plain messenger composer without terminal keys (ui/Pane.tsx).

// A cleared or restarted orchestrator leaves a gap: its old pane is gone before the
// replacement is detected as an agent. Home holds through that gap instead of
// bouncing to the list, and gives up only if no orchestrator shows up in time.
const HOME_REPLACE_GRACE_MS = 8_000;
let homeLostTimer: ReturnType<typeof setTimeout> | null = null;

function holdHomeForReplacement(): void {
  if (homeLostTimer) return;
  homeLostTimer = setTimeout(() => {
    homeLostTimer = null;
    if (!location.hash.startsWith('#/home/') || homeOf(location.hash, store.appState)?.paneId) return; // left, or onStateUpdate re-resolved
    showToast('Orchestrator stopped', 'Showing all agents.');
    handleRoute(); // no orchestrator → the list
  }, HOME_REPLACE_GRACE_MS);
}

function stopHoldingHome(): void {
  if (homeLostTimer) clearTimeout(homeLostTimer);
  homeLostTimer = null;
}

function handleRoute(e?: Event): void {
  if (!getToken()) {
    renderTokenScreen();
    return;
  }
  if (goHomeToOrchestrator()) return; // the hashchange re-enters handleRoute
  routeRendered = true;

  closePaneView();
  view.activePaneId = null;
  view.homeMode = false;

  const route = resolveRoute(location.hash, store.appState, lastHome());
  if (route.kind === 'redirect') {
    if (route.replace) location.replace(route.hash);
    else navigate(route.hash);
    return;
  }
  if (route.kind === 'loading') {
    // can't resolve the orchestrator yet — the first state re-routes (onStateUpdate)
    routeRendered = false;
    setLegacyScreen('loading', '<div style="display:flex;align-items:center;justify-content:center;flex:1;"><span class="loading-spinner"></span></div>');
  } else if (route.kind === 'home') {
    view.homeMode = true;
    view.activePaneId = route.paneId;
    try { localStorage.setItem(STORAGE_HOME, route.name); } catch { /* memory-only */ }
    dismissToastsForPane(route.paneId);
    dismissNotificationsForPane(route.paneId);
    markActivePaneSeen();
    renderPaneDetail(route.paneId);
  } else if (route.kind === 'agents') {
    mountScreen('agents', createElement(Dashboard, { hash: location.hash }), { topbar: dashboardTopbar(location.hash) });
  } else if (route.kind === 'pane') {
    view.activePaneId = route.paneId;
    view.paneBackRoute = nextPaneBackRoute(e instanceof HashChangeEvent ? new URL(e.oldURL).hash : null, view.paneBackRoute);
    // opening a pane clears its pending notifications (in-app toasts + OS)
    dismissToastsForPane(route.paneId);
    dismissNotificationsForPane(route.paneId);
    markActivePaneSeen();
    renderPaneDetail(route.paneId);
  } else {
    mountScreen('settings', createElement(Settings, { toast: showToast, onSignedOut: () => renderTokenScreen() }), { topbar: settingsTopbar });
  }

  wsSendWatch(); // sync the server-side pane watch with the current route
}

// ── Token screen ──────────────────────────────────────────────────────────────

function renderTokenScreen(message?: string): void {
  closePaneView();
  view.activePaneId = null;
  mountScreen('token', createElement(Token, { message, onToken: signIn }));
}

function signIn(token: string): void {
  setToken(token);
  setAppState(null); // drop pre-expiry state, so whichever of WS / HTTP lands first wins
  wsConnect();
  apiGet('/api/state').then((state) => {
    if (store.appState) return; // a WS push landed first: it is newer and has routed already
    setAppState(state as AppState);
    onStateUpdate(); // routes off the token screen
  }).catch((err: Error) => {
    // a WS state push already proved the token and opened the app: keep it
    if (err.message !== '401' && !store.appState) {
      renderTokenScreen('Could not connect. Check the token and try again.');
    }
  });
}

// ── Agent lifecycle UI (start / rename / clear / stop) ────────────────────────

// The pane's ⋮ (ui/Modals.tsx): Rename… (the header follows the store), Clear, Stop.
function agentMenu(paneId: string): void {
  const agent = findPane(paneId)?.pane.agent;
  openAgentMenu(paneId, agent?.displayName || agent?.name || '', {
    clear: () => { void clearAgentFlow(paneId); },
    stop: () => { void stopAgentFlow(paneId); },
  });
}

async function clearAgentFlow(paneId: string): Promise<void> {
  const ok = await confirmModal('Clear agent?', 'Starts a fresh session (same profile & directory) and closes the current one. In-session context is lost.', 'Clear', false);
  if (!ok) return;
  try {
    const res = await apiPost<ClearResponse>(`/api/agents/${encodeURIComponent(paneId)}/clear`);
    showToast('Cleared', 'Started a fresh session');
    // Clearing an orchestrator keeps the user on its Home: the state may not know the
    // replacement yet, so stay on #/home/<name> and let onStateUpdate re-resolve it.
    if (view.homeMode) return;
    navigate(res.paneId ? paneRoute(store.appState, res.paneId) : '#/agents');
  } catch (err) {
    showToast('Clear failed', (err as Error).message);
  }
}

async function stopAgentFlow(paneId: string): Promise<void> {
  const ok = await confirmModal('Stop agent?', 'Closes the pane and terminates the agent running in it.', 'Stop', true);
  if (!ok) return;
  try {
    await apiDelete(`/api/panes/${encodeURIComponent(paneId)}`);
    showToast('Stopped', 'Agent pane closed');
    navigate(paneGoneRoute(view));
  } catch (err) {
    showToast('Stop failed', (err as Error).message);
  }
}

// ── Pane detail ───────────────────────────────────────────────────────────────

function renderPaneDetail(paneId: string): void {
  mountScreen('pane', createElement(Pane, { paneId, home: view.homeMode }),
    { topbar: paneTopbar(paneId, view.homeMode, view.paneBackRoute, () => agentMenu(paneId)) });
}

// ── Service Worker registration ───────────────────────────────────────────────

function registerServiceWorker(): void {
  if (!window.isSecureContext) return;
  if (!('serviceWorker' in navigator)) return;
  // Only a build has a sw.js (npm run dev serves the sources, with no SW).
  if (import.meta.env.PROD) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failure is non-fatal
    });
  }

  // Handle navigate messages from SW notification clicks
  navigator.serviceWorker.addEventListener('message', (evt: MessageEvent<{ type: string; url: string }>) => {
    if (evt.data?.type === 'navigate') {
      navigate(evt.data.url);
    }
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Keep the app shell exactly as tall as the *visible* area. When the soft
// keyboard opens the visual viewport shrinks; without this the body would stay
// full-height, be taller than the visible area, and the browser would keep
// re-scrolling it to keep the caret in view — the "screen jitters up and down
// while typing" bug. Pinning #app to visualViewport.height means nothing
// overflows, so there's nothing for the browser to scroll. Android also gets
// interactive-widget=resizes-content (index.html); this covers iOS, where that
// hint is ignored, and is the fallback everywhere visualViewport exists.
function bindViewportHeight(): void {
  const vv = window.visualViewport;
  if (!vv) return; // older browsers keep the height:100% fallback
  const apply = (): void => {
    document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
  };
  apply();
  vv.addEventListener('resize', apply);
}

document.addEventListener('DOMContentLoaded', () => {
  elApp = document.getElementById('app');
  bindViewportHeight();
  mountOverlays(); // the toasts and the modals

  // A 401 drops the token (api.ts): ask for it again
  onUnauthorized(() => renderTokenScreen('Session expired or token invalid. Please enter your token.'));
  onWsMessage(handleWsMessage);
  subscribe(updateConnBadge); // the socket's link (ws.ts)

  // Load token from URL or storage
  const token = loadToken();

  // Route on hash change
  window.addEventListener('hashchange', handleRoute);

  // Initial route
  if (!token) {
    renderTokenScreen();
  } else {
    // Connect WS and load initial state
    wsConnect();
    apiGet('/api/state').then((state) => {
      if (store.appState) return; // a WS push landed first: it is newer and has routed already
      setAppState(state as AppState);
      onStateUpdate();
    }).catch((err: Error) => {
      if (err.message !== '401' && !routeRendered) {
        // Try to render with null state, WS will populate later
        handleRoute();
      }
    });
  }

  registerServiceWorker();

  // Pause the pane watch while hidden, resume it when visible (the open pane's view
  // re-reads its screen or transcript from its own listener, pane-view.ts)
  document.addEventListener('visibilitychange', () => {
    if (view.paneViewMode !== 'chat') wsSendWatch(); // pause/resume the pane watch
    if (document.hidden || !view.activePaneId) return;
    // Returning to a pane that's already open (app switch, no route change) won't
    // fire handleRoute, so clear any OS notification raised for it while hidden.
    dismissNotificationsForPane(view.activePaneId);
    markActivePaneSeen();
  });
});
