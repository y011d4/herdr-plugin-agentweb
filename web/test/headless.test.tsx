// @vitest-environment happy-dom
// A headless orchestrator (hl:<name>): the pane made for it where panes are looked up, its routes and
// watch, and its Home: chat only, its sends, question, ■, usage and warnings through
// /api/orchestrators/:name/*; the alerts, the Claude Code check and the [yoicks] notice.
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DESKTOP_QUERY } from '../src/composer-keys.ts';
import { shownStatus } from '../src/dashboard-group.ts';
import { draftKey, getDraft, getQuote, setDraft, setQuote } from '../src/drafts.ts';
import { clearToasts, getToasts } from '../src/notify.ts';
import { orchestratorOfPane, resolveRoute } from '../src/routes.ts';
import { findPane, markPaneSeen, setAppState, store } from '../src/store.ts';
import type { AppState, OrchestratorView, WsMessage, WsStateMessage } from '../src/types.ts';
import { Modals } from '../src/ui/Modals.tsx';
import { quoteLine } from '../src/transcript.ts';
import { compactLine, homeTopbar, Pane, resetRows, StoppedHome, untilText, usageParts } from '../src/ui/Pane.tsx';
import { claudeCheckText } from '../src/ui/Settings.tsx';
import { watchMessages } from '../src/watch.ts';
import { messages, state as recorded, transcript } from './contract.gen.ts';
import { chatDom, fire, render, settle } from './render.ts';

vi.mock('../src/ws.ts', () => ({
  onWsMessage: (_fn: (msg: WsMessage) => void) => () => {},
  wsSendWatch: () => {},
}));
// happy-dom has no canvas: a picked file becomes an attachment named after it, once `scaled` resolves
let scaled: Promise<void> = Promise.resolve();
vi.mock('../src/image.ts', async (orig) => ({ ...(await orig<typeof import('../src/image.ts')>()),
  toAttachment: async (f: File) => { await scaled; return { mediaType: 'image/jpeg', data: f.name }; } }));

// The recorded headless orchestrator "pilot" (Pilot): blocked on "Which fruit?" (id 1a2b3c4d), completionSeq 3,
// 5h 35% read long ago, ctx 12.5%, warnings silent (interrupt, clear) and unknown_event, a compaction done (64% → 12.5%).
const pilot = (): OrchestratorView => structuredClone((messages.find((m) => m.type === 'state' &&
  m.state.orchestrators.some((o) => o.name === 'pilot')) as WsStateMessage).state.orchestrators.find((o) => o.name === 'pilot')!);
function withPilot(edit: (p: OrchestratorView) => void = () => {}): AppState {
  const s = structuredClone(recorded);
  const p = pilot();
  edit(p);
  s.orchestrators.push(p);
  return s;
}
const idle = (p: OrchestratorView): void => { p.headless!.status = 'idle'; p.headless!.pending = null; p.headless!.warnings = []; p.headless!.compact = null; };

interface Req { method: string; url: string; body: any; answered: boolean; answer: (status: number, body: unknown) => void }
let reqs: Req[];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function answer(match: string, body: unknown, status = 200): Promise<void> {
  const r = reqs.find((q) => !q.answered && `${q.method} ${q.url}`.includes(match));
  assert.ok(r, `no open request ${match} (open: ${reqs.filter((q) => !q.answered).map((q) => `${q.method} ${q.url}`).join(', ')})`);
  r.answered = true;
  await act(async () => { r.answer(status, body); await flush(); });
}
const posts = (action: string) => reqs.filter((q) => q.method === 'POST' && q.url === `/api/orchestrators/pilot/${action}`).map((q) => q.body);

let unmount: () => Promise<void>;
let container: HTMLElement;
async function home(s: AppState, actions?: { clear: () => void; stop: () => void }): Promise<void> {
  setAppState(s);
  location.hash = '#/home/pilot';
  store.view.activePaneId = 'hl:pilot';
  store.view.homeMode = true;
  const t = homeTopbar('hl:pilot');
  ({ container, unmount } = await render(<><div id="tb">{t.title}{t.right}</div><Pane paneId="hl:pilot" home={true} actions={actions} name="pilot" /><Modals /></>));
  await act(() => new Promise<void>((r) => { setTimeout(r, 0); })); // happy-dom's hashchange, on a timer: it would close a popover opened before it
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => container.querySelector<T>(sel)!;
const opts = () => [...container.querySelectorAll<HTMLButtonElement>('#headless-prompt .ask-opt:not(.ask-extra)')];
const extras = () => [...container.querySelectorAll<HTMLButtonElement>('#headless-prompt .ask-extra')];
/** Types into a React-controlled field (the native setter, so React sees the change). */
const type = (el: HTMLTextAreaElement, value: string): Promise<void> => fire(() => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

beforeEach(() => {
  reqs = [];
  unmount = async () => {};
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
    reqs.push({ method: init.method ?? 'GET', url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), answered: false,
      answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
  }));
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  localStorage.clear();
  clearToasts();
  store.seenDone = {};
});
afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

describe('the pane made for a headless orchestrator', () => {
  it('findPane has it while it runs, never in the State\'s workspaces; stopped, it has none', () => {
    setAppState(withPilot());
    const f = findPane('hl:pilot')!;
    assert.equal(f.ws.label, 'Pilot');
    assert.deepEqual([f.pane.agent!.status, f.pane.agent!.completionSeq], ['blocked', 3]);
    assert.ok(!store.appState!.workspaces.some((w) => w.tabs.some((t) => t.panes.some((p) => p.paneId.startsWith('hl:')))));
    setAppState(withPilot((p) => { p.paneId = null; p.headless!.status = 'stopped'; }));
    assert.equal(findPane('hl:pilot'), null);
  });

  it('a done one seen on this phone shows idle, and stays seen when another pane is marked', () => {
    const s = withPilot((p) => { idle(p); p.headless!.status = 'done'; });
    s.workspaces[0].tabs[0].panes[0].agent!.status = 'done'; // p1
    s.workspaces[0].tabs[0].panes[0].agent!.completionSeq = 7;
    setAppState(s);
    markPaneSeen('hl:pilot');
    assert.equal(store.seenDone['hl:pilot'], 3);
    markPaneSeen('p1');
    assert.deepEqual(store.seenDone, { 'hl:pilot': 3, p1: 7 });
    assert.equal(shownStatus(findPane('hl:pilot')!.pane, store.seenDone), 'idle');
  });

  it('hl:<name> is its orchestrator, stopped too: a late link opens its Home', () => {
    const s = withPilot((p) => { p.paneId = null; });
    assert.equal(orchestratorOfPane(s, 'hl:pilot')?.name, 'pilot');
    assert.deepEqual(resolveRoute('#/pane/hl%3Apilot', s, null), { kind: 'redirect', hash: '#/home/pilot', replace: true });
  });

  it('is watched for its transcript only, whatever the mode', () => {
    assert.deepEqual(watchMessages('hl:pilot', 'terminal', true), [{ type: 'unwatch_pane' }, { type: 'watch_transcript', paneId: 'hl:pilot' }]);
  });
});

