/**
 * app.ts — Herdr Mobile PWA
 *
 * Single-page application with hash routing:
 *   #/agents    — dashboard (default)
 *   #/pane/:id  — pane terminal detail
 *   #/settings  — settings
 *
 * Depends on ansi.ts for ANSI→HTML rendering.
 */

import { ansiToHtml } from './ansi.ts';
import type { AppState, WorkspaceNode, WsMessage, WsAgentStatusMessage } from './types.ts';

// ── App version ──────────────────────────────────────────────────────────────
const APP_VERSION = '0.1.0';

// ── Storage keys ─────────────────────────────────────────────────────────────
const STORAGE_TOKEN = 'herdr_token';
const STORAGE_NOTIF = 'herdr_notifications';

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

function statusOrder(status: string): number {
  return ({ blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 } as Record<string, number>)[status] ?? 5;
}

// Most urgent agent status in a workspace; workspaces without agents sort last.
function workspaceUrgency(ws: WorkspaceNode): number {
  const ranks = (ws.tabs ?? [])
    .flatMap((t) => t.panes ?? [])
    .filter((p) => p.agent)
    .map((p) => statusOrder(p.agent!.status));
  return ranks.length ? Math.min(...ranks) : 6;
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
    throw new Error((err?.message as string | undefined) ?? `HTTP ${resp.status}`);
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
    setConnected(true);
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
    wsConnected = false;
    setConnected(false);
    if (wsPingTimer) clearInterval(wsPingTimer);
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
      renderPaneOutput(msg.ansi);
    }
  }
  // pong — no-op
}

// Tell the server which pane (if any) to watch for output pushes.
function wsSendWatch(): void {
  if (!wsSocket || wsSocket.readyState !== WebSocket.OPEN) return;
  if (activePaneId) {
    wsSocket.send(JSON.stringify({ type: 'watch_pane', paneId: activePaneId }));
  } else {
    wsSocket.send(JSON.stringify({ type: 'unwatch_pane' }));
  }
}

function setConnected(connected: boolean): void {
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
  const hash = location.hash || '#/agents';
  if (hash === '#/agents') {
    renderAgentsDashboard();
  } else if (hash.startsWith('#/pane/')) {
    // Pane detail auto-refreshes via its own poller; header may need updating
    updatePaneDetailHeader();
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
        { sticky: true, onclick: jumpToPane }
      );
    }
    return;
  }

  const body = `${workspaceLabel ?? ''} / ${tabLabel ?? ''}`;
  const title = `${agent ?? 'Agent'} ${to}`;

  // In-app toast (skip for the pane currently being viewed)
  if (activePaneId !== paneId) {
    showToast(title, body, { sticky: true, onclick: jumpToPane });
  }

  // System notification when page is hidden
  if (
    document.hidden &&
    localStorage.getItem(STORAGE_NOTIF) === 'true' &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    const n = new Notification(title, { body, tag: paneId });
    n.onclick = () => {
      window.focus();
      navigate(`#/pane/${encodeURIComponent(paneId)}`);
    };
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
}

const TOAST_MAX = 4;

function showToast(title: string, body: string, opts: ToastOptions = {}): void {
  if (!elToastContainer) return;

  // keep the stack bounded — drop the oldest toast
  while (elToastContainer.children.length >= TOAST_MAX) {
    elToastContainer.firstElementChild?.remove();
  }

  const el = document.createElement('div');
  el.className = 'toast';
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
    const paneId = decodeURIComponent(encoded);
    activePaneId = paneId;
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
      <div class="login-title">Herdr Mobile</div>
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
      navigate('#/agents');
    }).catch((err: Error) => {
      if (err.message !== '401') {
        renderTokenScreen('Could not connect. Check the token and try again.');
      }
    });
  });
}

