/**
 * app.ts — Herdr Agent Web PWA
 *
 * Single-page application with hash routing:
 *   #/agents    — dashboard (default)
 *   #/pane/:id  — pane terminal detail
 *   #/settings  — settings
 *
 * Depends on ansi.ts for ANSI→HTML rendering.
 */

import { ansiToHtml } from './ansi.ts';
import { renderItems } from './transcript.ts';
import type { TimelineItem } from './transcript.ts';
import { stripAnsi, parsePrompt, promptIdentity } from './prompt.ts';
import type { PromptOption, ParsedPrompt } from './prompt.ts';
import { statusOrder, groupWorkspacesForDashboard } from './dashboard-group.ts';
import type { AppState, WorkspaceNode, WsMessage, WsAgentStatusMessage, WsTranscriptItemsMessage } from './types.ts';

// ── App version ──────────────────────────────────────────────────────────────
const APP_VERSION = '0.1.0';
// Bumped each deploy and shown in the prompt panel + settings, so a stale cached
// bundle is immediately visible (the SW cache version tracks this).
const BUILD = 'v95';

// ── Storage keys ─────────────────────────────────────────────────────────────
const STORAGE_TOKEN = 'herdr_token';
const STORAGE_NOTIF = 'herdr_notifications';
const STORAGE_VIEW = 'herdr_pane_view'; // preferred pane view: 'terminal' | 'chat'

// ── WS reconnect config ───────────────────────────────────────────────────────
const WS_PING_INTERVAL_MS = 30_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS  = 15_000;
const STATE_POLL_INTERVAL_MS = 10_000;   // fallback when WS is down
const PANE_REFRESH_INTERVAL_MS = 3_000;  // polling while pane detail is visible

// ── Module-level state ────────────────────────────────────────────────────────
let token: string | null = null;
let wsSocket: WebSocket | null = null;
let wsConnected = false;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsPingTimer: ReturnType<typeof setInterval> | null = null;
let statePollTimer: ReturnType<typeof setInterval> | null = null;
let paneRefreshTimer: ReturnType<typeof setInterval> | null = null;

/** Last received State JSON */
let appState: AppState | null = null;

/** paneId currently shown in detail view (null if not on pane screen) */
let activePaneId: string | null = null;

// ── Chat view (Claude Code transcript) ────────────────────────────────────────
// A claude pane can be shown as its structured transcript instead of the raw
// terminal. Availability is probed per pane; the terminal stays the fallback.
let paneViewMode: 'terminal' | 'chat' = 'terminal';
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

/** source toggle: 'visible' | 'recent' */

// ── DOM refs (populated after DOMContentLoaded) ───────────────────────────────
let elApp: HTMLElement | null;
let elScreen: HTMLElement | null;
let elConnDot: HTMLElement | null;
let elReconnectBanner: HTMLElement | null;
let elToastContainer: HTMLElement | null;

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

// ── Token handling ────────────────────────────────────────────────────────────

function loadToken(): string | null {
  // Check URL for ?token= param first
  const params = new URLSearchParams(window.location.search);
  const urlToken = params.get('token');
  if (urlToken) {
    localStorage.setItem(STORAGE_TOKEN, urlToken);
    // Strip from URL without reload
    params.delete('token');
    const newSearch = params.toString();
    const newUrl = window.location.pathname + (newSearch ? '?' + newSearch : '') + window.location.hash;
    history.replaceState(null, '', newUrl);
    return urlToken;
  }
  return localStorage.getItem(STORAGE_TOKEN);
}

function clearToken(): void {
  localStorage.removeItem(STORAGE_TOKEN);
  token = null;
}

// ── Fetch wrapper ─────────────────────────────────────────────────────────────

async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...((options.headers ?? {}) as Record<string, string>),
  };
  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401) {
    clearToken();
    renderTokenScreen('Session expired or token invalid. Please enter your token.');
    throw new Error('401');
  }
  return resp;
}

