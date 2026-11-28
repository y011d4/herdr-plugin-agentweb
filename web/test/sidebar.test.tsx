// @vitest-environment happy-dom
// ui/Sidebar.tsx, the PC's rail of Homes: at its top the app's name, the dot it is given and ⚙; a row per Home in config
// order (its dot, its name, what waits there as a count, under them its agents' counts), the one on show marked; Other's
// blocked agents; All agents at the bottom, a link to the list; holding still while a finger is down. The recorded
// State: personal (p4, running; its account p1 p3 p4) and work (stopped, its account unknown: every agent); agents p1
// (working) p7 (unknown) p6 (blocked, its account no Home's) p3 (done).
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { setAppState, store } from '../src/store.ts';
import { WIDE_QUERY } from '../src/theme.ts';
import type { AppState, TodoItem } from '../src/types.ts';
import { Sidebar } from '../src/ui/Sidebar.tsx';
import { state as recorded } from './contract.gen.ts';
import { fakeMedia, fire, render } from './render.ts';

const fresh = (): AppState => structuredClone(recorded);
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const item = (id: string, text: string): TodoItem => ({ id, text, agent: null, url: null, due: null, createdAt: Date.now() - 60_000 });

let unmount: (() => Promise<void>) | null = null;
async function show(hash: string, state: AppState | null): Promise<HTMLElement> {
  location.hash = hash;
  await settle();
  setAppState(state);
  const r = await render(<Sidebar dot={<div id="conn-dot" />} />);
  unmount = r.unmount;
  return r.container;
}
/** each Home's row: its name, its dot's status, its count, its agents' counts (working, done, idle; a zero dimmed: 0-) */
const rows = (c: HTMLElement): Array<[string, string, string, string]> => [...c.querySelectorAll<HTMLAnchorElement>('a.sidebar-home')]
  .map((a) => [a.dataset.home!, a.querySelector<HTMLElement>('.status-dot')!.dataset.status!, a.querySelector('.home-needs')?.textContent ?? '',
    [...a.querySelectorAll<HTMLElement>('.status-counts [data-count]')]
      .map((e) => e.textContent!.trim().split(' ')[0] + (e.classList.contains('opacity-40') ? '-' : '')).join(' ')]);
const marked = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>('[aria-current="page"]')]
  .map((e) => e.dataset.home ?? e.getAttribute('href')!);

beforeEach(() => {
  store.seenDone = {};
  fakeMedia(WIDE_QUERY, true); // a PC: ⚙ is the rail's
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
  setAppState(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Sidebar', () => {
  it("has at its top the app's name, the dot it is given and ⚙", async () => {
    const c = await show('#/agents', fresh());
    const top = c.querySelector('#sidebar')!.firstElementChild!;
    assert.ok(top.textContent!.startsWith('Yoicks') && top.querySelector('#conn-dot') && top.querySelector('#btn-settings'));
    await fire(() => top.querySelector<HTMLElement>('#btn-settings')!.click());
    assert.equal(location.hash, '#/settings');
  });

  it('has a row per Home in config order: its dot, its name, what waits there, and under them its agents as counts', async () => {
    const s = fresh();
    s.orchestrators[0].todos = [item('t1', 'Merge the PR')];
    const c = await show('#/agents', s);
    // personal: p1 working, p3 done, t1 due; work's account is unknown: every agent, p6 blocked (its count), p7 unknown (idle)
    assert.deepEqual(rows(c), [['personal', 'idle', '1', '1 1 0-'], ['work', 'stopped', '1', '1 1 1']]);
    const personal = c.querySelector<HTMLAnchorElement>('a[data-home="personal"]')!;
    assert.equal(personal.getAttribute('href'), '#/home/personal');
    assert.equal(personal.querySelector('.mantine-NavLink-label')!.textContent, 'Personal');
    const work = c.querySelector<HTMLAnchorElement>('a[data-home="work"]')!;
    assert.equal(work.querySelector('.mantine-NavLink-label')!.textContent, 'work', 'no label: its name');
    assert.match(work.style.color, /dimmed/, 'not running');
    assert.ok(!c.querySelector('.home-todo, .agent-row'), 'neither what waits there nor the agents: those are its Home\'s');
  });

  it('has zeros under a Home without agents, as tall as the others, and no count on it while nothing waits there', async () => {
    const s = fresh();
    s.orchestrators[1].agents = []; // work: none
    const c = await show('#/agents', s);
    assert.deepEqual(rows(c), [['personal', 'idle', '', '1 1 0-'], ['work', 'stopped', '', '0- 0- 0-']]);
  });

  it('marks the Home on show; All agents, at the bottom, links the list and is marked on it', async () => {
    const c = await show('#/home/personal', fresh());
    assert.deepEqual(marked(c), ['personal']);
    const all = c.querySelector<HTMLAnchorElement>('a.sidebar-all')!;
    assert.equal(all.getAttribute('href'), '#/agents');
    assert.match(all.textContent!, /^All agents\s*4 ›$/);
    assert.ok(c.querySelector('#sidebar')!.lastElementChild!.contains(all), 'last');
    location.hash = '#/agents';
    await settle();
    assert.deepEqual(marked(c), ['#/agents']);
    location.hash = '#/home/work';
    await settle();
    assert.deepEqual(marked(c), ['work']);
  });

  it("lists under Other the blocked agents no Home's account lists, as chips; none without them", async () => {
    const c = await show('#/home/personal', fresh());
    const other = c.querySelector<HTMLElement>('section.sidebar-other')!;
    assert.equal(other.querySelector('.sidebar-heading')!.textContent, 'Other');
    assert.deepEqual([...other.querySelectorAll<HTMLElement>('.home-chip')].map((e) => e.dataset.paneId), ['p6']);
    await unmount!();
    const s = fresh();
    s.workspaces[1].tabs[0].panes[1].agent!.status = 'idle'; // p6
    const c2 = await show('#/home/personal', s);
    assert.ok(!c2.querySelector('section.sidebar-other'));
  });

  it('holds still while a finger is down; the latest State shows after the last one lifts, in the same #sidebar', async () => {
    const c = await show('#/agents', fresh());
    const aside = c.querySelector('#sidebar')!;
    const touch = (type: string, fingers = 0) =>
      fire(() => aside.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: Array.from({ length: fingers }, () => ({ clientX: 0 }) as Touch) })));
    const label = (): string => c.querySelector('a[data-home="personal"] .mantine-NavLink-label')!.textContent!;
    const renamed = (l: string): AppState => { const s = fresh(); s.orchestrators[0].label = l; return s; };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await touch('touchstart', 1);
    await fire(() => setAppState(renamed('Pushed')));
    assert.equal(label(), 'Personal');
    await touch('touchend');
    assert.equal(label(), 'Personal'); // not at once: a still tap's click lands first
    await act(async () => { vi.runAllTimers(); });
    assert.equal(label(), 'Pushed');
    assert.ok(c.querySelector('#sidebar') === aside, '#sidebar is the same element');
  });
});