// ── Agents dashboard ──────────────────────────────────────────────────────────

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

  const { workspaces = [] } = appState;

  // Collect all panes with agents, grouped by workspace
  let html = '<div id="screen-agents">';

  if (workspaces.length === 0) {
    html += '<div class="empty-state">No workspaces found.</div>';
  }

  const sortedWorkspaces = [...workspaces].sort(
    (a, b) => workspaceUrgency(a) - workspaceUrgency(b)
  );

  for (const ws of sortedWorkspaces) {
    const { workspaceId, label: wsLabel, tabs = [] } = ws;
    const allPanes = tabs.flatMap((t) => t.panes ?? []);
    const agentPanes = allPanes
      .filter((p) => p.agent)
      .sort((a, b) => statusOrder(a.agent!.status) - statusOrder(b.agent!.status));
    const inactivePanes = allPanes.filter((p) => !p.agent);

    if (allPanes.length === 0) continue;

    html += `<div class="workspace-group" data-ws="${escHtml(workspaceId)}">
      <div class="workspace-label">${escHtml(wsLabel || workspaceId)}</div>`;

    if (agentPanes.length === 0) {
      html += `<div class="inactive-panes-count">${inactivePanes.length} pane${inactivePanes.length !== 1 ? 's' : ''} (no active agents)</div>`;
    }

    for (const pane of agentPanes) {
      const { paneId, agent, title } = pane;
      const { displayName, name, status, customStatus, message, sinceUnixMs } = agent!;
      const displayLabel = displayName || name || 'Agent';
      const statusClass = status || 'unknown';
      const meta = customStatus || message || '';
      const relTime = relativeTime(sinceUnixMs);

      html += `
        <div class="agent-card" data-pane-id="${escHtml(paneId)}" role="button" tabindex="0">
          <div class="agent-card-header">
            <span class="agent-name">${escHtml(displayLabel)}</span>
            <span class="status-badge ${escHtml(statusClass)}">${escHtml(statusClass)}</span>
          </div>
          ${meta ? `<div class="agent-custom-status">${escHtml(meta)}</div>` : ''}
          <div class="agent-card-meta">
            ${title ? `<span class="pane-title">${escHtml(title)}</span>` : ''}
            ${relTime ? `<span>${escHtml(relTime)}</span>` : ''}
          </div>
        </div>`;
    }

    if (agentPanes.length > 0 && inactivePanes.length > 0) {
      html += `<div class="inactive-panes-count">+${inactivePanes.length} pane${inactivePanes.length !== 1 ? 's' : ''} without agents</div>`;
    }

    html += '</div>'; // workspace-group
  }

  html += '</div>'; // screen-agents
  elScreen!.innerHTML = html;

  // Attach tap handlers
  elScreen!.querySelectorAll('.agent-card').forEach((card) => {
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
    document.getElementById('topbar-right')!.innerHTML = '';
    document.getElementById('topbar-left')!.querySelector('button')!.addEventListener('click', () => navigate('#/agents'));
  }

  // each pane opens fitted to width, scrolled to the bottom
  paneFontPx = null;
  terminalTouchActive = false;
  pendingAnsi = null;
  lastLiveAnsi = '';
  historyFetchedAt = 0;
  historyRefreshing = false;
  appScrollPane = false;

  // Build screen HTML. The terminal holds two sections that are updated
  // independently so live pushes never touch the scrollback DOM above:
  // #term-history (scrollback prefix) + #term-live (current screen).
  elScreen!.innerHTML = `
    <div id="screen-pane" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
      <div class="terminal-output" id="terminal-output"><div id="term-history"></div><div id="term-live"><span class="loading-spinner"></span></div></div>
      <div class="input-bar">
        <div class="input-row">
          <textarea id="pane-input" rows="1" placeholder="Send text…" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
          <button class="input-send-btn" id="btn-send-enter">Send+&#x23CE;</button>
          <button class="input-send-literal" id="btn-send-literal">Send</button>
        </div>
        <div class="quickkey-row" id="quickkey-row"></div>
      </div>
    </div>
  `;

  const terminalEl = document.getElementById('terminal-output')!;
  bindPinchZoom(terminalEl);
  bindTerminalScroll(terminalEl);

  // Send buttons. Enter in the field inserts a newline — sending happens only
  // via the buttons, so the phone keyboard can't fire off half-typed commands.
  const paneInput = document.getElementById('pane-input') as HTMLTextAreaElement;

  const autoGrow = (): void => {
    paneInput.style.height = 'auto';
    paneInput.style.height = `${Math.min(paneInput.scrollHeight, 120)}px`;
  };
  paneInput.addEventListener('input', autoGrow);

  const takeText = (): string => {
    const text = paneInput.value;
    paneInput.value = '';
    autoGrow();
    return text;
  };

  document.getElementById('btn-send-enter')!.addEventListener('click', async () => {
    const text = takeText();
    if (!text) return;
    try {
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { text, enter: true });
      queuePaneEcho();
    } catch (err) {
      showToast('Send failed', (err as Error).message);
    }
  });
  document.getElementById('btn-send-literal')!.addEventListener('click', async () => {
    const text = takeText();
    if (!text) return;
    try {
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { text });
      queuePaneEcho();
    } catch (err) {
      showToast('Send failed', (err as Error).message);
    }
  });

  // Quick-key row
  buildQuickKeys(paneId);

  // Current screen first (small, fast), then the scrollback above it so the
  // view is continuously scrollable from the very first swipe.
  await refreshPaneOutput();
  void loadHistoryPrefix();

  // Start polling while this pane is visible
  startPaneRefresh();
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
const WHEEL_STEP_PX = 40; // finger travel per forwarded wheel event

