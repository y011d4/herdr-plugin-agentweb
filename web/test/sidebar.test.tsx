// @vitest-environment happy-dom
// ui/Sidebar.tsx, the PC sidebar: on top a heading per Home over what waits there, then Other's blocked agents;
// under them the agents folded into one row, unfolding into a group per Home over its account's agents, then
// Other; its links, the one on show marked; holding still while a finger is down. The recorded State: personal
// (p4, running; its account p1 p3 p4) and work (stopped, its account unknown); agents p1 p7 p6 p3 in the list's
// order, p6 blocked (its account no Home's).
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { draftKey, getQuote, setQuote } from '../src/drafts.ts';
import { setAppState, store } from '../src/store.ts';
import { todoQuote } from '../src/transcript.ts';
import type { AppState, TodoItem } from '../src/types.ts';
import { Sidebar } from '../src/ui/Sidebar.tsx';
import { state as recorded } from './contract.gen.ts';
import { fire, render } from './render.ts';

const fresh = (): AppState => structuredClone(recorded);
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const item = (id: string, text: string): TodoItem => ({ id, text, agent: null, url: null, due: null, createdAt: Date.now() - 60_000 });
/** the recorded State with a to-do item at each Home */
const withTodos = (): AppState => {
  const s = fresh();
  s.orchestrators[0].todos = [item('t1', 'Merge the PR')];
  s.orchestrators[1].todos = [item('t2', 'Log in')];
  return s;
};

let unmount: (() => Promise<void>) | null = null;
async function show(hash: string, state: AppState | null): Promise<HTMLElement> {
  location.hash = hash;
  await settle();
  setAppState(state);
  const r = await render(<Sidebar />);
  unmount = r.unmount;
  return r.container;
}
const unfold = (c: HTMLElement): Promise<void> => fire(() => c.querySelector<HTMLElement>('.sidebar-all')!.click());
const homes = (c: HTMLElement): Array<[string, string[], string[]]> => [...c.querySelectorAll<HTMLElement>('section.sidebar-home')]
  .map((s) => [s.dataset.home!, [...s.querySelectorAll<HTMLElement>('.home-chip')].map((e) => e.dataset.paneId!),
    [...s.querySelectorAll<HTMLElement>('.home-todo')].map((e) => e.dataset.todo!)]);
const groups = (c: HTMLElement): Array<[string, string, string[]]> => [...c.querySelectorAll<HTMLElement>('section.sidebar-group')]
  .map((s) => [s.dataset.home!, s.querySelector('.sidebar-heading')!.textContent!, [...s.querySelectorAll<HTMLElement>('[data-sidebar-pane]')].map((e) => e.dataset.sidebarPane!)]);
const marked = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>('[aria-current="page"]')]
  .map((e) => e.dataset.home ?? e.dataset.sidebarPane ?? e.getAttribute('href')!);

beforeEach(() => { store.seenDone = {}; });
afterEach(async () => {
  await unmount?.();
  unmount = null;
  setAppState(null);
  setQuote(draftKey('', 'personal'), '');
  vi.useRealTimers();
});

