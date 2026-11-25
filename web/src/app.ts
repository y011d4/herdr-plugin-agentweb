/**
 * app.ts — Yoicks PWA
 *
 * Single-page application with hash routing:
 *   #/agents    — dashboard (default)
 *   #/agents/:name — the dashboard of one orchestrator's Claude account (from its Home)
 *   #/home/:name — an orchestrator's chat (Home); #/home opens the last one used
 *   #/pane/:id  — pane terminal detail
 *   #/settings  — settings
 *
 * Depends on ansi.ts for ANSI→HTML rendering.
 */

import { ansiToHtml } from './ansi.ts';
import { renderItems, conversationItems, latestActivity } from './transcript.ts';
import type { TimelineItem } from './transcript.ts';
import { stripAnsi, parsePrompt, promptIdentity, displayCols, answerOutcome } from './prompt.ts';
import type { PromptOption, ParsedPrompt } from './prompt.ts';
import { dashboardCards, homeSummary, shownStatus } from './dashboard-group.ts';
import type { DashboardCard } from './dashboard-group.ts';
import { DESKTOP_QUERY, enterSends } from './composer-keys.ts';
import type { AppState, ClearResponse, OrchestratorView, WsMessage, WsAgentStatusMessage, WsTranscriptItemsMessage } from './types.ts';
import { apiDelete, apiGet, apiPost, getToken, loadToken, onUnauthorized, setToken } from './api.ts';
import { keptTasks, markPaneSeen, setAppState, store, subscribe } from './store.ts';
import { dismissNotificationsForPane, dismissToastsForPane, notifyAgentStatus, showToast } from './notify.ts';
import { onWsMessage, wsConnect, wsSendWatch } from './ws.ts';
import { agentsScope, defaultHome, homeAgentsHash, homeHash, homeOf, isAgentsRoute, nextPaneBackRoute, orchestratorOfPane,
  paneGoneRoute, paneRoute, resolveRoute } from './routes.ts';
import { createElement } from 'react';
import { confirmModal, openAgentMenu, openNewAgent } from './ui/Modals.tsx';
import { mountOverlays, mountScreen, setConnIndicator, setLegacyScreen, setLegacyTopbar } from './ui/mount.tsx';
import { BUILD, Settings, settingsTopbar } from './ui/Settings.tsx';
import { Token } from './ui/Token.tsx';

// ── Storage keys ─────────────────────────────────────────────────────────────
const STORAGE_VIEW = 'herdr_pane_view'; // preferred pane view: 'terminal' | 'chat'
const STORAGE_HOME = 'herdr_home'; // the orchestrator whose Home was opened last

const PANE_REFRESH_INTERVAL_MS = 3_000;  // polling while pane detail is visible

// ── Module-level state ────────────────────────────────────────────────────────
let paneRefreshTimer: ReturnType<typeof setInterval> | null = null;

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

// ── Chat view (Claude Code transcript) ────────────────────────────────────────
// A claude pane can be shown as its structured transcript instead of the raw
// terminal (view.paneViewMode). Availability is probed per pane; the terminal stays the fallback.
let chatAvailable = false;
let chatSessionId: string | null = null;
let chatCursor = 0; // byte offset into the transcript for incremental fetches
let chatProbeSeq = 0; // monotonic probe id, to invalidate a probe from a prior pane
let chatProbeActive = 0; // reqId of the availability probe in flight (0 = none) — prevents overlap
// Pending-prompt panel: when a claude pane is blocked (waiting for input), the
// chat surfaces an answer UI — tappable options for a pending AskUserQuestion,
// or the live terminal screen for any other prompt (permission, plan, y/n).
let promptPanelKind: 'none' | 'blocked' = 'none';
let promptScreenTimer: ReturnType<typeof setInterval> | null = null;
let promptScreenId = ''; // identity of the on-screen prompt whose buttons are rendered (avoids re-render churn; guards stale taps)
let promptPollSeq = 0; // monotonic request id; bumped on stop to invalidate an in-flight poll
let promptPollActive = 0; // reqId of the poll currently in flight (0 = none) — prevents overlap
let promptAnswerInFlight = false; // true while/just after a tapped answer is sent — blocks re-taps
let answerCooldownTimer: ReturnType<typeof setTimeout> | null = null; // floors the post-send re-tap block
let answerGen = 0; // per-answer token so a stale POST/timer can't clear the guard for a newer answer
// A tapped answer until it is seen landing (settlePendingAnswer). `back`: where to go
// once the agent resumes work ('' = stay); `prompt`: the identity of the prompt it answers.
interface PendingAnswer {
  paneId: string; gen: number; prompt: string; back: string;
  sent: boolean; resumed: boolean; timer: ReturnType<typeof setTimeout> | null;
}
let pendingAnswer: PendingAnswer | null = null;
const ANSWER_CONFIRM_MS = 10_000; // still on the same prompt this long after the press → say so

/** source toggle: 'visible' | 'recent' */

// ── DOM refs (populated after DOMContentLoaded) ───────────────────────────────
let elApp: HTMLElement | null;

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// ── Server messages ───────────────────────────────────────────────────────────

// Every WS message lands here, a fallback-polled state as a `state` message (ws.ts).
function handleWsMessage(msg: WsMessage): void {
  if (msg.type === 'state') {
    setAppState(msg.state);
    onStateUpdate();
  } else if (msg.type === 'agent_status') {
    onAgentStatus(msg);
  } else if (msg.type === 'pane_output') {
    if (msg.paneId === view.activePaneId) {
      appScrollPane = msg.appScroll; // server decides from fresh scroll metadata
      renderPaneOutput(msg.ansi);
    }
  } else if (msg.type === 'pane_gone') {
    onPaneGone(msg.paneId);
  } else if (msg.type === 'transcript_items') {
    if (msg.paneId === view.activePaneId) onTranscriptItems(msg);
  }
  // pong — no-op
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
  const started = startingHome ? orchestrators().find((o) => o.name === startingHome && o.paneId) : undefined;
  if (started) {
    startingHome = null;
    if (isAgentsRoute(location.hash)) { navigate(homeHash(started.name)); return; }
  }
  // Nothing rendered yet (startup), or the token was just (re-)entered and the
  // token screen is still up: render the current route.
  if (!routeRendered || view.screen === 'token') { handleRoute(); return; }
  const hash = location.hash || '#/agents';
  if (isAgentsRoute(hash)) {
    renderAgentsDashboard();
  } else if (hash.startsWith('#/pane/')) {
    // If the pane vanished (e.g. seen via /api/state polling while the WS is
    // down, so the pane_gone push can't fire), leave the now-stale view.
    if (view.activePaneId && !findPane(view.activePaneId)) {
      leaveClosedPane();
      return;
    }
    markActivePaneSeen(); // it may have just finished while on screen
    // Pane detail auto-refreshes via its own poller; header may need updating
    refreshPaneHeader();
    updatePromptPanel(); // agent may have just become (un)blocked
    settlePendingAnswer(); // ...because a tapped answer landed
  } else if (hash.startsWith('#/home/')) {
    if (homeReplaced(hash)) return;
    markActivePaneSeen(); // the orchestrator may have just finished while on screen
    refreshPaneHeader();
    renderHomeStatus();
    renderHomeActivity();
    updatePromptPanel();
    settlePendingAnswer();
  }
}

// ── Agent status pushes ───────────────────────────────────────────────────────

function onAgentStatus(msg: WsAgentStatusMessage): void {
  const { paneId, to } = msg;

  // A tapped answer's pane going `working`: these events come one by one, while state
  // snapshots are debounced and can skip a short `working` (blocked → done).
  if (to === 'working' && pendingAnswer?.paneId === paneId) {
    pendingAnswer.resumed = true;
    settlePendingAnswer();
  }

  notifyAgentStatus(msg); // a toast; for blocked/done also an OS notification while hidden

  // Refresh pane detail if it's the active one (not while hidden — the
  // visibilitychange handler re-reads the screen on return)
  if ((to === 'blocked' || to === 'done') && view.activePaneId === paneId && !document.hidden) {
    refreshPaneOutput();
  }
}

// ── Routing ───────────────────────────────────────────────────────────────────
// What a hash shows is decided in routes.ts (resolveRoute); this shell renders it.

function navigate(hash: string): void {
  location.hash = hash;
}

// Orchestrators (one per Claude account, say) each have a Home: #/home/<name>.
const orchestrators = (): OrchestratorView[] => store.appState?.orchestrators ?? [];

/** The orchestrator whose Home was opened last on this phone. */
function lastHome(): string | null {
  try { return localStorage.getItem(STORAGE_HOME); } catch { return null; }
}

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
// while it works, and a plain messenger composer without terminal keys.
let homeActivity: string | null = null; // latest tool call since the orchestrator last spoke
let homeStatusHtml = ''; // last rendered status bar, to skip no-op DOM writes

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

// An orchestrator started from the list: its Home opens once the state shows it running.
let startingHome: string | null = null;

async function startOrchestratorFlow(name: string): Promise<void> {
  startingHome = name;
  renderAgentsDashboard(); // the button shows it's starting
  try {
    await apiPost(`/api/orchestrators/${encodeURIComponent(name)}/start`);
  } catch (err) {
    startingHome = null;
    showToast('Could not start the orchestrator', (err as Error).message);
    if (isAgentsRoute(location.hash)) renderAgentsDashboard();
  }
}

