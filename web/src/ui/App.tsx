/**
 * ui/App.tsx — the app shell, drawn into #app: on a wide screen the PC sidebar (ui/Sidebar.tsx),
 * the topbar (the screen on show fills its three slots), the connection dot and the reconnect
 * banner, #screen, the toasts, the agent drawer and the modals (portalled into #modal-root). Hash routing:
 *   #/agents        — the list (ui/Dashboard.tsx); #/agents/:name one orchestrator's account's agents
 *   #/home/:name    — an orchestrator's Home; #/home opens the last one used
 *   #/pane/:id      — a pane, in a drawer (ui/AgentDrawer.tsx; its body: ui/Pane.tsx, pane-view.ts)
 *                     over the screen it was opened from (view.paneBackRoute), which stays as it is
 *   #/settings      — settings
 * What a hash shows is decided in routes.ts (resolveRoute); handleRoute renders it. Each render
 * of a route replaces the screen and its topbar with fresh instances (a new key), so a screen's
 * effects always start over; only the list under a drawer, and back from it, stays as it is.
 * start() (main.tsx) loads the token, connects, fetches the first
 * State and listens: hashchange, the SW's navigate message, visibilitychange, the viewport.
 */
import { useMediaQuery } from '@mantine/hooks';
import { Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { apiDelete, apiGet, apiPost, getToken, headlessName, loadToken, onUnauthorized, orchestratorPost, setToken } from '../api.ts';
import { dismissNotificationsForPane, notifyAgentStatus, notifyOrchestratorAlert, showToast } from '../notify.ts';
import { closeAgent, closingDrawer, go, openAgent } from '../nav.ts';
import { homeOf, isAgentsRoute, nextPaneBackRoute, nextPaneOverBase, nextSettingsBackRoute, resolveRoute } from '../routes.ts';
import { STORAGE_HOME, findPane, lastHome, markPaneSeen, setAppState, store, subscribe, type View } from '../store.ts';
import type { AppState, ClearResponse, WsMessage } from '../types.ts';
import { WIDE_QUERY } from '../theme.ts';
import { onWsMessage, wsConnect, wsSendWatch } from '../ws.ts';
import { AgentDrawer, type Sheet } from './AgentDrawer.tsx';
import { Dashboard, dashboardTopbar } from './Dashboard.tsx';
import { Modals, confirmModal, openRename } from './Modals.tsx';
import { closePaneView, homeTopbar, Pane, paneViewOnState, StoppedHome, stoppedHomeTopbar, type AgentActions } from './Pane.tsx';
import { Settings, settingsTopbar } from './Settings.tsx';
import { Sidebar } from './Sidebar.tsx';
import { Toasts } from './Toasts.tsx';
import { Token } from './Token.tsx';

export interface Topbar { title?: ReactNode; left?: ReactNode; right?: ReactNode }

// ── The shell's own state: the screen on show, the drawer and the link ────────

// The topbar before anything is routed (as index.html paints it) and while a Home waits for
// the first State.
const BARE: Topbar = { title: 'Yoicks' };

// hash: the route it shows (null: none, the token screen or a Home waiting for a State)
interface Shown { kind: View['screen']; node: ReactNode; topbar?: Topbar; key: number; hash: string | null }
let shown: Shown = { kind: 'loading', node: null, topbar: BARE, key: 0, hash: null };
// The agent drawer: the pane on show over #screen (ui/AgentDrawer.tsx), null before the first
let sheet: Sheet | null = null;
// End-to-end connectivity, updated on every store change (null: none yet, so a fresh open's
// first connect shows no banner)
let linkUp: boolean | null = null;
const listeners = new Set<() => void>();
const changed = (): void => { for (const fn of listeners) fn(); };
const subscribeShell = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Puts a screen on show (no topbar: hidden), for the route `hash`. */
function show(kind: View['screen'], node: ReactNode, topbar?: Topbar, hash: string | null = null): void {
  store.view.screen = kind;
  shown = { kind, node, topbar, key: shown.key + 1, hash };
  changed();
}

/** Opens the drawer on a pane, a fresh view of it; what had the focus as it opened (not on a pane to pane)
 *  gets it back on its close. */
function openSheet(paneId: string): void {
  const fresh = !sheet?.open;
  const opener = fresh ? (document.activeElement instanceof HTMLElement ? document.activeElement : null) : sheet!.opener;
  sheet = { paneId, key: (sheet?.key ?? 0) + 1, open: true, opener, openedPane: fresh ? paneId : sheet!.openedPane };
  changed();
}

/** Closes the drawer (its pane's view already stopped: closePaneView); `gone` drops it at once. */
function closeSheet(gone = false): void {
  if (!sheet?.open && !gone) return;
  sheet = gone ? null : { ...sheet!, open: false };
  changed();
}

export function App() {
  const { kind, node, topbar, key } = useSyncExternalStore(subscribeShell, () => shown);
  const link = useSyncExternalStore(subscribeShell, () => linkUp);
  const wide = useMediaQuery(WIDE_QUERY, false, { getInitialValueInEffect: false }); // read now: no first paint without it
  const drawer = useSyncExternalStore(subscribeShell, () => sheet);
  // the screen under an agent's drawer is out of reach, the keyboard's too; a wide screen's sidebar isn't
  const under = drawer?.open && kind !== 'token' ? true : undefined;
  const slot = (content: ReactNode): ReactNode => <Fragment key={key}>{content}</Fragment>;
  return (
    <>
      {/* a PC's: never over the token screen. Its slot stays when it isn't drawn, so the elements
          after it (#topbar, #reconnect-banner, #screen) stay the same as it comes and goes. */}
      {wide && kind !== 'token' && <Sidebar />}
      <header id="topbar" className="topbar" inert={under} style={topbar ? undefined : { display: 'none' }}>
        <div id="topbar-left">{slot(topbar?.left)}</div>
        <div className="topbar-title" id="topbar-title">{slot(topbar?.title)}</div>
        <div id="conn-dot" className={link ? 'conn-dot connected' : 'conn-dot'} title={link === null ? 'Disconnected' : link ? 'Connected' : 'Reconnecting…'}></div>
        <div id="topbar-right">{slot(topbar?.right)}</div>
      </header>
      {/* never over the token screen: leaving it while the link is down shows it */}
      <div id="reconnect-banner" role="status" aria-live="polite" inert={under} className={link === false && kind !== 'token' ? 'visible' : undefined}>
        <span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }}></span>
        Reconnecting&hellip;
      </div>
      <main id="screen" inert={under}>{slot(node)}</main>
      <div id="toast-container" aria-live="assertive" aria-atomic="false"><Toasts /></div>
      {createPortal(<><AgentDrawer sheet={kind === 'token' ? null : drawer} actions={agentActions} /><Modals /></>, document.getElementById('modal-root')!)}
    </>
  );
}

