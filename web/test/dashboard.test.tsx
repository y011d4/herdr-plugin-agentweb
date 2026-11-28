// @vitest-environment happy-dom
// ui/Dashboard.tsx: an agent as the app lists it (AgentRow: a Home's agents popover, its panel, the PC rail's Other), the
// State such a list draws while a finger is down (useHeldState), and the topbar's ⚙.
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { clearToasts } from '../src/notify.ts';
import { setAppState, store } from '../src/store.ts';
import { WIDE_QUERY } from '../src/theme.ts';
import type { AppState } from '../src/types.ts';
import { AgentRow, SettingsButton, agentCards, useHeldState } from '../src/ui/Dashboard.tsx';
import { state as recorded } from './contract.gen.ts';
import { fakeMedia, fire, render } from './render.ts';

const fresh = (): AppState => structuredClone(recorded);
/** Runs the (fake) timers due and lets React settle. */
const settle = (): Promise<void> => act(async () => { vi.runAllTimers(); });

/** Every agent's row, as a list of them draws it: the held State, keyed by pane. */
function Rows() {
  const [state, hold] = useHeldState();
  return <div id="rows" {...hold}>{agentCards(state).map((c) => <AgentRow key={c.pane.paneId} card={c} />)}</div>;
}

let unmounts: Array<() => Promise<void>>;
async function show(state: AppState | null): Promise<HTMLElement> {
  setAppState(state);
  const r = await render(<Rows />);
  unmounts.push(r.unmount);
  return r.container;
}
const ids = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>('.agent-row')].map((e) => e.dataset.paneId!);

beforeEach(() => {
  unmounts = [];
  location.hash = '#/home/personal';
  store.seenDone = {};
  clearToasts();
  localStorage.clear();
  fakeMedia(WIDE_QUERY, false);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const u of unmounts) await u();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AgentRow', () => {
  it("opens its agent on a click (a phone's: its drawer)", async () => {
    const c = await show(fresh());
    await fire(() => c.querySelector<HTMLElement>('.agent-row[data-pane-id="p7"]')!.click());
    assert.equal(location.hash, '#/pane/p7');
  });

  it("names its agent by herdr's name, else by its tab; under it its purpose; last, the location its name doesn't say and the branch", async () => {
    const s = fresh();
    const tab = s.workspaces[0].tabs.find((t) => t.panes.some((p) => p.paneId === 'p7'))!;
    tab.label = 'fix-auth';
    tab.panes.find((p) => p.paneId === 'p7')!.agent!.herdrName = 'fix-auth'; // agent start's tab is labelled by the name
    s.purposes.p7 = 'ログインを直す';
    const c = await show(s);
    const row = (id: string): Array<string | undefined> => ['.mantine-NavLink-label .truncate', '.card-purpose', '.card-location', '.card-branch']
      .map((sel) => c.querySelector(`.agent-row[data-pane-id="${id}"] ${sel}`)?.textContent ?? undefined);
    assert.deepEqual(row('p3'), ['w-review', 'レビューの指摘を直す', 'repo-wt-feat › feat #1', undefined]); // detached: no branch
    assert.deepEqual(row('p7'), ['fix-auth', 'ログインを直す', 'repo', 'main']);
    assert.equal(c.querySelector<HTMLElement>('.agent-row[data-pane-id="p7"] .card-purpose')!.title, 'ログインを直す', 'all of it on hover');
    delete s.purposes.p3;
    delete s.purposes.p7;
    await act(async () => setAppState(structuredClone(s)));
    assert.deepEqual(row('p3'), ['w-review', undefined, 'repo-wt-feat › feat #1', undefined]);
    assert.deepEqual(row('p7'), ['fix-auth', undefined, 'repo', 'main']);
    assert.deepEqual(row('p6'), ['feat #2', undefined, 'repo-wt-feat', undefined]); // no name: the tab
    assert.deepEqual(row('p1'), ['one #1', undefined, 'repo', 'main']);
  });

  it('lists every agent but the orchestrators; for an orchestrator, only its account (all when unknown)', async () => {
    assert.deepEqual(ids(await show(fresh())).sort(), ['p1', 'p3', 'p6', 'p7']);
    const s = fresh();
    assert.deepEqual(agentCards(s, s.orchestrators[0]).map((c) => c.pane.paneId).sort(), ['p1', 'p3']);
    assert.deepEqual(agentCards(s, s.orchestrators[1]).map((c) => c.pane.paneId).sort(), ['p1', 'p3', 'p6', 'p7']); // work's: unknown
  });
});