function handleRoute(e?: Event): void {
  if (!getToken()) {
    renderTokenScreen();
    return;
  }
  if (goHomeToOrchestrator()) return; // the hashchange re-enters handleRoute
  routeRendered = true;

  stopPaneRefresh();
  view.activePaneId = null;
  view.homeMode = false;
  dropPendingAnswer(); // left the pane: nothing to go back from

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
    renderAgentsDashboard();
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
  stopPaneRefresh();
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

// The pane's ⋮ (ui/Modals.tsx): Rename… (then the header here), Clear, Stop.
function agentMenu(paneId: string): void {
  const agent = findPane(paneId)?.pane.agent;
  openAgentMenu(paneId, agent?.displayName || agent?.name || '', {
    clear: () => { void clearAgentFlow(paneId); },
    stop: () => { void stopAgentFlow(paneId); },
    renamed: refreshPaneHeader,
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

// ── Agents dashboard ──────────────────────────────────────────────────────────

// One dashboard card. The list is flat (most recent status change first, see
// dashboardCards), so each card names its own workspace; `branch` and the
// `worktree` chip come from that workspace. pane.title is usually null, so the
// tab name is the card label, with a per-tab index for split-pane agents.
// A card's label: its tab name (the agent kind if a tab somehow has no label),
// with a per-tab index for split-pane agents.
function cardTitle({ pane, tabLabel, tabAgentIndex, tabAgentCount }: DashboardCard): string {
  const base = tabLabel || pane.agent?.name || pane.agent?.displayName || 'agent';
  return tabAgentCount > 1 ? `${base} #${tabAgentIndex}` : base;
}

function renderCard(card: DashboardCard): string {
  const { pane, workspaceLabel, branch, isWorktree } = card;
  const { paneId, agent, title } = pane;
  const { displayName, name, customStatus, message, sinceUnixMs } = agent!;
  // The chip shows the stable agent kind, so prefer `name` (raw pane.agent,
  // e.g. "claude"/"codex") over displayName, which can be a richer label.
  const agentKind = name || displayName || 'agent';
  const cardLabel = cardTitle(card);
  const statusClass = shownStatus(pane, store.seenDone) || 'unknown';
  const meta = customStatus || message || '';
  const relTime = relativeTime(sinceUnixMs);

  return `
    <div class="agent-card" data-pane-id="${escHtml(paneId)}" role="button" tabindex="0">
      <div class="agent-card-header">
        <span class="agent-name">${escHtml(cardLabel)}</span>
        ${branch ? `<span class="card-branch">${escHtml(branch)}</span>` : ''}
        <span class="status-badge ${escHtml(statusClass)}">${escHtml(statusClass)}</span>
      </div>
      ${meta ? `<div class="agent-custom-status">${escHtml(meta)}</div>` : ''}
      <div class="agent-card-meta">
        <span class="card-workspace">${escHtml(workspaceLabel)}</span>
        <span class="agent-kind">${escHtml(agentKind)}</span>
        ${isWorktree ? '<span class="card-worktree">worktree</span>' : ''}
        ${title ? `<span class="pane-title">${escHtml(title)}</span>` : ''}
        ${relTime ? `<span>${escHtml(relTime)}</span>` : ''}
      </div>
    </div>`;
}

// State pushes (agent_status_changed and friends) arrive continuously while the
// user reads the list. Rebuilding the whole #screen subtree on each one used to
// recreate #screen-agents — the scroll container — snapping scrollTop back to
// the top and, mid-drag, cancelling the in-progress touch scroll. So the
// container is kept stable (only its inner groups are replaced, which preserves
// scrollTop and iOS momentum) and rebuilds are deferred while a finger is down,
// flushing when it lifts (mirrors the terminal view's touch handling).
let agentsTouchActive = false;
let agentsRenderPending = false;

function onAgentsTouchEnd(e: TouchEvent): void {
  if (e.touches.length > 0) return; // other fingers still down
  agentsTouchActive = false;
  if (!agentsRenderPending) return;
  agentsRenderPending = false;
  // Rebuild on the next macrotask, not synchronously: a stationary tap synthesizes
  // a `click` on the tapped card right after touchend, and replacing the card here
  // would drop that tap (navigation lost). Deferring lets the click — and any
  // resulting navigation — land first. Only rebuild if the dashboard is still the
  // mounted view (its container survives only while shown) and the session is
  // still authenticated, so a tap-away, a 401 that swapped in the token screen, or
  // any other navigation isn't overwritten with stale agent data.
  setTimeout(() => {
    if (getToken() && document.getElementById('screen-agents')) renderAgentsDashboard();
  }, 0);
}

function renderAgentsDashboard(): void {
  // #/agents/<name> (opened from that orchestrator's Home): its account's agents, with a Back to its Home
  const scope = agentsScope(location.hash, store.appState);
  // Orchestrators have no cards, so this is the way to a Home: its own, else the one used last
  const home = scope ?? defaultHome(store.appState, lastHome());
  const { left, right } = setLegacyTopbar({
    titleHtml: 'Agents' + (scope ? `<span class="topbar-subtitle">&#183; ${escHtml(orchestratorLabel(scope))}</span>` : ''),
    leftHtml: home ? '<button class="topbar-back" aria-label="Home">&#8592; Home</button>' : '',
    rightHtml: `<button class="topbar-action" id="btn-new-agent" aria-label="New agent">+</button>` +
      `<button class="topbar-action" id="btn-settings" aria-label="Settings">&#9881;</button>`,
  });
  if (home) left.querySelector('button')!.addEventListener('click', () => navigate(homeHash(home.name)));
  right.querySelector('#btn-new-agent')!.addEventListener('click', () => { void openNewAgent(); });
  right.querySelector('#btn-settings')!.addEventListener('click', () => navigate('#/settings'));

  if (!store.appState) {
    setLegacyScreen('agents', `<div id="screen-agents" style="display:flex;align-items:center;justify-content:center;height:100%;"><span class="loading-spinner"></span></div>`);
    return;
  }

  // A scroll gesture is in progress on the list — rebuilding now would cancel it
  // and reset the scroll position. Defer until the finger lifts (onAgentsTouchEnd).
  // An absent container means we're re-entering the route; fall through to rebuild
  // it (which also clears any stale gesture flag) rather than deferring forever.
  if (agentsTouchActive && document.getElementById('screen-agents')) {
    agentsRenderPending = true;
    return;
  }

  const { workspaces = [] } = store.appState;
  const cards = agentCards(scope);
  // configured orchestrators that aren't running get a Start button atop the list
  const stopped = orchestrators().filter((o) => !o.paneId);
  const starts = stopped.length === 0 ? '' : '<div class="orch-start"><span class="orch-start-label">Start</span>' +
    stopped.map((o) => `<button class="orch-start-btn" data-orch="${escHtml(o.name)}"${startingHome === o.name ? ' disabled' : ''}>` +
      `${escHtml(o.label || o.name)}${startingHome === o.name ? ' …' : ''}</button>`).join('') + '</div>';
  const inner = starts + (workspaces.length === 0 ? '<div class="empty-state">No workspaces found.</div>'
    : cards.length === 0 ? '<div class="empty-state">No active agents.</div>'
    : `<div class="agent-list">${cards.map(renderCard).join('')}</div>`);

  // Keep the #screen-agents scroll container stable across state-push rebuilds:
  // replacing only its inner content preserves scrollTop and iOS momentum, while
  // the touch-defer above keeps an active drag from being cancelled. The container
  // is (re)created only when absent (first paint, or after leaving and returning
  // to the route) — the loading-spinner placeholder lacks data-ready.
  let scroller = document.getElementById('screen-agents') as HTMLElement | null;
  if (!scroller || !scroller.dataset.ready) {
    setLegacyScreen('agents', '<div id="screen-agents" data-ready="1"></div>');
    scroller = document.getElementById('screen-agents') as HTMLElement;
    agentsTouchActive = false;
    agentsRenderPending = false;
    scroller.addEventListener('touchstart', () => { agentsTouchActive = true; }, { passive: true });
    scroller.addEventListener('touchend', onAgentsTouchEnd, { passive: true });
    scroller.addEventListener('touchcancel', onAgentsTouchEnd, { passive: true });
  }
  scroller.innerHTML = inner;

  // Attach tap handlers
  scroller.querySelectorAll('.orch-start-btn').forEach((b) => {
    b.addEventListener('click', () => { void startOrchestratorFlow((b as HTMLElement).dataset.orch!); });
  });
  scroller.querySelectorAll('.agent-card').forEach((card) => {
    const el = card as HTMLElement;
    const paneId = el.dataset.paneId!;
    const activate = () => navigate(paneRoute(store.appState, paneId));
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') activate(); });
  });
}

// ── Pane detail ───────────────────────────────────────────────────────────────

function findPane(paneId: string) {
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

function paneHeaderHtml(found: ReturnType<typeof findPane>, paneId: string): string {
  const label = found?.pane?.agent?.displayName || found?.pane?.agent?.name || found?.pane?.title || paneId;
  const context = found ? `${found.ws.label} / ${found.tab.label}` : '';
  return `${escHtml(label)}${context ? `<span class="topbar-subtitle">&#183; ${escHtml(context)}</span>` : ''}`;
}

// An orchestrator's name: its configured label, else its workspace label.
function orchestratorLabel(o: OrchestratorView | undefined): string {
  return o?.label || (o?.paneId ? findPane(o.paneId)?.ws.label : '') || o?.name || 'Home';
}

// Home's title: the orchestrator's name and what it's up to.
function homeHeaderHtml(found: ReturnType<typeof findPane>): string {
  const st = found?.pane?.agent?.status ?? '';
  const sub = st === 'working' ? 'working…' : st === 'blocked' ? 'needs you' : 'ready';
  return `${escHtml(orchestratorLabel(orchestratorOfPane(store.appState, view.activePaneId)))}<span class="topbar-subtitle home-state ${escHtml(st)}">&#183; ${sub}</span>`;
}

function refreshPaneHeader(): void {
  if (!view.activePaneId) return;
  const found = findPane(view.activePaneId);
  if (found) setLegacyTopbar({ titleHtml: view.homeMode ? homeHeaderHtml(found) : paneHeaderHtml(found, view.activePaneId) });
}

// The agents a list or a Home shows, most recent status change first: never the
// orchestrators, and for an orchestrator (`scope`) only its account's agents —
// all of them when that isn't known (pure helper, tested in dashboard-group.test.ts).
function agentCards(scope?: OrchestratorView): DashboardCard[] {
  return dashboardCards(store.appState?.workspaces ?? [], orchestrators().map((o) => o.paneId), scope?.agents ?? null);
}

// Home status bar: its agents waiting on the user (tap → that agent) and counts of
// the rest (tap → its list). Rewritten only when its content changes, so the
// constant state pushes don't replace a chip under a finger.
function renderHomeStatus(): void {
  const el = document.getElementById('home-status');
  if (!el || !store.appState) return;
  const s = homeSummary(agentCards(orchestratorOfPane(store.appState, view.activePaneId)), store.seenDone);
  // With several orchestrators running, a switcher between their Homes (tap = that
  // orchestrator's pane, which routes to its Home like any chip), each with its status.
  const running = orchestrators().filter((o) => o.paneId);
  const switcher = running.length < 2 ? '' : '<div class="home-switch">' + running.map((o) => {
    const pane = findPane(o.paneId!)?.pane;
    const st = pane?.agent ? shownStatus(pane, store.seenDone) : 'unknown';
    return `<button class="home-switch-btn${o.paneId === view.activePaneId ? ' active' : ''}" data-pane-id="${escHtml(o.paneId!)}">` +
      `<i class="home-dot ${escHtml(st)}"></i>${escHtml(orchestratorLabel(o))}</button>`;
  }).join('') + '</div>';
  const chips = s.blocked.map((c) =>
    `<button class="home-chip" data-pane-id="${escHtml(c.pane.paneId)}">${escHtml(cardTitle(c))}<span class="home-chip-ws">${escHtml(c.workspaceLabel)}</span></button>`).join('');
  const html = switcher + (chips ? `<div class="home-attn"><span class="home-attn-label">Needs you</span>${chips}</div>` : '') +
    '<button class="home-counts" data-go="agents">' +
    `<span><i class="home-dot working"></i>${s.working} working</span>` +
    `<span><i class="home-dot done"></i>${s.done} done</span>` +
    `<span><i class="home-dot idle"></i>${s.idle} idle</span>` +
    '<span class="home-counts-more">All agents &#8250;</span></button>';
  if (html === homeStatusHtml) return;
  homeStatusHtml = html;
  el.innerHTML = html;
}

// Home "doing now" line: shown only while the orchestrator works — its latest
// tool call, or "thinking…" between them.
function renderHomeActivity(): void {
  const el = document.getElementById('home-activity');
  if (!el) return;
  const working = view.activePaneId !== null && findPane(view.activePaneId)?.pane?.agent?.status === 'working';
  el.style.display = working ? '' : 'none';
  if (working) el.textContent = homeActivity ? `▸ ${homeActivity}` : 'thinking…';
}

async function renderPaneDetail(paneId: string): Promise<void> {
  const found = findPane(paneId);
  if (view.homeMode) {
    const { right } = setLegacyTopbar({
      titleHtml: homeHeaderHtml(found),
      leftHtml: '',
      rightHtml: `<button class="topbar-action home-agents-btn" id="btn-home-agents">Agents</button>` +
        // terminal ⇄ chat, as on any pane (Esc / Ctrl+C / arrows live in the terminal's keys)
        `<button class="topbar-action view-toggle home-view-toggle" id="btn-view-toggle" style="display:none;" aria-label="Toggle terminal">&gt;_</button>` +
        `<button class="topbar-action" id="btn-agent-menu" aria-label="Agent actions">&#8942;</button>`,
    });
    right.querySelector('#btn-home-agents')!.addEventListener('click', () => navigate(homeAgentsHash(location.hash)));
    right.querySelector('#btn-view-toggle')!.addEventListener('click', () => {
      if (view.paneViewMode === 'chat') switchToTerminal(false); else switchToChat(undefined, false);
    });
    right.querySelector('#btn-agent-menu')!.addEventListener('click', () => agentMenu(paneId));
  } else {
    const backRoute = view.paneBackRoute;
    const { left, right } = setLegacyTopbar({
      titleHtml: paneHeaderHtml(found, paneId),
      leftHtml: `<button class="topbar-back" aria-label="Back">&#8592; ${backRoute.startsWith('#/home/') ? 'Home' : 'Agents'}</button>`,
      // View toggle (terminal ⇄ chat, hidden until a claude transcript is found) +
      // the agent-actions kebab (rename / clear / stop).
      rightHtml: `<button class="topbar-action view-toggle" id="btn-view-toggle" style="display:none;">Chat</button>` +
        `<button class="topbar-action" id="btn-agent-menu" aria-label="Agent actions">&#8942;</button>`,
    });
    right.querySelector('#btn-view-toggle')!.addEventListener('click', () => {
      if (view.paneViewMode === 'chat') switchToTerminal(); else switchToChat();
    });
    right.querySelector('#btn-agent-menu')!.addEventListener('click', () => agentMenu(paneId));
    left.querySelector('button')!.addEventListener('click', () => navigate(backRoute));
  }

  // each pane opens fitted to width, scrolled to the bottom
  paneViewGen++;
  paneFontPx = null;
  terminalTouchActive = false;
  pendingAnsi = null;
  lastLiveAnsi = '';
  historyFetchedAt = 0;
  historyRefreshing = false;
  appScrollPane = false;
  wheelQueue = 0;
  stopFling();
  // chat view starts closed; availability is probed after the terminal loads
  view.paneViewMode = 'terminal';
  chatAvailable = false;
  chatSessionId = null;
  chatCursor = 0;
  chatProbeActive = 0; // a prior pane's in-flight probe must not block this pane's probe
  promptPanelKind = 'none';
  promptScreenId = '';
  stopPromptScreenPoll();

  // Build screen HTML. The terminal holds two sections that are updated
  // independently so live pushes never touch the scrollback DOM above:
  // #term-history (scrollback prefix) + #term-live (current screen).
  setLegacyScreen('pane', `
    <div id="screen-pane"${view.homeMode ? ' class="screen-home"' : ''} style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
      ${view.homeMode ? '<div class="home-status" id="home-status"></div>' : ''}
      <div class="terminal-output" id="terminal-output"><div id="term-history"></div><div id="term-live"><span class="loading-spinner"></span></div></div>
      <div class="chat-log" id="chat-log" style="display:none;"></div>
      ${view.homeMode ? '<div class="home-activity" id="home-activity" style="display:none;"></div>' : ''}
      <div class="chat-prompt" id="chat-prompt" style="display:none;"></div>
      <div class="input-bar">
        <div class="input-row">
          <textarea id="pane-input" rows="1" placeholder="${view.homeMode ? `Message ${escHtml(orchestratorLabel(orchestratorOfPane(store.appState, paneId)))}…` : 'Send text…'}" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
          <button class="input-send-btn" id="btn-send-enter">Send</button>
        </div>
        <div class="quickkey-row" id="quickkey-row"${view.homeMode ? ' style="display:none;"' : ''}></div>
      </div>
    </div>
  `);

  if (view.homeMode) {
    homeStatusHtml = '';
    homeActivity = null;
    document.getElementById('home-status')!.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const chip = t.closest('[data-pane-id]') as HTMLElement | null;
      if (chip) navigate(paneRoute(store.appState, chip.dataset.paneId!));
      else if (t.closest('[data-go="agents"]')) navigate(homeAgentsHash(location.hash));
    });
    renderHomeStatus();
  }

  const terminalEl = document.getElementById('terminal-output')!;
  bindPinchZoom(terminalEl);
  bindTerminalScroll(terminalEl);

  // Answer a pending prompt: tapping an option sends its menu key.
  document.getElementById('chat-prompt')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.ask-opt') as HTMLElement | null;
    if (!btn || !view.activePaneId) return;
    const send = btn.dataset.askSend;
    if (send) void sendAskAnswer(send, btn);
  });

  // Send button. On a touch device Enter in the field inserts a newline — sending
  // happens only via the button, so the phone keyboard can't fire off half-typed
  // commands. On a PC Enter sends and Shift+Enter inserts a newline (composer-keys.ts).
  // This is the one composer: an agent's pane and an orchestrator's Home alike.
  const paneInput = document.getElementById('pane-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('btn-send-enter') as HTMLButtonElement;
  paneInput.addEventListener('keydown', (e) => {
    if (!enterSends(e, matchMedia(DESKTOP_QUERY).matches)) return;
    e.preventDefault();
    if (!e.repeat) sendBtn.click(); // a held Enter sends once, not once per auto-repeat
  });

  const autoGrow = (): void => {
    paneInput.style.height = 'auto';
    paneInput.style.height = `${Math.min(paneInput.scrollHeight, 120)}px`;
  };
  paneInput.addEventListener('input', autoGrow);
  // A new agent's first task the bridge couldn't deliver lands here, ready to send, and
  // stays (with the user's edits) until sent, so leaving the pane doesn't lose it. While
  // its send is in flight the composer is locked, here and in a view reopened meanwhile.
  const keptDraft = keptTasks.draft(paneId);
  if (keptDraft !== null) {
    paneInput.value = keptDraft;
    autoGrow();
  }
  paneInput.disabled = keptTasks.sending(paneId);
  paneInput.addEventListener('input', () => keptTasks.edit(paneId, paneInput.value));

  const clearInput = (): void => {
    paneInput.value = '';
    autoGrow();
  };

  sendBtn.addEventListener('click', async () => {
    const text = paneInput.value;
    if (!text || keptTasks.sending(paneId)) return;
    const kept = keptTasks.beginSend(paneId, text); // false unless the pane has a kept task
    if (kept) paneInput.disabled = true;
    let restored: string | null = null;
    try {
      // clear:true wipes the pane's composer first so this message submits on its
      // own — never merged with a half-typed draft the user left in the pane that
      // yoicks can't see. Scope it to Claude Code panes: Ctrl+U safely clears
      // Claude's input box, but to another app it's a raw control byte a
      // full-screen / non-readline TUI could act on. Other panes just get
      // text+enter. enter:true then submits in the same request.
      const isClaude = findPane(paneId)?.pane?.agent?.name === 'claude';
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { text, enter: true, ...(isClaude ? { clear: true } : {}) });
      if (kept) keptTasks.finishSend(paneId, true);
      if (paneInput.value === text) clearInput(); // clear on success, but keep text typed mid-send
      queuePaneEcho();
    } catch (err) {
      if (kept) restored = keptTasks.finishSend(paneId, false);
      showToast('Send failed', (err as Error).message);
    } finally {
      if (kept) {
        // Unlock the pane's composer as displayed now — this view's, or one reopened
        // during the send (this textarea is then detached) — and on failure show the
        // task in it again.
        paneInput.disabled = false;
        const live = view.activePaneId === paneId ? document.getElementById('pane-input') as HTMLTextAreaElement | null : null;
        if (live) {
          live.disabled = false;
          if (restored !== null) {
            live.value = restored;
            live.dispatchEvent(new Event('input')); // resize it
          }
        }
      }
    }
  });

  // Quick-key row
  buildQuickKeys(paneId);

  // Current screen first (small, fast), then the scrollback above it so the
  // view is continuously scrollable from the very first swipe.
  const gen = paneViewGen;
  await refreshPaneOutput();
  // If the user switched panes while the first read was in flight, this old
  // continuation must not run loadHistoryPrefix against the new pane — it would
  // slice the recent buffer with lastLiveAnsi='' and duplicate the screen.
  if (gen !== paneViewGen || paneId !== view.activePaneId) return;
  void loadHistoryPrefix();

  // Start polling while this pane is visible
  startPaneRefresh();

  // Probe whether this pane has a Claude transcript; if so reveal the toggle and
  // switch to chat when it's the preferred view.
  void initChatAvailability(paneId);
}

// ── Chat view ─────────────────────────────────────────────────────────────────

interface TranscriptResponse {
  available: boolean;
  sessionId?: string;
  items?: TimelineItem[];
  cursor?: number;
  reset?: boolean;
  truncated?: boolean;
}

// Chat is the default view; the terminal is only preferred if explicitly chosen.
function preferredView(): 'terminal' | 'chat' {
  return localStorage.getItem(STORAGE_VIEW) === 'terminal' ? 'terminal' : 'chat';
}

function updateViewToggleLabel(): void {
  const btn = document.getElementById('btn-view-toggle');
  if (btn) btn.textContent = view.homeMode ? (view.paneViewMode === 'chat' ? '>_' : 'Chat') : (view.paneViewMode === 'chat' ? 'Terminal' : 'Chat');
  // Home hides the terminal keys while chatting; they come back with the terminal
  if (view.homeMode) document.getElementById('quickkey-row')?.style.setProperty('display', view.paneViewMode === 'chat' ? 'none' : '');
}

function showViewToggle(visible: boolean): void {
  const btn = document.getElementById('btn-view-toggle');
  if (btn) btn.style.display = visible ? '' : 'none';
}

// One GET decides availability, reveals the toggle, and (when chat is preferred)
// switches straight in using the payload it just fetched — no second request.
async function initChatAvailability(paneId: string): Promise<void> {
  if (chatProbeActive) return; // one probe in flight — don't overlap (so a slow probe still applies)
  const gen = paneViewGen;
  const probeId = ++chatProbeSeq;
  chatProbeActive = probeId;
  try {
    const data = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/transcript`) as TranscriptResponse;
    // gen/paneId invalidate a probe from a prior pane; the in-flight guard means
    // no concurrent re-probe supersedes this one, so a slow probe still applies.
    if (probeId !== chatProbeSeq || gen !== paneViewGen || paneId !== view.activePaneId) return;
    chatAvailable = data.available;
    showViewToggle(chatAvailable);
    // the orchestrator is someone to talk to: always open it as chat
    if (chatAvailable && (preferredView() === 'chat' || orchestratorOfPane(store.appState, paneId))) switchToChat(data, false);
    else updateViewToggleLabel(); // staying on the terminal: Home reveals its keys
  } catch {
    // leave the terminal view; toggle stays hidden (Home reveals the keys)
    if (gen === paneViewGen) updateViewToggleLabel();
  } finally {
    if (chatProbeActive === probeId) chatProbeActive = 0; // only our own probe clears the guard
  }
}

// persist=true only for an explicit user toggle; automatic switches (honoring an
// existing preference, or falling back on a transient transcript miss) must not
// rewrite the stored preference.
function switchToChat(initial?: TranscriptResponse, persist = true): void {
  if (!chatAvailable || !view.activePaneId) return;
  view.paneViewMode = 'chat';
  if (persist) localStorage.setItem(STORAGE_VIEW, 'chat');
  document.getElementById('terminal-output')?.style.setProperty('display', 'none');
  document.getElementById('chat-log')?.style.setProperty('display', '');
  updateViewToggleLabel();
  if (initial?.items) {
    chatSessionId = initial.sessionId ?? null;
    chatCursor = initial.cursor ?? 0;
    renderChatReset(initial.items);
  } else {
    void loadChatInitial();
  }
  wsSendWatch(); // server: stop pane watch, start transcript watch
  updatePromptPanel(); // reveal the answer panel if the pane is already blocked
}

function switchToTerminal(persist = true): void {
  view.paneViewMode = 'terminal';
  if (persist) localStorage.setItem(STORAGE_VIEW, 'terminal');
  document.getElementById('chat-log')?.style.setProperty('display', 'none');
  document.getElementById('terminal-output')?.style.setProperty('display', '');
  updateViewToggleLabel();
  updatePromptPanel(); // hide the answer panel (chat-only)
  wsSendWatch(); // server: stop transcript watch, resume pane watch
  void refreshPaneOutput(); // repaint the live screen the user returns to
}

async function loadChatInitial(): Promise<void> {
  if (!view.activePaneId) return;
  const gen = paneViewGen;
  const paneId = view.activePaneId;
  // switchToChat starts the WS transcript watch alongside this request; if that
  // watch (or anything else) advances the chat state while this GET is in flight,
  // its result is stale — capture the start state and drop a mismatched reply so
  // the slower initial load can't replace a fresher log or rewind the cursor.
  const reqSession = chatSessionId;
  const reqCursor = chatCursor;
  try {
    const data = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/transcript`) as TranscriptResponse;
    if (gen !== paneViewGen || paneId !== view.activePaneId || view.paneViewMode !== 'chat') return;
    if (chatSessionId !== reqSession || chatCursor !== reqCursor) return; // superseded in flight
    if (!data.available) { chatAvailable = false; showViewToggle(false); switchToTerminal(false); return; }
    chatSessionId = data.sessionId ?? null;
    chatCursor = data.cursor ?? 0;
    renderChatReset(data.items ?? []);
  } catch {
    // keep whatever is shown; the WS watch will refresh
  }
}

