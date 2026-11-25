// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { clearToasts, getToasts } from '../src/notify.ts';
import { keptTasks, setAppState, store } from '../src/store.ts';
import type { AppState, WsMessage } from '../src/types.ts';
import { Pane, paneTopbar } from '../src/ui/Pane.tsx';
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
async function answer(match: string, body: unknown, status = 200): Promise<void> {
  const r = reqs.find((q) => !q.answered && `${q.method} ${q.url}`.includes(match));
  assert.ok(r, `no open request ${match} (open: ${reqs.filter((q) => !q.answered).map((q) => `${q.method} ${q.url}`).join(', ')})`);
  r.answered = true;
  await act(async () => { r.answer(status, body); await flush(); });
}
const posts = (paneId: string) => reqs.filter((q) => q.method === 'POST' && q.url === `/api/panes/${paneId}/input`).map((q) => q.body);

const fresh = (): AppState => structuredClone(recorded); // p1 claude working, p2 a shell, p7 codex; p4 runs the orchestrator "personal"
let desktop: boolean;
let unmount: () => Promise<void>;
let container: HTMLElement;

/** The pane screen as mounted: its topbar's slots, then the screen. */
async function show(paneId: string, home = false, back = '#/agents'): Promise<void> {
  store.view.activePaneId = paneId;
  store.view.homeMode = home;
  const t = paneTopbar(paneId, home, back, () => {});
  ({ container, unmount } = await render(<><div id="tb">{t.left}{t.title}{t.right}</div><Pane paneId={paneId} home={home} /></>));
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

describe('pane topbar', () => {
  it('names the agent and where it is, keeps that while the pane is gone, and goes Back', async () => {
    await show('p1', false, '#/agents/personal');
    assert.equal($('#tb').textContent!.replace(/[⋮]/g, ''), '← Agentsclaude· repo / oneChat');
    const s = fresh();
    s.workspaces[0].tabs[0].panes.splice(0, 1);
    await fire(() => setAppState(s));
    assert.match($('#tb').textContent!, /claude· repo \/ one/);
    await fire(() => $('.topbar-back').click());
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

describe('Home', () => {
  const home = async (s: AppState): Promise<void> => {
    setAppState(s);
    location.hash = '#/home/personal';
    await show('p4', true);
  };

  it('shows the counts of its account and goes to its list from them and from Agents', async () => {
    await home(fresh());
    assert.equal($('#tb').textContent!.replace(/[⋮]/g, ''), 'Personal· readyAgents>_');
    assert.equal($('.home-counts').textContent, '1 working1 done0 idleAll agents ›'); // p1, p3 (p4 is the orchestrator)
    assert.equal(container.querySelector('.home-switch'), null, 'one orchestrator running: no switcher');
    assert.equal(container.querySelector('.home-attn'), null);
    await fire(() => $('.home-counts').click());
    assert.equal(location.hash, '#/agents/personal');
    location.hash = '#/home/personal';
    await fire(() => $('#btn-home-agents').click());
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
