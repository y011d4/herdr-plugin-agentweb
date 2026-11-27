// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, getToasts } from '../src/notify.ts';
import { createPaneView, type PanelPrompt, type PaneView } from '../src/pane-view.ts';
import { promptIdentity } from '../src/prompt.ts';
import { setAppState, store } from '../src/store.ts';
import type { TimelineItem } from '../src/transcript.ts';
import type { AgentStatus, WsMessage } from '../src/types.ts';
import { read, state, transcript } from './contract.gen.ts';

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
let calls: { toggle: boolean[]; modes: number; activity: Array<string | null>; prompt: Array<PanelPrompt | null> };
function open(paneId: string): void {
  calls = { toggle: [], modes: 0, activity: [], prompt: [] };
  view = createPaneView(container, paneId, {
    showToggle: (v) => calls.toggle.push(v), modeChanged: () => calls.modes++, activity: (a) => calls.activity.push(a),
    prompt: (p) => calls.prompt.push(p),
  });
}
const chatLog = () => container.querySelector<HTMLElement>('#chat-log')!;
/** `paneId` opened afresh with its terminal chosen (the toggle's choice, in memory). */
function openOnTerminal(paneId: string): void {
  open(paneId);
  view.setMode('terminal', true);
  view.destroy();
  reqs = [];
  open(paneId);
}

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
  it('opens a Claude pane on its chat (its transcript first, no terminal read), appends a push, and replaces the log for a new session', async () => {
    open('p1');
    assert.equal(store.view.paneViewMode, 'chat', 'on its chat at once');
    assert.equal(container.querySelector<HTMLElement>('#terminal-output')!.style.display, 'none');
    assert.deepEqual(reqs.map((q) => q.url), ['/api/panes/p1/transcript'], 'no terminal read first');
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

  it('a tap on a link while chat text is selected only ends the selection', async () => {
    open('p1');
    await answer('/transcript', transcript[0]);
    const items: TimelineItem[] = [{ kind: 'assistant', text: 'PR: https://example.com/pull/1', sidechain: false }];
    push({ type: 'transcript_items', paneId: 'p1', available: true, sessionId: transcript[0].sessionId!, items, cursor: 300, reset: false });
    const a = chatLog().querySelector<HTMLAnchorElement>('a.chat-link')!;
    assert.equal(a.getAttribute('href'), 'https://example.com/pull/1');
    // what the chat log let through; the test itself never follows a link
    const opened: boolean[] = [];
    const record = (e: Event) => { opened.push(!e.defaultPrevented); e.preventDefault(); };
    document.addEventListener('click', record);
    try {
      const sel = getSelection()!;
      sel.selectAllChildren(chatLog().lastElementChild!);
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.deepEqual(opened, [false], 'the tap that dismisses a selection opens nothing');
      assert.equal(sel.isCollapsed, true, 'and it does dismiss it');
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.deepEqual(opened, [false, true], 'without a selection the link opens');
    } finally {
      document.removeEventListener('click', record);
    }
  });

  it('runs at most one availability probe at a time', async () => {
    vi.useFakeTimers();
    openOnTerminal('p3');
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
    view.destroy();
    await answer('/transcript', transcript[0]);
    assert.deepEqual(calls.toggle, []);
    assert.equal(chatLog().innerHTML, '');
    assert.equal(wsListeners.size, 0, 'unsubscribed from the socket');
    store.view.paneViewMode = 'chat';
    view.setMode('terminal', true); // a late caller: an answer landing after the pane was left
    assert.equal(store.view.paneViewMode, 'chat', 'the next pane\'s mode untouched');
    reqs = [];
    open('p1');
    assert.deepEqual(reqs.map((q) => q.url), ['/api/panes/p1/transcript'], 'no terminal choice kept for it: on its chat');
  });

  it("an explicit terminal is the pane's own choice, kept while the app runs; other panes still open on their chat", async () => {
    open('p6');
    await answer('/transcript', transcript[0]);
    view.setMode('terminal', true);
    view.destroy();
    reqs = [];
    open('p6');
    assert.equal(store.view.paneViewMode, 'terminal');
    assert.ok(reqs[0].url.startsWith('/api/panes/p6/read?source=visible'), 'its terminal first');
    view.destroy();
    reqs = [];
    open('p1');
    assert.equal(store.view.paneViewMode, 'chat', 'another pane: its chat');
    view.destroy();
    open('p6');
    await answer('/api/panes/p6/read?source=visible', read[1]);
    await answer('/api/panes/p6/transcript', transcript[0]);
    view.setMode('chat', true); // back to its chat (the panel tests below open p6 on it)
    assert.equal(localStorage.getItem('herdr_pane_view'), null, 'nothing stored');
  });

  it('suspended (a Home under a drawer) it takes no messages and reads nothing; resumed it goes on as it was', async () => {
    vi.useFakeTimers();
    open('p1');
    await answer('/transcript', transcript[0]);
    const first = chatLog().firstElementChild;
    view.suspend();
    store.view.paneViewMode = 'terminal'; // the drawer's
    const session = transcript[0].sessionId!;
    push({ type: 'transcript_items', paneId: 'p1', available: true, sessionId: session, items: [{ kind: 'assistant', text: 'late', sidechain: false }], cursor: 999, reset: false });
    await vi.advanceTimersByTimeAsync(3000 * 2);
    store.wsConnected = false;
    await vi.advanceTimersByTimeAsync(3000 * 2);
    assert.ok(!/late/.test(chatLog().textContent!), 'no message taken');
    assert.equal(reqs.filter((q) => !q.answered).length, 0, 'no read, no poll');
    store.wsConnected = true;
    calls.toggle = [];
    view.resume();
    assert.equal(store.view.paneViewMode, 'chat', 'its mode on show again');
    assert.deepEqual(calls.toggle, [true]);
    assert.ok(chatLog().firstElementChild === first, 'the same log');
    // the re-sent watch's tail, the same as shown: nothing redrawn
    push({ type: 'transcript_items', paneId: 'p1', available: true, sessionId: session, items: transcript[0].items!, cursor: transcript[0].cursor!, reset: true });
    assert.ok(chatLog().firstElementChild === first, 'not redrawn');
    push({ type: 'transcript_items', paneId: 'p1', available: true, sessionId: session, items: [{ kind: 'assistant', text: 'after', sidechain: false }], cursor: 999, reset: false });
    assert.match(chatLog().textContent!, /after/);
  });

  it('a probe failing while suspended reports nothing (the resume reports anew)', async () => {
    vi.useFakeTimers();
    openOnTerminal('p3'); // the terminal first, then the probe
    await answer('/api/panes/p3/read?source=visible', read[1]);
    assert.equal(count('/api/panes/p3/transcript'), 1);
    const modes = calls.modes;
    view.suspend();
    await answer('/api/panes/p3/transcript', { error: 'boom' }, 500);
    assert.equal(calls.modes, modes, 'no modeChanged');
  });

  it('a scrollback read dropped by a suspend is read again with the next look at the terminal', async () => {
    openOnTerminal('p3'); // the terminal first, then its scrollback
    await answer('/api/panes/p3/read?source=visible', read[1]);
    assert.equal(count('/api/panes/p3/read?source=recent'), 1);
    view.setMode('chat', false);
    view.suspend();
    await answer('/api/panes/p3/read?source=recent', { ansi: Array.from({ length: 40 }, (_, i) => `old-${i}`).join('\n') }); // dropped (held)
    view.resume();
    view.setMode('terminal', false);
    await answer('/api/panes/p3/read?source=visible', read[1]);
    assert.equal(count('/api/panes/p3/read?source=recent'), 2, 'read again');
    await answer('/api/panes/p3/read?source=recent', { ansi: Array.from({ length: 40 }, (_, i) => `new-${i}`).join('\n') }); // in
    view.suspend();
    view.resume(); // on its terminal: what scrolled into its history under the drawer is read too
    while (reqs.some((q) => !q.answered && q.url.startsWith('/api/panes/p3/read?source=visible'))) await answer('/api/panes/p3/read?source=visible', read[1]);
    assert.equal(count('/api/panes/p3/read?source=recent'), 3, 'read again on the resume');
  });

  it('a switch asked for while suspended (a typing option landing under a drawer) is made as it resumes', async () => {
    open('p1');
    await answer('/transcript', transcript[0]);
    view.suspend();
    view.setMode('terminal', false);
    assert.equal(container.querySelector<HTMLElement>('#terminal-output')!.style.display, 'none', 'not under the drawer');
    view.resume();
    assert.equal(store.view.paneViewMode, 'terminal');
    assert.equal(container.querySelector<HTMLElement>('#terminal-output')!.style.display, '');
    view.setMode('chat', false);
  });

  it("a terminal look from before a suspend leaves the scrollback to the resume's", async () => {
    open('p1');
    await answer('/transcript', transcript[0]);
    view.setMode('terminal', false); // its first terminal look: a screen read, then the scrollback
    view.suspend();
    view.resume(); // the resume's own look
    const screens = reqs.filter((q) => !q.answered && q.url.startsWith('/api/panes/p1/read?source=visible'));
    assert.equal(screens.length, 2);
    screens[0].answered = true;
    screens[0].answer(200, read[1]); // the old one lands first: held then, it draws nothing
    await flush();
    assert.equal(count('source=recent'), 0, 'no scrollback from the old look');
    await answer('/api/panes/p1/read?source=visible', read[1]);
    assert.equal(count('source=recent'), 1, "the resume's look reads it");
    view.setMode('chat', false);
  });

  it('a fallback poll in flight as it is suspended applies neither then nor after the resume', async () => {
    vi.useFakeTimers();
    open('p1');
    await answer('/transcript', transcript[0]);
    store.wsConnected = false;
    await vi.advanceTimersByTimeAsync(3000); // the socket down: a fallback poll
    assert.equal(reqs.filter((q) => !q.answered && q.url.includes('/transcript?session=')).length, 1);
    view.suspend();
    const session = transcript[0].sessionId!;
    await answer('/transcript?session=', { available: true, sessionId: session, cursor: 999, reset: false, items: [{ kind: 'assistant', text: 'stale', sidechain: false }] });
    view.resume();
    assert.ok(!/stale/.test(chatLog().textContent!), 'dropped');
    store.wsConnected = true;
  });

  it('opened on its chat with the socket down, a fallback poll with a transcript shows the toggle', async () => {
    vi.useFakeTimers();
    store.wsConnected = false;
    open('p1');
    await answer('/transcript', { error: 'down' }, 500); // the first GET fails
    assert.deepEqual(calls.toggle, []);
    await vi.advanceTimersByTimeAsync(3000);
    await answer('/transcript', { ...transcript[0], reset: true });
    assert.deepEqual(calls.toggle, [true]);
    store.wsConnected = true;
  });
});