function renderChatReset(items: TimelineItem[], preserveScroll = false): void {
  const chat = document.getElementById('chat-log');
  if (!chat) return;
  // A reconnect re-watch resends the same session's tail; keep the user where
  // they were reading instead of snapping to the bottom.
  const prevTop = chat.scrollTop;
  const prevFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  if (view.homeMode) {
    homeActivity = latestActivity(items, null);
    renderHomeActivity();
    items = conversationItems(items);
  }
  chat.innerHTML = items.length ? renderItems(items) : '<div class="chat-empty">No messages yet.</div>';
  chat.scrollTop = preserveScroll
    ? (prevFromBottom < 40 ? chat.scrollHeight : prevTop)
    : chat.scrollHeight;
}

function appendChatItems(items: TimelineItem[]): void {
  const chat = document.getElementById('chat-log');
  if (!chat || items.length === 0) return;
  if (view.homeMode) {
    homeActivity = latestActivity(items, homeActivity);
    renderHomeActivity();
    items = conversationItems(items);
    if (items.length === 0) return;
  }
  // follow the bottom only if the user is already there — don't yank them out of
  // history they've scrolled up to read.
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
  chat.querySelector('.chat-empty')?.remove();
  chat.insertAdjacentHTML('beforeend', renderItems(items));
  if (atBottom) chat.scrollTop = chat.scrollHeight;
}