// What is on screen (store.ts): the pane shown (activePaneId: the drawer's, or a Home's), whether it
// is a Home, its terminal/chat mode and the screen under the drawer. Mutated in place.
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

// ── Server messages ───────────────────────────────────────────────────────────

// Every WS message lands here, a fallback-polled state as a `state` message (ws.ts);
// the open pane's view hears its own (pane-view.ts).
function handleWsMessage(msg: WsMessage): void {
  if (msg.type === 'state') {
    setAppState(msg.state);
    onStateUpdate();
  } else if (msg.type === 'agent_status') {
    notifyAgentStatus(msg); // for blocked/done an OS notification while hidden
  } else if (msg.type === 'orchestrator_alert') {
    notifyOrchestratorAlert(msg); // a headless orchestrator's new warning (or a failed Claude Code check)
  } else if (msg.type === 'pane_gone') {
    onPaneGone(msg.paneId);
  }
  // pane_output, transcript_items: the open pane's view (pane-view.ts); pong — no-op
}

// The dot (and the banner) reflect end-to-end connectivity: the WebSocket to the bridge AND
// the bridge's own link to herdr (store.appState.connected). herdr can drop while the
// WS stays open, so a green dot requires both to be up.
function updateConnBadge(): void {
  const up = store.wsConnected && (store.appState?.connected ?? true);
  if (up === linkUp) return;
  linkUp = up;
  changed();
}

