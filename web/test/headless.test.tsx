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
import { renderItem } from '../src/transcript.ts';
import type { AppState, OrchestratorView, WsMessage, WsStateMessage } from '../src/types.ts';
import { Pane, paneTopbar, usageParts } from '../src/ui/Pane.tsx';
import { claudeCheckText } from '../src/ui/Settings.tsx';
import { watchMessages } from '../src/watch.ts';
import { messages, state as recorded } from './contract.gen.ts';
import { fire, render } from './render.ts';

vi.mock('../src/ws.ts', () => ({
  onWsMessage: (_fn: (msg: WsMessage) => void) => () => {},
  wsSendWatch: () => {},
}));
// happy-dom has no canvas: a picked file becomes an attachment named after it
vi.mock('../src/image.ts', async (orig) => ({ ...(await orig<typeof import('../src/image.ts')>()), toAttachment: async (f: File) => ({ mediaType: 'image/jpeg', data: f.name }) }));

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
  const t = paneTopbar('hl:pilot', true, '#/agents', () => {});
  ({ container, unmount } = await render(<><div id="tb">{t.title}{t.right}</div><Pane paneId="hl:pilot" home={true} actions={actions} name="pilot" /></>));
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => container.querySelector<T>(sel)!;
const opts = () => [...container.querySelectorAll<HTMLButtonElement>('#headless-prompt .ask-opt')];

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
    assert.equal($('#tb').textContent, 'Pilot· readyAgents>_⚙'); // the toggle stays hidden
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
    await fire(() => container.querySelector<HTMLButtonElement>('#input-images button')!.click());
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

  it('has ■ on its "doing now" line while it works', async () => {
    await home(withPilot((p) => { idle(p); p.headless!.status = 'working'; }));
    await fire(() => $('#btn-home-interrupt').click());
    assert.deepEqual(posts('interrupt'), [{}]);
  });

  it('shows its usage (old limits dimmed, the missing left out) and its warnings with what they offer', async () => {
    let cleared = 0;
    await home(withPilot((p) => {
      p.headless!.warnings.push({ kind: 'version', message: 'Claude Code 9.9.9 is not verified', since: Date.now(), actions: ['tui'] });
    }), { clear: () => { cleared++; }, stop: () => {} });
    assert.deepEqual([...container.querySelectorAll('#home-usage span')].map((e) => `${e.textContent}|${e.className}`), ['5h 35%|stale', ' · ctx 13%|']);
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
    assert.deepEqual(usageParts({ fiveHour: { utilization: 0.344, resetsAt: 0 }, sevenDay: { utilization: 0.69, resetsAt: 0 }, contextPct: null, at: now - 1000 }, now),
      [{ text: '5h 34%', stale: false }, { text: '7d 69%', stale: false }]);
    assert.deepEqual(usageParts({ fiveHour: null, sevenDay: null, contextPct: null, at: 0 }, now), []);
  });

  it('the Claude Code check reads as off when none has run or the last is over a day old', () => {
    const now = Date.now();
    assert.match(claudeCheckText(null, now), /none yet: the periodic check is off/);
    assert.match(claudeCheckText({ at: now - 60_000, version: '2.1.322', ok: true, failed: [] }, now), /^Claude Code 2\.1\.322 passed, 1m ago$/);
    assert.match(claudeCheckText({ at: now - 30 * 3_600_000, version: '2.1.330', ok: false, failed: ['interrupt'] }, now),
      /^Claude Code 2\.1\.330 failed \(interrupt\), 30h ago: none since, the periodic check looks off$/);
  });

  it("shows the bridge's [yoicks] words as a dim line, escaped", () => {
    assert.equal(renderItem({ kind: 'user', text: '[yoicks] w-1: working → done <b>', sidechain: false, ts: null }),
      '<div class="chat-item chat-notice">[yoicks] w-1: working → done &lt;b&gt;</div>');
  });
});