function onTranscriptItems(msg: WsTranscriptItemsMessage): void {
  if (!msg.available) {
    chatAvailable = false;
    showViewToggle(false);
    if (view.paneViewMode === 'chat') switchToTerminal(false);
    return;
  }
  chatAvailable = true;
  showViewToggle(true);
  if (view.paneViewMode !== 'chat') return; // availability noted; content applies only in chat mode
  if (msg.reset || msg.sessionId !== chatSessionId) {
    // Same session (a reconnect re-watch) → keep scroll; a new session → bottom.
    const sameSession = msg.sessionId != null && msg.sessionId === chatSessionId;
    chatSessionId = msg.sessionId ?? null;
    chatCursor = msg.cursor;
    renderChatReset(msg.items, sameSession);
  } else {
    chatCursor = msg.cursor;
    appendChatItems(msg.items);
  }
}

// HTTP fallback while the WS is down: fetch items past the cursor for the same
// session (mirrors the transcript watch).
async function pollChatFallback(): Promise<void> {
  if (!view.activePaneId || view.paneViewMode !== 'chat') return;
  const gen = paneViewGen;
  const paneId = view.activePaneId;
  // The response is only valid against the state this request started from. If
  // anything (a WS reset/push, or a newer poll) advances the session or cursor
  // while the request is in flight, applying it — append OR reset — would
  // duplicate or rewind, so capture the start state and drop a mismatched reply.
  const reqCursor = chatCursor;
  const reqSession = chatSessionId;
  const q = chatSessionId ? `?session=${encodeURIComponent(chatSessionId)}&after=${reqCursor}` : '';
  try {
    const data = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/transcript${q}`) as TranscriptResponse;
    if (gen !== paneViewGen || paneId !== view.activePaneId || view.paneViewMode !== 'chat') return;
    // Drop any response whose request start no longer matches the current state
    // BEFORE acting on it — a stale available:false must not force the terminal
    // after a WS push/reset already advanced the chat.
    if (chatSessionId !== reqSession || chatCursor !== reqCursor) return; // superseded in flight
    if (!data.available) { chatAvailable = false; showViewToggle(false); switchToTerminal(false); return; }
    if (data.reset || data.sessionId !== chatSessionId) {
      chatSessionId = data.sessionId ?? null;
      chatCursor = data.cursor ?? 0;
      renderChatReset(data.items ?? []);
    } else {
      const next = data.cursor ?? chatCursor;
      if (next <= chatCursor) return; // no new items past what we've shown
      chatCursor = next;
      appendChatItems(data.items ?? []);
    }
  } catch {
    // transient; retry next tick
  }
}

function buildQuickKeys(paneId: string): void {
  const KEYS: Array<{ label: string; payload: Record<string, unknown> }> = [
    { label: 'Enter',  payload: { keys: ['enter'] } },
    { label: '⌫',      payload: { keys: ['backspace'] } },
    { label: 'Esc',    payload: { keys: ['esc'] } },
    { label: 'Ctrl+C', payload: { keys: ['ctrl+c'] } },
    { label: '↑',      payload: { keys: ['up'] } },
    { label: '↓',      payload: { keys: ['down'] } },
    { label: 'Tab',    payload: { keys: ['tab'] } },
    { label: 'y',      payload: { text: 'y', enter: true } },
    { label: 'n',      payload: { text: 'n', enter: true } },
    { label: '1',      payload: { text: '1' } },
    { label: '2',      payload: { text: '2' } },
    { label: '3',      payload: { text: '3' } },
  ];

  const row = document.getElementById('quickkey-row');
  if (!row) return;

  for (const key of KEYS) {
    const btn = document.createElement('button');
    btn.className = 'qkey';
    btn.textContent = key.label;
    btn.addEventListener('click', async () => {
      try {
        await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, key.payload);
        queuePaneEcho();
      } catch (err) {
        showToast('Key send failed', (err as Error).message);
      }
    });
    row.appendChild(btn);
  }
}

// ── Fit-to-width rendering with pinch zoom ────────────────────────────────────

// null = auto-fit the pane width; a number = font px set by the pinch gesture
let paneFontPx: number | null = null;
let monoRatio: number | null = null; // monospace glyph width / font-size

function measureMonoRatio(el: HTMLElement): number {
  if (monoRatio !== null) return monoRatio;
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(100);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px;';
  probe.style.fontFamily = getComputedStyle(el).fontFamily;
  document.body.appendChild(probe);
  monoRatio = probe.offsetWidth / 100 / 100 || 0.6;
  probe.remove();
  return monoRatio;
}

function applyFitFontSize(outputEl: HTMLElement, ansiStr: string): void {
  if (paneFontPx !== null) {
    outputEl.style.fontSize = `${paneFontPx.toFixed(2)}px`;
    return;
  }
  const plain = ansiStr.replace(/\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
  let cols = 20;
  for (const line of plain.split('\n')) {
    const w = displayCols(line);
    if (w > cols) cols = w;
  }
  const padding = 32; // .terminal-output horizontal padding
  const avail = outputEl.clientWidth - padding;
  const px = avail / (cols * measureMonoRatio(outputEl));
  // clamp: below ~6px nothing is readable — fall back to horizontal scrolling
  outputEl.style.fontSize = `${Math.max(6, Math.min(14, px)).toFixed(2)}px`;
}

// Pinch-to-zoom on the terminal: two fingers scale the font, double-tap
// returns to fit-to-width. Page-level zoom stays untouched elsewhere.
// Also tracks whether any finger is on the terminal: replacing the DOM
// mid-gesture cancels the browser's touch scroll, so renders are deferred
// while a gesture is active (see renderPaneOutput).
const WHEEL_STEP_PX = 12; // finger travel per forwarded wheel event

function bindPinchZoom(outputEl: HTMLElement): void {
  let pinchStartDist = 0;
  let pinchStartPx = 0;
  let lastTapEndAt = 0;
  let tapStartX = 0;
  let tapStartY = 0;
  let tapCandidate = false;
  let lastTouchY = 0;
  let wheelAccum = 0;
  let touchVelocity = 0; // px/ms, positive = finger moving down (scroll up)
  let lastMoveAt = 0;
  // Forward app-scroll wheel steps only for a gesture that began as a single
  // finger and never became a pinch. Dropping from two fingers to one leaves
  // lastTouchY stale, so forwarding then would send a large scroll burst.
  let singleFingerGesture = false;

  const touchDist = (t: TouchList): number =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  outputEl.addEventListener('touchstart', (e: TouchEvent) => {
    terminalTouchActive = true;
    if (e.touches.length === 2) {
      tapCandidate = false;
      singleFingerGesture = false;
      pinchStartDist = touchDist(e.touches);
      pinchStartPx = parseFloat(getComputedStyle(outputEl).fontSize) || 13;
    } else if (e.touches.length === 1) {
      tapCandidate = true;
      singleFingerGesture = true;
      tapStartX = e.touches[0].clientX;
      tapStartY = e.touches[0].clientY;
      lastTouchY = e.touches[0].clientY;
      wheelAccum = 0;
      touchVelocity = 0;
      lastMoveAt = performance.now();
      stopFling();
    }
  }, { passive: true });

  outputEl.addEventListener('touchmove', (e: TouchEvent) => {
    if (e.touches.length === 1) {
      if (tapCandidate &&
          Math.hypot(e.touches[0].clientX - tapStartX, e.touches[0].clientY - tapStartY) > 10) {
        tapCandidate = false; // a scroll flick is not a tap
      }
      // app-scroll panes: translate vertical swipes into wheel events.
      // preventDefault stops the browser from also scrolling the container
      // off the bottom — that would defer the app's repaint into pendingAnsi
      // and freeze the forwarded scroll until the user returns to the bottom.
      if (appScrollPane && singleFingerGesture) {
        e.preventDefault();
        const y = e.touches[0].clientY;
        const dy = y - lastTouchY;
        const now = performance.now();
        const dt = now - lastMoveAt;
        if (dt > 0 && dt < 200) {
          touchVelocity = 0.7 * touchVelocity + 0.3 * (dy / dt);
        }
        lastMoveAt = now;
        wheelAccum += dy;
        lastTouchY = y;
        while (wheelAccum >= WHEEL_STEP_PX) { wheelAccum -= WHEEL_STEP_PX; queuePaneWheel(true); }
        while (wheelAccum <= -WHEEL_STEP_PX) { wheelAccum += WHEEL_STEP_PX; queuePaneWheel(false); }
      }
    }
    if (e.touches.length !== 2 || pinchStartDist === 0) return;
    e.preventDefault(); // keep the browser from zooming the whole page
    const px = Math.max(4, Math.min(24, pinchStartPx * (touchDist(e.touches) / pinchStartDist)));
    paneFontPx = px;
    outputEl.style.fontSize = `${px.toFixed(2)}px`;
  }, { passive: false });

  outputEl.addEventListener('touchend', (e: TouchEvent) => {
    if (e.touches.length > 0) return; // fingers still down
    terminalTouchActive = false;
    pinchStartDist = 0;

    if (tapCandidate) {
      const now = Date.now();
      tapCandidate = false;
      if (now - lastTapEndAt < 300) {
        // double-tap (two stationary taps): back to the fitted bottom
        lastTapEndAt = 0;
        paneFontPx = null;
        outputEl.scrollTop = outputEl.scrollHeight;
        flushPendingOutput(); // render any deferred screen now we're back at the bottom
        void refreshPaneOutput();
        return;
      }
      lastTapEndAt = now;
    } else {
      lastTapEndAt = 0;
    }

    if (appScrollPane && singleFingerGesture) {
      // A pause before lifting means the last recorded velocity is stale — don't
      // fling off an earlier fast move the user has already stopped.
      if (performance.now() - lastMoveAt > 100) touchVelocity = 0;
      startFling(touchVelocity);
    }
    flushPendingOutput();
  }, { passive: true });

  outputEl.addEventListener('touchcancel', () => {
    terminalTouchActive = false;
    pinchStartDist = 0;
    tapCandidate = false;
    singleFingerGesture = false;
    flushPendingOutput(); // deliver any output deferred during the cancelled gesture
  }, { passive: true });
}

// ── Continuous terminal buffer ────────────────────────────────────────────────
// The terminal is one continuous buffer: #term-history holds the scrollback
// prefix (fetched from source=recent, refreshed at most every 10s while the
// user reads it) and #term-live holds the current screen (updated by WS
// pushes). The view is scrollable from the very first swipe — no modes.

// Bumped on every pane-view render; async work captures it and bails if the
// user navigated away, so stale fetches can't poison the next pane's view.
let paneViewGen = 0;
// Bumped whenever a newer screen is rendered (WS push or HTTP read), so an
// in-flight HTTP read can drop its response if newer output arrived meanwhile.
let outputSeq = 0;
// Incremented when a pane read starts; only the latest in-flight read renders,
// so an earlier HTTP read can't win over a later one.
let refreshReqSeq = 0;
let terminalTouchActive = false; // a finger is on the terminal
let pendingAnsi: string | null = null; // output received while unsafe to render
let lastLiveAnsi = ''; // last rendered screen (for line counts and refits)
let historyFetchedAt = 0;
let lastPrefixEmpty = false; // last prefix fetch found no scrollback
let historyRefreshing = false;
// Full-screen apps (claude etc.) keep no terminal scrollback but scroll their
// own view on SGR mouse wheel events — forward swipes through the bridge's
// /scroll endpoint, which injects real wheel events into the pty.
let appScrollPane = false;
let wheelRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// Wheel events are batched (~70ms windows, sent as steps) so fast swipes
// don't turn into dozens of http requests, and the view refreshes on a
// rolling ~200ms cadence while scroll activity continues.
let wheelQueue = 0; // >0 = up steps, <0 = down steps
let wheelFlushTimer: ReturnType<typeof setTimeout> | null = null;
let lastWheelRefreshAt = 0;

function queuePaneWheel(up: boolean): void {
  if (!appScrollPane) return; // app-scroll off — never queue SGR wheels for a normal pane
  wheelQueue += up ? 1 : -1;
  if (!wheelFlushTimer) {
    wheelFlushTimer = setTimeout(() => { void flushWheelQueue(); }, 70);
  }
}

async function flushWheelQueue(): Promise<void> {
  wheelFlushTimer = null;
  // app-scroll may have turned off (pane left full-screen) since these were
  // queued — drop them so we don't inject SGR wheel bytes into a normal pane.
  if (!appScrollPane) { wheelQueue = 0; stopFling(); return; }
  if (!view.activePaneId || wheelQueue === 0) return;
  const direction = wheelQueue > 0 ? 'up' : 'down';
  const steps = Math.min(30, Math.abs(wheelQueue));
  wheelQueue -= (direction === 'up' ? steps : -steps);
  if (wheelQueue !== 0) {
    // more queued than one request carries — keep flushing
    wheelFlushTimer = setTimeout(() => { void flushWheelQueue(); }, 70);
  }
  try {
    await apiPost(`/api/panes/${encodeURIComponent(view.activePaneId)}/scroll`, { direction, steps });
  } catch { /* transient send failures just skip a scroll step */ }
  const now = Date.now();
  if (now - lastWheelRefreshAt > 200) {
    lastWheelRefreshAt = now;
    void refreshPaneOutput();
  }
  if (wheelRefreshTimer) clearTimeout(wheelRefreshTimer);
  wheelRefreshTimer = setTimeout(() => { void refreshPaneOutput(); }, 150);
}

// Momentum: keep sending decaying wheel batches after the finger lifts, like
// native fling. Renders are not deferred once the touch ends, so the view
// visibly follows the fling.
let flingTimer: ReturnType<typeof setInterval> | null = null;

function stopFling(): void {
  if (flingTimer) { clearInterval(flingTimer); flingTimer = null; }
}

function startFling(velocityPxMs: number): void {
  stopFling();
  let v = Math.max(-3, Math.min(3, velocityPxMs));
  if (Math.abs(v) < 0.4) return;
  flingTimer = setInterval(() => {
    if (!appScrollPane) { stopFling(); return; } // pane left full-screen mid-fling
    v *= 0.82;
    const dist = v * 80;
    const steps = Math.floor(Math.abs(dist) / WHEEL_STEP_PX);
    if (steps === 0) { stopFling(); return; }
    for (let i = 0; i < steps; i++) queuePaneWheel(dist > 0);
  }, 80);
}

const HISTORY_LINES = 1000;
const HISTORY_REFRESH_MS = 10_000;
const EMPTY_HISTORY_RETRY_MS = 1_500; // shorter retry when the last prefix was empty

// Fetch the scrollback and place everything ABOVE the current screen into
// #term-history. source=recent ends with the lines currently on screen, so
// the live section's line count is dropped from its tail to avoid the overlap.
async function loadHistoryPrefix(): Promise<void> {
  // Requires a live screen: source=recent ends with the current screen, and
  // without lastLiveAnsi we can't trim it off, so we'd duplicate it into history.
  // (Bails harmlessly when the first pane read hasn't rendered yet; historyFetchedAt
  // stays 0 so the next above-bottom scroll retries once live output exists.)
  if (!view.activePaneId || historyRefreshing || terminalTouchActive || !lastLiveAnsi) return;
  const gen = paneViewGen;
  const paneId = view.activePaneId;
  historyRefreshing = true;
  try {
    const data = await apiGet(
      `/api/panes/${encodeURIComponent(paneId)}/read?source=recent&lines=${HISTORY_LINES}&format=ansi`
    ) as Record<string, string | null>;
    if (gen !== paneViewGen || paneId !== view.activePaneId) return; // navigated away
    // A gesture may have started while the fetch was in flight; replacing the
    // history DOM / adjusting scrollTop now would cancel or jump it. Bail and
    // leave the cache dirty so the next above-bottom scroll refetches.
    if (terminalTouchActive) { historyFetchedAt = 0; return; }
    const outputEl = document.getElementById('terminal-output');
    const historyEl = document.getElementById('term-history');
    if (!outputEl || !historyEl) return;
    const recentLines = (data.ansi ?? data.text ?? '').split('\n');
    const liveLineCount = lastLiveAnsi ? lastLiveAnsi.split('\n').length : 0;
    const prefix = recentLines.slice(0, Math.max(0, recentLines.length - liveLineCount)).join('\n');
    // appScrollPane is driven by the WS pane_output push (server-computed from
    // fresh herdr scroll metadata) — nothing to recompute here. It only affects
    // the history-start marker below; an empty prefix on a full-screen app shows
    // no marker.
    // anchor by distance from the bottom: content only changes above the fold
    const fromBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight;
    historyEl.innerHTML = prefix
      ? ansiToHtml(prefix)
      : (appScrollPane ? '' : '<div class="history-start">&#183; start of output &#183;</div>');
    // Throttle refetches, but retry an empty result much sooner (see the scroll
    // handler): output may scroll off the live screen and become fetchable
    // history well before the normal 10s window, yet a per-scroll refetch would
    // flood the bridge.
    historyFetchedAt = Date.now();
    lastPrefixEmpty = !prefix;
    outputEl.scrollTop = outputEl.scrollHeight - fromBottom - outputEl.clientHeight;
  } catch {
    // scrollback is best-effort; the live screen keeps working without it
  } finally {
    historyRefreshing = false;
  }
}

function bindTerminalScroll(outputEl: HTMLElement): void {
  // desktop equivalent of the swipe-to-wheel forwarding
  let wheelDeltaAccum = 0;
  outputEl.addEventListener('wheel', (e: WheelEvent) => {
    if (!appScrollPane) return;
    e.preventDefault(); // forward to the app; don't also scroll the container
    wheelDeltaAccum += e.deltaY;
    while (wheelDeltaAccum <= -30) { wheelDeltaAccum += 30; queuePaneWheel(true); }
    while (wheelDeltaAccum >= 30) { wheelDeltaAccum -= 30; queuePaneWheel(false); }
  }, { passive: false });

  outputEl.addEventListener('scroll', () => {
    const fromBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight;
    if (fromBottom < 40) {
      flushPendingOutput();
    } else if (Date.now() - historyFetchedAt >
               (lastPrefixEmpty ? EMPTY_HISTORY_RETRY_MS : HISTORY_REFRESH_MS)) {
      // reading scrollback — freshen the prefix so lines that scrolled off the
      // live screen since the last fetch appear. An empty prefix is retried
      // sooner so newly-produced history shows up without a 10s wait.
      void loadHistoryPrefix();
    }
  }, { passive: true });
}

// Render the current screen into #term-live, following the bottom only when
// the user was already there — never yank them out of scrollback.
function renderPaneOutput(ansiStr: string): void {
  const outputEl = document.getElementById('terminal-output');
  const liveEl = document.getElementById('term-live');
  if (!outputEl || !liveEl) return;
  outputSeq++; // newer screen content — invalidates any in-flight HTTP read
  const atBottom =
    outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 40;
  // Replacing the DOM under an active touch cancels the scroll gesture, and
  // resizing the live section while the user reads above would shift the
  // content they're reading — defer until safe.
  if (terminalTouchActive || !atBottom) {
    pendingAnsi = ansiStr;
    return;
  }
  pendingAnsi = null;
  lastLiveAnsi = ansiStr;
  // live advanced — lines may have scrolled off into history that the cached
  // prefix doesn't have yet; mark it dirty so the next scroll-up refetches.
  historyFetchedAt = 0;
  applyFitFontSize(outputEl, ansiStr);
  liveEl.innerHTML = ansiToHtml(ansiStr);
  outputEl.scrollTop = outputEl.scrollHeight;
}

function flushPendingOutput(): void {
  if (pendingAnsi === null) return;
  const ansi = pendingAnsi;
  pendingAnsi = null;
  renderPaneOutput(ansi); // re-queues itself if still unsafe
}

async function refreshPaneOutput(): Promise<void> {
  if (!view.activePaneId) return;
  const liveEl = document.getElementById('term-live');
  if (!liveEl) return;

  const gen = paneViewGen;
  const seq = outputSeq;
  const reqId = ++refreshReqSeq;
  const paneId = view.activePaneId;
  try {
    const data = await apiGet(
      `/api/panes/${encodeURIComponent(paneId)}/read?source=visible&lines=200&format=ansi`
    ) as Record<string, unknown>;
    if (gen !== paneViewGen || paneId !== view.activePaneId) return; // navigated away
    // A later read started while this one was in flight — let the newest win, so
    // an earlier HTTP read can't overwrite a newer one's fresher output.
    if (reqId !== refreshReqSeq) return;
    // A newer screen (WS push) rendered while this read was in flight — its
    // response is stale, so drop it rather than overwrite the newer content with
    // old output the server won't re-push.
    if (outputSeq !== seq) return;
    // Keep app-scroll fresh on the HTTP fallback path (WS down); the server
    // computes it the same way it does for pane_output pushes.
    if (typeof data.appScroll === 'boolean') appScrollPane = data.appScroll;
    renderPaneOutput((data.ansi ?? data.text ?? '') as string);
  } catch (err) {
    const message = (err as Error).message;
    if (message === '401') return;
    // transient failures (bridge restart, herdr reconnect) must not wipe the
    // terminal the user is reading — keep the last render and toast instead
    if (lastLiveAnsi) {
      const now = Date.now();
      if (now - lastReadErrorToastAt > 10_000) {
        lastReadErrorToastAt = now;
        showToast('Output refresh failed', message);
      }
    } else {
      liveEl.textContent = `Error loading output: ${message}`;
    }
  }
}

let lastReadErrorToastAt = 0;

// Right after sending input, fetch fresh output a couple of times so keypress
// echo feels instant instead of waiting for the next push/poll cycle.
function queuePaneEcho(): void {
  setTimeout(() => { void refreshPaneOutput(); }, 120);
  setTimeout(() => { void refreshPaneOutput(); }, 500);
}

// ── Pending-prompt panel (answer UI when the pane is blocked) ──────────────────

const PROMPT_SCREEN_INTERVAL_MS = 1200;


// When a claude pane is blocked (waiting for input) and chat is active, show an
// answer panel above the input bar: the question and tappable option buttons
// parsed from the live prompt, with the raw terminal screen as collapsible
// context. The composer and quick-keys remain available.
function updatePromptPanel(): void {
  const panel = document.getElementById('chat-prompt');
  if (!panel) return;
  const status = view.activePaneId ? findPane(view.activePaneId)?.pane?.agent?.status : null;
  const blocked = view.paneViewMode === 'chat' && status === 'blocked';
  if (!blocked) {
    // Pane is no longer waiting: the answer (if one was just sent) has landed, so
    // end the post-send cooldown that was suppressing re-taps.
    if (promptPanelKind !== 'none') { panel.style.display = 'none'; panel.innerHTML = ''; promptPanelKind = 'none'; promptScreenId = ''; }
    endAnswerCooldown();
    stopPromptScreenPoll();
    return;
  }
  if (promptPanelKind !== 'blocked') {
    // A fresh blocked episode (panel was hidden, now shown): a distinct prompt, so
    // clear any lingering cooldown from a prior answer before rendering its buttons.
    endAnswerCooldown();
    panel.style.display = '';
    panel.innerHTML =
      `<div class="chat-prompt-head">&#9203; Waiting for your input <span class="chat-prompt-build">${BUILD}</span></div>` +
      '<div class="chat-prompt-q" id="chat-prompt-q"></div>' +
      '<div class="chat-prompt-options" id="chat-prompt-options"></div>' +
      // starts open (no buttons yet, so the terminal is the only UI);
      // renderPromptPanel collapses it once a menu is parsed.
      '<details class="chat-prompt-term" id="chat-prompt-term" open><summary>Terminal</summary>' +
      '<div class="chat-prompt-screen" id="chat-prompt-screen"><span class="loading-spinner"></span></div></details>';
    promptPanelKind = 'blocked';
    promptScreenId = '';
  }
  startPromptScreenPoll();
}

