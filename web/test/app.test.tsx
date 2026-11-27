// @vitest-environment happy-dom
// The shell (ui/App.tsx) as main.tsx starts it, over index.html's first paint, with a token stored:
// routing end to end over the real screens, the agent actions, the SW's navigate message,
// visibilitychange, the viewport, the dot and the banner. A fake bridge and socket. The tests run
// in order on one started app: each goes from where the one before left it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { clearToasts, getToasts } from '../src/notify.ts';
import { emit, setAppState, store } from '../src/store.ts';
import type { AppState, WsMessage } from '../src/types.ts';
import { WIDE_QUERY } from '../src/theme.ts';
import { App, start } from '../src/ui/App.tsx';
import { previewImage } from '../src/ui/Modals.tsx';
import { read, state as recorded, transcript } from './contract.gen.ts';
import { fakeMedia, mantine, settle } from './render.ts'; // and the act environment (settle: on the fake timers)

// The socket: the shell's message handler (the first to subscribe; pane views come later), and each
// watch sent (the pane, its mode, hidden).
const watches: string[] = [];
let push: ((msg: WsMessage) => void) | null = null;
vi.mock('../src/ws.ts', () => ({
  onWsMessage: (fn: (msg: WsMessage) => void) => { push ??= fn; return () => {}; },
  wsConnect: () => {},
  wsSendWatch: () => { watches.push(`${store.view.activePaneId}:${store.view.paneViewMode}${document.hidden ? ':hidden' : ''}`); },
}));