async function apiGet(path: string): Promise<unknown> {
  const resp = await apiFetch(path);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as Record<string, unknown>;
    const err = body?.error as Record<string, unknown> | undefined;
    throw new Error((err?.message as string | undefined) ?? `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function apiPost(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const resp = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    const err = data?.error as Record<string, unknown> | undefined;
    const e = new Error((err?.message as string | undefined) ?? `HTTP ${resp.status}`) as Error & { code?: string; status?: number };
    e.code = err?.code as string | undefined; // e.g. 'prompt_changed' — lets callers branch on the reason
    e.status = resp.status;
    throw e;
  }
  return resp.json();
}

// ── WebSocket lifecycle ───────────────────────────────────────────────────────

function wsConnect(): void {
  if (!token) return;
  if (wsSocket && wsSocket.readyState <= 1 /* OPEN or CONNECTING */) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  wsSocket = ws;

  ws.addEventListener('open', () => {
    wsConnected = true;
    wsReconnectDelay = WS_RECONNECT_BASE_MS;
    updateConnBadge();
    stopStatePoll();
    wsSendWatch(); // re-establish pane watch after reconnect

    // Ping keepalive
    if (wsPingTimer) clearInterval(wsPingTimer);
    wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, WS_PING_INTERVAL_MS);
  });

  ws.addEventListener('message', (evt: MessageEvent<string>) => {
    let msg: WsMessage;
    try { msg = JSON.parse(evt.data) as WsMessage; } catch { return; }
    handleWsMessage(msg);
  });

  ws.addEventListener('close', () => {
    // A delayed close from a socket we've already replaced isn't ours to act on.
    if (wsSocket !== ws) return;
    // Always clean up this socket's connection state...
    wsConnected = false;
    updateConnBadge();
    if (wsPingTimer) clearInterval(wsPingTimer);
    // ...but don't revive polling/reconnect once signed out (e.g. after a 401).
    if (!token) return;
    startStatePoll();
    scheduleWsReconnect();
  });

  ws.addEventListener('error', () => {
    // close event will follow
  });
}

function scheduleWsReconnect(): void {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    wsConnect();
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
  }, wsReconnectDelay);
}

function handleWsMessage(msg: WsMessage): void {
  if (msg.type === 'state') {
    appState = msg.state;
    onStateUpdate();
  } else if (msg.type === 'agent_status') {
    onAgentStatus(msg);
  } else if (msg.type === 'pane_output') {
    if (msg.paneId === activePaneId) {
      appScrollPane = msg.appScroll; // server decides from fresh scroll metadata
      renderPaneOutput(msg.ansi);
    }
  } else if (msg.type === 'pane_gone') {
    if (msg.paneId === activePaneId) {
      showToast('Pane closed', 'This pane no longer exists.');
      navigate('#/agents');
    }
  } else if (msg.type === 'transcript_items') {
    if (msg.paneId === activePaneId) onTranscriptItems(msg);
  }
  // pong — no-op
}

// Tell the server what to watch for the active pane: its transcript in chat
// mode, its terminal output otherwise. The two watches are mutually exclusive,
// so the unused one is always cancelled. Re-sent on reconnect and mode switches.
function wsSendWatch(): void {
  if (!wsSocket || wsSocket.readyState !== WebSocket.OPEN) return;
  if (activePaneId && paneViewMode === 'chat') {
    wsSocket.send(JSON.stringify({ type: 'unwatch_pane' }));
    wsSocket.send(JSON.stringify({ type: 'watch_transcript', paneId: activePaneId }));
  } else if (activePaneId) {
    wsSocket.send(JSON.stringify({ type: 'unwatch_transcript' }));
    wsSocket.send(JSON.stringify({ type: 'watch_pane', paneId: activePaneId }));
  } else {
    wsSocket.send(JSON.stringify({ type: 'unwatch_pane' }));
    wsSocket.send(JSON.stringify({ type: 'unwatch_transcript' }));
  }
}

// The badge reflects end-to-end connectivity: the WebSocket to the bridge AND
// the bridge's own link to herdr (appState.connected). herdr can drop while the
// WS stays open, so a green dot requires both to be up.
function updateConnBadge(): void {
  const connected = wsConnected && (appState?.connected ?? true);
  if (elConnDot) {
    elConnDot.classList.toggle('connected', connected);
    elConnDot.title = connected ? 'Connected' : 'Reconnecting…';
  }
  if (elReconnectBanner) {
    elReconnectBanner.classList.toggle('visible', !connected);
  }
}

// ── Fallback state polling (when WS is down) ──────────────────────────────────

function startStatePoll(): void {
  if (statePollTimer) return;
  statePollTimer = setInterval(async () => {
    if (!token) return;
    try {
      const state = await apiGet('/api/state') as AppState;
      appState = state;
      onStateUpdate();
    } catch {
      // ignore
    }
  }, STATE_POLL_INTERVAL_MS);
}

function stopStatePoll(): void {
  if (statePollTimer) clearInterval(statePollTimer);
  statePollTimer = null;
}

// ── State update handler ──────────────────────────────────────────────────────

function onStateUpdate(): void {
  updateConnBadge(); // state carries the bridge->herdr link status
  const hash = location.hash || '#/agents';
  if (hash === '#/agents') {
    renderAgentsDashboard();
  } else if (hash.startsWith('#/pane/')) {
    // If the pane vanished (e.g. seen via /api/state polling while the WS is
    // down, so the pane_gone push can't fire), leave the now-stale view.
    if (activePaneId && !findPane(activePaneId)) {
      showToast('Pane closed', 'This pane no longer exists.');
      navigate('#/agents');
      return;
    }
    // Pane detail auto-refreshes via its own poller; header may need updating
    updatePaneDetailHeader();
    updatePromptPanel(); // agent may have just become (un)blocked
  }
}

// ── Agent status notification handler ────────────────────────────────────────

function onAgentStatus(msg: WsAgentStatusMessage): void {
  const { paneId, agent, from, to, workspaceLabel, tabLabel } = msg;

  const jumpToPane = (): void => navigate(`#/pane/${encodeURIComponent(paneId)}`);

  const notifyStatuses = new Set(['blocked', 'done']);
  if (!notifyStatuses.has(to)) {
    // Still show toast for other transitions if not currently on that pane
    if (activePaneId !== paneId) {
      showToast(
        `${agent ?? 'Agent'}: ${from} → ${to}`,
        `${workspaceLabel ?? ''} / ${tabLabel ?? ''}`,
        { sticky: true, onclick: jumpToPane, paneId }
      );
    }
    return;
  }

  const body = `${workspaceLabel ?? ''} / ${tabLabel ?? ''}`;
  const title = `${agent ?? 'Agent'} ${to}`;

  // In-app toast (skip for the pane currently being viewed)
  if (activePaneId !== paneId) {
    showToast(title, body, { sticky: true, onclick: jumpToPane, paneId });
  }

  // System notification when page is hidden
  if (
    document.hidden &&
    localStorage.getItem(STORAGE_NOTIF) === 'true' &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    showSystemNotification(title, body, paneId);
  }

  // Refresh pane detail if it's the active one
  if (activePaneId === paneId) {
    refreshPaneOutput();
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────

interface ToastOptions {
  onclick?: () => void;
  /** sticky toasts stay until the user dismisses them */
  sticky?: boolean;
  /** associates the toast with a pane so opening that pane auto-dismisses it */
  paneId?: string;
}

const TOAST_MAX = 10;

function showToast(title: string, body: string, opts: ToastOptions = {}): void {
  if (!elToastContainer) return;

  // keep the stack bounded — drop the oldest toast
  while (elToastContainer.children.length >= TOAST_MAX) {
    elToastContainer.firstElementChild?.remove();
  }

  const el = document.createElement('div');
  el.className = 'toast';
  // tag so navigating to this pane can auto-dismiss its toasts (see dismissToastsForPane)
  if (opts.paneId) el.dataset.paneId = opts.paneId;
  el.innerHTML =
    `<div class="toast-main">` +
    `<div class="toast-header">${escHtml(title)}</div>` +
    `<div class="toast-body">${escHtml(body)}</div>` +
    `</div>` +
    `<button class="toast-close" aria-label="Dismiss">&#10005;</button>`;

  const dismiss = (): void => {
    el.classList.add('fading');
    setTimeout(() => el.remove(), 300);
  };

  el.querySelector('.toast-close')!.addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss();
  });

  // Swipe right to dismiss
  let touchStartX = 0;
  let touchDeltaX = 0;
  let didSwipe = false;
  el.addEventListener('touchstart', (e: TouchEvent) => {
    touchStartX = e.touches[0].clientX;
    touchDeltaX = 0;
    el.style.transition = 'none';
  }, { passive: true });
  el.addEventListener('touchmove', (e: TouchEvent) => {
    touchDeltaX = e.touches[0].clientX - touchStartX;
    if (touchDeltaX > 0) {
      el.style.transform = `translateX(${touchDeltaX}px)`;
      el.style.opacity = String(Math.max(0.2, 1 - touchDeltaX / 240));
    }
  }, { passive: true });
  el.addEventListener('touchend', () => {
    el.style.transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
    if (touchDeltaX > 72) {
      didSwipe = true;
      el.style.transform = 'translateX(120%)';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 150);
    } else {
      if (Math.abs(touchDeltaX) > 10) didSwipe = true;
      el.style.transform = '';
      el.style.opacity = '';
    }
    touchDeltaX = 0;
  });

  if (opts.onclick) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      // a swipe gesture must not double as a tap
      if (didSwipe) { didSwipe = false; return; }
      opts.onclick!();
      el.remove();
    });
  }
  elToastContainer.appendChild(el);

  if (!opts.sticky) {
    setTimeout(dismiss, 4_000);
  }
}