// Clear the "answer just sent" state: re-enable the option buttons and drop the
// in-flight guard. Called when the pane leaves `blocked` (answer landed) or a fresh
// prompt appears, and by a timeout floor in case neither is observed.
function endAnswerCooldown(): void {
  if (answerCooldownTimer) { clearTimeout(answerCooldownTimer); answerCooldownTimer = null; }
  promptAnswerInFlight = false;
  document.getElementById('chat-prompt')?.classList.remove('chat-prompt-sending');
}


// Render the question + option buttons. Rebuild only when the prompt identity
// changes, so a poll tick can't wipe a button the instant the user taps it, and a
// genuinely new prompt (even one with the same parsed signature) does get fresh
// buttons. `sid` is the identity of the screen `parsed` came from.
function renderPromptPanel(parsed: ParsedPrompt | null, sid: string): void {
  const optsEl = document.getElementById('chat-prompt-options');
  if (!optsEl) return;
  if (sid === promptScreenId) return; // same prompt still on screen — don't rebuild (keeps a tap from being wiped)
  promptScreenId = sid;
  // The answer moved the agent on to another prompt (the next question, the Submit tab
  // of several): it landed, and the user stays for that one.
  if (parsed && pendingAnswer && sid !== pendingAnswer.prompt) dropPendingAnswer();
  const qEl = document.getElementById('chat-prompt-q');
  if (qEl) qEl.textContent = parsed?.question ?? '';
  optsEl.innerHTML = (parsed?.options ?? []).map((o) =>
    `<button class="ask-opt" type="button" data-ask-send="${escHtml(o.send)}"><span class="ask-opt-num">${escHtml(o.send)}</span>` +
    `<span class="ask-opt-text"><span class="ask-opt-label">${escHtml(o.label)}</span>` +
    (o.description ? `<span class="ask-opt-desc">${escHtml(o.description)}</span>` : '') + '</span></button>',
  ).join('');
  const term = document.getElementById('chat-prompt-term') as HTMLDetailsElement | null;
  // Collapse the terminal only when we have a question to show above the buttons.
  // If a menu parsed but its question couldn't be extracted, bare "Yes/No" buttons
  // would have no context — keep the terminal open so the user can read the prompt.
  if (term) term.open = !parsed?.question;
  // A different prompt is now on screen (its buttons were just rebuilt, so they are
  // NOT the stale answered ones) — end any post-answer cooldown so these fresh buttons
  // are immediately tappable, even if the pane went blocked→blocked without an observed
  // unblock. A transient unparsable screen (parsed === null) is left to the
  // unblock/floor path, not treated as a new prompt.
  if (parsed) endAnswerCooldown();
}

