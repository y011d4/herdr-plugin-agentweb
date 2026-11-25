import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';

// A WebSocket the test drives: open() and drop() fire their events at once; close()
// fires its close event a moment later, as a browser does.
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static all: FakeWebSocket[] = [];
  url: string;
  readyState = 0;
  sent: Array<{ type: string; paneId?: string }> = [];
  constructor(url: string) {
    super();
    this.url = url;
    FakeWebSocket.all.push(this);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  /** the server or the network ends it (or it never connected) */
  drop() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  close() {
    this.readyState = 2;
    setTimeout(() => { this.readyState = 3; this.dispatchEvent(new Event('close')); }, 0);
  }
  receive(data: string) { this.dispatchEvent(new MessageEvent('message', { data })); }
  pings() { return this.sent.filter((m) => m.type === 'ping').length; }
}

const sockets = () => FakeWebSocket.all;
const last = () => sockets()[sockets().length - 1];

let ws: typeof import('../src/ws.ts');
let api: typeof import('../src/api.ts');
let store: typeof import('../src/store.ts');
let fetchMock: ReturnType<typeof vi.fn>;
let received: unknown[];
let emits: number;

beforeEach(async () => {
  vi.useFakeTimers();
  FakeWebSocket.all = [];
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  });
  vi.stubGlobal('location', { protocol: 'http:', host: 'bridge:8390' });
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ polled: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules(); // ws.ts keeps its socket and timers in module state
  ws = await import('../src/ws.ts');
  api = await import('../src/api.ts');
  store = await import('../src/store.ts');
  received = [];
  ws.onWsMessage((m) => received.push(m));
  emits = 0;
  store.subscribe(() => { emits++; });
  api.setToken('tok en');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ws — open and close', () => {
  it('connects with the token, reports the link, sends the watches and passes messages on', () => {
    store.store.view.activePaneId = 'p1';
    ws.wsConnect();
    ws.wsConnect(); // already connecting: no second socket
    assert.equal(sockets().length, 1);
    assert.equal(last().url, 'ws://bridge:8390/ws?token=tok%20en');
    assert.equal(store.store.wsConnected, false);
    last().open();
    assert.equal(store.store.wsConnected, true);
    assert.equal(emits, 1);
    assert.deepEqual(last().sent, [{ type: 'unwatch_transcript' }, { type: 'watch_pane', paneId: 'p1' }]);
    last().receive('{"type":"pong"}');
    last().receive('not json');
    assert.deepEqual(received, [{ type: 'pong' }]);
    last().drop();
    assert.equal(store.store.wsConnected, false);
    assert.equal(emits, 2);
  });

  it('polls /api/state every 10s while down, as state messages, until it is back', async () => {
    ws.wsConnect();
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(10_000); // the reconnect attempt (at 1s) is still connecting
    assert.equal(sockets().length, 2);
    assert.deepEqual(fetchMock.mock.calls.map((c) => c[0]), ['/api/state']);
    assert.equal((fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers.Authorization, 'Bearer tok en');
    assert.deepEqual(received, [{ type: 'state', state: { polled: true } }]);
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(fetchMock.mock.calls.length, 2);
    last().open();
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(fetchMock.mock.calls.length, 2);
  });
});

describe('ws — reconnecting', () => {
  it('backs off 1, 2, 4, 8, 15, 15s, and back to 1s after a connect', async () => {
    ws.wsConnect();
    last().open();
    last().drop();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const n = sockets().length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      assert.equal(sockets().length, n, `not before ${delay}ms`);
      await vi.advanceTimersByTimeAsync(1);
      assert.equal(sockets().length, n + 1, `at ${delay}ms`);
      last().drop(); // the attempt fails
    }
    await vi.advanceTimersByTimeAsync(15_000);
    last().open();
    last().drop();
    const n = sockets().length;
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(sockets().length, n + 1);
  });

  it('ignores the late close of a socket it has replaced', async () => {
    ws.wsConnect();
    const old = last();
    old.open();
    ws.wsSignOut(); // old.close(): its close event comes later
    api.setToken('again');
    ws.wsConnect();
    last().open();
    await vi.advanceTimersByTimeAsync(0); // the old socket's close lands now
    assert.equal(store.store.wsConnected, true);
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(sockets().length, 2);
    assert.equal(fetchMock.mock.calls.length, 0);
  });
});

describe('ws — signed out', () => {
  it('sign-out closes the socket and stops reconnecting, polling and pinging', async () => {
    ws.wsConnect();
    const s = last();
    s.open();
    api.clearToken();
    ws.wsSignOut();
    assert.equal(store.store.wsConnected, false);
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(s.readyState, 3);
    assert.equal(sockets().length, 1);
    assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(s.pings(), 0);
  });

  it('a socket dropped after a 401 cleared the token does not come back', async () => {
    ws.wsConnect();
    last().open();
    api.clearToken();
    last().drop();
    assert.equal(store.store.wsConnected, false);
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(sockets().length, 1);
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('does not connect without a token', () => {
    api.clearToken();
    ws.wsConnect();
    assert.equal(sockets().length, 0);
  });
});

describe('ws — keepalive', () => {
  it('pings every 30s while open, and stops when it drops', async () => {
    ws.wsConnect();
    const s = last();
    s.open();
    await vi.advanceTimersByTimeAsync(29_999);
    assert.equal(s.pings(), 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(s.pings(), 1);
    await vi.advanceTimersByTimeAsync(30_000);
    assert.equal(s.pings(), 2);
    s.drop();
    await vi.advanceTimersByTimeAsync(90_000);
    assert.equal(s.pings(), 2);
  });
});
