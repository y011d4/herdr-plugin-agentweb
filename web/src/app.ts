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
 * A pane's body (terminal, chat, answer panel) is pane-view.ts; this shell draws around it.
 */

import { homeSummary, shownStatus } from './dashboard-group.ts';
import { DESKTOP_QUERY, enterSends } from './composer-keys.ts';
import type { AppState, ClearResponse, OrchestratorView, WsMessage } from './types.ts';
import { apiDelete, apiGet, apiPost, getToken, loadToken, onUnauthorized, setToken } from './api.ts';
import { STORAGE_HOME, findPane, keptTasks, lastHome, markPaneSeen, setAppState, setStartingHome, store, subscribe } from './store.ts';
import { dismissNotificationsForPane, dismissToastsForPane, notifyAgentStatus, showToast } from './notify.ts';
import { onWsMessage, wsConnect, wsSendWatch } from './ws.ts';
import { createPaneView, type PaneView } from './pane-view.ts';
import { homeAgentsHash, homeHash, homeOf, isAgentsRoute, nextPaneBackRoute, orchestratorOfPane,
  paneGoneRoute, paneRoute, resolveRoute } from './routes.ts';
import { createElement } from 'react';
import { agentCards, cardTitle, Dashboard, dashboardTopbar, orchestratorLabel } from './ui/Dashboard.tsx';
import { confirmModal, openAgentMenu } from './ui/Modals.tsx';
import { mountOverlays, mountScreen, setConnIndicator, setLegacyScreen, setLegacyTopbar } from './ui/mount.tsx';
import { Settings, settingsTopbar } from './ui/Settings.tsx';
import { Token } from './ui/Token.tsx';

// ── Module-level state ────────────────────────────────────────────────────────
let paneView: PaneView | null = null; // the open pane's body (pane-view.ts), else null

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

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
    // Pane detail auto-refreshes via its own poller; header may need updating
    refreshPaneHeader();
    paneView?.onState(); // the answer panel: the agent may have just become (un)blocked
  } else if (hash.startsWith('#/home/')) {
    if (homeReplaced(hash)) return;
    markActivePaneSeen(); // the orchestrator may have just finished while on screen
    refreshPaneHeader();
    renderHomeStatus();
    renderHomeActivity();
    paneView?.onState();
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

// ── Pane detail ───────────────────────────────────────────────────────────────

function paneHeaderHtml(found: ReturnType<typeof findPane>, paneId: string): string {
  const label = found?.pane?.agent?.displayName || found?.pane?.agent?.name || found?.pane?.title || paneId;
  const context = found ? `${found.ws.label} / ${found.tab.label}` : '';
  return `${escHtml(label)}${context ? `<span class="topbar-subtitle">&#183; ${escHtml(context)}</span>` : ''}`;
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

// Home status bar: its agents waiting on the user (tap → that agent) and counts of
// the rest (tap → its list). Rewritten only when its content changes, so the
// constant state pushes don't replace a chip under a finger.
function renderHomeStatus(): void {
  const el = document.getElementById('home-status');
  if (!el || !store.appState) return;
  const s = homeSummary(agentCards(store.appState, orchestratorOfPane(store.appState, view.activePaneId)), store.seenDone);
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

function renderPaneDetail(paneId: string): void {
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
      paneView?.setMode(view.paneViewMode === 'chat' ? 'terminal' : 'chat', false);
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
      paneView?.setMode(view.paneViewMode === 'chat' ? 'terminal' : 'chat', true);
    });
    right.querySelector('#btn-agent-menu')!.addEventListener('click', () => agentMenu(paneId));
    left.querySelector('button')!.addEventListener('click', () => navigate(backRoute));
  }

  // The pane's body (terminal, chat, answer panel) goes in #pane-view (pane-view.ts);
  // the shell draws Home's status bar and "doing now" line and the composer around it.
  setLegacyScreen('pane', `
    <div id="screen-pane"${view.homeMode ? ' class="screen-home"' : ''} style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
      ${view.homeMode ? '<div class="home-status" id="home-status"></div>' : ''}
      <div id="pane-view" style="display:contents;"></div>
      ${view.homeMode ? '<div class="home-activity" id="home-activity" style="display:none;"></div>' : ''}
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

  // Reads the screen first, then the scrollback, then polls and probes for a transcript.
  paneView = createPaneView(document.getElementById('pane-view')!, paneId, {
    showToggle: showViewToggle,
    modeChanged: updateViewToggleLabel,
    activity: (text) => { homeActivity = text; renderHomeActivity(); },
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
      paneView?.echo();
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
}

/** Leaving the pane (or Home) on screen: its view stops, and its late responses do nothing. */
function closePaneView(): void {
  paneView?.destroy();
  paneView = null;
}

// The terminal ⇄ chat toggle (pane-view.ts reports the mode and whether chat exists).
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
        paneView?.echo();
      } catch (err) {
        showToast('Key send failed', (err as Error).message);
      }
    });
    row.appendChild(btn);
  }
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