function startPromptScreenPoll(): void {
  if (promptScreenTimer) return;
  const tick = async (): Promise<void> => {
    if (promptPollActive) return; // a poll is in flight — don't overlap (so slow reads aren't all discarded)
    if (view.paneViewMode !== 'chat' || !view.activePaneId) { stopPromptScreenPoll(); return; }
    if (document.hidden) return; // a full screen read every 1.2s — skip while nobody can see it
    if (findPane(view.activePaneId)?.pane?.agent?.status !== 'blocked') { updatePromptPanel(); return; }
    const reqId = ++promptPollSeq;
    promptPollActive = reqId;
    const paneId = view.activePaneId;
    try {
      const data = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/read?source=visible&format=ansi`) as Record<string, unknown>;
      // stopPromptScreenPoll bumps promptPollSeq to invalidate a poll from a prior
      // session; the in-flight guard means no concurrent tick supersedes this one.
      if (reqId !== promptPollSeq || view.paneViewMode !== 'chat' || paneId !== view.activePaneId) return;
      const ansi = (data.ansi ?? data.text ?? '') as string;
      const stripped = stripAnsi(ansi);
      const parsed = parsePrompt(stripped);
      renderPromptPanel(parsed, parsed ? promptIdentity(stripped) : '');
      const screen = document.getElementById('chat-prompt-screen');
      if (screen) screen.innerHTML = ansiToHtml(ansi);
    } catch { /* transient — keep the last screen */ } finally {
      if (promptPollActive === reqId) promptPollActive = 0; // only our own poll clears the guard
    }
  };
  void tick();
  promptScreenTimer = setInterval(() => { void tick(); }, PROMPT_SCREEN_INTERVAL_MS);
}

function stopPromptScreenPoll(): void {
  if (promptScreenTimer) { clearInterval(promptScreenTimer); promptScreenTimer = null; }
  promptPollSeq++;      // invalidate any in-flight poll so its late response can't render
  promptPollActive = 0; // let a fresh poll start after re-entering (the old one won't clear this)
}

// Read the live prompt off the screen: its parsed form and its region identity
// (null if the read fails). `id` is '' when no prompt/menu is present.
async function readPromptScreen(paneId: string): Promise<{ parsed: ParsedPrompt | null; id: string } | null> {
  try {
    const d = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/read?source=visible&format=ansi`) as Record<string, unknown>;
    const stripped = stripAnsi((d.ansi ?? d.text ?? '') as string);
    const parsed = parsePrompt(stripped);
    return { parsed, id: parsed ? promptIdentity(stripped) : '' };
  } catch { return null; }
}