/** Fade out and remove every toast associated with a pane (called on pane open). */
function dismissToastsForPane(paneId: string): void {
  if (!elToastContainer) return;
  for (const el of Array.from(elToastContainer.children) as HTMLElement[]) {
    if (el.dataset.paneId === paneId) {
      el.classList.add('fading');
      setTimeout(() => el.remove(), 300);
    }
  }
}

// ── System (OS) notifications ─────────────────────────────────────────────────

// Notifications are shown through the service-worker registration rather than the
// page `new Notification()` constructor: the constructor throws on mobile (Android
// requires SW notifications), and only SW-shown notifications are reachable via
// getNotifications() for later auto-dismissal. Desktop without an active
// registration falls back to the page constructor.
//
// tag === paneId is intentional: successive status pings for one pane coalesce to a
// single OS entry (latest status wins) instead of stacking stale ones, and it is the
// key dismissNotificationsForPane() matches on. The in-app toast stack keeps history.

function showSystemNotification(title: string, body: string, paneId: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration()
      .then((reg) => {
        // The app may have become visible while getRegistration() resolved; a
        // return-to-visible dismiss would then run before this notification exists.
        // Re-check the same document.hidden gate so a now-visible pane is never
        // left with a stale OS notification.
        if (!document.hidden) return;
        if (!reg) { pageNotification(title, body, paneId); return; }
        // showNotification() is itself async: the app can become visible between the
        // check above and when the notification is registered, so a visibilitychange
        // dismiss can run too early and miss it. Once it provably exists, dismiss it
        // if the user is now looking at this very pane.
        return reg.showNotification(title, { body, tag: paneId }).then(() => {
          if (!document.hidden && activePaneId === paneId) dismissNotificationsForPane(paneId);
        });
      })
      .catch(() => { if (document.hidden) pageNotification(title, body, paneId); });
  } else {
    pageNotification(title, body, paneId);
  }
}

// Page-constructor notifications are not reachable via getNotifications(), so track
// them per pane to close on pane open.
const pageNotifications = new Map<string, Notification[]>();

function pageNotification(title: string, body: string, paneId: string): void {
  try {
    const n = new Notification(title, { body, tag: paneId });
    n.onclick = () => {
      window.focus();
      navigate(`#/pane/${encodeURIComponent(paneId)}`);
    };
    const list = pageNotifications.get(paneId) ?? [];
    list.push(n);
    pageNotifications.set(paneId, list);
    n.addEventListener('close', () => {
      const cur = pageNotifications.get(paneId);
      if (!cur) return;
      const rest = cur.filter((x) => x !== n);
      if (rest.length) pageNotifications.set(paneId, rest);
      else pageNotifications.delete(paneId);
    });
  } catch {
    // `new Notification()` is an illegal constructor on some platforms — ignore
  }
}

/** Close any OS notifications for a pane once its page is opened. */
function dismissNotificationsForPane(paneId: string): void {
  // page-constructor fallbacks: closed via the tracked references
  const tracked = pageNotifications.get(paneId);
  if (tracked) {
    for (const n of tracked) n.close();
    pageNotifications.delete(paneId);
  }
  // SW-shown notifications: reachable via the registration
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration()
    .then((reg) => reg?.getNotifications({ tag: paneId }).then((ns) => ns.forEach((n) => n.close())))
    .catch(() => {});
}