describe('Sidebar', () => {
  it('shows on top a heading per Home, in config order, over what waits there, then the blocked agents no Home has', async () => {
    const c = await show('#/agents', withTodos());
    // work's account is unknown: it counts every blocked agent, as its Home does
    assert.deepEqual(homes(c), [['personal', [], ['t1']], ['work', ['p6'], ['t2']], ['', ['p6'], []]]);
    const personal = c.querySelector<HTMLAnchorElement>('a[data-home="personal"]')!;
    assert.equal(personal.textContent, 'Personal1'); // its count: t1
    assert.equal(personal.querySelector<HTMLElement>('.status-dot')!.dataset.status, 'idle'); // p4's status
    const work = c.querySelector<HTMLAnchorElement>('a[data-home="work"]')!;
    assert.equal(work.textContent, 'work2'); // no label: its name; p6 and t2
    assert.match(work.style.color, /dimmed/); // not running
    assert.equal(work.querySelector<HTMLElement>('.status-dot')!.dataset.status, 'stopped');
    assert.equal(c.querySelector('section.sidebar-home[data-home=""] .sidebar-heading')!.textContent, 'Other');
  });

  it('is a Home\'s heading alone while nothing waits there; no Other without a blocked agent there', async () => {
    const s = fresh();
    s.workspaces[1].tabs[0].panes[1].agent!.status = 'idle'; // p6
    const c = await show('#/agents', s);
    assert.deepEqual(homes(c), [['personal', [], []], ['work', [], []]]);
    for (const sec of c.querySelectorAll('section.sidebar-home')) assert.equal(sec.childElementCount, 1, 'its heading only');
  });

  it('folds the agents into one row with their count; a click unfolds them by Home, then Other, and folds them again', async () => {
    const c = await show('#/agents', fresh());
    const all = c.querySelector<HTMLButtonElement>('button.sidebar-all')!;
    assert.match(all.textContent!, /^All agents\s*4 ›$/);
    assert.equal(all.getAttribute('aria-expanded'), 'false');
    assert.ok(!c.querySelector('section.sidebar-group, [data-sidebar-pane]'), 'no agents while folded');
    await unfold(c);
    assert.equal(all.getAttribute('aria-expanded'), 'true');
    assert.match(all.textContent!, /^All agents\s*4 ▾$/);
    assert.deepEqual(groups(c), [['personal', 'Personal', ['p1', 'p3']], ['work', 'work', []], ['', 'Other', ['p7', 'p6']]]);
    assert.equal(c.querySelectorAll('a[data-home="personal"]').length, 1, "a Home's link is its heading on top only");
    assert.ok(!c.querySelector('[data-sidebar-pane="p4"]'), 'an orchestrator is a heading, never an agent');
    await unfold(c);
    assert.ok(!c.querySelector('section.sidebar-group'), 'folded again');
  });

  it('shows an agent as its card does: the name and its status (a seen done as idle), its purpose, the location and branch', async () => {
    store.seenDone = { p3: 4 };
    const c = await show('#/agents', fresh());
    await unfold(c);
    const p1 = c.querySelector<HTMLElement>('[data-sidebar-pane="p1"]')!;
    assert.equal(p1.textContent, 'one #1' + 'working' + 'repo' + 'main'); // the name and its status, the location, the branch
    assert.deepEqual(['.card-location', '.card-branch'].map((s) => p1.querySelector(s)!.textContent), ['repo', 'main']);
    assert.ok(!p1.querySelector('.card-purpose'), 'none given');
    const p3 = c.querySelector<HTMLElement>('[data-sidebar-pane="p3"]')!;
    assert.equal(p3.textContent, 'w-review' + 'idle' + 'レビューの指摘を直す' + 'repo-wt-feat › feat #1'); // herdr's name, its purpose
    assert.ok(p3.querySelector('.mantine-NavLink-label .status-badge') && !p3.querySelector('.mantine-NavLink-section'), 'the status on the name line: nothing beside the purpose');
    assert.equal(p3.querySelector<HTMLElement>('.card-purpose')!.title, 'レビューの指摘を直す', 'all of it on hover');
    assert.equal(p1.querySelector<HTMLElement>('.status-badge')!.dataset.status, 'working');
    assert.equal(c.querySelector('[data-sidebar-pane="p3"] .status-badge')!.textContent, 'idle');
    assert.equal(c.querySelector('[data-sidebar-pane="p6"] .status-badge')!.textContent, 'blocked');
  });

  it("links a Home's heading to its Home; marks the one on show", async () => {
    const c = await show('#/home/personal', fresh());
    assert.equal(c.querySelector('a[data-home="personal"]')!.getAttribute('href'), '#/home/personal');
    assert.equal(c.querySelector('a[data-home="work"]')!.getAttribute('href'), '#/home/work');
    assert.deepEqual(marked(c), ['personal']);
    location.hash = '#/agents';
    await settle();
    assert.deepEqual(marked(c), []);
  });

  it("opens a blocked agent's pane from its chip, and an agent's from its row, marked while it is shown", async () => {
    const c = await show('#/home/personal', fresh());
    await fire(() => c.querySelector<HTMLElement>('section.sidebar-home[data-home=""] .home-chip[data-pane-id="p6"]')!.click());
    await settle();
    assert.equal(location.hash, '#/pane/p6');
    location.hash = '#/home/personal';
    await settle();
    await unfold(c);
    await fire(() => c.querySelector<HTMLElement>('[data-sidebar-pane="p6"]')!.click());
    await settle();
    assert.equal(location.hash, '#/pane/p6');
    assert.deepEqual(marked(c), ['p6']);
    location.hash = '#/pane/%E0%A4%A'; // malformed: nothing marked, nothing thrown
    await settle();
    assert.deepEqual(marked(c), []);
  });

  it("Ask quotes an item in its running Home's composer and opens that Home; a stopped Home's items have none", async () => {
    const s = withTodos();
    const c = await show('#/agents', s);
    assert.ok(!c.querySelector('section.sidebar-home[data-home="work"] [data-action="todo-ask"]'), 'work is stopped');
    await fire(() => c.querySelector<HTMLElement>('section.sidebar-home[data-home="personal"] [data-action="todo-ask"]')!.click());
    await settle();
    assert.equal(getQuote(draftKey('', 'personal')), todoQuote(s.orchestrators[0].todos![0]));
    assert.equal(location.hash, '#/home/personal');
  });

  it('holds still while a finger is down; the latest State shows after the last one lifts, in the same #sidebar', async () => {
    const c = await show('#/agents', fresh());
    await unfold(c);
    const aside = c.querySelector('#sidebar')!;
    const touch = (type: string, fingers = 0) =>
      fire(() => aside.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: Array.from({ length: fingers }, () => ({ clientX: 0 }) as Touch) })));
    const title = (): string => c.querySelector('[data-sidebar-pane="p1"]')!.textContent!;
    const renamed = (label: string): AppState => { const s = fresh(); s.workspaces[0].tabs[0].label = label; return s; };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await touch('touchstart', 1);
    await fire(() => setAppState(renamed('pushed')));
    assert.match(title(), /^one #1/);
    await touch('touchend');
    assert.match(title(), /^one #1/); // not at once: a still tap's click lands first
    await act(async () => { vi.runAllTimers(); });
    assert.match(title(), /^pushed #1/);
    assert.ok(c.querySelector('#sidebar') === aside, '#sidebar is the same element');
  });
});