function bindPinchZoom(outputEl: HTMLElement): void {
  let pinchStartDist = 0;
  let pinchStartPx = 0;
  let lastTapEndAt = 0;
  let tapStartX = 0;
  let tapStartY = 0;
  let tapCandidate = false;
  let lastTouchY = 0;
  let wheelAccum = 0;

  const touchDist = (t: TouchList): number =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  outputEl.addEventListener('touchstart', (e: TouchEvent) => {
    terminalTouchActive = true;
    if (e.touches.length === 2) {
      tapCandidate = false;
      pinchStartDist = touchDist(e.touches);
      pinchStartPx = parseFloat(getComputedStyle(outputEl).fontSize) || 13;
    } else if (e.touches.length === 1) {
      tapCandidate = true;
      tapStartX = e.touches[0].clientX;
      tapStartY = e.touches[0].clientY;
      lastTouchY = e.touches[0].clientY;
      wheelAccum = 0;
    }
  }, { passive: true });

  outputEl.addEventListener('touchmove', (e: TouchEvent) => {
    if (e.touches.length === 1) {
      if (tapCandidate &&
          Math.hypot(e.touches[0].clientX - tapStartX, e.touches[0].clientY - tapStartY) > 10) {
        tapCandidate = false; // a scroll flick is not a tap
      }
      // app-scroll panes: translate vertical swipes into wheel events
      if (appScrollPane) {
        wheelAccum += e.touches[0].clientY - lastTouchY;
        lastTouchY = e.touches[0].clientY;
        while (wheelAccum >= WHEEL_STEP_PX) { wheelAccum -= WHEEL_STEP_PX; sendPaneWheel(true); }
        while (wheelAccum <= -WHEEL_STEP_PX) { wheelAccum += WHEEL_STEP_PX; sendPaneWheel(false); }
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
        pendingAnsi = null;
        outputEl.scrollTop = outputEl.scrollHeight;
        void refreshPaneOutput();
        return;
      }
      lastTapEndAt = now;
    } else {
      lastTapEndAt = 0;
    }

    flushPendingOutput();
  }, { passive: true });

  outputEl.addEventListener('touchcancel', () => {
    terminalTouchActive = false;
    pinchStartDist = 0;
    tapCandidate = false;
  }, { passive: true });
}

// ── Continuous terminal buffer ────────────────────────────────────────────────
// The terminal is one continuous buffer: #term-history holds the scrollback
// prefix (fetched from source=recent, refreshed at most every 10s while the
// user reads it) and #term-live holds the current screen (updated by WS
// pushes). The view is scrollable from the very first swipe — no modes.

