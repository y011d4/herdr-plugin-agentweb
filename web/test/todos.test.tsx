// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, getToasts } from '../src/notify.ts';
import { setAppState } from '../src/store.ts';
import { dueLabel, linkHost, splitTodos } from '../src/todos.ts';
import type { AppState, OrchestratorView, TodoItem } from '../src/types.ts';
import { needsYou, Todos } from '../src/ui/Todos.tsx';
import { state as recorded } from './contract.gen.ts';
import { fire, render } from './render.ts';

const at = (d: string): number => new Date(d).getTime(); // local time, as the labels are
const NOW = at('2026-11-27T12:00:00');
const item = (id: string, text: string, rest: Partial<TodoItem> = {}): TodoItem =>
  ({ id, text, agent: null, url: null, due: null, createdAt: NOW - 60_000, ...rest });

describe('todos.ts', () => {
  it('splits the items to do now (oldest first) from the ones due later (soonest first)', () => {
    const items = [item('a', 'a'), item('b', 'b', { due: at('2026-11-28T09:00:00') }), item('c', 'c', { due: NOW }),
      item('d', 'd', { due: at('2026-11-27T18:00:00') })];
    const { now, later } = splitTodos(items, NOW);
    assert.deepEqual(now.map((i) => i.id), ['a', 'c'], 'come due at its time');
    assert.deepEqual(later.map((i) => i.id), ['d', 'b']);
  });

  it('shows a link only for http(s), by its host', () => {
    assert.equal(linkHost('https://github.com/y011d4/herdr-yoicks/pull/119'), 'github.com');
    assert.equal(linkHost('http://127.0.0.1:8390/x'), '127.0.0.1:8390');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://h/x', '/relative', 'not a url']) assert.equal(linkHost(bad), null, bad);
  });

  it('names the day of a due', () => {
    assert.deepEqual(dueLabel(at('2026-11-27T18:30:00'), NOW), { text: 'today 18:30', past: false });
    assert.deepEqual(dueLabel(at('2026-11-28T09:00:00'), NOW), { text: 'tomorrow 09:00', past: false });
    assert.deepEqual(dueLabel(at('2026-11-26T09:05:00'), NOW), { text: 'yesterday 09:05', past: true });
    assert.deepEqual(dueLabel(at('2026-12-03T09:00:00'), NOW), { text: '12/3 09:00', past: false });
    assert.deepEqual(dueLabel(NOW, NOW), { text: 'today 12:00', past: true });
  });
});