describe('A list of rows under state pushes', () => {
  const touch = (el: Element, type: string, fingers = 0) =>
    fire(() => el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: Array.from({ length: fingers }, () => ({ clientX: 0 }) as Touch) })));
  const renamed = (label: string): AppState => { const s = fresh(); s.workspaces[0].tabs[0].label = label; return s; };
  const name = (c: HTMLElement) => c.querySelector('.agent-row[data-pane-id="p1"] .mantine-NavLink-label .truncate')!.textContent;

  it('updates in place: each row (keyed by pane) stays the same node, also when the order changes', async () => {
    const c = await show(fresh());
    const row = c.querySelector('.agent-row[data-pane-id="p1"]');
    assert.equal(ids(c)[0], 'p1');
    const s = renamed('pushed');
    s.workspaces[0].tabs[0].panes[0].agent!.stateChangeSeq = 1; // now the oldest change: last
    await fire(() => setAppState(s));
    assert.equal(ids(c).at(-1), 'p1');
    assert.ok(c.querySelector('.agent-row[data-pane-id="p1"]') === row, 'the p1 row is the same element');
    assert.equal(name(c), 'pushed #1'); // the tab's 2nd agent is the orchestrator
  });

  it('holds while a finger is down; the latest State shows on the macrotask after the last one lifts', async () => {
    const c = await show(fresh());
    const list = c.querySelector('#rows')!;
    // Fake, so lift's setTimeout runs only in settle(): `await fire()` (React's act) itself waits a
    // macrotask (setImmediate), which a real setTimeout(0) can beat under load.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await touch(list, 'touchstart', 1);
    await fire(() => setAppState(renamed('pushed')));
    assert.equal(name(c), 'one #1');
    await touch(list, 'touchend', 1); // another finger is still down
    await settle();
    assert.equal(name(c), 'one #1');
    await touch(list, 'touchend');
    assert.equal(name(c), 'one #1'); // not at once: a still tap's click lands first
    await settle();
    assert.equal(name(c), 'pushed #1');

    // a new touch before that macrotask keeps holding; touchcancel lifts too
    await touch(list, 'touchstart', 1);
    await fire(() => setAppState(renamed('again')));
    await touch(list, 'touchend');
    await touch(list, 'touchstart', 1);
    await settle();
    assert.equal(name(c), 'pushed #1');
    await touch(list, 'touchcancel');
    await settle();
    assert.equal(name(c), 'again #1');
  });
});

describe('SettingsButton', () => {
  it("⚙ in a topbar on a phone, the sidebar's on a PC", async () => {
    const setWide = fakeMedia(WIDE_QUERY, false);
    const r = await render(<><div id="bar"><SettingsButton /></div><div id="side"><SettingsButton sidebar /></div></>);
    unmounts.push(r.unmount);
    const c = r.container;
    const btns = [...c.querySelectorAll<HTMLElement>('#bar button')];
    assert.deepEqual(btns.map((b) => [b.id, b.classList.contains('mantine-ActionIcon-root'), b.getAttribute('aria-label'), b.textContent]),
      [['btn-settings', true, 'Settings', '⚙']]);
    assert.equal(c.querySelector('#side')!.innerHTML, '');
    await fire(() => btns[0].click());
    assert.equal(location.hash, '#/settings');
    await setWide(true);
    assert.equal(c.querySelector('#bar')!.innerHTML, '');
    assert.ok(c.querySelector('#side #btn-settings'));
  });
});