function dropPendingAnswer(): void {
  if (pendingAnswer?.timer) clearTimeout(pendingAnswer.timer);
  pendingAnswer = null;
}

// After a tapped answer: the pane going `working` shows it reached the agent and the
// agent moved on, so the view goes Back to where the pane was opened from
// (answerOutcome). Several questions only get there after the Submit tab: each earlier
// answer leaves the pane blocked on the next prompt (renderPromptPanel drops the
// pending answer). A permission prompt is treated the same: Yes resumes work, while No
// leaves the agent waiting for the user's instructions (blocked → done, no `working`,
// seen live), so the user stays to type them.
function settlePendingAnswer(): void {
  const a = pendingAnswer;
  if (!a) return;
  if (a.paneId !== view.activePaneId) { dropPendingAnswer(); return; }
  const status = findPane(a.paneId)?.pane?.agent?.status;
  if (status === 'working') a.resumed = true; // may come before the press is confirmed
  const outcome = answerOutcome(a.sent, a.resumed, status);
  if (outcome === 'wait') return;
  dropPendingAnswer();
  if (outcome === 'back' && a.back) navigate(a.back);
}

// Answer by selecting the tapped option. Pressing an option's digit in a numbered
// menu selects AND submits it in one atomic keystroke — verified live: sending "3"
// to an AskUserQuestion answered "cherry" with no Enter and no cursor movement. The
// digit goes as a raw keystroke via send_text (`press`): a digit through send_input
// is bracketed-paste-wrapped and ignored, and keys:[digit] is dropped by herdr (both
// verified live). Selection is by number, so the ❯ cursor's position is irrelevant.
//
// The buttons are only re-rendered on the ~1.2s poll, so the prompt on screen may
// have changed (answered on the desktop, timed out) since they were drawn. We send
// the buttons' prompt identity as `expect_prompt`; the bridge re-reads the screen and
// presses the digit ONLY if it still matches — check and send back-to-back on the
// server, so nothing can slip in between (a client-side check would leave a round-trip
// gap). A mismatch returns 409 and we refresh. An in-flight guard and a per-answer
// generation token keep double-taps and stale async work off the shared guard.
async function sendAskAnswer(target: string, btn: HTMLElement): Promise<void> {
  if (!view.activePaneId || promptAnswerInFlight) return;
  const to = parseInt(target, 10);
  // Claude's prompts never exceed ~6 options, so every option is a single digit; a
  // multi-digit option would submit on its first digit, so refuse it and leave the
  // terminal (always shown below) as the way to answer that out-of-range case.
  if (!Number.isInteger(to) || to < 1 || to > 9) return;
  const expectedId = promptScreenId; // region identity of the prompt these buttons belong to
  if (!expectedId) return;
  const paneId = view.activePaneId;
  const myGen = ++answerGen; // token for THIS answer; a stale POST/timer must not touch a newer one
  promptAnswerInFlight = true;
  if (answerCooldownTimer) { clearTimeout(answerCooldownTimer); answerCooldownTimer = null; }
  const panel = document.getElementById('chat-prompt');
  panel?.classList.add('chat-prompt-sending'); // disable the buttons while the answer settles
  btn.classList.add('ask-opt-sent');
  // Go Back once the agent resumes work — not from Home, and not for "Chat about this",
  // which hands the turn back to the user in this pane. Tracked before the POST: the
  // `working` push can beat its response.
  const chat = /^Chat about this/i.test(btn.querySelector('.ask-opt-label')?.textContent ?? '');
  dropPendingAnswer();
  const pending: PendingAnswer = {
    paneId, gen: myGen, prompt: expectedId, back: view.homeMode || chat ? '' : view.paneBackRoute,
    sent: false, resumed: false, timer: null,
  };
  pendingAnswer = pending;
  try {
    await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { press: String(to), expect_prompt: expectedId });
    if (myGen !== answerGen) return; // a newer tap already superseded this — don't touch shared state
    if (pendingAnswer === pending) {
      pending.sent = true;
      pending.timer = setTimeout(() => {
        if (pendingAnswer !== pending) return;
        dropPendingAnswer();
        if (paneId === view.activePaneId) showToast('Answer not confirmed', 'The prompt is still waiting. Check the terminal.');
      }, ANSWER_CONFIRM_MS);
      settlePendingAnswer();
    }
    // The digit already submitted this prompt, but the panel keeps showing it (with
    // tappable buttons) until the pane's status refreshes. Hold the guard through
    // that window so a double-tap can't fire the same digit again into the *next*
    // prompt or the terminal. It's released the moment the pane leaves `blocked` or a
    // fresh prompt renders (endAnswerCooldown); this timer is only a floor, and it
    // no-ops if a newer answer has since started. No DOM is mutated here — that would
    // risk clobbering another pane's panel if the user navigated away mid-request.
    answerCooldownTimer = setTimeout(() => { if (myGen === answerGen) endAnswerCooldown(); }, 1500);
  } catch (err) {
    if (myGen !== answerGen) return; // superseded — the newer answer owns the guard now
    if (pendingAnswer === pending) dropPendingAnswer(); // not pressed: stay
    btn.classList.remove('ask-opt-sent');
    endAnswerCooldown();
    if ((err as { code?: string }).code === 'prompt_changed') {
      // The prompt advanced before the digit landed — refresh to the live prompt and
      // let the user retap; never send into a different prompt.
      const live = await readPromptScreen(paneId);
      if (myGen === answerGen && paneId === view.activePaneId) renderPromptPanel(live?.parsed ?? null, live?.id ?? '');
      showToast('Prompt changed', 'The prompt updated before your tap was sent — try again.');
    } else {
      showToast('Send failed', (err as Error).message);
    }
  }
}