// The bridge: every request waits until the test answers it.
interface Req { method: string; url: string; answered: boolean; answer: (status: number, body: unknown) => void }
const reqs: Req[] = [];
vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
  reqs.push({ method: init.method ?? 'GET', url, answered: false, answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
}));
// A phone's width until a test says otherwise: no PC sidebar.
const setWide = fakeMedia(WIDE_QUERY, false);
/** Answers every open request `${method} ${url}` containing `match` (StrictMode starts a pane's view twice). */
async function answer(match: string, body: unknown, status = 200): Promise<void> {
  const open = reqs.filter((q) => !q.answered && `${q.method} ${q.url}`.includes(match));
  assert.ok(open.length, `no open request ${match}`);
  await act(async () => {
    for (const r of open) { r.answered = true; r.answer(status, body); }
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  await settle(); // a hash it set routes on the next task
}
const reads = (paneId: string): number => reqs.filter((q) => q.url.startsWith(`/api/panes/${paneId}/read?source=visible`)).length;

const go = async (hash: string): Promise<void> => { location.hash = hash; await settle(); };
const click = async (el: Element | null): Promise<void> => {
  assert.ok(el, 'nothing to click');
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
};
const $ = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
const fresh = (): AppState => structuredClone(recorded); // p4 runs the orchestrator "personal"; "work" isn't running
const toastTitles = (): string[] => getToasts().map((t) => t.title);

// The page outside a browser: the visual viewport, a secure context with a service worker
// (its messages, and the OS notifications it shows), the page's visibility.
const vv = Object.assign(new EventTarget(), { height: 700 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
const closed: string[] = [];
const reg = { getNotifications: async ({ tag }: { tag: string }) => [{ close: () => closed.push(tag) }] };
const sw = Object.assign(new EventTarget(), { getRegistration: async () => reg });
Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
let hidden = false;
Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => {
  vi.useRealTimers();
  clearToasts();
});

describe('App', () => {
  it("draws over index.html's first paint; until the first State the screen is empty, then a fresh open lands on the Home used last", async () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../index.html'), 'utf8');
    document.body.innerHTML = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('<script'));
    localStorage.setItem('herdr_token', 't');
    localStorage.setItem('herdr_home', 'work');
    history.replaceState(null, '', '/');
    const replace = vi.spyOn(location, 'replace');
    start();
    await act(async () => { createRoot(document.getElementById('app')!).render(<StrictMode>{mantine(<App />)}</StrictMode>); });

    assert.equal(document.querySelectorAll('#topbar').length, 1, 'one topbar');
    assert.equal(document.querySelectorAll('#screen').length, 1);
    assert.equal(document.querySelectorAll('#toast-container').length, 1);
    assert.equal($('#topbar')!.style.display, '');
    assert.equal($('#topbar-title')!.textContent, 'Yoicks');
    assert.equal($('#screen')!.childElementCount, 0);
    assert.equal($('#conn-dot')!.title, 'Disconnected');
    assert.equal($('#reconnect-banner')!.classList.contains('visible'), false, 'no banner before the first link change');

    const s = fresh();
    s.orchestrators[1].paneId = 'p6'; // both run: "work", used last, wins over the first
    store.wsConnected = true;
    await answer('GET /api/state', s);
    assert.deepEqual(replace.mock.calls.map((c) => c[0]), ['#/home/work']);
    assert.equal(location.hash, '#/home/work');
    assert.ok($('#screen #screen-pane.screen-home'), 'the Home');
    assert.equal(store.view.activePaneId, 'p6');
    assert.ok($('#topbar-right #btn-settings'), "the Home's topbar");
    assert.equal($('#conn-dot')!.className, 'conn-dot connected');
    assert.equal($('#conn-dot')!.title, 'Connected');
    replace.mockRestore();
  });

  it('keeps --app-height at the visual viewport height', async () => {
    assert.equal(document.documentElement.style.getPropertyValue('--app-height'), '700px');
    vv.height = 512;
    vv.dispatchEvent(new Event('resize'));
    assert.equal(document.documentElement.style.getPropertyValue('--app-height'), '512px');
  });

  it("opens an orchestrator's pane as its Home, and a bare #/home as the Home used last", async () => {
    await go('#/pane/p4');
    assert.equal(location.hash, '#/home/personal');
    assert.equal(store.view.activePaneId, 'p4');
    assert.equal(localStorage.getItem('herdr_home'), 'personal');
    await go('#/home/work');
    await go('#/home'); // "personal" comes first; "work" was used last
    assert.equal(location.hash, '#/home/work');
    assert.equal(store.view.activePaneId, 'p6');
  });

  it("lists #/agents/<name>'s account; a pane opens in a drawer over it, which stays as it is, and closes back to it when the pane goes", async () => {
    await go('#/agents/personal');
    const ids = [...document.querySelectorAll<HTMLElement>('#screen-agents .agent-card')].map((c) => c.dataset.paneId).sort();
    assert.deepEqual(ids, ['p1', 'p3'], 'its account, never the orchestrator');
    assert.match($('#topbar-title')!.textContent!, /Agents.*Personal/);
    const list = $('#screen #screen-agents');
    const before = history.length;
    await click($('.agent-card[data-pane-id="p1"]'));
    assert.equal(location.hash, '#/pane/p1');
    assert.ok($('#modal-root .agent-drawer #screen-pane'), 'the pane, in the drawer');
    assert.ok($('#screen #screen-agents') === list, 'the list under it, the same element');
    assert.match($('.agent-drawer-head')!.textContent!, /claude/);
    assert.ok(document.activeElement === $('.agent-drawer-head'), 'the focus starts on its header, not on ✕');
    assert.equal(store.view.activePaneId, 'p1');
    const inert = (sel: string): boolean => $(sel)!.hasAttribute('inert');
    assert.ok(inert('#screen') && inert('#topbar') && inert('#reconnect-banner'), 'the screen under it out of reach');
    assert.ok(!$('#sidebar') || !inert('#sidebar'), "a wide screen's sidebar stays usable");
    await act(async () => push!({ type: 'pane_gone', paneId: 'p1' }));
    await settle();
    assert.deepEqual(toastTitles(), ['Pane closed']);
    assert.equal(location.hash, '#/agents/personal');
    assert.ok(!$('.agent-drawer #screen-pane'), 'the drawer closed');
    assert.ok($('#screen #screen-agents') === list, 'back on the same list');
    assert.ok(!$('#screen')!.hasAttribute('inert') && !$('#topbar')!.hasAttribute('inert'));
    assert.equal(history.length, before + 1, 'the close went back: no entry left over');
  });

  it("a pane gone under an image preview closes both: the preview's entry, then the drawer's", async () => {
    await go('#/agents');
    await go('#/pane/p1');
    await act(async () => previewImage('data:image/png;base64,AA==', 'shot'));
    assert.ok($('#modal-root .image-preview'));
    await act(async () => push!({ type: 'pane_gone', paneId: 'p1' }));
    await settle(50);
    assert.equal(location.hash, '#/agents');
    assert.ok(!$('#modal-root .image-preview') && !$('.agent-drawer #screen-pane'));

    // the preview closed by hand, its Back still under way, as the pane goes: one Back each, no further.
    // A browser's Back lands a task later (happy-dom's at once).
    const realBack = history.back.bind(history);
    const later = vi.spyOn(history, 'back').mockImplementation(() => { setTimeout(realBack, 0); });
    await go('#/agents/personal');
    await go('#/pane/p1');
    await act(async () => previewImage('data:image/png;base64,AA==', 'shot'));
    await act(async () => {
      $('#modal-root .image-preview-close')!.click();
      push!({ type: 'pane_gone', paneId: 'p1' });
    });
    await settle(50);
    later.mockRestore();
    assert.equal(location.hash, '#/agents/personal');
    assert.ok(!$('#modal-root .image-preview') && !$('.agent-drawer #screen-pane'));
  });

  it('leaves a pane a State no longer has', async () => {
    await go('#/agents');
    await go('#/pane/p2');
    assert.ok($('.agent-drawer #screen-pane'));
    const s = fresh();
    s.workspaces[0].tabs[1].panes = s.workspaces[0].tabs[1].panes.filter((p) => p.paneId !== 'p2');
    s.orchestrators[1].paneId = 'p6';
    await act(async () => push!({ type: 'state', state: s }));
    await act(async () => push!({ type: 'state', state: s })); // a second State before the close lands says nothing again
    await settle();
    assert.deepEqual(toastTitles(), ['Pane closed']);
    assert.equal(location.hash, '#/agents');
  });

  it("opens a pane over a Home, the Home's view stopped as it is; closing goes back to the Home, drawn afresh", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/home/personal');
    const home = $('#screen #screen-pane.screen-home');
    const homeReads = reads('p4');
    await go('#/pane/p1');
    assert.ok($('#screen #screen-pane.screen-home') === home, 'the Home under it, as it was');
    assert.ok($('.agent-drawer #screen-pane'));
    assert.equal(store.view.homeMode, false);
    assert.equal(watches.at(-1), 'p1:terminal', 'the watch follows the drawer');
    const close = $('#btn-drawer-close')!;
    await act(async () => { close.click(); close.click(); }); // a double tap goes back once
    await settle();
    assert.equal(location.hash, '#/home/personal');
    assert.ok(!$('.agent-drawer #screen-pane'));
    assert.ok($('#screen #screen-pane.screen-home') !== home, 'a fresh Home');
    assert.ok(reads('p4') > homeReads, "its new view reads the orchestrator's screen");
    assert.equal(store.view.activePaneId, 'p4');
  });

  it('pane to pane replaces the entry (Back still closes the drawer); a pane opened afresh closes to the list in its place', async () => {
    // happy-dom's replace() adds an entry, as assign() does: a browser's, in place
    const replace = vi.spyOn(location, 'replace').mockImplementation((url: string | URL) => {
      const oldURL = location.href;
      history.replaceState(history.state, '', String(url));
      dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: location.href }));
    });
    await go('#/agents');
    await go('#/pane/p1');
    const before = history.length;
    await act(async () => { sw.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', url: '#/pane/p2' } })); });
    await settle();
    assert.equal(location.hash, '#/pane/p2');
    assert.equal(history.length, before, 'replaced');
    assert.equal(store.view.activePaneId, 'p2');
    history.back(); // the phone's Back
    await settle();
    assert.equal(location.hash, '#/agents');
    assert.ok(!$('.agent-drawer #screen-pane'));

    await go('#/settings');
    await go('#/pane/p2'); // not from a list or a Home: the list goes under it
    assert.ok($('#screen #screen-agents') && $('.agent-drawer #screen-pane'));
    replace.mockClear();
    await click($('#btn-drawer-close'));
    await settle();
    assert.deepEqual(replace.mock.calls.map((c) => c[0]), ['#/agents']);
    assert.equal(location.hash, '#/agents');
    assert.ok(!$('.agent-drawer #screen-pane'));
    replace.mockRestore();
  });

  it("Escape closes the drawer, but not while the ⋮ menu or a confirm is over it; it closes those", async () => {
    await go('#/agents');
    await go('#/pane/p1');
    const esc = (): Promise<void> => act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await click($('#btn-agent-menu'));
    assert.ok($('[data-menu-dropdown]'));
    await esc();
    await settle();
    assert.ok(!$('[data-menu-dropdown]') && $('.agent-drawer #screen-pane') && location.hash === '#/pane/p1', 'only the menu closed');
    await click($('#btn-agent-menu'));
    await click($('#am-stop'));
    assert.ok($('#modal-root #cf-ok'));
    await esc();
    await settle();
    assert.ok(!$('#modal-root #cf-ok') && $('.agent-drawer #screen-pane') && location.hash === '#/pane/p1', 'only the confirm closed');
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })); });
    await settle();
    assert.equal(location.hash, '#/pane/p1', "an IME's Escape doesn't close it");
    await esc();
    await settle();
    assert.equal(location.hash, '#/agents');
    assert.ok(!$('.agent-drawer #screen-pane'));
  });

  it("a stopped orchestrator's Home has Start; its running Home opens once the State shows it", async () => {
    const s = fresh(); // "work" stopped
    await act(async () => push!({ type: 'state', state: s }));
    await go('#/home/work');
    assert.ok($('#screen #screen-home-stopped'));
    assert.equal(store.view.activePaneId, null);
    assert.equal($('#topbar-right')!.textContent, '⚙', 'a stopped Home\'s topbar: Settings alone');
    assert.ok(!$('#btn-home-clear') && $('#btn-settings'), 'no Clear/Stop to a stopped Home; Settings');
    await click($('#btn-home-start'));
    await answer('POST /api/orchestrators/work/start', { ok: true, paneId: 'p6' });
    assert.equal(($('#btn-home-start') as HTMLButtonElement).disabled, true, 'starting until the State shows it');
    s.orchestrators[1].paneId = 'p6';
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.equal(location.hash, '#/home/work');
    assert.equal(store.view.activePaneId, 'p6');
    assert.ok($('#screen #screen-pane.screen-home'));
  });

  it("a failed Start says so and frees the stopped Home's button", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/home/work');
    await click($('#btn-home-start'));
    await answer('POST /api/orchestrators/work/start', { error: { code: 'already_running', message: 'it runs' } }, 409);
    assert.deepEqual(toastTitles(), ['Could not start the orchestrator']);
    assert.equal(($('#btn-home-start') as HTMLButtonElement).disabled, false);
  });

  it("a Clear that ends with no gap seen still lets go within 8s: a later exit shows the stopped Home at once", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/home/personal');
    await click($('#btn-home-clear'));
    await click($('#modal-root #cf-ok'));
    const r = reqs.find((q) => !q.answered && q.method === 'POST' && q.url === '/api/agents/p4/clear')!;
    await act(async () => { r.answered = true; r.answer(200, { ok: true, paneId: 'p8' }); for (let i = 0; i < 20; i++) await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(8_000); }); // the old pane still listed all along
    assert.equal(store.view.activePaneId, 'p4');
    const s = fresh();
    s.orchestrators[0].paneId = null; // it exits later (not a Clear)
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.ok($('#screen #screen-home-stopped'), 'no hold left over from the Clear');
  });

  it("a Home whose orchestrator goes shows it stopped; a Clear holds for the replacement, up to 8s", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/home/personal');
    const s = fresh();
    s.orchestrators[0].paneId = null; // it exited (not a Clear): the stopped Home at once
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.equal(location.hash, '#/home/personal');
    assert.equal(store.view.activePaneId, null);
    assert.ok($('#screen #screen-home-stopped'));
    s.orchestrators[0].paneId = 'p4'; // started again (elsewhere): its running Home
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.equal(store.view.activePaneId, 'p4');

    // a Clear: the gap before the replacement holds the Home, the replacement re-routes onto it
    await click($('#btn-home-clear'));
    await click($('#modal-root #cf-ok'));
    await act(async () => push!({ type: 'state', state: s })); // a push while the old pane is still there
    s.orchestrators[0].paneId = null;
    await act(async () => push!({ type: 'state', state: s }));
    assert.equal(store.view.activePaneId, 'p4', 'held through the gap');
    await answer('POST /api/agents/p4/clear', { ok: true, paneId: 'p1' });
    s.orchestrators[0].paneId = 'p1';
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.equal(store.view.activePaneId, 'p1', 're-routed onto the replacement');
    assert.ok($('#screen #screen-pane.screen-home'));

    // a Clear whose replacement never shows: the stopped Home after 8s
    await click($('#btn-home-clear'));
    await click($('#modal-root #cf-ok'));
    s.orchestrators[0].paneId = null;
    await act(async () => push!({ type: 'state', state: s }));
    await act(async () => { vi.advanceTimersByTime(7_999); });
    assert.equal(store.view.activePaneId, 'p1');
    assert.deepEqual(toastTitles().filter((t) => t === 'Orchestrator stopped'), []);
    await act(async () => { vi.advanceTimersByTime(1); });
    assert.ok(toastTitles().includes('Orchestrator stopped'));
    await settle();
    assert.equal(location.hash, '#/home/personal');
    assert.ok($('#screen #screen-home-stopped'));
    await answer('POST /api/agents/p1/clear', { ok: true, paneId: 'p8' });
  });

  it('Stop goes back to the list the pane came from; Clear goes to the new pane, or stays on a Home', async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/agents/personal');
    await go('#/pane/p3');
    await click($('#btn-agent-menu'));
    await click($('#am-stop'));
    await click($('#modal-root #cf-ok'));
    await answer('DELETE /api/panes/p3', { ok: true });
    assert.deepEqual(toastTitles(), ['Stopped']);
    assert.equal(location.hash, '#/agents/personal');

    await go('#/pane/p1');
    await click($('#btn-agent-menu'));
    await click($('#am-clear'));
    await click($('#modal-root #cf-ok'));
    await answer('POST /api/agents/p1/clear', { ok: true, paneId: 'p8' });
    assert.equal(location.hash, '#/pane/p8');

    // a Home has no ⋮: Settings in its topbar, Clear and Stop on its status bar
    await go('#/home/personal');
    assert.ok(!$('#btn-agent-menu') && $('#btn-settings'), "a Home's topbar: Settings, no agent-actions menu");
    await click($('#btn-home-clear'));
    await click($('#modal-root #cf-ok'));
    await answer('POST /api/agents/p4/clear', { ok: true, paneId: 'p9' });
    assert.equal(location.hash, '#/home/personal', 'the State routes onto the replacement');
    const s = fresh();
    s.orchestrators[0].paneId = 'p1'; // the replacement (a pane the recorded State has)
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.equal(store.view.activePaneId, 'p1');
  });

  it("a Clear whose old pane goes before it answers opens the new pane, saying nothing of the old one's going", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/agents');
    await go('#/pane/p1');
    await click($('#btn-agent-menu'));
    await click($('#am-clear'));
    await click($('#modal-root #cf-ok'));
    await act(async () => push!({ type: 'pane_gone', paneId: 'p1' })); // herdr closed it first
    const s = fresh();
    s.workspaces[0].tabs[0].panes = s.workspaces[0].tabs[0].panes.filter((p) => p.paneId !== 'p1');
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.equal(location.hash, '#/pane/p1', 'held for the new pane');
    await answer('POST /api/agents/p1/clear', { ok: true, paneId: 'p8' });
    assert.equal(location.hash, '#/pane/p8');
    assert.deepEqual(toastTitles(), ['Cleared']);
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/agents');
  });

  it('a Clear answered while its drawer is closing (its Back under way) opens nothing', async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/agents');
    await go('#/pane/p1');
    await click($('#btn-agent-menu'));
    await click($('#am-clear'));
    await click($('#modal-root #cf-ok'));
    const realBack = history.back.bind(history);
    let land = (): void => {};
    const later = vi.spyOn(history, 'back').mockImplementation(() => { land = realBack; });
    await click($('#btn-drawer-close')); // its Back not landed yet
    await answer('POST /api/agents/p1/clear', { ok: true, paneId: 'p8' });
    later.mockRestore();
    await act(async () => land());
    await settle();
    assert.equal(location.hash, '#/agents');
    assert.ok(!$('.agent-drawer #screen-pane'));
  });

  it("a Stop answered after another pane opened leaves that pane's drawer open", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/agents');
    await go('#/pane/p3');
    await click($('#btn-agent-menu'));
    await click($('#am-stop'));
    await click($('#modal-root #cf-ok'));
    await go('#/pane/p1'); // before the DELETE answers
    await answer('DELETE /api/panes/p3', { ok: true });
    assert.equal(location.hash, '#/pane/p1');
    assert.ok($('.agent-drawer #screen-pane'));
    await go('#/agents');
  });

  it("a Home's Stop button closes its orchestrator's pane after the confirm, and the Home stays, stopped", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/home/personal');
    await click($('#btn-home-stop'));
    await click($('#modal-root #cf-ok'));
    await answer('DELETE /api/panes/p4', { ok: true });
    assert.deepEqual(toastTitles(), ['Stopped']);
    const s = fresh();
    s.orchestrators[0].paneId = null;
    await act(async () => push!({ type: 'state', state: s }));
    await settle();
    assert.equal(location.hash, '#/home/personal');
    assert.ok($('#screen #screen-home-stopped #btn-home-start'));
  });

  it("a Home's Settings button opens the settings, whose Back returns to that Home", async () => {
    await act(async () => push!({ type: 'state', state: fresh() }));
    await go('#/home/personal');
    await click($('#btn-settings'));
    assert.equal(location.hash, '#/settings');
    await settle();
    await click($('.topbar-back'));
    assert.equal(location.hash, '#/home/personal');
  });

  it("routes the SW's navigate message; an orchestrator's pane lands on its Home, drawn afresh", async () => {
    await act(async () => { sw.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', url: '#/pane/p2' } })); });
    await settle();
    assert.equal(location.hash, '#/pane/p2');
    await go('#/home/personal');
    const before = reads('p4');
    await act(async () => { sw.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', url: '#/pane/p4' } })); });
    await settle();
    assert.equal(location.hash, '#/home/personal');
    assert.ok(reads('p4') > before, "a new view reads the orchestrator's screen");
    assert.equal(store.view.activePaneId, 'p4');
  });

  it('pauses the watch while hidden; back on screen resumes it, closes the open pane’s OS notifications and marks it seen', async () => {
    store.seenDone = {};
    hidden = true;
    await go('#/pane/p3'); // done (completionSeq 4)
    assert.equal(watches.at(-1), 'p3:terminal:hidden');
    assert.equal(store.seenDone.p3, undefined, 'not seen while hidden');
    await settle();
    closed.length = 0;
    hidden = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await settle();
    assert.equal(watches.at(-1), 'p3:terminal');
    assert.deepEqual(closed, ['p3']);
    assert.equal(store.seenDone.p3, 4);
  });

  it("follows the socket and herdr's link with the dot and the banner", async () => {
    store.wsConnected = true;
    await act(async () => setAppState({ ...fresh(), connected: false }));
    assert.equal($('#conn-dot')!.className, 'conn-dot');
    assert.equal($('#conn-dot')!.title, 'Reconnecting…');
    assert.equal($('#reconnect-banner')!.classList.contains('visible'), true);
    await act(async () => setAppState(fresh()));
    assert.equal($('#conn-dot')!.className, 'conn-dot connected');
    assert.equal($('#reconnect-banner')!.classList.contains('visible'), false);
    store.wsConnected = false;
    await act(async () => emit());
    assert.equal($('#reconnect-banner')!.classList.contains('visible'), true);
    store.wsConnected = true;
    await act(async () => emit());
  });

  it('watches a pane opened from a chat pane on its terminal from the start', async () => {
    await go('#/pane/p1');
    await answer('/api/panes/p1/read?source=visible', read[1]);
    await answer('/api/panes/p1/transcript', transcript[0]); // claude's transcript: chat
    assert.equal(watches.at(-1), 'p1:chat');

    await go('#/pane/p2'); // a shell: terminal only
    await answer('/api/panes/p2/read?source=visible', read[1]);
    await answer('/api/panes/p2/transcript', { available: false });
    assert.ok($('#terminal-output')!.style.display !== 'none', 'the terminal is shown');
    assert.deepEqual(watches.slice(watches.lastIndexOf('p1:chat') + 1).filter((w) => w.startsWith('p2:')), ['p2:terminal']);
  });

  it("a headless orchestrator's Home watches its transcript only; its Stop and Clear go to /api/orchestrators/:name", async () => {
    const pilot = (running: boolean): AppState => {
      const s = fresh();
      s.orchestrators.push({ name: 'pilot', label: 'Pilot', paneId: running ? 'hl:pilot' : null, agents: [], mode: 'headless',
        headless: { status: running ? 'idle' : 'stopped', completionSeq: 0, pending: null, usage: null, warnings: [], model: 'default', models: [] } });
      return s;
    };
    await act(async () => push!({ type: 'state', state: pilot(true) }));
    await go('#/home/pilot');
    assert.equal(reads('hl%3Apilot'), 0, 'no terminal to read');
    assert.equal(watches.at(-1), 'hl:pilot:chat');
    await answer('GET /api/panes/hl%3Apilot/transcript', { available: false });
    assert.equal($('#chat-log')!.textContent, 'No messages yet.');

    await click($('#btn-home-stop'));
    await click($('#modal-root #cf-ok'));
    await answer('POST /api/orchestrators/pilot/stop', { ok: true });
    await act(async () => push!({ type: 'state', state: pilot(false) }));
    await settle();
    assert.ok($('#screen #screen-home-stopped #btn-home-start'), 'stopped, the Home stays');

    await act(async () => push!({ type: 'state', state: pilot(true) }));
    await settle();
    await click($('#btn-home-clear'));
    await click($('#modal-root #cf-ok'));
    await answer('POST /api/orchestrators/pilot/clear', { ok: true, paneId: 'hl:pilot', name: 'pilot' });
    assert.equal(location.hash, '#/home/pilot');
    assert.equal(store.view.activePaneId, 'hl:pilot');
  });

  it("draws the PC sidebar on a wide screen only, before the shell's elements, which stay as it comes and goes", async () => {
    await go('#/agents');
    const shell = (): Array<HTMLElement | null> => ['#topbar', '#reconnect-banner', '#screen'].map($);
    const before = shell();
    const list = $('#screen-agents');
    assert.ok(!$('#sidebar'), 'no sidebar');
    await setWide(true);
    assert.ok($('#app > #sidebar')!.nextElementSibling === before[0], 'first in #app, before #topbar');
    assert.ok($('#sidebar [data-home="personal"]'), 'its Homes');
    await setWide(false);
    assert.ok(!$('#sidebar'), 'no sidebar');
    await setWide(true); // and the 401 below goes to the token screen with it wide
    assert.ok(shell().every((el, i) => el === before[i]), '#topbar, #reconnect-banner and #screen are the same elements');
    assert.ok($('#screen-agents') === list, 'the screen on show stays');
  });

  it('a 401 shows the token screen with its message, without the topbar or the banner (or the PC sidebar)', async () => {
    await go('#/agents');
    assert.ok($('#sidebar'), 'wide, from the test before');
    store.wsConnected = false;
    await act(async () => emit()); // the link is down
    assert.equal($('#reconnect-banner')!.classList.contains('visible'), true);
    await click($('#btn-new-agent'));
    await answer('GET /api/profiles', {}, 401);
    assert.equal($('#screen #screen-login .login-subtitle')!.textContent, 'Session expired or token invalid. Please enter your token.');
    assert.equal(localStorage.getItem('herdr_token'), null);
    assert.equal($('#topbar')!.style.display, 'none');
    assert.equal($('#reconnect-banner')!.classList.contains('visible'), false);
    assert.ok(!$('#sidebar'), 'no sidebar over the token screen');
  });
});