describe("a headless orchestrator's Home", () => {
  it('is the chat alone: no terminal read, no toggle or keys, empty until its transcript has a line', async () => {
    await home(withPilot(idle));
    assert.deepEqual(reqs.map((q) => `${q.method} ${q.url}`), ['GET /api/panes/hl%3Apilot/transcript']);
    await answer('/transcript', { available: false });
    assert.equal($('#chat-log').textContent, 'No messages yet.');
    assert.equal($('#btn-view-toggle').style.display, 'none');
    assert.equal($('#quickkey-row').style.display, 'none');
    assert.equal($('#tb').textContent, 'Pilot· ready>_⚙'); // the toggle stays hidden
  });

  it('sends the composer to /api/orchestrators/:name/send', async () => {
    await home(withPilot(idle));
    const ta = $<HTMLTextAreaElement>('#pane-input');
    await fire(() => { ta.value = 'hi'; });
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send'), [{ text: 'hi' }]);
    await answer('POST /api/orchestrators/pilot/send', { ok: true });
    assert.equal(ta.value, '');
  });

  it('attaches picked images (thumbnails, removable), sends them with the text and clears them once sent', async () => {
    await home(withPilot(idle));
    const pick = async (...names: string[]) => {
      const picker = $<HTMLInputElement>('#input-image-picker');
      Object.defineProperty(picker, 'files', { configurable: true, value: names.map((n) => new File(['x'], n, { type: n.endsWith('.txt') ? 'text/plain' : 'image/png' })) });
      await fire(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
    };
    await pick('a.png', 'notes.txt', 'b.png');
    const thumbs = () => [...container.querySelectorAll<HTMLImageElement>('#input-images img')].map((i) => i.src);
    assert.deepEqual(thumbs(), ['data:image/jpeg;base64,a.png', 'data:image/jpeg;base64,b.png']);
    await fire(() => $('#input-images [aria-label="Remove image"]').click());
    assert.deepEqual(thumbs(), ['data:image/jpeg;base64,b.png']);
    await fire(() => $('#btn-send-enter').click()); // an image alone is a message
    await fire(() => $('#btn-send-enter').click()); // once
    assert.deepEqual(posts('send'), [{ text: '', images: [{ mediaType: 'image/jpeg', data: 'b.png' }] }]);
    await answer('POST /api/orchestrators/pilot/send', { ok: true });
    assert.ok(container.querySelector('#input-images') === null, 'thumbnails cleared');
    await pick('c.png');
    await fire(() => $('#btn-send-enter').click());
    await answer('POST /api/orchestrators/pilot/send', { error: { code: 'invalid_params', message: 'the images are over 1 MiB in all' } }, 400);
    assert.deepEqual(thumbs(), ['data:image/jpeg;base64,c.png']); // kept on a failure
    assert.deepEqual(getToasts().map((t) => t.body), ['the images are over 1 MiB in all']);
  });

  it('opens an attached image and a sent one full screen; × still removes an attached one', async () => {
    await home(withPilot(idle));
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    await answer('/transcript', { ...transcript[0], items: [{ kind: 'user', text: '', images: [png], sidechain: false, ts: null }] });
    const picker = $<HTMLInputElement>('#input-image-picker');
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['x'], 'a.png', { type: 'image/png' })] });
    await fire(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
    const shown = () => [...container.querySelectorAll<HTMLImageElement>('.image-preview img')].map((i) => `${i.src} ${i.alt}`);
    await fire(() => $('#input-images [aria-label="View image"]').click());
    assert.deepEqual(shown(), ['data:image/jpeg;base64,a.png Attached image']);
    await fire(() => $('.image-preview-close').click());
    assert.deepEqual(shown(), []);
    await fire(() => $('#chat-log .chat-image').click()); // the tap lands on the image inside its button
    assert.deepEqual(shown(), [`${png} image`]);
    await fire(() => $('.image-preview img').click());
    assert.deepEqual(shown(), []);
    await fire(() => $('#input-images [aria-label="Remove image"]').click());
    assert.ok(container.querySelector('#input-images') === null);
  });

  it("a worker's name in a [yoicks] notice opens its pane (herdr's name, from the State); one gone says so", async () => {
    await home(withPilot(idle)); // p3's agent is herdr's w-review (contract.gen.ts)
    location.hash = '#/home/pilot';
    await answer('/transcript', { ...transcript[0], items: [{ kind: 'user', text: '[yoicks] w-review: working → done\n[yoicks] w-gone: working → done', sidechain: false, ts: null }] });
    const names = [...container.querySelectorAll<HTMLElement>('#chat-log .chat-notice-agent')];
    assert.deepEqual(names.map((b) => b.dataset.agent), ['w-review', 'w-gone']);
    await fire(() => names[0].click());
    assert.equal(location.hash, '#/pane/p3');
    location.hash = '#/home/pilot';
    await fire(() => names[1].click());
    assert.equal(location.hash, '#/home/pilot');
    assert.deepEqual(getToasts().map((t) => t.body), ["w-gone isn't known yet, or is gone: try again in a moment."], 'p1, p6, p7 have no name yet');
    clearToasts();
    const named = withPilot(idle);
    for (const p of named.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes))) if (p.agent) p.agent.herdrName ??= `w-${p.paneId}`;
    await fire(() => setAppState(named));
    await fire(() => names[1].click());
    assert.deepEqual(getToasts().map((t) => t.body), ['No running agent is named w-gone.'], 'every name known');
  });

  it('sends nothing while an image is still being scaled', async () => {
    await home(withPilot(idle));
    let release = () => {};
    scaled = new Promise((r) => { release = r; });
    const picker = $<HTMLInputElement>('#input-image-picker');
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['x'], 'a.png', { type: 'image/png' })] });
    await fire(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
    await fire(() => { $<HTMLTextAreaElement>('#pane-input').value = 'see this'; });
    assert.equal($<HTMLButtonElement>('#btn-send-enter').disabled, true);
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send'), []);
    await act(async () => { release(); await flush(); });
    scaled = Promise.resolve();
    assert.equal($<HTMLButtonElement>('#btn-send-enter').disabled, false);
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send'), [{ text: 'see this', images: [{ mediaType: 'image/jpeg', data: 'a.png' }] }]);
  });

  it('counts its own question on Needs you, whose popover says where it is answered', async () => {
    const count = (): number => Number(/· (\d+)/.exec(container.querySelector('[data-action="needs"]')?.textContent ?? '')?.[1] ?? 0);
    await home(withPilot((p) => { idle(p); p.todos = [{ id: 't1', text: 'log in', agent: null, url: null, due: null, createdAt: 0 }]; }));
    const without = count();
    await unmount();
    await home(withPilot((p) => { p.todos = [{ id: 't1', text: 'log in', agent: null, url: null, due: null, createdAt: 0 }]; }));
    assert.equal(count(), without + 1, 'blocked on its question: one more');
    await fire(() => $('[data-action="needs"]').click());
    assert.equal($('[data-asks]').textContent, 'Pilot is waiting for your answer, below the chat.');
    await fire(() => setAppState(withPilot((p) => { idle(p); p.todos = [{ id: 't1', text: 'log in', agent: null, url: null, due: null, createdAt: 0 }]; })));
    assert.equal(container.querySelector('[data-asks]'), null, 'answered');
    assert.equal(count(), without);
  });

  it("answers its question with one POST per tap; a stale one says so and frees the options", async () => {
    await home(withPilot());
    assert.equal($('#headless-prompt .chat-prompt-q').textContent, 'Which fruit?');
    assert.deepEqual(opts().map((b) => b.textContent), ['1applered', '2cherry']);
    await fire(() => opts()[1].click());
    await fire(() => opts()[1].click());
    assert.deepEqual(posts('answer'), [{ id: '1a2b3c4d', answers: { 'Which fruit?': 'cherry' } }]);
    await answer('POST /api/orchestrators/pilot/answer', { error: { code: 'stale_question', message: 'gone' } }, 409);
    assert.deepEqual(getToasts().map((t) => t.title), ['Question changed']);
    await fire(() => opts()[0].click());
    assert.equal(posts('answer').length, 2);
    await fire(() => setAppState(withPilot(idle)));
    assert.equal(container.querySelector('#headless-prompt'), null, 'answered: the State takes it away');
  });

  it('asks several questions in turn, a multiSelect one with checks, then sends them together', async () => {
    await home(withPilot((p) => {
      const q = p.headless!.pending!.questions[0];
      p.headless!.pending!.questions = [{ ...q, multiSelect: true }, { question: 'Size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] }];
    }));
    assert.match($('#headless-prompt .chat-prompt-head').textContent!, /Fruit \(1\/2\)/);
    assert.equal($<HTMLButtonElement>('#headless-prompt-next').disabled, true);
    await fire(() => opts()[1].click()); // cherry, then apple: sent in the options' order
    await fire(() => opts()[0].click());
    await fire(() => $('#headless-prompt-next').click());
    assert.equal($('#headless-prompt .chat-prompt-q').textContent, 'Size?');
    await fire(() => opts()[1].click());
    assert.deepEqual(posts('answer'), [{ id: '1a2b3c4d', answers: { 'Which fruit?': 'apple, cherry', 'Size?': 'L' } }]);
  });

  it("takes Enter in a question's own answer as its Next (Send on the last) on a PC; Shift+Enter, an IME's, a held one and a phone's don't", async () => {
    await home(withPilot((p) => {
      const q = p.headless!.pending!.questions[0];
      p.headless!.pending!.questions = [q, { question: 'Size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }] }];
    }));
    const field = () => $<HTMLTextAreaElement>('#headless-prompt-text');
    const enter = async (init: KeyboardEventInit = {}): Promise<boolean> => { // whether it kept the newline from going in
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
      await fire(() => field().dispatchEvent(ev));
      return ev.defaultPrevented;
    };
    const question = () => $('#headless-prompt .chat-prompt-q').textContent;
    await fire(() => $('#headless-prompt-own').click());
    await type(field(), 'a ripe one');
    assert.equal(await enter(), false, "a phone's return key: a newline");
    vi.stubGlobal('matchMedia', () => ({ matches: true })); // a PC
    assert.deepEqual([await enter({ shiftKey: true }), await enter({ isComposing: true })], [false, false], 'Shift+Enter, an IME confirming: as typed');
    assert.equal(await enter({ repeat: true }), true, 'held: no newline either');
    assert.equal(question(), 'Which fruit?', 'none of them moved on');
    assert.equal(await enter(), true);
    assert.equal(question(), 'Size?', 'Next: the second question');
    assert.deepEqual(posts('answer'), [], 'nothing sent before the last is answered');
    await fire(() => $('#headless-prompt-own').click());
    await enter(); // nothing typed: nothing
    assert.equal(question(), 'Size?');
    await type(field(), 'XL');
    await enter();
    assert.deepEqual(posts('answer'), [{ id: '1a2b3c4d', answers: { 'Which fruit?': 'a ripe one', 'Size?': 'XL' } }], 'Send: all of them');
  });

  it("types a question's own answer under its options: that question's alone, a multiSelect's with its checks", async () => {
    await home(withPilot((p) => {
      const q = p.headless!.pending!.questions[0];
      p.headless!.pending!.questions = [q, { question: 'Size?', header: 'Size', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] },
        { question: 'When?', header: 'When', multiSelect: false, options: [{ label: 'now', description: '' }] }];
    }));
    // as Claude Code's TUI numbers them: the options, then Type something., then Chat about this
    assert.deepEqual(extras().map((b) => b.textContent), ['3Type something.', '4Chat about thisWrite about it below instead of answering']);
    assert.equal(container.querySelector('#headless-prompt-next'), null, 'a single choice needs no Next until typing');
    await fire(() => $('#headless-prompt-own').click());
    assert.equal($<HTMLButtonElement>('#headless-prompt-next').disabled, true, 'nothing typed yet');
    await type($<HTMLTextAreaElement>('#headless-prompt-text'), '  a ripe one  ');
    await fire(() => $('#headless-prompt-next').click());
    // the next question starts with its own empty field, closed
    assert.equal($('#headless-prompt .chat-prompt-q').textContent, 'Size?');
    assert.equal(container.querySelector('#headless-prompt-text'), null);
    assert.equal($('#headless-prompt-own').textContent, 'Type something');
    await fire(() => opts()[1].click());
    await fire(() => $('#headless-prompt-own').click());
    assert.equal($<HTMLTextAreaElement>('#headless-prompt-text').value, '');
    await type($<HTMLTextAreaElement>('#headless-prompt-text'), 'XL');
    await fire(() => $('#headless-prompt-next').click());
    await fire(() => opts()[0].click());
    assert.deepEqual(posts('answer'), [{ id: '1a2b3c4d', answers: { 'Which fruit?': 'a ripe one', 'Size?': 'L, XL', 'When?': 'now' } }]);
  });

  it('minimizes its questions to one line above the composer and back as they were; kept while open, a new question comes in full', async () => {
    const three = (p: OrchestratorView): void => {
      const q = p.headless!.pending!.questions[0];
      p.headless!.pending!.questions = [q, { question: 'Size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] },
        { question: 'When?', header: 'When', multiSelect: false, options: [{ label: 'now', description: '' }] }];
    };
    await home(withPilot(three));
    const panel = $('#headless-prompt');
    await fire(() => opts()[1].click()); // cherry: on to 2/3
    await fire(() => $('#headless-prompt-minimize').click());
    assert.ok(container.querySelector('#headless-prompt[data-minimized]') !== null, 'minimized');
    assert.equal(opts().length, 0, 'no options shown');
    assert.match($('#headless-prompt-expand').textContent!, /^⏳ Questions \(3\) — tap to answer/);
    assert.ok(container.querySelector('#pane-input') !== null, 'the composer below it');
    await fire(() => $('#headless-prompt-expand').click());
    assert.ok($('#headless-prompt') === panel, 'the same element: no second flash');
    assert.match($('#headless-prompt .chat-prompt-head').textContent!, /Size \(2\/3\)/, 'where it was');
    await fire(() => opts()[1].click()); // L
    await fire(() => $('#headless-prompt-minimize').click());
    await unmount();
    await home(withPilot(three)); // the Home again, the same question open
    assert.ok(container.querySelector('#headless-prompt[data-minimized]') !== null, 'still minimized');
    await fire(() => setAppState(withPilot((p) => { three(p); p.headless!.pending!.id = 'q2'; })));
    assert.ok(container.querySelector('#headless-prompt[data-minimized]') === null, 'a new question comes in full');
    await fire(() => opts()[0].click());
    await fire(() => opts()[0].click());
    await fire(() => opts()[0].click());
    assert.deepEqual(posts('answer'), [{ id: 'q2', answers: { 'Which fruit?': 'apple', 'Size?': 'S', 'When?': 'now' } }], 'one per question, then together');
  });

  describe('its composer, while its question is open', () => {
    const input = () => $<HTMLTextAreaElement>('#pane-input');
    const key = draftKey('hl:pilot', 'pilot');
    const enter = (): Promise<void> => fire(() => {
      vi.stubGlobal('matchMedia', () => ({ matches: true })); // a PC: Enter sends
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    it('the race: Enter pressed the moment a question comes sends nothing; the draft is kept, and goes once the question is gone', async () => {
      await home(withPilot(idle));
      await type(input(), 'and run the tests');
      await fire(() => setAppState(withPilot())); // the question comes…
      await enter(); // …as Enter is pressed
      await fire(() => $('#btn-send-enter').click());
      assert.deepEqual(posts('send'), []);
      assert.deepEqual([input().disabled, input().value, $<HTMLButtonElement>('#btn-send-enter').disabled], [true, 'and run the tests', true]);
      assert.equal($('#composer-locked').textContent!.trim(), 'Answer the question above, or press Chat about this to write about it.');
      await fire(() => setAppState(withPilot(idle))); // answered
      assert.ok(container.querySelector('#composer-locked') === null, 'unlocked');
      await enter();
      assert.deepEqual(posts('send'), [{ text: 'and run the tests' }]);
    });

    it("one sent before the State shows the question is refused by the bridge (409): kept, and it says why", async () => {
      await home(withPilot(idle));
      await type(input(), 'hello');
      await fire(() => $('#btn-send-enter').click());
      await answer('POST /api/orchestrators/pilot/send', { error: { code: 'question_pending', message: 'a question waits' } }, 409);
      assert.equal(input().value, 'hello');
      assert.deepEqual(getToasts().map((t) => t.title), ['Not sent: a question came first']);
      await fire(() => setAppState(withPilot()));
      assert.deepEqual([input().disabled, input().value, getDraft(key)], [true, 'hello', 'hello']);
    });

    it("Chat about this opens it, empty, for a message about the question: its id and the panel's answers so far; then the draft is back", async () => {
      setDraft(key, 'my draft');
      await home(withPilot((p) => {
        const q = p.headless!.pending!.questions[0];
        p.headless!.pending!.questions = [q, { question: 'Size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }] }];
      }));
      assert.deepEqual([input().disabled, input().value], [true, 'my draft']);
      await fire(() => opts()[1].click()); // cherry: answered so far
      await fire(() => $('#headless-prompt-chat').click());
      assert.deepEqual([input().disabled, input().value, input().placeholder], [false, '', 'Write about the question…'], 'an empty field, the draft kept');
      assert.ok(document.activeElement === input(), 'focused');
      assert.equal($('#headless-prompt-chat').getAttribute('aria-pressed'), 'true');
      assert.deepEqual(posts('answer'), [], 'nothing declined until it is sent');
      await type(input(), 'why S?');
      assert.equal(getDraft(key), 'my draft');
      await fire(() => $('#btn-send-enter').click());
      assert.deepEqual(posts('send'), [{ text: 'why S?', question: '1a2b3c4d', answers: { 'Which fruit?': 'cherry' } }]);
      await answer('POST /api/orchestrators/pilot/send', { ok: true });
      assert.equal(input().value, '');
      await fire(() => setAppState(withPilot(idle))); // the bridge declined it
      assert.deepEqual([input().disabled, input().value, getDraft(key)], [false, 'my draft', 'my draft'], 'the draft is back');
    });

    it("sets the draft's images aside while writing about the question; an image-only one on its way leaves the draft as it was", async () => {
      const pick = (name: string): Promise<void> => {
        const picker = $<HTMLInputElement>('#input-image-picker');
        Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['x'], name, { type: 'image/png' })] });
        return fire(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
      };
      const thumbs = (): number => container.querySelectorAll('#input-images [aria-label="View image"]').length;
      setDraft(key, 'my draft');
      await home(withPilot(idle));
      await pick('a.png');
      assert.equal(thumbs(), 1);
      await fire(() => setAppState(withPilot()));
      await fire(() => $('#headless-prompt-chat').click());
      assert.equal(thumbs(), 0, 'aside');
      await pick('b.png');
      await fire(() => $('#btn-send-enter').click());
      assert.deepEqual(posts('send'), [{ text: '', images: [{ mediaType: 'image/jpeg', data: 'b.png' }], question: '1a2b3c4d' }]);
      await fire(() => setAppState(withPilot(idle))); // declined before the send answers
      await answer('POST /api/orchestrators/pilot/send', { ok: true });
      assert.equal(input().value, 'my draft');
      assert.equal(thumbs(), 1, "the draft's image back, the sent one gone");
    });

    it('keeps unsent text about the question with the draft when the Home is left, or its send fails once it is', async () => {
      setDraft(key, 'my draft');
      await home(withPilot());
      await fire(() => $('#headless-prompt-chat').click());
      await type(input(), 'half written');
      await unmount();
      assert.equal(getDraft(key), 'my draft\n\nhalf written');
      setDraft(key, 'my draft');
      await home(withPilot());
      await fire(() => $('#headless-prompt-chat').click());
      await type(input(), 'on its way');
      await fire(() => $('#btn-send-enter').click());
      await unmount();
      unmount = async () => {};
      await answer('POST /api/orchestrators/pilot/send', { error: { code: 'x', message: 'down' } }, 500);
      assert.equal(getDraft(key), 'my draft\n\non its way');
    });

    it('gives an image picked for the draft, still read as Chat about this opens, to the draft', async () => {
      await home(withPilot(idle));
      let release = () => {};
      scaled = new Promise((r) => { release = r; });
      const picker = $<HTMLInputElement>('#input-image-picker');
      Object.defineProperty(picker, 'files', { configurable: true, value: [new File(['x'], 'a.png', { type: 'image/png' })] });
      await fire(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
      await fire(() => setAppState(withPilot()));
      await fire(() => $('#headless-prompt-chat').click());
      await act(async () => { release(); await flush(); });
      scaled = Promise.resolve();
      assert.ok(container.querySelector('#input-images') === null, 'not in the message about the question');
      await fire(() => setAppState(withPilot(idle)));
      assert.equal(container.querySelectorAll('#input-images [aria-label="View image"]').length, 1, "the draft's");
    });

    it('the question gone while its Chat about this is on its way: the draft once sent; unsent, the draft and what was written', async () => {
      setDraft(key, 'my draft');
      await home(withPilot());
      await fire(() => $('#headless-prompt-chat').click());
      await type(input(), 'about it');
      await fire(() => $('#btn-send-enter').click());
      await fire(() => setAppState(withPilot(idle))); // declined before the send answers
      assert.equal(input().value, 'about it', 'still on its way');
      await answer('POST /api/orchestrators/pilot/send', { ok: true });
      assert.equal(input().value, 'my draft');
      // answered elsewhere while writing about it: nothing typed is lost
      await fire(() => setAppState(withPilot((p) => { p.headless!.pending!.id = 'q2'; })));
      await fire(() => $('#headless-prompt-chat').click());
      await type(input(), 'half written');
      await fire(() => setAppState(withPilot(idle)));
      assert.deepEqual([input().value, getDraft(key)], ['my draft\n\nhalf written', 'my draft\n\nhalf written']);
    });
  });

  it('has ■ on its "doing now" line while it works', async () => {
    await home(withPilot((p) => { idle(p); p.headless!.status = 'working'; }));
    await fire(() => $('#btn-home-interrupt').click());
    assert.deepEqual(posts('interrupt'), [{}]);
  });

  it("compacts from its ⋮ between turns, with a focus if given; a refusal stays in the dialog", async () => {
    let cleared = 0;
    await home(withPilot(idle), { clear: () => { cleared++; }, stop: () => {} });
    const menu = () => fire(() => $('#btn-home-menu').click());
    const item = (id: string) => document.querySelector<HTMLButtonElement>(`#hm-${id}`)!;
    await menu();
    assert.deepEqual([...document.querySelectorAll('[id^=hm-]')].map((e) => e.textContent), ['Compact…', 'Clear (fresh session)…', 'Stop…']);
    await fire(() => item('clear').click());
    assert.equal(cleared, 1);
    await menu();
    await fire(() => item('compact').click());
    const focus = document.querySelector<HTMLInputElement>('#cp-focus')!;
    await fire(() => { focus.value = '  the open PRs  '; });
    await fire(() => document.querySelector<HTMLElement>('#cp-ok')!.click());
    assert.deepEqual(posts('compact'), [{ focus: 'the open PRs' }]);
    await answer('POST /api/orchestrators/pilot/compact', { error: { code: 'busy', message: 'it is working: compact once its turn has ended' } }, 409);
    assert.equal(document.querySelector('#cp-error')!.textContent, 'it is working: compact once its turn has ended');
    await fire(() => document.querySelector<HTMLElement>('#cp-ok')!.click());
    await answer('POST /api/orchestrators/pilot/compact', { ok: true });
    assert.ok(document.querySelector('#cp-focus') === null, 'closed once sent');
    await unmount();
    for (const status of ['working', 'blocked'] as const) {
      await home(withPilot((p) => { idle(p); p.headless!.status = status; }), { clear: () => {}, stop: () => {} });
      await menu();
      assert.ok(item('compact').disabled && item('compact').textContent === 'Compact…after this turn', status);
      await fire(() => item('compact').click());
      assert.ok(document.querySelector('#cp-focus') === null, `no dialog while ${status}`);
      await unmount();
    }
    await home(withPilot(idle)); // no actions (a test's bare Home): no ⋮
    assert.ok(container.querySelector('#btn-home-menu') === null);
  });

  it('suggests a Compact once the context is 70% full (a dot on ⋮, the context on its item), and never runs one', async () => {
    const hint = () => container.querySelector<HTMLElement>('#home-status [data-hint]');
    await home(withPilot(idle), { clear: () => {}, stop: () => {} });
    assert.ok(hint() === null);
    assert.equal($('#home-usage .high'), null);
    assert.equal($('#btn-home-menu').getAttribute('aria-label'), 'Orchestrator actions');
    await unmount();
    await home(withPilot((p) => { idle(p); p.headless!.usage!.contextPct = 71.4; }), { clear: () => {}, stop: () => {} });
    assert.ok(hint() !== null && hint()!.contains($('#btn-home-menu')));
    assert.equal($('#btn-home-menu').getAttribute('aria-label'), 'Orchestrator actions (ctx 71%: Compact suggested)');
    assert.equal($('#home-usage .high').textContent, ' · ctx 71%');
    await fire(() => $('#btn-home-menu').click());
    assert.equal(document.querySelector('#hm-compact')!.textContent, 'Compact…ctx 71%');
    assert.deepEqual(posts('compact'), []);
  });

  it('says on its "doing now" line that it compacts, then how it went, until the next turn', async () => {
    const line = () => $('#home-activity');
    const compact = (c: Partial<NonNullable<OrchestratorView['headless']>['compact']>, status: 'idle' | 'working' = 'idle') =>
      withPilot((p) => { idle(p); p.headless!.status = status; p.headless!.compact = { state: 'done', from: null, to: null, error: '', ...c }; });
    await home(compact({ state: 'running', from: 64 }, 'working'));
    assert.deepEqual([line().style.display, line().textContent], ['', 'compacting…■']);
    await fire(() => setAppState(compact({ from: 64, to: 12.5 })));
    assert.deepEqual([line().style.display, line().textContent], ['', 'compacted: ctx 64% → 13%']);
    await fire(() => setAppState(compact({ state: 'failed', error: 'Not enough messages to compact.' })));
    assert.equal(line().textContent, 'compact failed: Not enough messages to compact.');
    await fire(() => setAppState(compact({ from: 64, to: 12.5 }, 'working'))); // the next turn: its own
    assert.equal(line().textContent, 'thinking…■');
    await fire(() => setAppState(withPilot(idle)));
    assert.equal(line().style.display, 'none');
  });

  it('shows its model and switches it, but not mid-turn; none without a list', async () => {
    await home(withPilot()); // blocked: its turn runs
    const select = () => $<HTMLSelectElement>('#home-model');
    assert.deepEqual([...select().options].map((o) => `${o.value}:${o.text}`), ['opus:Opus 5.5', 'sonnet:Sonnet 5.5']);
    assert.equal(select().value, 'sonnet');
    assert.equal(select().disabled, true);
    await unmount();
    await home(withPilot(idle));
    assert.equal(select().disabled, false);
    const change = (v: string) => fire(() => { select().value = v; select().dispatchEvent(new Event('change', { bubbles: true })); });
    await change('opus');
    assert.deepEqual(posts('model'), [{ model: 'opus' }]);
    await answer('POST /api/orchestrators/pilot/model', { error: { code: 'busy', message: 'it is working: change the model once its turn has ended' } }, 409);
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`), ['Model not changed: it is working: change the model once its turn has ended']);
    await change('opus');
    await answer('POST /api/orchestrators/pilot/model', { error: { code: 'model_pending', message: "Claude Code hasn't answered within 10s" } }, 504);
    assert.equal(getToasts().at(-1)!.title, 'Model change pending');
    await unmount();
    await home(withPilot((p) => { idle(p); p.headless!.model = p.headless!.activeModel = 'claude-gone-1'; })); // saved, no longer listed
    assert.deepEqual([...select().options].map((o) => o.value), ['claude-gone-1', 'opus', 'sonnet']);
    assert.equal(select().value, 'claude-gone-1');
    await unmount();
    await home(withPilot((p) => { idle(p); p.headless!.models = []; }));
    assert.ok(container.querySelector('#home-model') === null);
  });

  it('shows the model in effect: with none chosen, a session resumed on Fable shows Fable; not said yet, the choice or …', async () => {
    const select = () => $<HTMLSelectElement>('#home-model');
    await home(withPilot((p) => {
      idle(p);
      p.headless!.model = '';
      p.headless!.activeModel = 'claude-fable-5-2';
      p.headless!.models.push({ value: 'claude-fable-5-2[1m]', displayName: 'Fable', description: 'Fable 5.2 · Most capable', resolvedModel: 'claude-fable-5-2' },
        { value: 'fable', displayName: 'Fable 5.2', description: 'For your toughest challenges', resolvedModel: 'claude-fable-5-2' });
    }));
    assert.equal(`${select().value}:${select().selectedOptions[0].text}`, 'claude-fable-5-2[1m]:Fable');
    await fire(() => { select().value = 'opus'; select().dispatchEvent(new Event('change', { bubbles: true })); });
    assert.deepEqual(posts('model'), [{ model: 'opus' }]);
    await unmount();
    await home(withPilot((p) => { idle(p); p.headless!.activeModel = ''; }));
    assert.equal(select().value, 'sonnet');
    await unmount();
    await home(withPilot((p) => { idle(p); p.headless!.model = p.headless!.activeModel = ''; }));
    assert.equal(`${select().value}:${select().selectedOptions[0].text}:${select().selectedOptions[0].disabled}`, ':…:true');
  });

  it('shows its usage (old limits dimmed, the missing left out) and its warnings with what they offer', async () => {
    let cleared = 0;
    await home(withPilot((p) => {
      p.headless!.warnings.push({ kind: 'version', message: 'Claude Code 9.9.9 is not verified', since: Date.now(), actions: ['tui'] });
    }), { clear: () => { cleared++; }, stop: () => {} });
    assert.deepEqual([...container.querySelectorAll('#home-usage span')].map((e) => `${e.textContent}|${e.classList.contains('stale') ? 'stale' : ''}`), ['5h 35%|stale', ' · fable 4%|stale', ' · ctx 13%|']);
    const rows = [...container.querySelectorAll<HTMLElement>('.home-warning')];
    assert.deepEqual(rows.map((r) => `${r.dataset.kind}:${[...r.querySelectorAll<HTMLElement>('button')].map((b) => b.dataset.action).join(',')}`),
      ['silent:interrupt,clear', 'unknown_event:', 'version:tui']);
    await fire(() => rows[0].querySelector<HTMLElement>('[data-action=clear]')!.click());
    assert.equal(cleared, 1);
    assert.equal(container.querySelector('.tui-steps'), null);
    await fire(() => rows[2].querySelector<HTMLElement>('[data-action=tui]')!.click());
    assert.match($('.tui-steps').textContent!, /remove "mode": "headless" from the orchestrator "pilot".*y011d4\.yoicks\.stop.*Start/);
  });

  it("opens when each limit resets from its usage, a button, and counts down at each minute's start with no State push", async () => {
    const T = new Date(2026, 0, 15, 9, 0).getTime(); // local time, as the clock times are; the limits read at T, the page opened 30 s on
    vi.useFakeTimers({ now: T + 30_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      setAppState(withPilot((p) => {
        idle(p);
        p.headless!.usage = { fiveHour: { utilization: 0.42, resetsAt: T + (2 * 60 + 13) * 60_000 }, sevenDay: { utilization: 0.34, resetsAt: T + (3 * 24 + 4) * 3_600_000 },
          fable: null, contextPct: 23, at: T };
      }));
      location.hash = '#/home/pilot';
      store.view.activePaneId = 'hl:pilot';
      store.view.homeMode = true;
      ({ container, unmount } = await render(<Pane paneId="hl:pilot" home={true} name="pilot" />));
      await settle(0);
      const btn = $('[data-action=usage]');
      const rows = () => [...container.querySelectorAll('[data-usage-resets] [data-limit]')].map((r) => [...r.children].map((c) => c.textContent).join(' '));
      assert.equal(btn.tagName, 'BUTTON'); // a keyboard's Tab reaches it, Enter or Space opens it
      assert.equal($('#home-usage').textContent, '5h 42% · 7d 34% · ctx 23%'); // the figures as they were: no time in them
      assert.deepEqual([btn.getAttribute('aria-expanded'), rows()], ['false', []]);

      await fire(() => { btn.focus(); btn.click(); }); // as a keyboard does: Tab to it, then Enter
      await settle(0);
      assert.equal(btn.getAttribute('aria-expanded'), 'true');
      assert.deepEqual(rows(), ['5h 42% resets in 2h13m · today 11:13', '7d 34% resets in 3d4h · 1/18 13:00']);
      assert.ok(document.activeElement === $('[data-usage-resets]'), 'the focus is in the popover');
      await settle(29_999);
      assert.deepEqual(rows(), ['5h 42% resets in 2h13m · today 11:13', '7d 34% resets in 3d4h · 1/18 13:00']);
      await settle(1);
      assert.deepEqual(rows(), ['5h 42% resets in 2h12m · today 11:13', '7d 34% resets in 3d3h · 1/18 13:00']);
      await settle((2 * 60 + 12) * 60_000);
      assert.deepEqual(rows(), ['5h 42% has reset (today 11:13)', '7d 34% resets in 3d1h · 1/18 13:00']);

      // Escape closes it, the focus back on the figures; so does a tap outside
      await fire(() => $('[data-usage-resets]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await settle(0);
      assert.deepEqual([btn.getAttribute('aria-expanded'), rows()], ['false', []]);
      assert.ok(document.activeElement === btn, 'the focus is back on the figures');
      await fire(() => btn.click());
      await settle(0);
      assert.equal(rows().length, 2);
      await fire(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
      await settle(0);
      assert.deepEqual([btn.getAttribute('aria-expanded'), rows()], ['false', []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no popover while no limit is known: the context alone', async () => {
    await home(withPilot((p) => { idle(p); p.headless!.usage = { fiveHour: null, sevenDay: null, fable: null, contextPct: 23, at: 0 }; }));
    assert.equal($('#home-usage').textContent, 'ctx 23%');
    assert.equal(container.querySelector('[data-action=usage]'), null);
  });
});

describe('replying on a Home, and asking about a to-do item', () => {
  const input = () => $<HTMLTextAreaElement>('#pane-input');
  const key = draftKey('hl:pilot', 'pilot');
  const said = { kind: 'assistant' as const, text: 'The **PR** is ready:\nhttps://github.com/o/r/pull/7', sidechain: false, ts: null };
  const mine = { kind: 'user' as const, text: 'deploy it', sidechain: false, ts: null };
  const chat = (items: unknown[]): Promise<void> => answer('/transcript', { ...transcript[0], items });
  // a PC's right click (Mantine's Menu.ContextMenu); its menu in #modal-root (the chat's own root)
  const menu = (el: Element): Promise<void> => fire(() => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
  const pick = (action: string): Promise<void> => fire(() => document.querySelector<HTMLElement>(`#modal-root [data-action="${action}"]`)!.click());
  const items = () => [...document.querySelectorAll<HTMLElement>('#modal-root [data-action]')].map((e) => e.dataset.action);
  const todo = { id: 't1', text: 'merge PR #7', agent: 'w-review', url: 'https://github.com/o/r/pull/7', due: null, createdAt: 0 };
  beforeEach(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="modal-root"></div>');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === DESKTOP_QUERY })); // a PC, but where a test says a phone
  });
  afterEach(() => { document.querySelector('#modal-root')?.remove(); });

  it("on a phone a long press is the OS's (its text selection), and a tap opens the menu; not on a link, nor a tap ending a selection", async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    await home(withPilot(idle));
    await chat([said]);
    const msg = $('#chat-log .chat-assistant');
    assert.equal(msg.getAttribute('style'), null, 'no user-select: none, no -webkit-touch-callout: none');
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await fire(() => { msg.dispatchEvent(ev); }); // Android's long press
    assert.deepEqual([ev.defaultPrevented, items()], [false, []], "the OS's: selecting words, its own Copy");
    const tap = (el: Element, held = 0): Promise<void> => fire(() => {
      const down = new Event('touchstart', { bubbles: true });
      el.dispatchEvent(down);
      getSelection()!.removeAllRanges(); // what a tap does to a selection, maybe before its click
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 });
      Object.defineProperty(click, 'timeStamp', { value: down.timeStamp + held });
      el.dispatchEvent(click);
    });
    await tap(msg, 600);
    assert.deepEqual(items(), [], 'a held press is no tap');
    const link = $('#chat-log .chat-assistant a');
    link.addEventListener('click', (e) => { e.preventDefault(); }); // no navigation in happy-dom (it would fetch the URL)
    await tap(link);
    assert.deepEqual(items(), [], 'a link opens itself');
    getSelection()!.selectAllChildren(msg.querySelector('.chat-md')!);
    await tap(msg);
    assert.deepEqual(items(), [], 'only ends the selection');
    await tap(msg);
    assert.deepEqual(items(), ['reply', 'copy']);
    await pick('reply');
    assert.equal(getQuote(key), '> Replying to your message: The PR is ready: https://github.com/o/r/pull/7');
  });

  it("Reply on a message quotes it above the composer, focused, and sends the quote first; the ↩ beside one too; ✕ drops it", async () => {
    await home(withPilot(idle));
    await chat([said, mine]);
    await menu($('#chat-log .chat-assistant'));
    await pick('reply');
    assert.equal($('#composer-quote').dataset.quoteOf, 'you');
    assert.equal($('#composer-quote').textContent, 'Replying to the orchestratorThe PR is ready: https://github.com/o/r/pull/7');
    assert.ok(document.activeElement === input(), 'focused, to type at once');
    await type(input(), 'merge it');
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send'), [{ text: '> Replying to your message: The PR is ready: https://github.com/o/r/pull/7\n\nmerge it' }]);
    await answer('POST /api/orchestrators/pilot/send', { ok: true });
    assert.ok(container.querySelector('#composer-quote') === null && getQuote(key) === '', 'sent: gone');
    await fire(() => $('#chat-log .chat-user [aria-label="Reply"]').click()); // the user's own, from its ↩
    assert.equal($('#composer-quote').dataset.quoteOf, 'me');
    assert.equal(getQuote(key), '> Replying to my message: deploy it');
    await fire(() => $('#composer-quote [aria-label="Cancel the reply"]').click());
    assert.ok(container.querySelector('#composer-quote') === null && getQuote(key) === '', 'dropped');
  });

  it("a [yoicks] notice has no Reply: no ↩, its menu Copy only", async () => {
    await home(withPilot(idle));
    await chat([{ kind: 'user', text: '[yoicks] w-a: working → done', sidechain: false, ts: null }, said]);
    const notice = $('#chat-log .chat-notice');
    assert.ok(notice.querySelector('.chat-reply') === null, 'no ↩');
    assert.ok(container.querySelector('#chat-log .chat-assistant .chat-reply') !== null, "the Home's own message keeps its ↩");
    await menu(notice);
    assert.deepEqual([...document.querySelectorAll<HTMLElement>('#modal-root [data-action]')].map((e) => e.dataset.action), ['copy']);
  });

  it('drops a sent quote also where storage keeps nothing (full, or a private window)', async () => {
    await home(withPilot(idle));
    await chat([said]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    await fire(() => $('#chat-log .chat-assistant [aria-label="Reply"]').click());
    assert.equal($('#composer-quote').dataset.quoteOf, 'you');
    await type(input(), 'merge it');
    await fire(() => $('#btn-send-enter').click());
    await answer('POST /api/orchestrators/pilot/send', { ok: true });
    assert.ok(container.querySelector('#composer-quote') === null, 'not sent again with the next message');
    vi.restoreAllMocks();
  });

  it('Copy copies its words; on a link (or with its text selected) the menu is the browser\'s', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (t: string) => { copied.push(t); } } });
    await home(withPilot(idle));
    await chat([said]);
    await menu($('#chat-log .chat-assistant'));
    await pick('copy');
    await flush();
    assert.deepEqual(copied, [said.text]);
    assert.deepEqual(getToasts().map((t) => t.title), ['Copied']);
    const link = $('#chat-log .chat-assistant a');
    await fire(() => { link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 })); });
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await fire(() => { link.dispatchEvent(ev); });
    assert.equal(ev.defaultPrevented, false, "the browser's menu: open, copy the link");
    assert.equal($('#chat-log .chat-assistant').hasAttribute('data-expanded'), false, 'no menu of ours');
  });

  it('draws a reply with what it quotes on top; a tap scrolls to that message and marks it, or says it is not shown', async () => {
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) { scrolled.push(this); });
    await home(withPilot(idle));
    await chat([said, mine, { kind: 'user', text: `${quoteLine('you', said.text)}\n\nmerge it`, sidechain: false, ts: null },
      { kind: 'user', text: '> Replying to your message: long gone\n\nand?', sidechain: false, ts: null }]);
    const [, reply, lost] = [...container.querySelectorAll<HTMLElement>('#chat-log .chat-user')];
    assert.equal(reply.querySelector('.chat-quote-ref')!.textContent, 'OrchestratorThe PR is ready: https://github.com/o/r/pull/7');
    assert.equal(reply.querySelector('.chat-md')!.textContent, 'merge it');
    assert.equal(reply.dataset.quote, '> Replying to my message: merge it', 'a reply to it quotes its words, not its quote');
    await fire(() => reply.querySelector<HTMLElement>('.chat-quote-ref')!.click());
    const original = $('#chat-log .chat-assistant');
    assert.ok(scrolled.length === 1 && scrolled[0] === original, 'scrolled to the original');
    assert.equal(original.dataset.flash, '');
    await fire(() => lost.querySelector<HTMLElement>('.chat-quote-ref')!.click());
    assert.equal(scrolled.length, 1);
    assert.deepEqual(getToasts().map((t) => t.title), ['Not in this chat']);
    vi.restoreAllMocks();
  });

  it('keeps the quote with the draft (stored: a reload too); while its question is open: shown with the locked draft, left out of Chat about this, no new one', async () => {
    setDraft(key, 'my draft');
    setQuote(key, quoteLine('you', 'earlier words'));
    await home(withPilot()); // blocked on its question
    await chat([said]);
    assert.deepEqual([$('#composer-quote').dataset.quoteOf, input().disabled, input().value], ['you', true, 'my draft']);
    await fire(() => $('#headless-prompt-chat').click());
    assert.ok(container.querySelector('#composer-quote') === null, 'not about the question');
    await menu($('#chat-log .chat-assistant'));
    await pick('reply');
    assert.deepEqual(getToasts().map((t) => t.title), ['Answer the question first']);
    assert.equal(getQuote(key), '> Replying to your message: earlier words', 'untouched');
    await type(input(), 'why?');
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send'), [{ text: 'why?', question: '1a2b3c4d' }]);
    await answer('POST /api/orchestrators/pilot/send', { ok: true });
    await fire(() => setAppState(withPilot(idle)));
    assert.deepEqual([$('#composer-quote').dataset.quoteOf, input().value], ['you', 'my draft'], 'back with the draft');
  });

  it('Ask on a to-do item closes the popover and quotes the item (text, id, worker, link) in the composer, focused', async () => {
    await home(withPilot((p) => { idle(p); p.todos = [todo]; }));
    await fire(() => $('[data-action="needs"]').click());
    await fire(() => $('[data-action="todo-ask"]').click());
    assert.ok(container.querySelector('[data-needs-list]') === null, 'closed');
    assert.deepEqual([$('#composer-quote').dataset.quoteOf, $('#composer-quote').textContent], ['todo', 'Asking about a to-domerge PR #7']);
    await act(() => new Promise<void>((r) => { setTimeout(r, 30); })); // past the popover's focus return
    assert.ok(document.activeElement === input(), 'in the composer, not back on Needs you');
    await type(input(), 'is CI green?');
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send'), [{ text: '> To-do: merge PR #7 (id t1, worker w-review, https://github.com/o/r/pull/7)\n\nis CI green?' }]);
  });

  it('has Ask off while its question is open, and none on a stopped Home (no composer)', async () => {
    await home(withPilot((p) => { p.todos = [todo]; }));
    await fire(() => $('[data-action="needs"]').click());
    assert.equal($<HTMLButtonElement>('[data-action="todo-ask"]').disabled, true);
    await unmount();
    setAppState(withPilot((p) => { idle(p); p.paneId = null; p.headless!.status = 'stopped'; p.todos = [todo]; }));
    ({ container, unmount } = await render(<StoppedHome name="pilot" />));
    await fire(() => $('[data-action="needs"]').click());
    assert.ok(container.querySelector('[data-todo="t1"]') && container.querySelector('[data-action="todo-ask"]') === null);
  });
});

