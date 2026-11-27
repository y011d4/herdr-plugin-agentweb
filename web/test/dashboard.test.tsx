// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { clearToasts } from '../src/notify.ts';
import { setAppState, store } from '../src/store.ts';
import type { AppState } from '../src/types.ts';
import { Dashboard, dashboardTopbar } from '../src/ui/Dashboard.tsx';
import { state as recorded } from './contract.gen.ts';
import { fire, render } from './render.ts';

const fresh = (): AppState => structuredClone(recorded);
/** Runs the (fake) timers due and lets React settle. */
const settle = (): Promise<void> => act(async () => { vi.runAllTimers(); });

let unmounts: Array<() => Promise<void>>;
async function show(hash: string, state: AppState | null): Promise<HTMLElement> {
  setAppState(state);
  const r = await render(<Dashboard hash={hash} />);
  unmounts.push(r.unmount);
  return r.container;
}
const ids = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>('.agent-card')].map((e) => e.dataset.paneId!);

beforeEach(() => {
  unmounts = [];
  location.hash = '#/agents';
  store.seenDone = {};
  clearToasts();
  localStorage.clear();
});
afterEach(async () => {
  vi.useRealTimers();
  for (const u of unmounts) await u();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Dashboard cards', () => {
  it('opens a card on a click, Enter or Space', async () => {
    const c = await show('#/agents', fresh());
    const card = c.querySelector<HTMLElement>('.agent-card[data-pane-id="p7"]')!;
    for (const go of [() => card.click(), () => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      () => card.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))]) {
      location.hash = '#/agents';
      await fire(go);
      assert.equal(location.hash, '#/pane/p7');
    }
    location.hash = '#/agents';
    await fire(() => card.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    assert.equal(location.hash, '#/agents');
  });

  it("names a card by its agent's purpose, else herdr's name for it, else its tab; below, the name a purpose hides and the location its name doesn't say", async () => {
    const s = fresh();
    const tab = s.workspaces[0].tabs.find((t) => t.panes.some((p) => p.paneId === 'p7'))!;
    tab.label = 'fix-auth';
    tab.panes.find((p) => p.paneId === 'p7')!.agent!.herdrName = 'fix-auth'; // agent start's tab is labelled by the name
    s.purposes.p7 = 'ログインを直す';
    const c = await show('#/agents', s);
    const card = (id: string): string[] => ['.agent-name', '.card-location']
      .map((sel) => c.querySelector(`.agent-card[data-pane-id="${id}"] ${sel}`)!.textContent!);
    assert.deepEqual(card('p3'), ['レビューの指摘を直す', 'w-review · repo-wt-feat › feat #1']);
    // the branch leaves the purpose's row for the dim line
    assert.deepEqual(card('p7'), ['ログインを直す', 'fix-auth · main · repo']);
    assert.ok(!c.querySelector('.agent-card[data-pane-id="p7"] .card-branch'));
    delete s.purposes.p3;
    delete s.purposes.p7;
    await act(async () => setAppState(structuredClone(s)));
    assert.deepEqual(card('p3'), ['w-review', 'repo-wt-feat › feat #1']);
    assert.deepEqual(card('p7'), ['fix-auth', 'repo']);
    assert.equal(c.querySelector('.agent-card[data-pane-id="p7"] .card-branch')!.textContent, 'main');
    assert.deepEqual(card('p6'), ['feat #2', 'repo-wt-feat']); // no name: the tab
    assert.deepEqual(card('p1'), ['one #1', 'repo']);
  });
});

describe('Dashboard list', () => {
  it('scopes #/agents/<name> to its account, and never shows an orchestrator', async () => {
    assert.deepEqual(ids(await show('#/agents/personal', fresh())).sort(), ['p1', 'p3']);
    assert.deepEqual(ids(await show('#/agents/work', fresh())).sort(), ['p1', 'p3', 'p6', 'p7']); // account unknown: every agent
    assert.deepEqual(ids(await show('#/agents', fresh())).sort(), ['p1', 'p3', 'p6', 'p7']);
  });

  it('says when there are no workspaces, or no agents', async () => {
    const none = fresh();
    none.workspaces = [];
    let c = await show('#/agents', none);
    assert.equal(c.querySelector('#screen-agents .empty-state')!.textContent, 'No workspaces found.');
    const idle = fresh();
    idle.workspaces = [idle.workspaces[2]]; // w3: a pane without an agent
    c = await show('#/agents', idle);
    assert.equal(c.querySelector('#screen-agents .empty-state')!.textContent, 'No active agents.');
    assert.ok(c.querySelector('.agent-list') === null, 'no .agent-list when there are no agents');
  });

  it('shows a spinner (no data-ready) until the first State', async () => {
    const c = await show('#/agents', null);
    assert.equal(c.querySelector<HTMLElement>('#screen-agents')!.dataset.ready, undefined);
    assert.ok(c.querySelector('#screen-agents .mantine-Loader-root'));
    await fire(() => setAppState(fresh()));
    assert.equal(c.querySelector<HTMLElement>('#screen-agents')!.dataset.ready, '1');
  });

});

