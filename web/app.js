/**
 * app.js — Herdr Mobile PWA
 *
 * Single-page application with hash routing:
 *   #/agents    — dashboard (default)
 *   #/pane/:id  — pane terminal detail
 *   #/settings  — settings
 *
 * Depends on ansi.js for ANSI→HTML rendering.
 */

import { ansiToHtml } from './ansi.js';

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
let token = null;
let wsSocket = null;
let wsConnected = false;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer = null;
let wsPingTimer = null;
let statePollTimer = null;
let paneRefreshTimer = null;

/** @type {Object|null} Last received State JSON */
let appState = null;

/** paneId currently shown in detail view (null if not on pane screen) */
let activePaneId = null;

/** source toggle: 'visible' | 'recent' */
let paneSource = 'visible';

// ── DOM refs (populated after DOMContentLoaded) ───────────────────────────────
let elApp, elScreen, elConnDot, elReconnectBanner, elToastContainer;

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(ms) {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function statusOrder(status) {
  return { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 }[status] ?? 5;
}

// Most urgent agent status in a workspace; workspaces without agents sort last.
function workspaceUrgency(ws) {
  const ranks = (ws.tabs ?? [])
    .flatMap((t) => t.panes ?? [])
    .filter((p) => p.agent)
    .map((p) => statusOrder(p.agent.status));
  return ranks.length ? Math.min(...ranks) : 6;
}

// ── Token handling ────────────────────────────────────────────────────────────

function loadToken() {
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

function clearToken() {
  localStorage.removeItem(STORAGE_TOKEN);
  token = null;
}

// ── Fetch wrapper ─────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...(options.headers ?? {}),
  };
  const resp = await fetch(path, { ...options, headers });
  if (resp.status === 401) {
    clearToken();
    renderTokenScreen('Session expired or token invalid. Please enter your token.');
    throw new Error('401');
  }
  return resp;
}

async function apiGet(path) {
  const resp = await apiFetch(path);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  }
  return resp.json();
}

async function apiPost(path, body = {}) {
  const resp = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── WebSocket lifecycle ───────────────────────────────────────────────────────

function wsConnect() {
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

    // Ping keepalive
    clearInterval(wsPingTimer);
    wsPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, WS_PING_INTERVAL_MS);
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleWsMessage(msg);
  });

  ws.addEventListener('close', () => {
    wsConnected = false;
    setConnected(false);
    clearInterval(wsPingTimer);
    startStatePoll();
    scheduleWsReconnect();
  });

  ws.addEventListener('error', () => {
    // close event will follow
  });
}

function scheduleWsReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    wsConnect();
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
  }, wsReconnectDelay);
}

function handleWsMessage(msg) {
  if (msg.type === 'state') {
    appState = msg.state;
    onStateUpdate();
  } else if (msg.type === 'agent_status') {
    onAgentStatus(msg);
  }
  // pong — no-op
}

function setConnected(connected) {
  if (elConnDot) {
    elConnDot.classList.toggle('connected', connected);
    elConnDot.title = connected ? 'Connected' : 'Reconnecting…';
  }
  if (elReconnectBanner) {
    elReconnectBanner.classList.toggle('visible', !connected);
  }
}

// ── Fallback state polling (when WS is down) ──────────────────────────────────

function startStatePoll() {
  if (statePollTimer) return;
  statePollTimer = setInterval(async () => {
    if (!token) return;
    try {
      const state = await apiGet('/api/state');
      appState = state;
      onStateUpdate();
    } catch {
      // ignore
    }
  }, STATE_POLL_INTERVAL_MS);
}

function stopStatePoll() {
  clearInterval(statePollTimer);
  statePollTimer = null;
}

// ── State update handler ──────────────────────────────────────────────────────

function onStateUpdate() {
  const hash = location.hash || '#/agents';
  if (hash === '#/agents') {
    renderAgentsDashboard();
  } else if (hash.startsWith('#/pane/')) {
    // Pane detail auto-refreshes via its own poller; header may need updating
    updatePaneDetailHeader();
  }
}

// ── Agent status notification handler ────────────────────────────────────────

