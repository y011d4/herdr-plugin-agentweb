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
  // pane IDs covered by the currently acknowledged subscription; snapshot status
  // replays skip these (live events deliver their changes) and cover the rest.
  let subscribedPaneIds = new Set<string>();

  function setConnected(val: boolean): void {
    if (connected !== val) {
      connected = val;
      onConnectionChange?.(val);
    }
  }

  // Only non-sensitive identifiers reach the logs — never text/keys/prompts,
  // which pane.send_input and agent.send carry and bridge.log would persist.
  function safeParamsForLog(params: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const k of ['pane_id', 'target', 'source', 'format']) {
      // JSON.stringify escapes control chars (ids come from decoded URL path
      // segments) so a newline/escape can't forge or corrupt a log line.
      if (typeof params[k] === 'string') parts.push(`${k}=${JSON.stringify(params[k])}`);
    }
    return parts.join(' ');
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
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          console.error(`[herdr-client] rpc ${method} error: ${err.message} ${safeParamsForLog(params)}`);
          reject(err);
        }
      });

      conn.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          console.error(`[herdr-client] rpc ${method} closed without response ${safeParamsForLog(params)}`);
          reject(new Error('connection closed'));
        }
      });
    });
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  // Replay agent-status changes from a fresh snapshot for events live
  // subscriptions missed. A pane's changes are snapshot-only exactly while it is
  // NOT in the acknowledged subscription's coverage (subscribedPaneIds): every
  // pane right after a full reconnect (coverage cleared on drop), and panes
  // created during a rebuild until the new subscription acks. Covered panes get
  // their changes live, so replaying them would duplicate.
  async function fetchSnapshot(replayMissed = false, coverage: Set<string> = subscribedPaneIds): Promise<NormalizedState> {
    // Hold live events while the snapshot RPC is in flight so applying it can't
    // clobber a status a concurrent event just set (see dispatchEvent).
    snapshotDepth++;
    try {
      const result = await request('session.snapshot') as Record<string, unknown>;
      const snap = (result.snapshot ?? result) as Record<string, unknown>;
      const nowMs = Date.now();
      const prev = currentState;
      currentState = createState(snap as Parameters<typeof createState>[0], nowMs, currentState);
      if (replayMissed && prev) {
        for (const [paneId, pane] of currentState._paneById) {
          if (!pane.agent || coverage.has(paneId)) continue;
          const from = prev._paneById.get(paneId)?.agent?.status ?? 'unknown';
          const to = pane.agent.status;
          if (from !== to) onAgentStatus?.({ paneId, from, to, agent: pane.agent }, currentState);
        }
      }
      // Deliver snapshot immediately (not debounced) so getState() callers see it
      // right away, and so a flood of queued events can't starve the initial delivery.
      onState?.(currentState);
      return currentState;
    } finally {
      if (--snapshotDepth === 0) drainEvents();
    }
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

  function openSubscribeConnection(paneIds: string[], onReady?: () => void): Socket | undefined {
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
            // Subscriptions are future-only (verified against herdr): a status
            // change between the pre-subscribe snapshot and this ack is delivered
            // by neither the old nor the new subscription. Replay one more
            // snapshot against the coverage that was live before this ack to catch
            // those (buffering keeps it from clobbering live state), then adopt
            // this subscription's coverage. On failure, reconnect so the gap is
            // still replayed rather than silently swallowed by the new coverage.
            const prevCoverage = subscribedPaneIds;
            subscribedPaneIds = new Set(paneIds);
            fetchSnapshot(true, prevCoverage).catch((err: Error) => {
              console.error('[herdr-client] subscription reconcile failed:', err.message);
              // Drop this subscription so its close handler clears coverage and
              // reconnects: the reconnect's snapshot then replays the gap, which
              // the already-adopted new coverage would otherwise skip.
              if (conn === subscribeConn && !destroyed) conn.destroy();
            });
            onReady?.();
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

        dispatchEvent(eventName, data);
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
        subscribedPaneIds = new Set(); // no live coverage until we resubscribe
        setConnected(false);
        // Reflect the drop in the cached state so /api/state and WS clients stop
        // showing stale data as connected; the next snapshot restores connected.
        if (currentState) {
          currentState = { ...currentState, connected: false };
          onState?.(currentState);
        }
        scheduleReconnect();
      }
    });

    return conn;
  }

  // All subscription events flow through dispatchEvent so they can be held while
  // a snapshot is in flight. Otherwise a snapshot's createState() reassignment
  // could clobber a status a live event just applied — or emit a bogus reverse
  // transition. Buffered events drain (in order, and idempotently — applyEvent
  // is a no-op when from===to) once every in-flight snapshot has settled.
  let snapshotDepth = 0;
  const eventBuffer: Array<[string, Record<string, unknown>]> = [];

  function dispatchEvent(eventName: string, data: Record<string, unknown>): void {
    if (snapshotDepth > 0) { eventBuffer.push([eventName, data]); return; }
    handleEvent(eventName, data);
  }

  function drainEvents(): void {
    // One synchronous turn — apply everything buffered so far, in order. But for
    // per-pane status events, only the LAST matters: applying an earlier one
    // after the snapshot already advanced that pane would roll it back and emit a
    // bogus reverse transition. Skip status events superseded by a later one for
    // the same pane. (Event names are already normalized to underscore form.)
    const buffered = eventBuffer.splice(0);
    const lastStatusIdx = new Map<string, number>();
    buffered.forEach(([name, data], i) => {
      if (name === 'pane_agent_status_changed' && typeof data.pane_id === 'string') {
        lastStatusIdx.set(data.pane_id, i);
      }
    });
    buffered.forEach(([name, data], i) => {
      if (name === 'pane_agent_status_changed' && typeof data.pane_id === 'string'
          && lastStatusIdx.get(data.pane_id) !== i) return;
      handleEvent(name, data);
    });
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
        // replay status for panes not yet covered by an acknowledged
        // subscription (created during the rebuild) — their changes are
        // snapshot-only; existing covered panes get theirs live
        await fetchSnapshot(true);
        const paneIds = getPaneIds(currentState!);
        // Keep the old subscription alive until the new one is acknowledged so no
        // events (agent status, notifications) are lost in the gap. Drop the old
        // one once the new sub is ready — or if the new connection dies first,
        // which would otherwise leave the old one a zombie feeding stale events.
        const oldConn = subscribeConn;
        let oldDropped = false;
        let newAcked = false;
        const dropOld = (): void => {
          if (!oldDropped && oldConn) { oldDropped = true; oldConn.destroy(); }
        };
        const newConn = openSubscribeConnection(paneIds, () => { newAcked = true; dropOld(); });
        subscribeConn = newConn ?? null;
        if (newConn) newConn.once('close', dropOld);
        else dropOld();
        // If the old subscription drops on its own before the new one is
        // acknowledged, coverage for the existing panes is lost while the
        // replacement isn't live yet. subscribeConn already points at newConn, so
        // the old conn's own close handler ignores it — force a reconnect, which
        // re-snapshots and replays the gap.
        if (oldConn) {
          oldConn.once('close', () => {
            if (!oldDropped && !newAcked && !destroyed) {
              subscribedPaneIds = new Set();
              scheduleReconnect();
            }
          });
        }
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
      // replay status changes missed while the subscription was down (no-op on
      // the very first connect, where there is no previous state to diff against)
      await fetchSnapshot(true);
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