let terminalTouchActive = false; // a finger is on the terminal
let pendingAnsi: string | null = null; // output received while unsafe to render
let lastLiveAnsi = ''; // last rendered screen (for line counts and refits)
let historyFetchedAt = 0;
let historyRefreshing = false;
// Full-screen apps (claude etc.) keep no terminal scrollback but scroll their
// own view on SGR mouse wheel events — forward swipes through the bridge's
// /scroll endpoint, which injects real wheel events into the pty.
let appScrollPane = false;
let wheelRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function sendPaneWheel(up: boolean): void {
  if (!activePaneId) return;
  apiPost(`/api/panes/${encodeURIComponent(activePaneId)}/scroll`, { direction: up ? 'up' : 'down' })
    .catch(() => { /* transient send failures just skip a scroll step */ });
  if (wheelRefreshTimer) clearTimeout(wheelRefreshTimer);
  wheelRefreshTimer = setTimeout(() => { void refreshPaneOutput(); }, 250);
}

const HISTORY_LINES = 1000;
const HISTORY_REFRESH_MS = 10_000;

// Fetch the scrollback and place everything ABOVE the current screen into
// #term-history. source=recent ends with the lines currently on screen, so
// the live section's line count is dropped from its tail to avoid the overlap.
async function loadHistoryPrefix(): Promise<void> {
  if (!activePaneId || historyRefreshing || terminalTouchActive) return;
  historyRefreshing = true;
  try {
    const data = await apiGet(
      `/api/panes/${encodeURIComponent(activePaneId)}/read?source=recent&lines=${HISTORY_LINES}&format=ansi`
    ) as Record<string, string | null>;
    const outputEl = document.getElementById('terminal-output');
    const historyEl = document.getElementById('term-history');
    if (!outputEl || !historyEl) return;
    const recentLines = (data.ansi ?? data.text ?? '').split('\n');
    const liveLineCount = lastLiveAnsi ? lastLiveAnsi.split('\n').length : 0;
    const prefix = recentLines.slice(0, Math.max(0, recentLines.length - liveLineCount)).join('\n');
    // No terminal scrollback + an agent runs here: a full-screen app that
    // handles wheel scrolling itself (verified for claude) — forward swipes
    // as wheel events. Without an agent (fresh shell), injecting mouse
    // sequences would type garbage, so show the start-of-output marker.
    appScrollPane = !prefix && !!(activePaneId && findPane(activePaneId)?.pane.agent);
    // anchor by distance from the bottom: content only changes above the fold
    const fromBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight;
    historyEl.innerHTML = prefix
      ? ansiToHtml(prefix)
      : (appScrollPane ? '' : '<div class="history-start">&#183; start of output &#183;</div>');
    historyFetchedAt = Date.now();
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
    wheelDeltaAccum += e.deltaY;
    while (wheelDeltaAccum <= -30) { wheelDeltaAccum += 30; sendPaneWheel(true); }
    while (wheelDeltaAccum >= 30) { wheelDeltaAccum -= 30; sendPaneWheel(false); }
  }, { passive: true });

  outputEl.addEventListener('scroll', () => {
    const fromBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight;
    if (fromBottom < 40) {
      flushPendingOutput();
    } else if (Date.now() - historyFetchedAt > HISTORY_REFRESH_MS) {
      // reading scrollback — freshen the prefix occasionally so lines that
      // scrolled off the live screen since the last fetch appear
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

  try {
    const data = await apiGet(
      `/api/panes/${encodeURIComponent(activePaneId)}/read?source=visible&lines=200&format=ansi`
    ) as Record<string, string | null>;
    renderPaneOutput(data.ansi ?? data.text ?? '');
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

function startPaneRefresh(): void {
  stopPaneRefresh();
  paneRefreshTimer = setInterval(() => {
    // While the WS pane watch is pushing, client polling is redundant —
    // poll only as a fallback when the socket is down.
    if (activePaneId && !document.hidden && !wsConnected) {
      refreshPaneOutput();
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
          <span class="settings-row-value">${escHtml(APP_VERSION)}</span>
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

document.addEventListener('DOMContentLoaded', () => {
  elApp = document.getElementById('app');
  elScreen = document.getElementById('screen');
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
    if (!document.hidden && activePaneId) {
      refreshPaneOutput();
    }
  });
});