// ── Routing ───────────────────────────────────────────────────────────────────

function navigate(hash: string): void {
  location.hash = hash;
}

function handleRoute(): void {
  if (!token) {
    renderTokenScreen();
    return;
  }

  stopPaneRefresh();
  activePaneId = null;

  const hash = location.hash || '#/agents';

  if (hash === '#/agents' || hash === '#/') {
    renderAgentsDashboard();
  } else if (hash.startsWith('#/pane/')) {
    const encoded = hash.slice('#/pane/'.length);
    let paneId: string;
    try {
      paneId = decodeURIComponent(encoded);
    } catch {
      navigate('#/agents'); // malformed pane hash — don't break routing
      return;
    }
    activePaneId = paneId;
    // opening a pane clears its pending notifications (in-app toasts + OS)
    dismissToastsForPane(paneId);
    dismissNotificationsForPane(paneId);
    renderPaneDetail(paneId);
  } else if (hash === '#/settings') {
    renderSettingsScreen();
  } else {
    navigate('#/agents');
  }

  wsSendWatch(); // sync the server-side pane watch with the current route
}

// ── Token screen ──────────────────────────────────────────────────────────────

function renderTokenScreen(message?: string): void {
  stopPaneRefresh();
  activePaneId = null;

  elScreen!.innerHTML = `
    <div id="screen-login" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;padding:32px 24px;height:100%;overflow-y:auto;">
      <div class="login-logo">&#128241;</div>
      <div class="login-title">Herdr Agent Web</div>
      <div class="login-subtitle">${message ? escHtml(message) : 'Enter the access token shown when the bridge server started.'}</div>
      <form class="login-form" id="token-form" style="width:100%;max-width:360px;display:flex;flex-direction:column;gap:12px;">
        <input type="password" id="token-input" placeholder="Paste access token…" autocomplete="off" autocorrect="off" spellcheck="false" />
        <button type="submit" class="btn-primary">Connect</button>
      </form>
    </div>
  `;

  // Hide topbar for login screen
  const topbar = document.getElementById('topbar');
  if (topbar) topbar.style.display = 'none';
  if (elReconnectBanner) elReconnectBanner.classList.remove('visible');

  document.getElementById('token-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = (document.getElementById('token-input') as HTMLInputElement).value.trim();
    if (!val) return;
    token = val;
    localStorage.setItem(STORAGE_TOKEN, token);
    if (topbar) topbar.style.display = '';
    wsConnect();
    // Immediately fetch state
    apiGet('/api/state').then((state) => {
      appState = state as AppState;
      // navigate() re-renders only via hashchange; if the hash is already
      // #/agents (e.g. token re-entry after expiry) no event fires, so route
      // directly to avoid leaving the login screen up.
      if (location.hash === '#/agents') handleRoute();
      else navigate('#/agents');
    }).catch((err: Error) => {
      if (err.message !== '401') {
        renderTokenScreen('Could not connect. Check the token and try again.');
      }
    });
  });
}

// ── Agents dashboard ──────────────────────────────────────────────────────────

// Render agent-pane cards for a repo group — a main checkout plus any linked
// worktrees — as a single status-sorted list, so an urgent worktree agent isn't
// stuck below idle main-checkout agents. A flat workspace is a one-member group.
// Each card's `branch` and `worktree` chip come from its own workspace. Returns
// totalPanes so the caller can skip an empty group.
function renderGroupCards(workspaces: WorkspaceNode[]): { html: string; totalPanes: number } {
  // Flatten every pane across the group, carrying its workspace's git context
  // and its tab label — pane.title is usually null, so the tab name is the only
  // distinguishing label when a workspace runs several agents; a per-tab index
  // keeps split-pane cards distinct.
  const items = workspaces.flatMap((ws) => {
    const branch = ws.worktree?.branch || null;
    const isWorktree = ws.worktree?.isLinkedWorktree ?? false;
    return (ws.tabs ?? []).flatMap((t) => {
      const panes = t.panes ?? [];
      const tabAgentPanes = panes.filter((p) => p.agent);
      return panes.map((pane) => ({
        pane,
        branch,
        isWorktree,
        tabLabel: t.label,
        tabAgentIndex: tabAgentPanes.indexOf(pane) + 1,
        tabAgentCount: tabAgentPanes.length,
      }));
    });
  });
  const agentItems = items
    .filter((x) => x.pane.agent)
    .sort((a, b) => statusOrder(a.pane.agent!.status) - statusOrder(b.pane.agent!.status));
  const inactiveCount = items.length - agentItems.length;

  let html = '';
  if (agentItems.length === 0) {
    html += `<div class="inactive-panes-count">${inactiveCount} pane${inactiveCount !== 1 ? 's' : ''} (no active agents)</div>`;
  }

  for (const { pane, branch, isWorktree, tabLabel, tabAgentIndex, tabAgentCount } of agentItems) {
    const { paneId, agent, title } = pane;
    const { displayName, name, status, customStatus, message, sinceUnixMs } = agent!;
    // The chip shows the stable agent kind, so prefer `name` (raw pane.agent,
    // e.g. "claude"/"codex") over displayName, which can be a richer label.
    const agentKind = name || displayName || 'agent';
    // Tab name is the human-meaningful identifier within a workspace; fall back
    // to the agent kind if a tab somehow has no label. When the tab runs multiple
    // agent panes, suffix a per-tab index so the cards differ.
    const baseLabel = tabLabel || agentKind;
    const cardLabel = tabAgentCount > 1 ? `${baseLabel} #${tabAgentIndex}` : baseLabel;
    const statusClass = status || 'unknown';
    const meta = customStatus || message || '';
    const relTime = relativeTime(sinceUnixMs);

    html += `
      <div class="agent-card" data-pane-id="${escHtml(paneId)}" role="button" tabindex="0">
        <div class="agent-card-header">
          <span class="agent-name">${escHtml(cardLabel)}</span>
          ${branch ? `<span class="card-branch">${escHtml(branch)}</span>` : ''}
          <span class="status-badge ${escHtml(statusClass)}">${escHtml(statusClass)}</span>
        </div>
        ${meta ? `<div class="agent-custom-status">${escHtml(meta)}</div>` : ''}
        <div class="agent-card-meta">
          <span class="agent-kind">${escHtml(agentKind)}</span>
          ${isWorktree ? '<span class="card-worktree">worktree</span>' : ''}
          ${title ? `<span class="pane-title">${escHtml(title)}</span>` : ''}
          ${relTime ? `<span>${escHtml(relTime)}</span>` : ''}
        </div>
      </div>`;
  }

  return { html, totalPanes: items.length };
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
    if (token && document.getElementById('screen-agents')) renderAgentsDashboard();
  }, 0);
}

