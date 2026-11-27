// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { draftKey, setDraft } from '../src/drafts.ts';
import { clearToasts, getToasts } from '../src/notify.ts';
import { keptTasks, setAppState, store } from '../src/store.ts';
import type { AppState, WsMessage } from '../src/types.ts';
import { orchestratorOfPane } from '../src/routes.ts';
import { WIDE_QUERY } from '../src/theme.ts';
import { AgentDrawer, type Sheet } from '../src/ui/AgentDrawer.tsx';
import { homeTopbar, Pane, paneViewOnState } from '../src/ui/Pane.tsx';
import { read, state as recorded, transcript } from './contract.gen.ts';
import { fire, render } from './render.ts';

// The socket: pane-view.ts subscribes itself; nothing is pushed here.
vi.mock('../src/ws.ts', () => ({
  onWsMessage: (_fn: (msg: WsMessage) => void) => () => {},
  wsSendWatch: () => {},
}));

// The bridge: every request waits until the test answers it.
interface Req { method: string; url: string; body: any; answered: boolean; answer: (status: number, body: unknown) => void }
let reqs: Req[];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
async function answer(match: string, body: unknown, status = 200, nth = 0): Promise<void> {
  const r = reqs.filter((q) => !q.answered && `${q.method} ${q.url}`.includes(match))[nth]; // nth: the nth still open
  assert.ok(r, `no open request ${match} (open: ${reqs.filter((q) => !q.answered).map((q) => `${q.method} ${q.url}`).join(', ')})`);
  r.answered = true;
  await act(async () => { r.answer(status, body); await flush(); });
}
const posts = (paneId: string) => reqs.filter((q) => q.method === 'POST' && q.url === `/api/panes/${paneId}/input`).map((q) => q.body);

const fresh = (): AppState => structuredClone(recorded); // p1 claude working, p2 a shell, p7 codex; p4 runs the orchestrator "personal"
let desktop: boolean;
let unmount: () => Promise<void>;
let container: HTMLElement;

const noActions = () => ({ rename: () => {}, clear: () => {}, stop: () => {} });
/** A pane as mounted, in its drawer over `back`; a Home with its topbar's slots, then the screen. */
async function show(paneId: string, home = false, back = '#/agents', name = home ? orchestratorOfPane(store.appState, paneId)?.name : undefined): Promise<void> {
  store.view.activePaneId = paneId;
  store.view.homeMode = home;
  store.view.paneBackRoute = back;
  store.view.paneOverBase = false;
  const t = homeTopbar(paneId);
  ({ container, unmount } = await render(home ? <><div id="tb">{t.title}{t.right}</div><Pane paneId={paneId} home name={name} /></>
    : <AgentDrawer sheet={{ paneId, key: 1, open: true, opener: null, openedPane: paneId }} actions={noActions} />));
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => container.querySelector<T>(sel)!;
const ta = () => $<HTMLTextAreaElement>('#pane-input');
const type = (text: string) => fire(() => { ta().value = text; ta().dispatchEvent(new Event('input', { bubbles: true })); });
/** A keydown on the composer; true when it was not prevented (a newline goes in). */
async function key(init: KeyboardEventInit & { keyCode?: number }): Promise<boolean> {
  let ok = true;
  await fire(() => { ok = ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })); });
  return ok;
}

beforeEach(() => {
  reqs = [];
  unmount = async () => {};
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
    reqs.push({ method: init.method ?? 'GET', url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), answered: false,
      answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
  }));
  desktop = true;
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(hover: hover) and (pointer: fine)' && desktop }));
  localStorage.clear();
  clearToasts();
  store.seenDone = {};
  location.hash = '#/agents';
  setAppState(fresh());
});
afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
});