describe('around a headless orchestrator', () => {
  it('compactLine says what it knows', () => {
    assert.equal(compactLine({ state: 'done', from: 64.2, to: 12.5, error: '' }), 'compacted: ctx 64% → 13%');
    assert.equal(compactLine({ state: 'done', from: null, to: 3, error: '' }), 'compacted: ctx 3%');
    assert.equal(compactLine({ state: 'done', from: 64, to: null, error: '' }), 'compacted');
    assert.equal(compactLine({ state: 'failed', from: 64, to: null, error: 'API Error: Request was aborted.' }), 'compact failed: API Error: Request was aborted.');
  });

  it('usageParts leaves out what is unknown', () => {
    const now = 1_000_000_000;
    assert.deepEqual(usageParts({ fiveHour: { utilization: 0.344, resetsAt: 0 }, sevenDay: { utilization: 0.69, resetsAt: 0 }, fable: null, contextPct: null, at: now - 1000 }, now),
      [{ text: '5h 34%', stale: false }, { text: '7d 69%', stale: false }]);
    assert.deepEqual(usageParts({ fiveHour: null, sevenDay: null, fable: { utilization: 0.04, resetsAt: 0 }, contextPct: 7, at: now - 11 * 60_000 }, now),
      [{ text: 'fable 4%', stale: true }, { text: 'ctx 7%', stale: false }]);
    assert.deepEqual(usageParts({ fiveHour: null, sevenDay: null, fable: null, contextPct: null, at: 0 }, now), []);
  });

  it('resetRows says when each known limit resets: the time left and the clock time, or that it has reset', () => {
    const now = new Date(2026, 0, 15, 9, 0, 30).getTime(); // local: the clock times are
    const w = (utilization: number, resetsAt: number) => ({ utilization, resetsAt });
    assert.deepEqual(resetRows({ fiveHour: w(0.42, now + 45 * 60_000 - 30_000), sevenDay: w(0.34, now - 30_000), fable: w(0.04, now + 6 * 86_400_000 - 30_000),
      contextPct: 12, at: now - 1000 }, now), [
      { name: '5h', used: '42%', when: 'resets in 45m · today 09:45' },
      { name: '7d', used: '34%', when: 'has reset (today 09:00)' },
      { name: 'fable', used: '4%', when: 'resets in 6d · 1/21 09:00' }]);
    assert.deepEqual(resetRows({ fiveHour: w(0.1, 0), sevenDay: null, fable: null, contextPct: 12, at: now }, now), [{ name: '5h', used: '10%', when: 'reset time unknown' }]);
    assert.deepEqual(resetRows({ fiveHour: null, sevenDay: null, fable: null, contextPct: 12, at: now }, now), []);
  });

  it('untilText rounds up to whole minutes and names the two largest units', () => {
    const now = Date.UTC(2026, 0, 15, 9, 0, 30);
    const m = 60_000, h = 60 * m, d = 24 * h;
    assert.deepEqual([1, 30_000, m, m + 1, 45 * m, h, h + 1, 2 * h + 13 * m, 23 * h + 59 * m + 1, d, 3 * d + 4 * h + 59 * m, 7 * d].map((ms) => untilText(now + ms, now)),
      ['1m', '1m', '1m', '2m', '45m', '1h', '1h1m', '2h13m', '1d', '1d', '3d4h', '7d']);
    assert.deepEqual([0, -1, -h].map((ms) => untilText(now + ms, now)), ['', '', '']);
  });

  it('the Claude Code check reads as off when none has run or the last is over a day old', () => {
    const now = Date.now();
    assert.match(claudeCheckText(null, now), /none yet: the periodic check is off/);
    assert.match(claudeCheckText({ at: now - 60_000, version: '2.1.322', ok: true, failed: [] }, now), /^Claude Code 2\.1\.322 passed, 1m ago$/);
    assert.match(claudeCheckText({ at: now - 30 * 3_600_000, version: '2.1.330', ok: false, failed: ['interrupt'] }, now),
      /^Claude Code 2\.1\.330 failed \(interrupt\), 30h ago: none since, the periodic check looks off$/);
  });

  it("shows the bridge's [yoicks] words as a dim line, escaped, the worker's name a button", () => {
    const line = chatDom([{ kind: 'user', text: '[yoicks] w-1: working → done <b>', sidechain: false, ts: null }]).querySelector('.chat-item.chat-notice')!;
    assert.equal(line.textContent, '[yoicks] w-1: working → done <b>'); // its words as text: no <b> element
    assert.equal(line.querySelector('b'), null);
    assert.equal(line.querySelector<HTMLElement>('button.chat-notice-agent')!.dataset.agent, 'w-1');
  });
});