function renderAgentsDashboard(): void {
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.style.display = '';
    document.getElementById('topbar-title')!.textContent = 'Agents';
    document.getElementById('topbar-left')!.innerHTML = '';
    document.getElementById('topbar-right')!.innerHTML =
      `<button class="topbar-action" id="btn-settings" aria-label="Settings">&#9881;</button>`;
    document.getElementById('btn-settings')!.addEventListener('click', () => navigate('#/settings'));
  }

  if (!appState) {
    elScreen!.innerHTML = `<div id="screen-agents" style="display:flex;align-items:center;justify-content:center;height:100%;"><span class="loading-spinner"></span></div>`;
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

  const { workspaces = [] } = appState;

  let inner = '';

  if (workspaces.length === 0) {
    inner += '<div class="empty-state">No workspaces found.</div>';
  }

  // Linked worktrees are grouped under their main checkout (matched by repoKey)
  // and the top-level entries are status-ordered; a worktree whose main isn't
  // open — and every other workspace — stays top-level. Grouping/sorting is a
  // pure helper (unit-tested in dashboard-group.test.ts).
  for (const { entry: ws, members } of groupWorkspacesForDashboard(workspaces)) {
    // Main checkout + its linked worktrees render as one status-sorted group, so
    // each worktree's cards (with their own branch + `worktree` chip) read as
    // part of the repo rather than a repo of their own.
    const { html: cards, totalPanes } = renderGroupCards(members);
    if (totalPanes === 0) continue;

    // An orphan worktree (its main isn't open) keeps a repo-qualified badge.
    const wt = ws.worktree;
    const badge = wt?.isLinkedWorktree
      ? `<span class="worktree-badge">${escHtml(wt.repoName || 'repo')} · worktree</span>`
      : '';
    inner += `<div class="workspace-group" data-ws="${escHtml(ws.workspaceId)}">
      <div class="workspace-label"><span class="workspace-name">${escHtml(ws.label || ws.workspaceId)}</span>${badge}</div>${cards}</div>`;
  }

  // Keep the #screen-agents scroll container stable across state-push rebuilds:
  // replacing only its inner content preserves scrollTop and iOS momentum, while
  // the touch-defer above keeps an active drag from being cancelled. The container
  // is (re)created only when absent (first paint, or after leaving and returning
  // to the route) — the loading-spinner placeholder lacks data-ready.
  let scroller = document.getElementById('screen-agents') as HTMLElement | null;
  if (!scroller || !scroller.dataset.ready) {
    elScreen!.innerHTML = '<div id="screen-agents" data-ready="1"></div>';
    scroller = document.getElementById('screen-agents') as HTMLElement;
    agentsTouchActive = false;
    agentsRenderPending = false;
    scroller.addEventListener('touchstart', () => { agentsTouchActive = true; }, { passive: true });
    scroller.addEventListener('touchend', onAgentsTouchEnd, { passive: true });
    scroller.addEventListener('touchcancel', onAgentsTouchEnd, { passive: true });
  }
  scroller.innerHTML = inner;

  // Attach tap handlers
  scroller.querySelectorAll('.agent-card').forEach((card) => {
    const el = card as HTMLElement;
    const paneId = el.dataset.paneId!;
    const activate = () => navigate(`#/pane/${encodeURIComponent(paneId)}`);
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') activate(); });
  });
}

// ── Pane detail ───────────────────────────────────────────────────────────────