// Whether the state currently reports this pane as running Claude — the only
// kind that can ever have a transcript, so the only kind worth re-probing.
function paneIsClaude(paneId: string): boolean {
  const agent = findPane(paneId)?.pane?.agent;
  return (agent?.name ?? agent?.displayName ?? '').toLowerCase().includes('claude');
}

function startPaneRefresh(): void {
  stopPaneRefresh();
  paneRefreshTimer = setInterval(() => {
    if (!view.activePaneId || document.hidden) return;
    // A claude pane's transcript may appear shortly after the pane opens (session
    // just started, JSONL not written yet). Re-probe until chat is found so the
    // view upgrades without a manual reload; non-claude panes are never probed.
    if (!chatAvailable && view.paneViewMode === 'terminal' && paneIsClaude(view.activePaneId)) {
      void initChatAvailability(view.activePaneId);
    }
    // While the WS watch is pushing, client polling is redundant — poll only as
    // a fallback when the socket is down, for whichever view is active.
    if (!store.wsConnected) {
      if (view.paneViewMode === 'chat') void pollChatFallback();
      else refreshPaneOutput();
    }
  }, PANE_REFRESH_INTERVAL_MS);
}

function stopPaneRefresh(): void {
  if (paneRefreshTimer) clearInterval(paneRefreshTimer);
  paneRefreshTimer = null;
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

  // Stop pane polling when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (view.paneViewMode !== 'chat') wsSendWatch(); // pause/resume the pane watch
    if (document.hidden || !view.activePaneId) return;
    // Returning to a pane that's already open (app switch, no route change) won't
    // fire handleRoute, so clear any OS notification raised for it while hidden.
    dismissNotificationsForPane(view.activePaneId);
    markActivePaneSeen();
    // In chat mode the transcript watch keeps pushing while the WS is up, so the
    // HTTP fallback must only run when the socket is down — otherwise a fallback
    // response racing a WS push duplicates items and rewinds chatCursor.
    if (view.paneViewMode === 'chat') { if (!store.wsConnected) void pollChatFallback(); }
    else refreshPaneOutput();
  });
});