describe('composer', () => {
  it('on a PC Enter sends once (text + enter, no clear outside claude) and empties the field', async () => {
    await show('p2');
    await type('ls');
    assert.equal(await key({}), false, 'the Enter is prevented: no newline');
    assert.deepEqual(posts('p2'), [{ text: 'ls', enter: true }]);
    await answer('POST /api/panes/p2/input', { ok: true });
    assert.equal(ta().value, '');
  });

  it('Shift/Ctrl/Alt/Meta+Enter, an IME Enter (isComposing, 229) and Enter on a touch device insert a newline', async () => {
    await show('p2');
    await type('ls');
    for (const mod of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) assert.equal(await key({ [mod]: true }), true, mod);
    assert.equal(await key({ isComposing: true }), true, 'isComposing');
    assert.equal(await key({ keyCode: 229 }), true, 'keyCode 229');
    desktop = false;
    assert.equal(await key({}), true, 'touch');
    assert.deepEqual(posts('p2'), []);
  });

  it('a held Enter (auto-repeat) sends once', async () => {
    await show('p2');
    await type('ls');
    await key({});
    assert.equal(await key({ repeat: true }), false);
    assert.equal(posts('p2').length, 1);
  });

  it('adds clear:true only on a claude pane', async () => {
    await show('p1');
    assert.ok(container.querySelector('#btn-attach') === null, 'no + on a TUI pane'); // images: a headless Home's only
    await type('hi');
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('p1'), [{ text: 'hi', enter: true, clear: true }]);
    await unmount();
    await show('p7'); // codex
    await type('hi');
    await fire(() => $('#btn-send-enter').click());
    assert.deepEqual(posts('p7'), [{ text: 'hi', enter: true }]);
  });

  it('keeps what is typed while the send is in flight, and sends nothing empty', async () => {
    await show('p2');
    await fire(() => $('#btn-send-enter').click());
    assert.equal(posts('p2').length, 0);
    await type('ls');
    await key({});
    await type('ls -l');
    await answer('POST /api/panes/p2/input', { ok: true });
    assert.equal(ta().value, 'ls -l');
    await type('bad');
    await key({});
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500);
    assert.equal(ta().value, 'bad');
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`), ['Send failed: boom']);
  });

  it('shows a kept task, locks it while it is sent, shows it again on failure and drops it on success', async () => {
    keptTasks.keep('p2', 'first task');
    await show('p2');
    assert.equal(ta().value, 'first task');
    await type('first task, edited');
    await key({});
    assert.equal(ta().disabled, true);
    await unmount(); // left and reopened while it is sent: still locked, empty
    await show('p2');
    assert.equal(ta().disabled, true);
    assert.equal(ta().value, '');
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500);
    assert.equal(ta().disabled, false);
    assert.equal(ta().value, 'first task, edited');
    await key({});
    await answer('POST /api/panes/p2/input', { ok: true });
    assert.equal(ta().value, '');
    assert.equal(keptTasks.draft('p2'), null);
  });

  it('keeps an unsent draft per pane and per Home across leaving and reopening (stored: a reload too) until it is sent', async () => {
    const reopen = async (paneId: string, home = false, name?: string) => { await unmount(); await show(paneId, home, '#/agents', name); };
    await show('p2');
    await type('p2 draft');
    await reopen('p1');
    assert.equal(ta().value, '', "another pane's composer");
    await type('p1 draft');
    location.hash = '#/home/personal';
    await reopen('p4', true);
    assert.equal(ta().value, '', "the Home's composer");
    await type('home draft');
    await reopen('p2');
    assert.equal(ta().value, 'p2 draft');
    await key({});
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500);
    await reopen('p2');
    assert.equal(ta().value, 'p2 draft', 'a failed send keeps it');
    await key({});
    await reopen('p2');
    assert.equal(ta().value, '', 'reopened while it is sent: not shown, so not sent twice');
    assert.equal(JSON.parse(localStorage.getItem('herdr_drafts')!)['pane:p2'], 'p2 draft', 'but stored: a reload mid-send keeps it');
    await answer('POST /api/panes/p2/input', { ok: true });
    assert.equal(ta().value, '');
    await reopen('p2');
    assert.equal(ta().value, '', 'sent: forgotten');
    await type('a');
    await key({});
    await type('ab');
    await type('a'); // edited mid-send, back to what went out
    await answer('POST /api/panes/p2/input', { ok: true });
    await reopen('p2');
    assert.equal(ta().value, '', 'sent: forgotten too');
    await type('one');
    await key({});
    await type('two');
    await key({});
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500);
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500);
    await reopen('p2');
    assert.equal(ta().value, 'two', 'two failed sends: the last one stays');
    await key({});
    await type('three');
    await key({});
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500);
    assert.equal(ta().value, 'three', 'a newer draft stays');
    await answer('POST /api/panes/p2/input', { ok: true });
    assert.equal(ta().value, '');
    await reopen('p2');
    await type('four');
    await key({});
    await type('five');
    await key({});
    await answer('POST /api/panes/p2/input', { ok: true }, 200, 1); // five went
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500); // four didn't
    assert.equal(ta().value, 'four', 'failed, and nothing newer unsent: the draft again');
    await reopen('p2');
    assert.equal(ta().value, 'four');
    await reopen('p1');
    assert.equal(ta().value, 'p1 draft');
    await reopen('p4', true);
    assert.equal(ta().value, 'home draft');
    assert.deepEqual(JSON.parse(localStorage.getItem('herdr_drafts')!), { 'pane:p1': 'p1 draft', 'pane:p2': 'four', 'home:personal': 'home draft' });
    await key({});
    await reopen('p9', true, 'personal'); // a Clear gave the Home a new pane while it was sent
    assert.equal(ta().value, '');
    await answer('POST /api/panes/p4/input', { error: { code: 'x', message: 'boom' } }, 500);
    assert.equal(ta().value, 'home draft', 'a failed send shows it in the Home again');
  });

  it("drops the drafts of panes and orchestrators the State no longer has, but not while herdr is out of reach", async () => {
    for (const k of [draftKey('p2'), draftKey('p99'), draftKey('p4', 'personal'), draftKey('', 'gone')]) setDraft(k, k);
    setAppState({ ...fresh(), connected: false, workspaces: [], orchestrators: [] });
    assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem('herdr_drafts')!)), ['pane:p2', 'pane:p99', 'home:personal', 'home:gone']);
    setAppState(fresh());
    assert.deepEqual(JSON.parse(localStorage.getItem('herdr_drafts')!), { 'pane:p2': 'pane:p2', 'home:personal': 'home:personal' });
    await show('p2');
    await key({});
    const gone = fresh(); // p2 closed while its send is in flight
    for (const ws of gone.workspaces) for (const t of ws.tabs) t.panes = t.panes.filter((p) => p.paneId !== 'p2');
    setAppState(gone);
    await answer('POST /api/panes/p2/input', { error: { code: 'x', message: 'boom' } }, 500);
    assert.deepEqual(JSON.parse(localStorage.getItem('herdr_drafts')!), { 'home:personal': 'home:personal' }, 'its failure stores nothing for a reused id');
  });

  it('keeps the same textarea and what is typed in it across state pushes', async () => {
    location.hash = '#/home/personal';
    await show('p4', true);
    await type('half-typed');
    const node = ta();
    const shown: string[] = [];
    for (const status of ['working', 'idle', 'working'] as const) {
      const s = fresh();
      s.workspaces[0].tabs[0].panes[1].agent!.status = status; // p4, the orchestrator
      await fire(() => setAppState(s));
      shown.push($('#home-activity').style.display);
    }
    assert.deepEqual(shown, ['', 'none', ''], 'each push re-rendered the screen');
    assert.ok(ta() === node, 'the same textarea');
    assert.equal(ta().value, 'half-typed');
  });
});

describe('answer panel', () => {
  const ASK = ['─'.repeat(28), ' ☐ Fruit', 'Pick a fruit', '', '❯ 1. apple', '  2. banana', '  3. cherry',
    'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');

  it('shows under the pane body while the pane is blocked in chat; a double tap sends one press', async () => {
    await show('p6'); // claude, blocked
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', transcript[0]);
    await answer('/read?source=visible&format=ansi', { ansi: ASK });
    const panel = $('#chat-prompt');
    assert.ok(panel.previousElementSibling === $('#pane-view') && panel.nextElementSibling === $('.input-bar'), 'between the body and the input bar');
    const opts = [...container.querySelectorAll<HTMLButtonElement>('#chat-prompt .ask-opt')];
    assert.deepEqual(opts.map((b) => b.textContent), ['1apple', '2banana', '3cherry']);
    await fire(() => opts[1].click());
    await fire(() => opts[1].click());
    assert.equal(posts('p6').length, 1);
    assert.equal(posts('p6')[0].press, '2');
    assert.ok(posts('p6')[0].expect_prompt, 'expect_prompt is set');
    const s = fresh();
    s.workspaces[1].tabs[0].panes.find((p) => p.paneId === 'p6')!.agent!.status = 'working';
    await fire(() => { setAppState(s); paneViewOnState(); });
    assert.equal(container.querySelector('#chat-prompt'), null, 'unblocked: the panel goes');
  });
});

describe('quick keys', () => {
  it('POSTs each of the 12 payloads exactly once', async () => {
    await show('p2');
    const keys = [...container.querySelectorAll<HTMLButtonElement>('.qkey')];
    assert.deepEqual(keys.map((b) => b.textContent), ['Enter', '⌫', 'Esc', 'Ctrl+C', '↑', '↓', 'Tab', 'y', 'n', '1', '2', '3']);
    for (const b of keys) await fire(() => b.click());
    assert.deepEqual(posts('p2'), [
      { keys: ['enter'] }, { keys: ['backspace'] }, { keys: ['esc'] }, { keys: ['ctrl+c'] }, { keys: ['up'] }, { keys: ['down'] },
      { keys: ['tab'] }, { text: 'y', enter: true }, { text: 'n', enter: true }, { text: '1' }, { text: '2' }, { text: '3' },
    ]);
  });
});

describe('pane header', () => {
  it("is a modal sheet on a phone; on a wide screen no modal (the sidebar beside it is usable)", async () => {
    await show('p2');
    assert.equal($('[role="dialog"]').getAttribute('aria-modal'), 'true');
    await unmount();
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === WIDE_QUERY, addEventListener() {}, removeEventListener() {} }));
    await show('p2');
    assert.equal($('[role="dialog"]').getAttribute('aria-modal'), 'false');
  });

  it("on a wide screen a close gives the focus back to its opener, else to the new screen's control for the pane, not from the sidebar", async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === WIDE_QUERY, addEventListener() {}, removeEventListener() {} }));
    let set: (s: Sheet) => void = () => {};
    let screen: (k: number) => void = () => {};
    function Host({ opener }: { opener: HTMLElement | null }) {
      const [s, setS] = useState<Sheet>({ paneId: 'p2', key: 1, open: true, opener, openedPane: 'p2' });
      const [k, setK] = useState(0); // the screen under it drawn afresh (a Home): a new chip
      set = setS;
      screen = setK;
      return <><aside id="sidebar"><button id="side">a</button></aside><main id="screen" key={k}><button data-pane-id="p2">chip</button></main><AgentDrawer sheet={s} actions={noActions} /></>;
    }
    const outside = document.body.appendChild(document.createElement('button'));
    ({ container, unmount } = await render(<Host opener={outside} />));
    // closed on p7, opened on p2 (pane to pane in between): the chip is p2's
    const close = (opener: HTMLElement | null) => fire(() => set({ paneId: 'p7', key: 3, open: false, opener, openedPane: 'p2' }));
    const reopen = (opener: HTMLElement | null) => fire(() => set({ paneId: 'p2', key: 2, open: true, opener, openedPane: 'p2' }));
    assert.ok(document.activeElement === $('.agent-drawer-head'));
    await close(outside);
    assert.ok(document.activeElement === outside, 'back to its opener');
    outside.remove();
    await reopen(outside);
    await fire(() => screen(1));
    await close(outside);
    assert.ok(document.activeElement === $('#screen [data-pane-id="p2"]'), "its opener gone: the new screen's chip");
    await reopen(outside);
    await fire(() => set({ paneId: 'p2', key: 4, open: false, opener: outside, openedPane: 'p9' })); // p9 cleared into p2: no p9 chip
    assert.ok(document.activeElement === $('#screen [data-pane-id="p2"]'), "the pane it opened on gone too: the pane on show's");
    await reopen(null);
    $('#side').focus();
    await close(null);
    assert.ok(document.activeElement === $('#side'), 'moved to the sidebar: it stays');
  });

  it('names the agent and where it is, keeps that while the pane is gone, and ✕ closes it', async () => {
    location.hash = '#/pane/p1'; // opened afresh: its close replaces it with the screen under it
    await show('p1', false, '#/agents/personal');
    assert.equal($('.agent-drawer-head').textContent!.replace(/[⋮]/g, ''), '✕claude· repo / oneChat');
    const s = fresh();
    s.workspaces[0].tabs[0].panes.splice(0, 1);
    await fire(() => setAppState(s));
    assert.match($('.agent-drawer-head').textContent!, /claude· repo \/ one/);
    await fire(() => $('#btn-drawer-close').click());
    assert.equal(location.hash, '#/agents/personal');
  });

  it('shows the toggle once there is a transcript: chat by default, then terminal, remembered', async () => {
    await show('p1');
    const toggle = $('#btn-view-toggle');
    assert.equal(toggle.style.display, 'none');
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', transcript[0]);
    assert.equal(toggle.style.display, '');
    assert.equal(toggle.textContent, 'Terminal');
    assert.equal($('#quickkey-row').style.display, '');
    await fire(() => toggle.click());
    assert.equal(toggle.textContent, 'Chat');
    assert.equal(localStorage.getItem('herdr_pane_view'), 'terminal');
  });
});

describe('read-only chat', () => {
  const bar = () => $('#pane-input').closest<HTMLElement>('.input-bar')!;

  it("a pane's chat has no composer or keys, its terminal has both; while it works ■ Interrupt sends Esc", async () => {
    await show('p1'); // claude, working
    assert.equal(bar().style.display, '', 'shown until the view is in chat (a terminal scrolled to its bottom stays so)');
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', transcript[0]);
    assert.equal(bar().style.display, 'none', 'chat: read-only');
    await fire(() => $('#btn-pane-interrupt').click());
    assert.deepEqual(posts('p1'), [{ keys: ['esc'] }]);
    await fire(() => $('#btn-view-toggle').click());
    assert.equal(bar().style.display, '', 'terminal: the composer and keys');
    assert.ok(!$('#btn-pane-interrupt'), "■ is the chat's (the terminal has Esc)");
    await type('typed in the terminal');
    await fire(() => $('#btn-view-toggle').click());
    assert.equal(bar().style.display, 'none');
    await fire(() => $('#btn-view-toggle').click());
    assert.equal(ta().value, 'typed in the terminal', 'hidden, not dropped');
  });

  it('■ only while it works', async () => {
    const s = fresh();
    s.workspaces[0].tabs[0].panes[0].agent!.status = 'idle';
    setAppState(s);
    await show('p1');
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', transcript[0]);
    assert.ok(!$('#btn-pane-interrupt'));
    s.workspaces[0].tabs[0].panes[0].agent!.status = 'working';
    await fire(() => setAppState(structuredClone(s)));
    assert.ok($('#btn-pane-interrupt'));
  });

  it('a pane without a transcript (its terminal) has them; so has a chat with a kept first task', async () => {
    await show('p2'); // a shell
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', { available: false });
    assert.equal(bar().style.display, '');
    await unmount();
    keptTasks.keep('p1', 'first task');
    await show('p1');
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', transcript[0]);
    assert.equal(bar().style.display, '', 'chat, with the task to send');
    assert.equal(ta().value, 'first task');
    keptTasks.beginSend('p1', 'first task'); // sent: no longer kept, for the tests after this one
    keptTasks.finishSend('p1', true);
  });
});

describe('Home', () => {
  const home = async (s: AppState): Promise<void> => {
    setAppState(s);
    location.hash = '#/home/personal';
    await show('p4', true);
  };

  it('shows the counts of its account and goes to its list from them', async () => {
    await home(fresh());
    assert.equal($('#tb').textContent, 'Personal· ready>_⚙', "a Home's topbar: no Agents, ends with Settings, no ⋮");
    assert.equal($('.home-counts').textContent, '1 working1 done0 idleAgents ›'); // p1, p3 (p4 is the orchestrator)
    // two configured, one running: the switcher lists both, the stopped one dimmed
    const sw = [...container.querySelectorAll<HTMLElement>('.home-switch-btn')];
    assert.deepEqual(sw.map((b) => `${b.className}|${b.dataset.orch}|${b.querySelector('i')!.className}|${b.textContent}`),
      ['home-switch-btn active|personal|home-dot idle|Personal', 'home-switch-btn stopped|work|home-dot stopped|work']);
    assert.equal(container.querySelector('.home-attn'), null);
    await fire(() => $('.home-counts').click());
    assert.equal(location.hash, '#/agents/personal');
  });

  it('lists the agents waiting on the user, and a switcher once two orchestrators run', async () => {
    const s = fresh();
    s.orchestrators[0].agents!.push('p6'); // blocked
    s.orchestrators[1].paneId = 'p7';
    await home(s);
    const chips = [...container.querySelectorAll<HTMLElement>('.home-chip')];
    assert.deepEqual(chips.map((c) => `${c.dataset.paneId}:${c.textContent}`), ['p6:feat #2repo-wt-feat']);
    const sw = [...container.querySelectorAll<HTMLElement>('.home-switch-btn')];
    assert.deepEqual(sw.map((b) => `${b.className}|${b.dataset.paneId}|${b.querySelector('i')!.className}|${b.textContent}`),
      ['home-switch-btn active|p4|home-dot idle|Personal', 'home-switch-btn|p7|home-dot unknown|repo']);
    await fire(() => sw[1].click());
    assert.equal(location.hash, '#/home/work');
    await fire(() => chips[0].click());
    assert.equal(location.hash, '#/pane/p6');
  });

  it("hides the terminal keys until the view is on the terminal; its toggle doesn't change the preferred view", async () => {
    await home(fresh());
    const toggle = $('#btn-view-toggle');
    assert.equal($('#quickkey-row').style.display, 'none');
    assert.equal(toggle.style.display, 'none');
    assert.equal(toggle.getAttribute('aria-label'), 'Toggle terminal');
    assert.equal($('#pane-input').getAttribute('placeholder'), 'Message Personal…');
    await answer('/read?source=visible', read[1]);
    await answer('/transcript', transcript[0]); // an orchestrator always opens as chat
    assert.equal(toggle.style.display, '');
    assert.equal(toggle.textContent, '>_');
    assert.equal($('#quickkey-row').style.display, 'none');
    await fire(() => toggle.click());
    assert.equal(toggle.textContent, 'Chat');
    assert.equal($('#quickkey-row').style.display, '');
    assert.equal(container.querySelectorAll('.qkey').length, 12);
    assert.equal(localStorage.getItem('herdr_pane_view'), null);
  });

  it('shows "doing now" only while the orchestrator works, and its state in the title', async () => {
    const s = fresh();
    s.workspaces[0].tabs[0].panes[1].agent!.status = 'working';
    await home(s);
    assert.equal($('#home-activity').style.display, '');
    assert.equal($('#home-activity').textContent, 'thinking…');
    assert.equal($('.home-state').className, 'topbar-subtitle home-state working');
    assert.equal($('.home-state').textContent, '· working…');
    await fire(() => setAppState(fresh()));
    assert.equal($('#home-activity').style.display, 'none');
    assert.equal($('.home-state').textContent, '· ready');
  });
});
