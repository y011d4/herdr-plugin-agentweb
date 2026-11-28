// @vitest-environment happy-dom
// ui/HomePanel.tsx, a PC's Home panel (from 1280px, beside the Home): Needs you (its count), the orchestrator's question,
// the blocked agents as rows and the to-do list; then the other agents by urgency, and Open the list. An agent's row opens
// it in herdr on a PC, its ⋮ Open in herdr and Show here (Dashboard.tsx's AgentRow). The recorded State: personal (p4,
// running; its account p1 p3 p4) and work (stopped, its account unknown: every agent); agents p1 (working) p7 (unknown)
// p6 (blocked) p3 (done, herdr's name w-review).
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { draftKey, getQuote, setQuote } from '../src/drafts.ts';
import { clearToasts, getToasts } from '../src/notify.ts';
import { setAppState, store } from '../src/store.ts';
import { WIDE_QUERY } from '../src/theme.ts';
import { todoQuote } from '../src/transcript.ts';
import type { AppState, TodoItem } from '../src/types.ts';
import { HomePanel } from '../src/ui/HomePanel.tsx';
import { state as recorded } from './contract.gen.ts';
import { fakeMedia, fire, render } from './render.ts';

const fresh = (): AppState => structuredClone(recorded);
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const item = (id: string, text: string, due: number | null = null): TodoItem => ({ id, text, agent: null, url: null, due, createdAt: Date.now() - 60_000 });

let posts: string[];
let unmount: (() => Promise<void>) | null = null;
let c: HTMLElement;
async function show(name: string, state: AppState): Promise<void> {
  setAppState(state);
  const r = await render(<HomePanel name={name} />);
  unmount = r.unmount;
  c = r.container;
}
const ids = (sel: string): string[] => [...c.querySelectorAll<HTMLElement>(sel)].map((e) => e.dataset.paneId ?? e.dataset.todo!);
const head = (panel: string): string => c.querySelector(`[data-panel="${panel}"]`)!.firstElementChild!.textContent!;

beforeEach(() => {
  store.seenDone = {};
  posts = [];
  fakeMedia(WIDE_QUERY, true);
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    if (init.method === 'POST') posts.push(url);
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
  });
  location.hash = '#/home/personal';
});
afterEach(async () => {
  await unmount?.();
  unmount = null;
  setAppState(null);
  setQuote(draftKey('', 'personal'), '');
  clearToasts();
  vi.unstubAllGlobals();
});

describe('HomePanel', () => {
  it('shows what needs you (its blocked agents as rows, its to-do list), then its other agents by urgency, and its list', async () => {
    const s = fresh();
    s.workspaces[0].tabs[0].panes[0].agent!.status = 'blocked'; // p1
    s.orchestrators[0].todos = [item('t1', 'Merge the PR'), item('t2', 'Later on', Date.now() + 3_600_000)];
    await show('personal', s);
    assert.equal(c.querySelector('aside#home-panel')!.getAttribute('aria-label'), 'Personal: what needs you, and its agents');
    assert.equal(head('needs'), 'Needs you · 2'); // p1 and t1 (t2 is due later)
    assert.deepEqual(ids('[data-panel="needs"] .agent-row'), ['p1'], 'blocked: a row, not a chip');
    assert.deepEqual(ids('[data-panel="needs"] .home-todo'), ['t1'], 'the one due later under Later');
    assert.ok(c.querySelector('[data-panel="needs"] [data-action="todo-later"]'));
    assert.deepEqual(ids('[data-panel="agents"] .agent-row'), ['p3'], 'the rest: p1 is above, p4 is the orchestrator');
    assert.deepEqual([...c.querySelectorAll<HTMLElement>('[data-panel="agents"] > :first-child .status-counts [data-count]:not(.invisible)')]
      .map((e) => e.textContent), ['1 done'], 'its counts after the heading (a zero keeps its place, unseen)');
    assert.equal(c.querySelector('a.home-panel-list')!.getAttribute('href'), '#/agents/personal');
  });

  it('says so when nothing waits and there are no agents', async () => {
    const s = fresh();
    s.orchestrators[0].agents = ['p4'];
    await show('personal', s);
    assert.equal(head('needs'), 'Needs you');
    assert.equal(c.querySelector('[data-panel="needs"]')!.textContent, 'Needs youNothing waits on you.');
    assert.match(c.querySelector('[data-panel="agents"]')!.textContent!, /^AgentsNo agents\.Open the list/);
  });

  it("lists a stopped Home's: its account unknown, every agent; its items without Ask", async () => {
    const s = fresh();
    s.orchestrators[1].todos = [item('t3', 'Log in')];
    await show('work', s);
    assert.deepEqual(ids('[data-panel="needs"] .agent-row'), ['p6']);
    assert.deepEqual(ids('[data-panel="agents"] .agent-row'), ['p1', 'p3', 'p7'], 'working, done, then idle (p7 unknown)');
    await fire(() => c.querySelector<HTMLElement>('.home-todo')!.click());
    assert.ok(c.querySelector('[data-action="todo-done"]') && !c.querySelector('[data-action="todo-ask"]'));
  });

  it("Ask quotes an item in its running Home's composer, beside it: the Home stays", async () => {
    const s = fresh();
    s.orchestrators[0].todos = [item('t1', 'Merge the PR')];
    await show('personal', s);
    await fire(() => c.querySelector<HTMLElement>('.home-todo')!.click());
    await fire(() => c.querySelector<HTMLElement>('[data-action="todo-ask"]')!.click());
    assert.equal(getQuote(draftKey('', 'personal')), todoQuote(s.orchestrators[0].todos[0]));
    assert.equal(location.hash, '#/home/personal');
  });

  it("opens an agent in herdr on a click; its ⋮ has Open in herdr and Show here, its drawer", async () => {
    await show('personal', fresh());
    await fire(() => c.querySelector<HTMLElement>('.agent-row[data-pane-id="p3"]')!.click());
    await settle();
    assert.deepEqual(posts, ['/api/panes/p3/focus']);
    assert.deepEqual(getToasts().map((t) => t.title), ['Opened in herdr']);
    assert.equal(location.hash, '#/home/personal', 'no drawer');
    const more = c.querySelector<HTMLElement>('[data-agent-menu="p3"]')!;
    assert.equal(more.getAttribute('aria-label'), 'More for w-review');
    await fire(() => more.click());
    const menu = c.querySelector<HTMLElement>('[data-agent-more="p3"]')!;
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map((e) => e.textContent), ['Open in herdr', 'Show here']);
    await fire(() => menu.querySelector<HTMLElement>('[data-action="herdr"]')!.click());
    await settle();
    assert.deepEqual(posts, ['/api/panes/p3/focus', '/api/panes/p3/focus']);
    await fire(() => more.click());
    await fire(() => c.querySelector<HTMLElement>('[data-agent-more="p3"] [data-action="show"]')!.click());
    await settle();
    assert.equal(location.hash, '#/pane/p3');
    assert.equal(posts.length, 2, 'Show here: nothing sent');
  });
});