// ── The open pane going away ──────────────────────────────────────────────────
// Pane views only show a pane; leaving it when it closes, and holding a Home while
// its orchestrator is replaced, happen here.

/** The open pane no longer exists: say so and close its drawer. Its view stops now and it is no longer
 *  the open pane: a close going back lands a moment later, and a state meanwhile says nothing again. */
function leaveClosedPane(): void {
  showToast('Pane closed', 'This pane no longer exists.');
  closePaneView();
  view.activePaneId = null;
  closeAgent();
}

/** herdr closed a pane (pane_gone): the open one leaves; a Home's orchestrator going is the State's to show. */
function onPaneGone(paneId: string): void {
  if (paneId !== view.activePaneId || paneId === clearingPane) return; // a Clear's old pane: its drawer waits for the new one
  if (!view.homeMode) leaveClosedPane();
}

/** A state on a Home whose orchestrator's pane changed: a new pane (started, or cleared) re-routes
 *  onto it; none shows the stopped Home, unless a Clear is replacing it (true: either happened). */
function homeReplaced(hash: string): boolean {
  const id = homeOf(hash, store.appState)?.paneId ?? null;
  if (id === view.activePaneId) return false; // unchanged: a Clear in flight keeps holding (homeClearing)
  if (id || !homeClearing) { stopHoldingHome(); handleRoute(); }
  else holdHomeForReplacement(); // gone mid-Clear: the replacement is on its way
  return true;
}

// ── State update handler ──────────────────────────────────────────────────────