describe('pane view: answer panel', () => {
  async function blocked(): Promise<void> {
    open('p6');
    await answer('/transcript', transcript[0]); // chat: the blocked pane's panel shows
    assert.deepEqual(calls.prompt, [{ parsed: null, id: '', screen: null }]);
    await answer(PROMPT, { ansi: ASK });
  }
  const shown = () => calls.prompt[calls.prompt.length - 1];
  const withStatus = (status: AgentStatus) => {
    const s = structuredClone(state);
    for (const ws of s.workspaces) for (const t of ws.tabs) for (const p of t.panes) if (p.paneId === 'p6') p.agent!.status = status;
    setAppState(s);
    view.onState();
  };

  it('feeds the prompt and its identity, the same while it holds, a new one when it changes, none once unblocked', async () => {
    vi.useFakeTimers();
    await blocked();
    const first = shown()!;
    assert.deepEqual(first.parsed!.options.map((o) => o.label), ['apple', 'banana', 'cherry']);
    assert.equal(first.parsed!.question, 'Pick a fruit');
    assert.equal(first.id, promptIdentity(ASK));
    assert.match(first.screen!, /banana/);
    await vi.advanceTimersByTimeAsync(1200);
    await answer(PROMPT, { ansi: `${ASK}\n\u001b[2m status bar\u001b[0m` }); // the status bar below: same prompt
    assert.ok(shown()!.parsed === first.parsed, 'the same prompt while its identity holds');
    assert.match(shown()!.screen!, /status bar/);
    await vi.advanceTimersByTimeAsync(1200);
    await answer(PROMPT, { ansi: ASK.replace('Pick a fruit', 'Pick another') });
    assert.equal(shown()!.parsed!.question, 'Pick another');
    assert.notEqual(shown()!.id, first.id);
    withStatus('working');
    assert.equal(shown(), null);
  });

  it('closes its drawer once a sent answer has the agent working, not for "Chat about this" nor on a Home', async () => {
    await blocked();
    store.view.paneBackRoute = '#/agents/personal';
    location.hash = '#/pane/p6';
    view.answered(shown()!.id, false, Promise.resolve());
    await flush();
    push({ type: 'agent_status', paneId: 'p6', agent: 'claude', from: 'blocked', to: 'working', workspaceLabel: null, tabLabel: null });
    assert.equal(location.hash, '#/agents/personal');

    location.hash = '#/pane/p6';
    view.answered(shown()!.id, true, Promise.resolve()); // Chat about this
    await flush();
    withStatus('working');
    assert.equal(location.hash, '#/pane/p6');
  });

  it('says "Answer not confirmed" when the pane is still blocked 10s after the press; a failed press stays quiet', async () => {
    vi.useFakeTimers();
    await blocked();
    view.answered(shown()!.id, false, Promise.reject(new Error('boom')));
    await vi.advanceTimersByTimeAsync(10_000);
    assert.deepEqual(getToasts(), []);
    view.answered(shown()!.id, false, Promise.resolve());
    await vi.advanceTimersByTimeAsync(9_999);
    assert.deepEqual(getToasts(), []);
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(getToasts().map((t) => t.title), ['Answer not confirmed']);
  });

  it('after a 409 re-reads the prompt and shows it, unless a newer answer began meanwhile', async () => {
    await blocked();
    const changed = ASK.replace('Pick a fruit', 'Pick another');
    const done = view.reread(() => true);
    await answer(PROMPT, { ansi: changed });
    await done;
    assert.equal(shown()!.parsed!.question, 'Pick another');
    const stale = view.reread(() => false);
    await answer(PROMPT, { ansi: ASK });
    await stale;
    assert.equal(shown()!.parsed!.question, 'Pick another');
  });
});
