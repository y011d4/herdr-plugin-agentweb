// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, getToasts } from '../src/notify.ts';
import { createPaneView, type PaneView } from '../src/pane-view.ts';
import { setAppState, store } from '../src/store.ts';
import type { TimelineItem } from '../src/transcript.ts';
import type { WsMessage } from '../src/types.ts';
import { errors, read, state, transcript } from './contract.gen.ts';

// The socket: the test delivers messages to whoever listens (pane-view.ts subscribes itself).
const wsListeners = new Set<(msg: WsMessage) => void>();
vi.mock('../src/ws.ts', () => ({
  onWsMessage: (fn: (msg: WsMessage) => void) => { wsListeners.add(fn); return () => { wsListeners.delete(fn); }; },
  wsSendWatch: () => {},
}));
const push = (msg: WsMessage) => { for (const fn of wsListeners) fn(msg); };

// The bridge: every request waits until the test answers it.
interface Req { method: string; url: string; body: any; answered: boolean; answer: (status: number, body: unknown) => void }
let reqs: Req[];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
/** Answers the first open request whose "METHOD url" contains `match`, and lets the app go on. */
async function answer(match: string, body: unknown, status = 200): Promise<void> {
  const r = reqs.find((q) => !q.answered && `${q.method} ${q.url}`.includes(match));
  assert.ok(r, `no open request ${match} (open: ${reqs.filter((q) => !q.answered).map((q) => `${q.method} ${q.url}`).join(', ')})`);
  r.answered = true;
  r.answer(status, body);
  await flush();
}
const count = (match: string) => reqs.filter((q) => `${q.method} ${q.url}`.includes(match)).length;

const SCREEN = 'GET /api/panes/p6/read?source=visible&lines=200';
const PROMPT = 'GET /api/panes/p6/read?source=visible&format=ansi';
const ASK = ['─'.repeat(28), ' ☐ Fruit', 'Pick a fruit', '', '❯ 1. apple', '  2. banana', '  3. cherry',
  'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');

let container: HTMLElement;
let view: PaneView;
let calls: { toggle: boolean[]; modes: number; activity: Array<string | null> };
function open(paneId: string): void {
  calls = { toggle: [], modes: 0, activity: [] };
  view = createPaneView(container, paneId, {
    showToggle: (v) => calls.toggle.push(v), modeChanged: () => calls.modes++, activity: (a) => calls.activity.push(a),
  });
}
const chatLog = () => container.querySelector<HTMLElement>('#chat-log')!;
const options = () => [...container.querySelectorAll<HTMLButtonElement>('#chat-prompt .ask-opt')];

beforeEach(() => {
  reqs = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
    const q: Req = { method: init.method ?? 'GET', url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), answered: false,
      answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) };
    reqs.push(q);
  }));
  localStorage.clear();
  clearToasts();
  setAppState(structuredClone(state)); // p1: claude working; p6: claude blocked
  store.wsConnected = true;
  container = document.body.appendChild(document.createElement('div'));
});
afterEach(() => {
  view.destroy();
  container.remove();
  vi.useRealTimers();
});

describe('pane view: chat', () => {
  it('opens a transcript as chat, appends a push, and replaces the log for a new session', async () => {
    open('p1');
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', transcript[0]);
    assert.deepEqual(calls.toggle, [true]);
    assert.equal(store.view.paneViewMode, 'chat');
    assert.equal(chatLog().style.display, '');
    assert.equal(chatLog().querySelectorAll('.chat-item').length, 2);
    const first = chatLog().firstElementChild;

    const session = transcript[0].sessionId!;
    const more: TimelineItem[] = [{ kind: 'assistant', text: 'and more', sidechain: false }];
    push({ type: 'transcript_items', paneId: 'p1', available: true, sessionId: session, items: more, cursor: 300, reset: false });
    assert.equal(chatLog().querySelectorAll('.chat-item').length, 3);
    assert.ok(chatLog().firstElementChild === first, 'an append keeps the nodes already shown');
    push({ type: 'transcript_items', paneId: 'p2', available: true, sessionId: session, items: more, cursor: 400, reset: false });
    assert.equal(chatLog().querySelectorAll('.chat-item').length, 3, "another pane's push is not ours");

    push({ type: 'transcript_items', paneId: 'p1', available: true, sessionId: 'new-session', items: more, cursor: 10, reset: true });
    assert.equal(chatLog().querySelectorAll('.chat-item').length, 1);
    assert.match(chatLog().textContent!, /and more/);
  });

  it('runs at most one availability probe at a time', async () => {
    vi.useFakeTimers();
    localStorage.setItem('herdr_pane_view', 'terminal');
    open('p1');
    await answer('/read?source=visible', read[1]);
    assert.equal(count('/transcript'), 1);
    await vi.advanceTimersByTimeAsync(3000 * 3); // the refresh timer re-probes a claude pane without chat
    assert.equal(count('/transcript'), 1, 'no second probe while the first is in flight');
    await answer('/transcript', { available: false });
    await vi.advanceTimersByTimeAsync(3000);
    assert.equal(count('/transcript'), 2, 'the next tick probes again once it is answered');
  });

  it('writes nothing for responses that land after destroy()', async () => {
    open('p1');
    await answer('/read?source=visible', read[1]);
    view.destroy();
    await answer('/transcript', transcript[0]);
    assert.deepEqual(calls.toggle, []);
    assert.equal(chatLog().style.display, 'none');
    assert.equal(chatLog().innerHTML, '');
    assert.equal(wsListeners.size, 0, 'unsubscribed from the socket');
  });
});

describe('pane view: answer panel', () => {
  async function blocked(): Promise<void> {
    open('p6');
    await answer(SCREEN, read[1]);
    await answer('/transcript', transcript[0]); // chat: the blocked pane's panel shows
    await answer(PROMPT, { ansi: ASK });
    assert.deepEqual(options().map((b) => b.textContent), ['1apple', '2banana', '3cherry']);
  }
  const posts = () => reqs.filter((q) => q.method === 'POST' && q.url === '/api/panes/p6/input');

  it('sends one press for a double tap, with the prompt it answers', async () => {
    await blocked();
    options()[1].click();
    options()[1].click();
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].body.press, '2');
    assert.ok(posts()[0].body.expect_prompt, 'expect_prompt is set');
  });

  it('on a 409 (prompt changed) re-reads the prompt, says so, and takes a new tap', async () => {
    await blocked();
    options()[1].click();
    await answer('POST /api/panes/p6/input', errors.find((e) => e.error.code === 'prompt_changed'), 409);
    await answer(PROMPT, { ansi: ASK });
    assert.deepEqual(getToasts().map((t) => t.title), ['Prompt changed']);
    assert.ok(!container.querySelector('#chat-prompt')!.classList.contains('chat-prompt-sending'), 'the buttons are live again');
    options()[0].click();
    assert.equal(posts().length, 2);
    assert.equal(posts()[1].body.press, '1');
  });
});