describe('Dashboard under state pushes', () => {
  const touch = (el: Element, type: string, fingers = 0) =>
    fire(() => el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: Array.from({ length: fingers }, () => ({ clientX: 0 }) as Touch) })));
  const renamed = (label: string): AppState => { const s = fresh(); s.workspaces[0].tabs[0].label = label; return s; };

  it('updates in place: the scroller and each card (keyed by pane) stay the same nodes, also when the order changes', async () => {
    const c = await show('#/agents', fresh());
    const scroller = c.querySelector('#screen-agents');
    const card = c.querySelector('.agent-card[data-pane-id="p1"]');
    assert.equal(ids(c)[0], 'p1');
    const s = renamed('pushed');
    s.workspaces[0].tabs[0].panes[0].agent!.stateChangeSeq = 1; // now the oldest change: last
    await fire(() => setAppState(s));
    assert.equal(ids(c).at(-1), 'p1');
    assert.ok(c.querySelector('#screen-agents') === scroller, '#screen-agents is the same element');
    assert.ok(c.querySelector('.agent-card[data-pane-id="p1"]') === card, 'the p1 card is the same element');
    assert.equal(card!.querySelector('.agent-name')!.textContent, 'pushed #1'); // the tab's 2nd agent is the orchestrator
  });

  it('holds the list while a finger is down; the latest State shows on the macrotask after the last one lifts', async () => {
    const c = await show('#/agents', fresh());
    const scroller = c.querySelector('#screen-agents')!;
    const name = () => c.querySelector('.agent-card[data-pane-id="p1"] .agent-name')!.textContent;
    // Fake, so lift's setTimeout runs only in settle(): `await fire()` (React's act) itself waits a
    // macrotask (setImmediate), which a real setTimeout(0) can beat under load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await touch(scroller, 'touchstart', 1);
    await fire(() => setAppState(renamed('pushed')));
    assert.equal(name(), 'one #1');
    await touch(scroller, 'touchend', 1); // another finger is still down
    await settle();
    assert.equal(name(), 'one #1');
    await touch(scroller, 'touchend');
    assert.equal(name(), 'one #1'); // not at once: a still tap's click lands first
    await settle();
    assert.equal(name(), 'pushed #1');

    // a new touch before that macrotask keeps holding; touchcancel lifts too
    await touch(scroller, 'touchstart', 1);
    await fire(() => setAppState(renamed('again')));
    await touch(scroller, 'touchend');
    await touch(scroller, 'touchstart', 1);
    await settle();
    assert.equal(name(), 'pushed #1');
    await touch(scroller, 'touchcancel');
    await settle();
    assert.equal(name(), 'again #1');
    assert.ok(c.querySelector('#screen-agents') === scroller, '#screen-agents is the same element');
  });
});

describe('Dashboard topbar', () => {
  async function bar(hash: string, state: AppState): Promise<HTMLElement> {
    setAppState(state);
    const t = dashboardTopbar(hash);
    const r = await render(<><div id="l">{t.left}</div><div id="t">{t.title}</div><div id="r">{t.right}</div></>);
    unmounts.push(r.unmount);
    return r.container;
  }

  it("names the account's orchestrator, and ← Home goes to it", async () => {
    const c = await bar('#/agents/personal', fresh());
    assert.equal(c.querySelector('#t')!.textContent, 'Agents· Personal');
    assert.equal(c.querySelector('#t .topbar-subtitle')!.textContent, '· Personal');
    const home = c.querySelector<HTMLElement>('#l .topbar-back')!;
    assert.deepEqual([home.textContent, home.getAttribute('aria-label')], ['← Home', 'Home']);
    await fire(() => home.click());
    assert.equal(location.hash, '#/home/personal');
  });

  it('the full list: ← Home to the one used last, running or not, else the first running, else the first', async () => {
    let c = await bar('#/agents', fresh());
    assert.equal(c.querySelector('#t')!.textContent, 'Agents');
    await fire(() => c.querySelector<HTMLElement>('#l .topbar-back')!.click());
    assert.equal(location.hash, '#/home/personal');
    localStorage.setItem('herdr_home', 'work'); // not running: its Home has Start
    location.hash = '#/agents';
    c = await bar('#/agents', fresh());
    await fire(() => c.querySelector<HTMLElement>('#l .topbar-back')!.click());
    assert.equal(location.hash, '#/home/work');
    localStorage.clear();
    const stopped = fresh();
    stopped.orchestrators[0].paneId = null;
    c = await bar('#/agents', stopped);
    location.hash = '#/agents';
    await fire(() => c.querySelector<HTMLElement>('#l .topbar-back')!.click());
    assert.equal(location.hash, '#/home/personal', 'none running: the first configured');
  });

  it('has no Start buttons: each orchestrator starts from its own Home', async () => {
    const stopped = fresh();
    stopped.orchestrators[0].paneId = null;
    const c = await show('#/agents', stopped);
    assert.equal(c.querySelector('.orch-start, .orch-start-btn'), null);
  });

  it('+ (New agent) and ⚙ (Settings)', async () => {
    const c = await bar('#/agents', fresh());
    const btns = [...c.querySelectorAll<HTMLElement>('#r button')];
    assert.deepEqual(btns.map((b) => [b.id, b.classList.contains('mantine-ActionIcon-root'), b.getAttribute('aria-label'), b.textContent]),
      [['btn-new-agent', true, 'New agent', '+'], ['btn-settings', true, 'Settings', '⚙']]);
    await fire(() => btns[1].click());
    assert.equal(location.hash, '#/settings');
  });
});