function onAgentStatus(msg) {
  const { paneId, agent, from, to, workspaceLabel, tabLabel } = msg;

  const notifyStatuses = new Set(['blocked', 'done']);
  if (!notifyStatuses.has(to)) {
    // Still show toast for other transitions if not currently on that pane
    if (activePaneId !== paneId) {
      showToast(`${agent ?? 'Agent'}: ${from} → ${to}`, `${workspaceLabel ?? ''} / ${tabLabel ?? ''}`);
    }
    return;
  }

  const body = `${workspaceLabel ?? ''} / ${tabLabel ?? ''}`;
  const title = `${agent ?? 'Agent'} ${to}`;

  // In-app toast (skip for the pane currently being viewed)
  if (activePaneId !== paneId) {
    showToast(title, body, () => navigate(`#/pane/${encodeURIComponent(paneId)}`));
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

function showToast(title, body, onclick) {
  if (!elToastContainer) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="toast-header">${escHtml(title)}</div><div class="toast-body">${escHtml(body)}</div>`;
  if (onclick) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => { onclick(); el.remove(); });
  }
  elToastContainer.appendChild(el);

  // Auto-dismiss after 4s
  setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => el.remove(), 300);
  }, 4_000);
}

// ── Routing ───────────────────────────────────────────────────────────────────

function navigate(hash) {
  location.hash = hash;
}

function handleRoute() {
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
}

// ── Token screen ──────────────────────────────────────────────────────────────

function renderTokenScreen(message) {
  stopPaneRefresh();
  activePaneId = null;

  elScreen.innerHTML = `
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

  document.getElementById('token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('token-input').value.trim();
    if (!val) return;
    token = val;
    localStorage.setItem(STORAGE_TOKEN, token);
    if (topbar) topbar.style.display = '';
    wsConnect();
    // Immediately fetch state
    apiGet('/api/state').then((state) => {
      appState = state;
      navigate('#/agents');
    }).catch((err) => {
      if (err.message !== '401') {
        renderTokenScreen('Could not connect. Check the token and try again.');
      }
    });
  });
}

// ── Agents dashboard ──────────────────────────────────────────────────────────

function renderAgentsDashboard() {
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.style.display = '';
    document.getElementById('topbar-title').textContent = 'Agents';
    document.getElementById('topbar-left').innerHTML = '';
    document.getElementById('topbar-right').innerHTML =
      `<button class="topbar-action" id="btn-settings" aria-label="Settings">&#9881;</button>`;
    document.getElementById('btn-settings').addEventListener('click', () => navigate('#/settings'));
  }

  if (!appState) {
    elScreen.innerHTML = `<div id="screen-agents" style="display:flex;align-items:center;justify-content:center;height:100%;"><span class="loading-spinner"></span></div>`;
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
      .sort((a, b) => statusOrder(a.agent.status) - statusOrder(b.agent.status));
    const inactivePanes = allPanes.filter((p) => !p.agent);

    if (allPanes.length === 0) continue;

    html += `<div class="workspace-group" data-ws="${escHtml(workspaceId)}">
      <div class="workspace-label">${escHtml(wsLabel || workspaceId)}</div>`;

    if (agentPanes.length === 0) {
      html += `<div class="inactive-panes-count">${inactivePanes.length} pane${inactivePanes.length !== 1 ? 's' : ''} (no active agents)</div>`;
    }

    for (const pane of agentPanes) {
      const { paneId, agent, title } = pane;
      const { displayName, name, status, customStatus, message, sinceUnixMs } = agent;
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
  elScreen.innerHTML = html;

  // Attach tap handlers
  elScreen.querySelectorAll('.agent-card').forEach((card) => {
    const paneId = card.dataset.paneId;
    const activate = () => navigate(`#/pane/${encodeURIComponent(paneId)}`);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') activate(); });
  });
}

// ── Pane detail ───────────────────────────────────────────────────────────────

function findPane(paneId) {
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

function updatePaneDetailHeader() {
  if (!activePaneId) return;
  const found = findPane(activePaneId);
  const titleEl = document.getElementById('topbar-title');
  if (titleEl && found) {
    titleEl.textContent = found.pane.agent?.displayName || found.pane.agent?.name || found.pane.title || activePaneId;
  }
}

async function renderPaneDetail(paneId) {
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.style.display = '';
    const found = findPane(paneId);
    const label = found?.pane?.agent?.displayName || found?.pane?.agent?.name || found?.pane?.title || paneId;
    document.getElementById('topbar-title').textContent = label;
    document.getElementById('topbar-left').innerHTML =
      `<button class="topbar-back" aria-label="Back">&#8592; Agents</button>`;
    document.getElementById('topbar-right').innerHTML = '';
    document.getElementById('topbar-left').querySelector('button').addEventListener('click', () => navigate('#/agents'));
  }

  // Build screen HTML
  elScreen.innerHTML = `
    <div id="screen-pane" style="display:flex;flex-direction:column;flex:1;overflow:hidden;">
      <div class="pane-source-bar">
        <button class="source-btn ${paneSource === 'visible' ? 'active' : ''}" data-source="visible">Visible</button>
        <button class="source-btn ${paneSource === 'recent' ? 'active' : ''}" data-source="recent">Recent</button>
        <button class="focus-btn" id="btn-pane-focus">Focus</button>
      </div>
      <div class="terminal-output" id="terminal-output"><span class="loading-spinner"></span></div>
      <div class="input-bar">
        <div class="input-row">
          <input type="text" id="pane-input" placeholder="Send text…" autocorrect="off" autocapitalize="off" spellcheck="false" />
          <button class="input-send-btn" id="btn-send-enter">Send+&#x23CE;</button>
          <button class="input-send-literal" id="btn-send-literal">Send</button>
        </div>
        <div class="quickkey-row" id="quickkey-row"></div>
      </div>
    </div>
  `;

  // Source toggle
  elScreen.querySelectorAll('.source-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      paneSource = btn.dataset.source;
      elScreen.querySelectorAll('.source-btn').forEach((b) => b.classList.toggle('active', b.dataset.source === paneSource));
      refreshPaneOutput();
    });
  });

  // Focus button
  document.getElementById('btn-pane-focus').addEventListener('click', async () => {
    try {
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/focus`, {});
    } catch (err) {
      showToast('Focus failed', err.message);
    }
  });

  // Send buttons
  const paneInput = document.getElementById('pane-input');
  document.getElementById('btn-send-enter').addEventListener('click', async () => {
    const text = paneInput.value;
    if (!text) return;
    paneInput.value = '';
    try {
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { text, enter: true });
    } catch (err) {
      showToast('Send failed', err.message);
    }
  });
  document.getElementById('btn-send-literal').addEventListener('click', async () => {
    const text = paneInput.value;
    if (!text) return;
    paneInput.value = '';
    try {
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { text });
    } catch (err) {
      showToast('Send failed', err.message);
    }
  });
  // Also send on Enter key in input field
  paneInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = paneInput.value;
      if (!text) return;
      paneInput.value = '';
      try {
        await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { text, enter: true });
      } catch (err) {
        showToast('Send failed', err.message);
      }
    }
  });

  // Quick-key row
  buildQuickKeys(paneId);

  // Load terminal output
  await refreshPaneOutput();

  // Start polling while this pane is visible
  startPaneRefresh();
}

function buildQuickKeys(paneId) {
  const KEYS = [
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
      } catch (err) {
        showToast('Key send failed', err.message);
      }
    });
    row.appendChild(btn);
  }
}

async function refreshPaneOutput() {
  if (!activePaneId) return;
  const outputEl = document.getElementById('terminal-output');
  if (!outputEl) return;

  try {
    const data = await apiGet(
      `/api/panes/${encodeURIComponent(activePaneId)}/read?source=${paneSource}&lines=200&format=ansi`
    );
    const ansiStr = data.ansi ?? data.text ?? '';
    const rendered = ansiToHtml(ansiStr);
    outputEl.innerHTML = rendered;
    // Scroll to bottom
    outputEl.scrollTop = outputEl.scrollHeight;
  } catch (err) {
    if (err.message !== '401') {
      outputEl.textContent = `Error loading output: ${err.message}`;
    }
  }
}

function startPaneRefresh() {
  stopPaneRefresh();
  paneRefreshTimer = setInterval(() => {
    if (activePaneId && !document.hidden) {
      refreshPaneOutput();
    }
  }, PANE_REFRESH_INTERVAL_MS);
}

function stopPaneRefresh() {
  clearInterval(paneRefreshTimer);
  paneRefreshTimer = null;
}

// ── Settings screen ───────────────────────────────────────────────────────────

function renderSettingsScreen() {
  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.style.display = '';
    document.getElementById('topbar-title').textContent = 'Settings';
    document.getElementById('topbar-left').innerHTML =
      `<button class="topbar-back" aria-label="Back">&#8592;</button>`;
    document.getElementById('topbar-right').innerHTML = '';
    document.getElementById('topbar-left').querySelector('button').addEventListener('click', () => navigate('#/agents'));
  }

  const notifEnabled = localStorage.getItem(STORAGE_NOTIF) === 'true';
  const herdrVersion = appState?.herdr?.version ?? '—';
  const herdrProtocol = appState?.herdr?.protocol ?? '—';
  const bridgeUrl = `${location.protocol}//${location.host}`;
  const notifPermission = typeof Notification !== 'undefined' ? Notification.permission : 'unavailable';

  elScreen.innerHTML = `
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
  document.getElementById('toggle-notif').addEventListener('change', (e) => {
    localStorage.setItem(STORAGE_NOTIF, e.target.checked ? 'true' : 'false');
  });

  // Request permission
  document.getElementById('btn-request-notif').addEventListener('click', async () => {
    if (typeof Notification === 'undefined') {
      showToast('Not supported', 'Notifications are not available in this browser.');
      return;
    }
    const result = await Notification.requestPermission();
    document.getElementById('notif-permission').textContent = result;
    if (result === 'granted') {
      localStorage.setItem(STORAGE_NOTIF, 'true');
      document.getElementById('toggle-notif').checked = true;
    }
  });

  // Clear token
  document.getElementById('btn-clear-token').addEventListener('click', () => {
    if (wsSocket) { wsSocket.close(); wsSocket = null; }
    clearTimeout(wsReconnectTimer);
    clearInterval(wsPingTimer);
    stopStatePoll();
    stopPaneRefresh();
    appState = null;
    wsConnected = false;
    clearToken();
    renderTokenScreen();
  });
}

// ── Service Worker registration ───────────────────────────────────────────────

function registerServiceWorker() {
  if (!window.isSecureContext) return;
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW registration failure is non-fatal
  });

  // Handle navigate messages from SW notification clicks
  navigator.serviceWorker.addEventListener('message', (evt) => {
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
      appState = state;
      handleRoute();
    }).catch((err) => {
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
