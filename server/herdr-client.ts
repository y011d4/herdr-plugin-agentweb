import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { createSplitter, serialize } from './ndjson.ts';
import { createState, applyEvent, getPaneIds, PANE_SET_CHANGING_EVENTS } from './state.ts';
import type { HerdrClientCallbacks, HerdrClient, NormalizedState, RpcResponse, EventPush } from './types.ts';

const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PANE_REBUILD_DEBOUNCE_MS = 250;
const STATE_BROADCAST_DEBOUNCE_MS = 250;

// Extend Error to carry a herdrCode property from RPC responses
interface HerdrError extends Error {
  herdrCode?: string;
}

export function createHerdrClient({ socketPath, onState, onAgentStatus, onConnectionChange }: HerdrClientCallbacks): HerdrClient {
  let currentState: NormalizedState | null = null;
  let subscribeConn: Socket | null = null;
  let connected = false;
  let destroyed = false;
  let backoffMs = BACKOFF_INITIAL_MS;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  function setConnected(val: boolean): void {
    if (connected !== val) {
      connected = val;
      onConnectionChange?.(val);
    }
  }

  // ── single-request RPC ──────────────────────────────────────────────────────

  function request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `mobile:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const conn = createConnection(socketPath);
      const splitter = createSplitter();
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          conn.destroy();
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);

      conn.on('connect', () => {
        conn.write(serialize({ type: 'request', id, method, params }));
      });

      conn.on('data', (chunk: Buffer) => {
        const lines = splitter.push(chunk.toString('utf8'));
        for (const line of lines) {
          if (settled) break;
          let msg: RpcResponse;
          try { msg = JSON.parse(line) as RpcResponse; } catch { continue; }
          if (msg.id !== id) continue;
          settled = true;
          clearTimeout(timer);
          conn.destroy();
          if (msg.error) {
            const err: HerdrError = new Error(msg.error.message || 'herdr error');
            err.herdrCode = msg.error.code;
            reject(err);
          } else {
            resolve(msg.result);
          }
        }
      });

      conn.on('error', (err: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(err); }
      });

      conn.on('close', () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('connection closed')); }
      });
    });
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  async function fetchSnapshot(): Promise<NormalizedState> {
    const result = await request('session.snapshot') as Record<string, unknown>;
    const snap = (result.snapshot ?? result) as Record<string, unknown>;
    const nowMs = Date.now();
    currentState = createState(snap as Parameters<typeof createState>[0], nowMs, currentState);
    // Deliver snapshot immediately (not debounced) so getState() callers see it
    // right away, and so a flood of queued events can't starve the initial delivery.
    onState?.(currentState);
    return currentState;
  }

  // ── subscribe connection ────────────────────────────────────────────────────

  function buildSubscriptions(paneIds: string[]): Array<{ type: string; pane_id?: string }> {
    const subscriptions: Array<{ type: string; pane_id?: string }> = [
      { type: 'workspace.created' },
      { type: 'workspace.updated' },
      { type: 'workspace.renamed' },
      { type: 'workspace.moved' },
      { type: 'workspace.closed' },
      { type: 'workspace.focused' },
      { type: 'tab.created' },
      { type: 'tab.closed' },
      { type: 'tab.focused' },
      { type: 'tab.renamed' },
      { type: 'tab.moved' },
      { type: 'pane.created' },
      { type: 'pane.closed' },
      { type: 'pane.focused' },
      { type: 'pane.moved' },
      { type: 'pane.exited' },
      { type: 'worktree.created' },
      { type: 'worktree.opened' },
      { type: 'worktree.removed' },
      ...paneIds.map(pane_id => ({
        type: 'pane.agent_status_changed',
        pane_id,
      })),
    ];
    return subscriptions;
  }

  function openSubscribeConnection(paneIds: string[]): Socket | undefined {
    if (destroyed) return;

    const conn = createConnection(socketPath);
    const splitter = createSplitter();
    let ackReceived = false;
    const id = `mobile:sub:${Date.now()}`;

    // A socket that connects but never acks would otherwise hang forever:
    // reconnection is only triggered by 'close'.
    const ackTimer = setTimeout(() => {
      if (!ackReceived) conn.destroy();
    }, REQUEST_TIMEOUT_MS);

    conn.on('connect', () => {
      const subscriptions = buildSubscriptions(paneIds);
      conn.write(serialize({ type: 'request', id, method: 'events.subscribe', params: { subscriptions } }));
    });

    conn.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      const lines = splitter.push(chunk.toString('utf8'));
      for (const line of lines) {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

        if (!ackReceived) {
          const result = msg.result as Record<string, unknown> | undefined;
          if (result?.type === 'subscription_started') {
            ackReceived = true;
            clearTimeout(ackTimer);
            setConnected(true);
            backoffMs = BACKOFF_INITIAL_MS;
          }
          continue;
        }

        // event push line. herdr mixes name forms: lifecycle events arrive in
        // underscore form (pane_created), typed subscription events in dot form
        // (pane.agent_status_changed) — normalize to underscore for dispatch.
        const eventMsg = msg as unknown as EventPush;
        const eventName = (eventMsg.event || '').replaceAll('.', '_');
        const data = (eventMsg.data || {}) as Record<string, unknown>;
        if (!eventName) continue;

        handleEvent(eventName, data);
      }
    });

    conn.on('error', () => {
      // handled by close
    });

    conn.on('close', () => {
      clearTimeout(ackTimer);
      if (destroyed) return;
      if (conn === subscribeConn) {
        subscribeConn = null;
        setConnected(false);
        scheduleReconnect();
      }
    });

    return conn;
  }

  function handleEvent(eventName: string, data: Record<string, unknown>): void {
    if (PANE_SET_CHANGING_EVENTS.has(eventName)) {
      schedulePaneRebuild();
      return;
    }

    if (!currentState) return;

    const { state: nextState, changes } = applyEvent(currentState, eventName, data, Date.now());
    currentState = nextState;

    for (const change of changes) {
      onAgentStatus?.(change, currentState);
    }

    // Focus events are applied to the model but do not trigger WS pushes: herdr
    // emits them ~10/s during desktop activity, and phone clients don't track
    // desktop focus live (GET /api/state returns the current value on demand).
    if (changes.length > 0 || eventName === 'workspace_renamed' || eventName === 'tab_renamed') {
      scheduleBroadcast();
    }
  }

  // ── debounced helpers ───────────────────────────────────────────────────────

  function schedulePaneRebuild(): void {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(async () => {
      rebuildTimer = null;
      try {
        await fetchSnapshot();
        const paneIds = getPaneIds(currentState!);
        const oldConn = subscribeConn;
        subscribeConn = openSubscribeConnection(paneIds) ?? null;
        // close old after new is established
        if (oldConn) oldConn.destroy();
      } catch (err) {
        console.error('[herdr-client] rebuild failed:', (err as Error).message);
        scheduleReconnect();
      }
    }, PANE_REBUILD_DEBOUNCE_MS);
  }

  function scheduleBroadcast(): void {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (currentState) onState?.(currentState);
    }, STATE_BROADCAST_DEBOUNCE_MS);
  }

  // ── reconnect backoff ───────────────────────────────────────────────────────

  function scheduleReconnect(): void {
    if (destroyed) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    setTimeout(() => connect(), delay);
  }

  async function connect(): Promise<void> {
    if (destroyed) return;
    try {
      await fetchSnapshot();
      const paneIds = getPaneIds(currentState!);
      if (subscribeConn) subscribeConn.destroy();
      subscribeConn = openSubscribeConnection(paneIds) ?? null;
    } catch (err) {
      console.error('[herdr-client] connect failed:', (err as Error).message);
      scheduleReconnect();
    }
  }

  // ── public API ──────────────────────────────────────────────────────────────

  return {
    start(): void {
      connect();
    },

    isConnected(): boolean {
      return connected;
    },

    getState(): NormalizedState | null {
      return currentState;
    },

    async rpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
      return request(method, params);
    },

    destroy(): void {
      destroyed = true;
      if (rebuildTimer) clearTimeout(rebuildTimer);
      if (broadcastTimer) clearTimeout(broadcastTimer);
      if (subscribeConn) subscribeConn.destroy();
    },
  };
}
