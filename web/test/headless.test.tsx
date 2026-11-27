// @vitest-environment happy-dom
// A headless orchestrator (hl:<name>): the pane made for it where panes are looked up, its routes and
// watch, and its Home: chat only, its sends, question, ■, usage and warnings through
// /api/orchestrators/:name/*; the alerts, the Claude Code check and the [yoicks] notice.
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { shownStatus } from '../src/dashboard-group.ts';
import { clearToasts, getToasts } from '../src/notify.ts';
import { orchestratorOfPane, resolveRoute } from '../src/routes.ts';
import { findPane, markPaneSeen, setAppState, store } from '../src/store.ts';
import type { AppState, OrchestratorView, WsMessage, WsStateMessage } from '../src/types.ts';
import { Modals } from '../src/ui/Modals.tsx';
import { homeTopbar, Pane, usageParts } from '../src/ui/Pane.tsx';
import { claudeCheckText } from '../src/ui/Settings.tsx';
import { watchMessages } from '../src/watch.ts';
import { messages, state as recorded, transcript } from './contract.gen.ts';
import { chatHtml, fire, render } from './render.ts';

vi.mock('../src/ws.ts', () => ({
  onWsMessage: (_fn: (msg: WsMessage) => void) => () => {},
  wsSendWatch: () => {},
}));
// happy-dom has no canvas: a picked file becomes an attachment named after it, once `scaled` resolves
let scaled: Promise<void> = Promise.resolve();
vi.mock('../src/image.ts', async (orig) => ({ ...(await orig<typeof import('../src/image.ts')>()),
  toAttachment: async (f: File) => { await scaled; return { mediaType: 'image/jpeg', data: f.name }; } }));

// The recorded headless orchestrator "pilot" (Pilot): blocked on "Which fruit?" (id 1a2b3c4d), completionSeq 3,
// 5h 35% read long ago, ctx 12.5%, warnings silent (interrupt, clear) and unknown_event.
const pilot = (): OrchestratorView => structuredClone((messages.find((m) => m.type === 'state' &&
  m.state.orchestrators.some((o) => o.name === 'pilot')) as WsStateMessage).state.orchestrators.find((o) => o.name === 'pilot')!);
function withPilot(edit: (p: OrchestratorView) => void = () => {}): AppState {
  const s = structuredClone(recorded);
  const p = pilot();
  edit(p);
  s.orchestrators.push(p);
  return s;
}
const idle = (p: OrchestratorView): void => { p.headless!.status = 'idle'; p.headless!.pending = null; p.headless!.warnings = []; };

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

  it("types a question's own answer under its options: that question's alone, a multiSelect's with its checks", async () => {
    await home(withPilot((p) => {
      const q = p.headless!.pending!.questions[0];
      p.headless!.pending!.questions = [q, { question: 'Size?', header: 'Size', multiSelect: true, options: [{ label: 'S', description: '' }, { label: 'L', description: '' }] },
        { question: 'When?', header: 'When', multiSelect: false, options: [{ label: 'now', description: '' }] }];
    }));
    // as Claude Code's TUI numbers them: the options, then Type something., then Chat about this
    assert.deepEqual(extras().map((b) => b.textContent), ['3Type something.', '4Chat about thisAsk the orchestrator about it instead of answering']);
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

  it('chats about the questions instead of answering, with the answers so far', async () => {
    await home(withPilot((p) => {
      const q = p.headless!.pending!.questions[0];
      p.headless!.pending!.questions = [q, { question: 'Size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }] }];
    }));
    await fire(() => opts()[0].click());
    await fire(() => $('#headless-prompt-own').click());
    await type($<HTMLTextAreaElement>('#headless-prompt-text'), 'not an answer yet');
    await fire(() => $('#headless-prompt-chat').click());
    await fire(() => $('#headless-prompt-chat').click());
    assert.deepEqual(posts('answer'), [{ id: '1a2b3c4d', chat: true, answers: { 'Which fruit?': 'apple' } }]);
    assert.match($('#headless-prompt .chat-prompt-hint').textContent!, /not an answer/);
  });

  it("sends a composer message with the panel's answers so far (the bridge's Chat about this), and none once it's gone", async () => {
    await home(withPilot((p) => {
      const q = p.headless!.pending!.questions[0];
      p.headless!.pending!.questions = [q, { question: 'Size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }] }];
    }));
    await fire(() => opts()[1].click());
    await fire(() => { $<HTMLTextAreaElement>('#pane-input').value = 'why S?'; });
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send'), [{ text: 'why S?', answers: { 'Which fruit?': 'cherry' } }]);
    // a multiSelect's checks count as they stand (the TUI records them at each check)
    await fire(() => setAppState(withPilot((p) => { p.headless!.pending!.id = 'm1'; p.headless!.pending!.questions[0].multiSelect = true; })));
    await fire(() => opts()[0].click());
    await fire(() => $('#headless-prompt-chat').click());
    assert.deepEqual(posts('answer'), [{ id: 'm1', chat: true, answers: { 'Which fruit?': 'apple' } }]);
    await answer('POST /api/orchestrators/pilot/send', { ok: true });
    await fire(() => setAppState(withPilot(idle)));
    await fire(() => { $<HTMLTextAreaElement>('#pane-input').value = 'thanks'; });
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('send')[1], { text: 'thanks' });
  });

  it('has ■ on its "doing now" line while it works', async () => {
    await home(withPilot((p) => { idle(p); p.headless!.status = 'working'; }));
    await fire(() => $('#btn-home-interrupt').click());
    assert.deepEqual(posts('interrupt'), [{}]);
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
});

describe('around a headless orchestrator', () => {
  it('usageParts leaves out what is unknown', () => {
    const now = 1_000_000_000;
    assert.deepEqual(usageParts({ fiveHour: { utilization: 0.344, resetsAt: 0 }, sevenDay: { utilization: 0.69, resetsAt: 0 }, fable: null, contextPct: null, at: now - 1000 }, now),
      [{ text: '5h 34%', stale: false }, { text: '7d 69%', stale: false }]);
    assert.deepEqual(usageParts({ fiveHour: null, sevenDay: null, fable: { utilization: 0.04, resetsAt: 0 }, contextPct: 7, at: now - 11 * 60_000 }, now),
      [{ text: 'fable 4%', stale: true }, { text: 'ctx 7%', stale: false }]);
    assert.deepEqual(usageParts({ fiveHour: null, sevenDay: null, fable: null, contextPct: null, at: 0 }, now), []);
  });

  it('the Claude Code check reads as off when none has run or the last is over a day old', () => {
    const now = Date.now();
    assert.match(claudeCheckText(null, now), /none yet: the periodic check is off/);
    assert.match(claudeCheckText({ at: now - 60_000, version: '2.1.322', ok: true, failed: [] }, now), /^Claude Code 2\.1\.322 passed, 1m ago$/);
    assert.match(claudeCheckText({ at: now - 30 * 3_600_000, version: '2.1.330', ok: false, failed: ['interrupt'] }, now),
      /^Claude Code 2\.1\.330 failed \(interrupt\), 30h ago: none since, the periodic check looks off$/);
  });

  it("shows the bridge's [yoicks] words as a dim line, escaped, the worker's name a button", () => {
    assert.equal(chatHtml({ kind: 'user', text: '[yoicks] w-1: working → done <b>', sidechain: false, ts: null }),
      '<div class="chat-item chat-notice">[yoicks] <button type="button" class="chat-notice-agent" data-agent="w-1">w-1</button>: working → done &lt;b&gt;</div>');
  });
});