// Every state — WS push, startup/sign-in fetch, fallback poll — lands here, so
// this is also where a first state routes the app, whichever source wins the race.
function onStateUpdate(): void {
  if (goHomeToOrchestrator()) return; // first state of a fresh open: decide home
  // Nothing rendered yet (startup), or the token was just (re-)entered and the
  // token screen is still up: render the current route.
  if (!routeRendered || view.screen === 'token') { handleRoute(); return; }
  // (the list follows the store itself: ui/Dashboard.tsx)
  const hash = location.hash;
  if (hash.startsWith('#/pane/')) {
    // If the pane vanished (e.g. seen via /api/state polling while the WS is
    // down, so the pane_gone push can't fire), leave the now-stale view.
    if (view.activePaneId && view.activePaneId !== clearingPane && !findPane(view.activePaneId)) {
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

// A cleared orchestrator leaves a gap: its old pane is gone before the replacement is
// detected as an agent. Its Home holds through that gap instead of showing the stopped
// Home, and gives up only if no orchestrator shows up in time.
const HOME_REPLACE_GRACE_MS = 8_000;
let homeLostTimer: ReturnType<typeof setTimeout> | null = null;
let homeClearing = false; // a Home's Clear is in flight or replacing its orchestrator

function holdHomeForReplacement(): void {
  if (homeLostTimer) return;
  homeLostTimer = setTimeout(() => {
    homeLostTimer = null;
    homeClearing = false;
    if (!location.hash.startsWith('#/home/') || homeOf(location.hash, store.appState)?.paneId) return; // left, or onStateUpdate re-resolved
    showToast('Orchestrator stopped', 'It did not come back after Clear.');
    handleRoute(); // the stopped Home
  }, HOME_REPLACE_GRACE_MS);
}

function stopHoldingHome(): void {
  if (homeLostTimer) clearTimeout(homeLostTimer);
  homeLostTimer = null;
  homeClearing = false;
}

function handleRoute(e?: Event): void {
  stopHoldingHome(); // a route rendered afresh (left the Home, or its replacement is in) ends any hold
  if (!getToken()) {
    renderTokenScreen();
    return;
  }
  if (goHomeToOrchestrator()) return; // the hashchange re-enters handleRoute
  routeRendered = true;
  const from = e instanceof HashChangeEvent ? new URL(e.oldURL).hash : null;

  closePaneView(); // the drawer's pane, or a Home's (left, or frozen under the drawer)
  view.activePaneId = null;
  view.homeMode = false;

  const route = resolveRoute(location.hash, store.appState, lastHome());
  if (route.kind === 'pane') {
    openPaneRoute(route.paneId, from);
    wsSendWatch();
    return;
  }
  if (route.kind !== 'redirect') closeSheet();
  if (route.kind === 'redirect') {
    if (route.replace) location.replace(route.hash);
    else location.hash = route.hash;
    return;
  }
  if (route.kind === 'loading') {
    // can't resolve the orchestrator yet — the first state re-routes (onStateUpdate)
    routeRendered = false;
    show('loading', <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}><span className="loading-spinner"></span></div>, BARE);
  } else if (route.kind === 'home') {
    view.homeMode = true;
    view.activePaneId = route.paneId;
    try { localStorage.setItem(STORAGE_HOME, route.name); } catch { /* memory-only */ }
    if (route.paneId) {
      dismissNotificationsForPane(route.paneId);
      markActivePaneSeen();
      renderHome(route.paneId, route.name);
    } else {
      // a headless one's warnings offer Clear while stopped too (a fresh session)
      show('pane', <StoppedHome name={route.name} clear={() => { void clearAgentFlow(`hl:${route.name}`); }} />, stoppedHomeTopbar(route.name), location.hash);
    }
  } else if (route.kind === 'agents') {
    // back from a drawer over it, the list stays as it was: where it was scrolled to
    if (shown.hash !== location.hash) showList(location.hash);
  } else {
    view.settingsBackRoute = nextSettingsBackRoute(from, view.settingsBackRoute);
    show('settings', <Settings toast={showToast} onSignedOut={() => renderTokenScreen()} />, settingsTopbar(view.settingsBackRoute), location.hash);
  }

  wsSendWatch(); // sync the server-side pane watch with the current route
}

const showList = (hash: string): void => show('agents', <Dashboard hash={hash} />, dashboardTopbar(hash), hash);

/** #/pane/<id>: the pane in the drawer, over the screen it was opened from (a Home or a list, left as it
 *  is: a Home's view stopped, its chat as it was), else over the list, drawn now. */
function openPaneRoute(paneId: string, from: string | null): void {
  let base = nextPaneBackRoute(from, view.paneBackRoute);
  if (shown.hash !== base) {
    if (!isAgentsRoute(base)) base = '#/agents'; // a Home only as it is on show (one view at a time)
    showList(base);
  }
  view.paneOverBase = nextPaneOverBase(from, base, view.paneOverBase);
  view.paneBackRoute = base;
  view.activePaneId = paneId;
  // A pane view opens on the terminal (pane-view.ts) but mounts after the route's watch goes
  // out (handleRoute's wsSendWatch): set its mode now, or that watch follows the last pane's chat.
  view.paneViewMode = 'terminal';
  // opening a pane clears its pending OS notifications
  dismissNotificationsForPane(paneId);
  markActivePaneSeen();
  openSheet(paneId);
}

// ── Token screen ──────────────────────────────────────────────────────────────

function renderTokenScreen(message?: string): void {
  closePaneView();
  view.activePaneId = null;
  closeSheet(true);
  show('token', <Token message={message} onToken={signIn} />);
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

// ── Agent lifecycle UI (rename / clear / stop) ────────────────────────────────

// A pane's ⋮ (ui/Pane.tsx's AgentMenu): Rename… (the header follows the store), Clear, Stop. A Home
// has no ⋮: its Clear and Stop are buttons on its status bar (ui/Pane.tsx), through the same confirm
// flows. A headless orchestrator's (hl:<name>) go to /api/orchestrators/:name/*: it has no herdr pane.
function agentActions(paneId: string): AgentActions {
  return {
    rename: () => { const agent = findPane(paneId)?.pane.agent; openRename(paneId, agent?.displayName || agent?.name || ''); },
    clear: () => { void clearAgentFlow(paneId); },
    stop: () => { void stopAgentFlow(paneId); },
  };
}

// The pane a Clear is replacing: its going is expected (its drawer stays for the new pane).
let clearingPane: string | null = null;

/** Whether `paneId` is the drawer's pane now, not closing. The hash, not view.activePaneId: it changes at
 *  once; a close going Back changes it only once that lands (closingDrawer). */
const drawerShows = (paneId: string): boolean => location.hash === `#/pane/${encodeURIComponent(paneId)}` && !closingDrawer();

async function clearAgentFlow(paneId: string): Promise<void> {
  const hl = headlessName(paneId);
  const ok = await confirmModal('Clear agent?', hl ? 'Starts a fresh session and ends the current one. In-session context is lost.'
    : 'Starts a fresh session (same profile & directory) and closes the current one. In-session context is lost.', 'Clear', false);
  if (!ok) return;
  if (view.homeMode) homeClearing = true; // the gap before the replacement isn't a stop
  else clearingPane = paneId;
  try {
    const res = hl ? await orchestratorPost<{ paneId: string }>(hl, 'clear') : await apiPost<ClearResponse>(`/api/agents/${encodeURIComponent(paneId)}/clear`);
    showToast('Cleared', 'Started a fresh session');
    // Clearing an orchestrator keeps the user on its Home: the state may not know the
    // replacement yet, so stay on #/home/<name> and let onStateUpdate re-resolve it. The hold's
    // timer bounds the Clear's flag too: it ends within 8s even if no gap is ever seen.
    if (view.homeMode) { if (homeClearing) holdHomeForReplacement(); return; }
    if (!drawerShows(paneId)) return; // another pane (or none) opened meanwhile: it stays
    if (res.paneId) openAgent(res.paneId);
    else closeAgent();
  } catch (err) {
    stopHoldingHome();
    showToast('Clear failed', (err as Error).message);
    if (view.homeMode) handleRoute(); // it may have stopped meanwhile: show what the State says
    else if (drawerShows(paneId) && !findPane(paneId)) leaveClosedPane(); // gone, the Clear failed or not
  } finally {
    if (clearingPane === paneId) clearingPane = null;
  }
}

async function stopAgentFlow(paneId: string): Promise<void> {
  const hl = headlessName(paneId);
  const ok = await confirmModal('Stop agent?', hl ? 'Stops the orchestrator. Start resumes its session.' : 'Closes the pane and terminates the agent running in it.', 'Stop', true);
  if (!ok) return;
  try {
    await (hl ? orchestratorPost(hl, 'stop') : apiDelete(`/api/panes/${encodeURIComponent(paneId)}`));
    showToast('Stopped', hl ? 'The orchestrator stopped' : 'Agent pane closed');
    if (!view.homeMode && drawerShows(paneId)) closeAgent(); // a Home stays: the State shows it stopped; another pane opened meanwhile too
  } catch (err) {
    showToast('Stop failed', (err as Error).message);
  }
}

// ── A running Home ────────────────────────────────────────────────────────────

function renderHome(paneId: string, name: string): void {
  view.paneViewMode = 'terminal'; // as openPaneRoute's
  const actions = { clear: () => { void clearAgentFlow(paneId); }, stop: () => { void stopAgentFlow(paneId); } };
  show('pane', <Pane paneId={paneId} home actions={actions} name={name} />, homeTopbar(paneId), location.hash);
}

// ── Startup ───────────────────────────────────────────────────────────────────

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

/** Once, before the first render (main.tsx). */
export function start(): void {
  bindViewportHeight();

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

  // A notification's tap (sw.ts) opens its pane
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (evt: MessageEvent<{ type: string; url: string }>) => {
      if (evt.data?.type === 'navigate') go(evt.data.url);
    });
  }

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
}