function findPane(paneId: string) {
  if (!appState) return null;
  for (const ws of appState.workspaces ?? []) {
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

function updatePaneDetailHeader(): void {
  if (!activePaneId) return;
  const found = findPane(activePaneId);
  const titleEl = document.getElementById('topbar-title');
  if (titleEl && found) {
    titleEl.innerHTML = paneHeaderHtml(found, activePaneId);
  }
}

async function renderPaneDetail(paneId: string): Promise<void> {
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.style.display = '';
    const found = findPane(paneId);
    document.getElementById('topbar-title')!.innerHTML = paneHeaderHtml(found, paneId);
    document.getElementById('topbar-left')!.innerHTML =
      `<button class="topbar-back" aria-label="Back">&#8592; Agents</button>`;
    // View toggle (terminal ⇄ chat). Hidden until a claude transcript is found.
    document.getElementById('topbar-right')!.innerHTML =
      `<button class="topbar-action view-toggle" id="btn-view-toggle" style="display:none;">Chat</button>`;
    document.getElementById('btn-view-toggle')!.addEventListener('click', () => {
      if (paneViewMode === 'chat') switchToTerminal(); else switchToChat();
    });
    document.getElementById('topbar-left')!.querySelector('button')!.addEventListener('click', () => navigate('#/agents'));
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
  paneViewMode = 'terminal';
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
  elScreen!.innerHTML = `
    <div id="screen-pane" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
      <div class="terminal-output" id="terminal-output"><div id="term-history"></div><div id="term-live"><span class="loading-spinner"></span></div></div>
      <div class="chat-log" id="chat-log" style="display:none;"></div>
      <div class="chat-prompt" id="chat-prompt" style="display:none;"></div>
      <div class="input-bar">
        <div class="input-row">
          <textarea id="pane-input" rows="1" placeholder="Send text…" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
          <button class="input-send-btn" id="btn-send-enter">Send</button>
        </div>
        <div class="quickkey-row" id="quickkey-row"></div>
      </div>
    </div>
  `;

  const terminalEl = document.getElementById('terminal-output')!;
  bindPinchZoom(terminalEl);
  bindTerminalScroll(terminalEl);

  // Answer a pending prompt: tapping an option sends its menu key.
  document.getElementById('chat-prompt')!.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.ask-opt') as HTMLElement | null;
    if (!btn || !activePaneId) return;
    const send = btn.dataset.askSend;
    if (send) void sendAskAnswer(send, btn);
  });

  // Send button. Enter in the field inserts a newline — sending happens only
  // via the button, so the phone keyboard can't fire off half-typed commands.
  const paneInput = document.getElementById('pane-input') as HTMLTextAreaElement;

  const autoGrow = (): void => {
    paneInput.style.height = 'auto';
    paneInput.style.height = `${Math.min(paneInput.scrollHeight, 120)}px`;
  };
  paneInput.addEventListener('input', autoGrow);

  const clearInput = (): void => {
    paneInput.value = '';
    autoGrow();
  };

  document.getElementById('btn-send-enter')!.addEventListener('click', async () => {
    const text = paneInput.value;
    if (!text) return;
    try {
      // clear:true wipes the pane's composer first so this message submits on its
      // own — never merged with a half-typed draft the user left in the pane that
      // agentweb can't see. Scope it to Claude Code panes: Ctrl+U safely clears
      // Claude's input box, but to another app it's a raw control byte a
      // full-screen / non-readline TUI could act on. Other panes just get
      // text+enter. enter:true then submits in the same request.
      const isClaude = findPane(paneId)?.pane?.agent?.name === 'claude';
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { text, enter: true, ...(isClaude ? { clear: true } : {}) });
      if (paneInput.value === text) clearInput(); // clear on success, but keep text typed mid-send
      queuePaneEcho();
    } catch (err) {
      showToast('Send failed', (err as Error).message);
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
  if (gen !== paneViewGen || paneId !== activePaneId) return;
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
  if (btn) btn.textContent = paneViewMode === 'chat' ? 'Terminal' : 'Chat';
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
    if (probeId !== chatProbeSeq || gen !== paneViewGen || paneId !== activePaneId) return;
    chatAvailable = data.available;
    showViewToggle(chatAvailable);
    if (chatAvailable && preferredView() === 'chat') switchToChat(data, false);
  } catch {
    // leave the terminal view; toggle stays hidden
  } finally {
    if (chatProbeActive === probeId) chatProbeActive = 0; // only our own probe clears the guard
  }
}

// persist=true only for an explicit user toggle; automatic switches (honoring an
// existing preference, or falling back on a transient transcript miss) must not
// rewrite the stored preference.
function switchToChat(initial?: TranscriptResponse, persist = true): void {
  if (!chatAvailable || !activePaneId) return;
  paneViewMode = 'chat';
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
  paneViewMode = 'terminal';
  if (persist) localStorage.setItem(STORAGE_VIEW, 'terminal');
  document.getElementById('chat-log')?.style.setProperty('display', 'none');
  document.getElementById('terminal-output')?.style.setProperty('display', '');
  updateViewToggleLabel();
  updatePromptPanel(); // hide the answer panel (chat-only)
  wsSendWatch(); // server: stop transcript watch, resume pane watch
  void refreshPaneOutput(); // repaint the live screen the user returns to
}

async function loadChatInitial(): Promise<void> {
  if (!activePaneId) return;
  const gen = paneViewGen;
  const paneId = activePaneId;
  // switchToChat starts the WS transcript watch alongside this request; if that
  // watch (or anything else) advances the chat state while this GET is in flight,
  // its result is stale — capture the start state and drop a mismatched reply so
  // the slower initial load can't replace a fresher log or rewind the cursor.
  const reqSession = chatSessionId;
  const reqCursor = chatCursor;
  try {
    const data = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/transcript`) as TranscriptResponse;
    if (gen !== paneViewGen || paneId !== activePaneId || paneViewMode !== 'chat') return;
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
  chat.innerHTML = items.length ? renderItems(items) : '<div class="chat-empty">No messages yet.</div>';
  chat.scrollTop = preserveScroll
    ? (prevFromBottom < 40 ? chat.scrollHeight : prevTop)
    : chat.scrollHeight;
}

function appendChatItems(items: TimelineItem[]): void {
  const chat = document.getElementById('chat-log');
  if (!chat || items.length === 0) return;
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
    if (paneViewMode === 'chat') switchToTerminal(false);
    return;
  }
  chatAvailable = true;
  showViewToggle(true);
  if (paneViewMode !== 'chat') return; // availability noted; content applies only in chat mode
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
  if (!activePaneId || paneViewMode !== 'chat') return;
  const gen = paneViewGen;
  const paneId = activePaneId;
  // The response is only valid against the state this request started from. If
  // anything (a WS reset/push, or a newer poll) advances the session or cursor
  // while the request is in flight, applying it — append OR reset — would
  // duplicate or rewind, so capture the start state and drop a mismatched reply.
  const reqCursor = chatCursor;
  const reqSession = chatSessionId;
  const q = chatSessionId ? `?session=${encodeURIComponent(chatSessionId)}&after=${reqCursor}` : '';
  try {
    const data = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/transcript${q}`) as TranscriptResponse;
    if (gen !== paneViewGen || paneId !== activePaneId || paneViewMode !== 'chat') return;
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

// terminal display width of a line: CJK and other wide glyphs occupy two cells
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

function displayCols(line: string): number {
  let w = 0;
  for (const ch of line) w += WIDE_CHAR.test(ch) ? 2 : 1;
  return w;
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
  if (!activePaneId || wheelQueue === 0) return;
  const direction = wheelQueue > 0 ? 'up' : 'down';
  const steps = Math.min(30, Math.abs(wheelQueue));
  wheelQueue -= (direction === 'up' ? steps : -steps);
  if (wheelQueue !== 0) {
    // more queued than one request carries — keep flushing
    wheelFlushTimer = setTimeout(() => { void flushWheelQueue(); }, 70);
  }
  try {
    await apiPost(`/api/panes/${encodeURIComponent(activePaneId)}/scroll`, { direction, steps });
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
  if (!activePaneId || historyRefreshing || terminalTouchActive || !lastLiveAnsi) return;
  const gen = paneViewGen;
  const paneId = activePaneId;
  historyRefreshing = true;
  try {
    const data = await apiGet(
      `/api/panes/${encodeURIComponent(paneId)}/read?source=recent&lines=${HISTORY_LINES}&format=ansi`
    ) as Record<string, string | null>;
    if (gen !== paneViewGen || paneId !== activePaneId) return; // navigated away
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
  if (!activePaneId) return;
  const liveEl = document.getElementById('term-live');
  if (!liveEl) return;

  const gen = paneViewGen;
  const seq = outputSeq;
  const reqId = ++refreshReqSeq;
  const paneId = activePaneId;
  try {
    const data = await apiGet(
      `/api/panes/${encodeURIComponent(paneId)}/read?source=visible&lines=200&format=ansi`
    ) as Record<string, unknown>;
    if (gen !== paneViewGen || paneId !== activePaneId) return; // navigated away
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
  const status = activePaneId ? findPane(activePaneId)?.pane?.agent?.status : null;
  const blocked = paneViewMode === 'chat' && status === 'blocked';
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
  const qEl = document.getElementById('chat-prompt-q');
  if (qEl) qEl.textContent = parsed?.question ?? '';
  optsEl.innerHTML = (parsed?.options ?? []).map((o) =>
    `<button class="ask-opt" type="button" data-ask-send="${escHtml(o.send)}"><span class="ask-opt-num">${escHtml(o.send)}</span>` +
    `<span class="ask-opt-label">${escHtml(o.label)}</span></button>`,
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
    if (paneViewMode !== 'chat' || !activePaneId) { stopPromptScreenPoll(); return; }
    if (findPane(activePaneId)?.pane?.agent?.status !== 'blocked') { updatePromptPanel(); return; }
    const reqId = ++promptPollSeq;
    promptPollActive = reqId;
    const paneId = activePaneId;
    try {
      const data = await apiGet(`/api/panes/${encodeURIComponent(paneId)}/read?source=visible&format=ansi`) as Record<string, unknown>;
      // stopPromptScreenPoll bumps promptPollSeq to invalidate a poll from a prior
      // session; the in-flight guard means no concurrent tick supersedes this one.
      if (reqId !== promptPollSeq || paneViewMode !== 'chat' || paneId !== activePaneId) return;
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
  if (!activePaneId || promptAnswerInFlight) return;
  const to = parseInt(target, 10);
  // Claude's prompts never exceed ~6 options, so every option is a single digit; a
  // multi-digit option would submit on its first digit, so refuse it and leave the
  // terminal (always shown below) as the way to answer that out-of-range case.
  if (!Number.isInteger(to) || to < 1 || to > 9) return;
  const expectedId = promptScreenId; // region identity of the prompt these buttons belong to
  if (!expectedId) return;
  const paneId = activePaneId;
  const myGen = ++answerGen; // token for THIS answer; a stale POST/timer must not touch a newer one
  promptAnswerInFlight = true;
  if (answerCooldownTimer) { clearTimeout(answerCooldownTimer); answerCooldownTimer = null; }
  const panel = document.getElementById('chat-prompt');
  panel?.classList.add('chat-prompt-sending'); // disable the buttons while the answer settles
  btn.classList.add('ask-opt-sent');
  try {
    await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { press: String(to), expect_prompt: expectedId });
    if (myGen !== answerGen) return; // a newer tap already superseded this — don't touch shared state
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
    btn.classList.remove('ask-opt-sent');
    endAnswerCooldown();
    if ((err as { code?: string }).code === 'prompt_changed') {
      // The prompt advanced before the digit landed — refresh to the live prompt and
      // let the user retap; never send into a different prompt.
      const live = await readPromptScreen(paneId);
      if (myGen === answerGen && paneId === activePaneId) renderPromptPanel(live?.parsed ?? null, live?.id ?? '');
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
    if (!activePaneId || document.hidden) return;
    // A claude pane's transcript may appear shortly after the pane opens (session
    // just started, JSONL not written yet). Re-probe until chat is found so the
    // view upgrades without a manual reload; non-claude panes are never probed.
    if (!chatAvailable && paneViewMode === 'terminal' && paneIsClaude(activePaneId)) {
      void initChatAvailability(activePaneId);
    }
    // While the WS watch is pushing, client polling is redundant — poll only as
    // a fallback when the socket is down, for whichever view is active.
    if (!wsConnected) {
      if (paneViewMode === 'chat') void pollChatFallback();
      else refreshPaneOutput();
    }
  }, PANE_REFRESH_INTERVAL_MS);
}

function stopPaneRefresh(): void {
  if (paneRefreshTimer) clearInterval(paneRefreshTimer);
  paneRefreshTimer = null;
}

// ── Settings screen ───────────────────────────────────────────────────────────

function renderSettingsScreen(): void {
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.style.display = '';
    document.getElementById('topbar-title')!.textContent = 'Settings';
    document.getElementById('topbar-left')!.innerHTML =
      `<button class="topbar-back" aria-label="Back">&#8592;</button>`;
    document.getElementById('topbar-right')!.innerHTML = '';
    document.getElementById('topbar-left')!.querySelector('button')!.addEventListener('click', () => navigate('#/agents'));
  }

  const notifEnabled = localStorage.getItem(STORAGE_NOTIF) === 'true';
  const herdrVersion = appState?.herdr?.version ?? '—';
  const herdrProtocol = appState?.herdr?.protocol ?? '—';
  const bridgeUrl = `${location.protocol}//${location.host}`;
  const notifPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unavailable';

  elScreen!.innerHTML = `
    <div id="screen-settings">
      <div class="settings-section">
        <div class="settings-section-title">Notifications</div>
        <div class="settings-row">
          <span class="settings-row-label">Enable notifications</span>
          <label class="toggle">
            <input type="checkbox" id="toggle-notif" ${notifEnabled ? 'checked' : ''} />
            <span class="toggle-track"></span>
          </label>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">Permission status</span>
          <span class="settings-row-value" id="notif-permission">${escHtml(notifPermission)}</span>
        </div>
        <div class="settings-row">
          <button class="btn-secondary" id="btn-request-notif" style="width:100%;">Request Notification Permission</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Connection</div>
        <div class="settings-row">
          <span class="settings-row-label">Bridge URL</span>
          <span class="settings-row-value">${escHtml(bridgeUrl)}</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">herdr version</span>
          <span class="settings-row-value">${escHtml(String(herdrVersion))}</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">Protocol</span>
          <span class="settings-row-value">${escHtml(String(herdrProtocol))}</span>
        </div>
        <div class="settings-row">
          <span class="settings-row-label">WS status</span>
          <span class="settings-row-value">${wsConnected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Account</div>
        <div class="settings-row">
          <button class="btn-secondary" id="btn-clear-token" style="width:100%;color:#f47c2a;">Clear token &amp; sign out</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">About</div>
        <div class="settings-row">
          <span class="settings-row-label">App version</span>
          <span class="settings-row-value">${escHtml(APP_VERSION)} (${escHtml(BUILD)})</span>
        </div>
      </div>
    </div>
  `;

  // Notification toggle
  (document.getElementById('toggle-notif') as HTMLInputElement).addEventListener('change', (e) => {
    localStorage.setItem(STORAGE_NOTIF, (e.target as HTMLInputElement).checked ? 'true' : 'false');
  });

  // Request permission
  document.getElementById('btn-request-notif')!.addEventListener('click', async () => {
    if (typeof Notification === 'undefined') {
      showToast('Not supported', 'Notifications are not available in this browser.');
      return;
    }
    const result = await Notification.requestPermission();
    document.getElementById('notif-permission')!.textContent = result;
    if (result === 'granted') {
      localStorage.setItem(STORAGE_NOTIF, 'true');
      (document.getElementById('toggle-notif') as HTMLInputElement).checked = true;
    }
  });

  // Clear token
  document.getElementById('btn-clear-token')!.addEventListener('click', () => {
    if (wsSocket) { wsSocket.close(); wsSocket = null; }
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    if (wsPingTimer) clearInterval(wsPingTimer);
    stopStatePoll();
    stopPaneRefresh();
    appState = null;
    wsConnected = false;
    clearToken();
    renderTokenScreen();
  });
}

// ── Service Worker registration ───────────────────────────────────────────────

function registerServiceWorker(): void {
  if (!window.isSecureContext) return;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW registration failure is non-fatal
  });

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
  elScreen = document.getElementById('screen');
  bindViewportHeight();
  elConnDot = document.getElementById('conn-dot');
  elReconnectBanner = document.getElementById('reconnect-banner');
  elToastContainer = document.getElementById('toast-container');

  // Load token from URL or storage
  token = loadToken();

  // Route on hash change
  window.addEventListener('hashchange', handleRoute);

  // Initial route
  if (!token) {
    // Hide topbar until logged in
    const topbar = document.getElementById('topbar');
    if (topbar) topbar.style.display = 'none';
    renderTokenScreen();
  } else {
    // Connect WS and load initial state
    wsConnect();
    apiGet('/api/state').then((state) => {
      appState = state as AppState;
      handleRoute();
    }).catch((err: Error) => {
      if (err.message !== '401') {
        // Try to render with null state, WS will populate later
        handleRoute();
      }
    });
  }

  registerServiceWorker();

  // Stop pane polling when tab is hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !activePaneId) return;
    // Returning to a pane that's already open (app switch, no route change) won't
    // fire handleRoute, so clear any OS notification raised for it while hidden.
    dismissNotificationsForPane(activePaneId);
    // In chat mode the transcript watch keeps pushing while the WS is up, so the
    // HTTP fallback must only run when the socket is down — otherwise a fallback
    // response racing a WS push duplicates items and rewinds chatCursor.
    if (paneViewMode === 'chat') { if (!wsConnected) void pollChatFallback(); }
    else refreshPaneOutput();
  });
});
