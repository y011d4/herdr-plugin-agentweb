/**
 * ws.ts — the bridge WebSocket: connect with the token, ping every 30s, reconnect with
 * backoff (1→2→4→8→15s), poll /api/state every 10s while it is down, and keep the
 * server-side watches in step with the pane on screen. Every message reaches the
 * onWsMessage listeners, a polled state as a `state` message. store.wsConnected
 * follows the socket (with an emit()).
 */
import { apiGet, getToken } from './api.ts';
import { emit, store } from './store.ts';
import type { AppState, WsMessage } from './types.ts';
import { watchMessages } from './watch.ts';

const WS_PING_INTERVAL_MS = 30_000;
const WS_RECONNECT_BASE_MS = 1_000;
const WS_RECONNECT_MAX_MS = 15_000;
const STATE_POLL_INTERVAL_MS = 10_000; // fallback when WS is down

let wsSocket: WebSocket | null = null;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsPingTimer: ReturnType<typeof setInterval> | null = null;
let statePollTimer: ReturnType<typeof setInterval> | null = null;

const listeners = new Set<(msg: WsMessage) => void>();

export function onWsMessage(fn: (msg: WsMessage) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function dispatch(msg: WsMessage): void {
  for (const fn of listeners) fn(msg);
}

export function wsConnect(): void {
  const token = getToken();
  if (!token) return;
  if (wsSocket && wsSocket.readyState <= 1 /* OPEN or CONNECTING */) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  wsSocket = ws;

  ws.addEventListener('open', () => {
    store.wsConnected = true;
    wsReconnectDelay = WS_RECONNECT_BASE_MS;
    emit();
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
    dispatch(msg);
  });

  ws.addEventListener('close', () => {
    // A delayed close from a socket we've already replaced isn't ours to act on.
    if (wsSocket !== ws) return;
    // Always clean up this socket's connection state...
    store.wsConnected = false;
    emit();
    if (wsPingTimer) clearInterval(wsPingTimer);
    // ...but don't revive polling/reconnect once signed out (e.g. after a 401).
    if (!getToken()) return;
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

// Tell the server what to watch for the active pane: its transcript in chat
// mode, its terminal output otherwise. The two watches are mutually exclusive,
// so the unused one is always cancelled. Re-sent on reconnect and mode switches.
export function wsSendWatch(): void {
  if (!wsSocket || wsSocket.readyState !== WebSocket.OPEN) return;
  const { activePaneId, paneViewMode } = store.view;
  for (const m of watchMessages(activePaneId, paneViewMode, document.hidden)) wsSocket.send(JSON.stringify(m));
}

// ── Fallback state polling (when WS is down) ──────────────────────────────────

function startStatePoll(): void {
  if (statePollTimer) return;
  statePollTimer = setInterval(async () => {
    if (!getToken()) return;
    try {
      const state = await apiGet('/api/state') as AppState;
      dispatch({ type: 'state', state });
    } catch {
      // ignore
    }
  }, STATE_POLL_INTERVAL_MS);
}

function stopStatePoll(): void {
  if (statePollTimer) clearInterval(statePollTimer);
  statePollTimer = null;
}

/** Sign-out: close the socket for good (its late close is ignored) and stop every timer. */
export function wsSignOut(): void {
  if (wsSocket) { wsSocket.close(); wsSocket = null; }
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  if (wsPingTimer) clearInterval(wsPingTimer);
  stopStatePoll();
  store.wsConnected = false;
}
