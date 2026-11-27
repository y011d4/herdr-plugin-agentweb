// @vitest-environment happy-dom
// ui/Sidebar.tsx, the PC sidebar: a heading per Home over its account's agents, then Other; its links,
// the one on show marked; holding still while a finger is down. The recorded State: personal (p4,
// running; its account p1 p3 p4) and work (stopped, its account unknown); agents p1 p7 p6 p3 in the
// list's order.
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { setAppState, store } from '../src/store.ts';
import type { AppState } from '../src/types.ts';
import { Sidebar } from '../src/ui/Sidebar.tsx';
import { state as recorded } from './contract.gen.ts';
import { fire, render } from './render.ts';

const fresh = (): AppState => structuredClone(recorded);
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

let unmount: (() => Promise<void>) | null = null;
async function show(hash: string, state: AppState | null): Promise<HTMLElement> {
  location.hash = hash;
  await settle();
  setAppState(state);
  const r = await render(<Sidebar />);
  unmount = r.unmount;
  return r.container;
}
const groups = (c: HTMLElement): Array<[string, string[]]> => [...c.querySelectorAll<HTMLElement>('section.sidebar-group')]
  .map((s) => [s.dataset.home!, [...s.querySelectorAll<HTMLElement>('[data-sidebar-pane]')].map((e) => e.dataset.sidebarPane!)]);
const marked = (c: HTMLElement): string[] => [...c.querySelectorAll<HTMLElement>('[aria-current="page"]')]
  .map((e) => e.dataset.home ?? e.dataset.sidebarPane ?? e.getAttribute('href')!);

beforeEach(() => { store.seenDone = {}; });
afterEach(async () => {
  await unmount?.();
  unmount = null;
  setAppState(null);
  vi.useRealTimers();
});

describe('Sidebar', () => {
  it("has a heading per Home, in config order, over its account's agents in the list's order, then Other", async () => {
    const c = await show('#/agents', fresh());
    assert.deepEqual(groups(c), [['personal', ['p1', 'p3']], ['work', []], ['', ['p7', 'p6']]]);
    const personal = c.querySelector<HTMLAnchorElement>('a[data-home="personal"]')!;
    assert.equal(personal.textContent, 'Personal');
    assert.equal(personal.querySelector('.home-dot')!.className, 'home-dot idle'); // p4's status
    const work = c.querySelector<HTMLAnchorElement>('a[data-home="work"]')!;
    assert.equal(work.textContent, 'work'); // no label: its name
    assert.ok(work.classList.contains('stopped'));
    assert.equal(work.querySelector('.home-dot')!.className, 'home-dot stopped');
    assert.equal(c.querySelector('section[data-home=""] .sidebar-heading')!.textContent, 'Other');
    assert.ok(!c.querySelector('[data-sidebar-pane="p4"]'), 'an orchestrator is a heading, never an agent');
  });

  it('shows an agent as its card does: the title and branch, the workspace, its status (a seen done as idle)', async () => {
    store.seenDone = { p3: 4 };
    const c = await show('#/agents', fresh());
    const p1 = c.querySelector<HTMLElement>('[data-sidebar-pane="p1"]')!;
    assert.equal(p1.textContent, 'one #1 main' + 'repo' + 'working'); // label (title, branch), workspace, status
    assert.equal(p1.querySelector('.card-branch')!.textContent, ' main');
    assert.equal(p1.querySelector('.status-badge')!.className, 'status-badge working');
    assert.equal(c.querySelector('[data-sidebar-pane="p3"] .status-badge')!.textContent, 'idle');
    assert.equal(c.querySelector('[data-sidebar-pane="p6"] .status-badge')!.textContent, 'blocked');
  });

  it("links a Home's heading to its Home and All agents (with the count) to the list; marks the one on show", async () => {
    const c = await show('#/home/personal', fresh());
    assert.equal(c.querySelector('a[data-home="personal"]')!.getAttribute('href'), '#/home/personal');
    assert.equal(c.querySelector('a[data-home="work"]')!.getAttribute('href'), '#/home/work');
    const all = c.querySelector<HTMLAnchorElement>('a.sidebar-all')!;
    assert.equal(all.getAttribute('href'), '#/agents');
    assert.match(all.textContent!, /^All agents\s*4$/);
    assert.deepEqual(marked(c), ['personal']);
    location.hash = '#/agents';
    await settle();
    assert.deepEqual(marked(c), ['#/agents']);
  });

  it("opens an agent's pane and marks it while it is shown", async () => {
    const c = await show('#/home/personal', fresh());
    await fire(() => c.querySelector<HTMLElement>('[data-sidebar-pane="p6"]')!.click());
    await settle();
    assert.equal(location.hash, '#/pane/p6');
    assert.deepEqual(marked(c), ['p6']);
    location.hash = '#/pane/%E0%A4%A'; // malformed: nothing marked, nothing thrown
    await settle();
    assert.deepEqual(marked(c), []);
  });

  it('holds still while a finger is down; the latest State shows after the last one lifts, in the same #sidebar', async () => {
    const c = await show('#/agents', fresh());
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