describe('Todos', () => {
  let reqs: { method: string; url: string; answer: (status: number, body: unknown) => void }[];
  let unmount: () => Promise<void>;
  let container: HTMLElement;
  const home = (todos: TodoItem[]): OrchestratorView => ({ ...structuredClone(recorded.orchestrators[0]), todos });
  const show = async (o: OrchestratorView, now = NOW): Promise<void> => { ({ container, unmount } = await render(<Todos o={o} now={now} />)); };
  const rows = (): string[] => [...container.querySelectorAll<HTMLElement>('.home-todo')].map((r) => `${r.dataset.todo}:${r.textContent}`);

  beforeEach(() => {
    reqs = [];
    unmount = async () => {};
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
      reqs.push({ method: init.method ?? 'GET', url, answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
    }));
    clearToasts();
    setAppState(structuredClone(recorded));
  });
  afterEach(async () => { await unmount(); vi.unstubAllGlobals(); });

  it('draws nothing without items', async () => {
    await show(home([]));
    assert.equal(container.querySelector('.home-todos'), null);
  });

  it('lists what to do now with its worker, its link by host and its due; the rest under Later', async () => {
    await show(home([
      item('a1b2c3', 'merge PR #119', { agent: 'w-todo', url: 'https://github.com/y011d4/herdr-yoicks/pull/119' }),
      item('d4e5f6', 'delete ~/backup.tgz', { due: at('2026-11-28T09:00:00') }),
      item('0a0b0c', 'run /login in side', { due: at('2026-11-27T09:00:00') }),
    ]));
    assert.deepEqual(rows(), ['a1b2c3:✓merge PR #119w-todogithub.com ↗', '0a0b0c:✓run /login in sidedue today 09:00']);
    const link = container.querySelector<HTMLAnchorElement>('[data-host="github.com"]')!;
    assert.equal(link.getAttribute('href'), 'https://github.com/y011d4/herdr-yoicks/pull/119');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(container.querySelector<HTMLElement>('[data-todo="0a0b0c"] [data-due]')!.dataset.due, 'past');
    // later: closed until tapped
    const later = container.querySelector<HTMLElement>('[data-action="todo-later"]')!;
    assert.equal(later.textContent, 'Later (1) ›');
    await fire(() => later.click());
    assert.equal(later.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(rows().slice(2), ['d4e5f6:✓delete ~/backup.tgztomorrow 09:00']);
  });

  it("doesn't link a url that isn't http(s)", async () => {
    await show(home([item('a1b2c3', 'x', { url: 'javascript:alert(1)' })]));
    assert.equal(container.querySelector('.home-todo a'), null);
  });

  it("opens the worker's drawer by its herdr name", async () => {
    await show(home([item('a1b2c3', 'merge it', { agent: 'w-review' })])); // p3's name in the recording
    location.hash = '#/home/personal';
    await fire(() => container.querySelector<HTMLElement>('[data-agent="w-review"]')!.click());
    assert.equal(location.hash, '#/pane/p3');
  });

  it('✓ ticks it off; a gone one is no error, a failure says so', async () => {
    await show(home([item('a1b2c3', 'merge it'), item('d4e5f6', 'log in')]));
    const tick = (id: string): Promise<void> => fire(() => container.querySelector<HTMLElement>(`[data-todo="${id}"] [data-action="todo-done"]`)!.click());
    await tick('a1b2c3');
    assert.deepEqual(reqs.map((r) => `${r.method} ${r.url}`), ['DELETE /api/orchestrators/personal/todos/a1b2c3']);
    assert.equal(container.querySelector('[data-todo="a1b2c3"] [data-action="todo-done"]')!.hasAttribute('data-loading'), true, 'busy until the State drops it');
    await fire(() => reqs[0].answer(404, { error: { code: 'not_found', message: 'no item' } }));
    assert.equal(getToasts().length, 0);
    await tick('d4e5f6');
    await fire(() => reqs[1].answer(500, { error: { code: 'error', message: 'could not save the to-do list: disk full' } }));
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`), ['Could not tick it off: could not save the to-do list: disk full']);
    assert.equal(container.querySelector('[data-todo="d4e5f6"] [data-action="todo-done"]')!.hasAttribute('data-loading'), false, 'tappable again');
  });

  it("dense (the sidebar's): two lines of text at most, all of it on hover; Ask on the line of its worker, link and due, else beside the text", async () => {
    const long = 'merge PR #119 once CI is green at /home/u/src/repo-wt-a-very-long-branch-name-that-wraps';
    const o = home([item('a1b2c3', long, { agent: 'w-todo' }), item('d4e5f6', 'log in')]);
    ({ container, unmount } = await render(<Todos o={o} now={NOW} ask={() => {}} dense />));
    const text = container.querySelector<HTMLElement>('[data-todo="a1b2c3"] .mantine-Text-root')!;
    assert.equal(text.dataset.lineClamp, 'true');
    assert.match(text.getAttribute('style')!, /--text-line-clamp: ?2/);
    assert.equal(text.title, long);
    const ask = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-todo="${id}"] [data-action="todo-ask"]`)!;
    assert.ok(ask('a1b2c3').parentElement === container.querySelector('[data-todo="a1b2c3"] [data-agent="w-todo"]')!.parentElement, 'on its worker\'s line');
    assert.ok(ask('d4e5f6').parentElement === container.querySelector('[data-todo="d4e5f6"]'), 'no such line: beside the text');
    await unmount();
    // the popover's: all of the text, Ask at the row's end
    ({ container, unmount } = await render(<Todos o={o} now={NOW} ask={() => {}} />));
    const full = container.querySelector<HTMLElement>('[data-todo="a1b2c3"] .mantine-Text-root')!;
    assert.ok(!full.hasAttribute('data-line-clamp') && !full.title);
    assert.ok(ask('a1b2c3').parentElement === container.querySelector('[data-todo="a1b2c3"]'));
  });

  it('counts what waits at a Home: its blocked agents, its orchestrator waiting itself, its items due now', () => {
    const s: AppState = structuredClone(recorded);
    s.orchestrators[0].agents!.push('p6'); // blocked
    const o = s.orchestrators[0]; // personal, a TUI one in p4 (idle)
    setAppState(s);
    assert.equal(needsYou(o, s, NOW), 1);
    o.todos = [item('a', 'now'), item('b', 'later', { due: NOW + 1 })];
    assert.equal(needsYou(o, s, NOW), 2);
    assert.equal(needsYou(o, s, NOW + 1), 3, 'come due');
    // a TUI orchestrator at a prompt in its pane
    s.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).find((p) => p.paneId === 'p4')!.agent!.status = 'blocked';
    setAppState(s);
    assert.equal(needsYou(o, s, NOW), 3);
    // a headless one with its question
    const hl: AppState = structuredClone(recorded);
    const h = hl.orchestrators[0];
    h.paneId = 'hl:personal';
    h.mode = 'headless';
    h.headless = { status: 'blocked', completionSeq: 0, pending: { id: 'q', questions: [] }, usage: null, warnings: [], model: '', activeModel: '', models: [], compact: null };
    setAppState(hl);
    assert.equal(needsYou(h, hl, NOW), 1);
  });
});
