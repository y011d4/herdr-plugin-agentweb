// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, getToasts } from '../src/notify.ts';
import { setAppState } from '../src/store.ts';
import { WIDE_QUERY } from '../src/theme.ts';
import { dueLabel, linkHost, localInput, snoozeChoices, splitTodos } from '../src/todos.ts';
import type { AppState, OrchestratorView, TodoItem } from '../src/types.ts';
import { needsYou, Todos } from '../src/ui/Todos.tsx';
import { state as recorded } from './contract.gen.ts';
import { fakeMedia, fire, render } from './render.ts';

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

  it("snooze's presets: in 1 and 3 hours (to the minute), this evening while an hour or more ahead, tomorrow morning", () => {
    const show = (now: number): string[] => snoozeChoices(now).map((c) => `${c.label} ${localInput(c.at)}`);
    assert.deepEqual(show(at('2026-11-27T12:00:20')), ['In 1 hour 2026-11-27T13:01', 'In 3 hours 2026-11-27T15:01',
      'This evening 2026-11-27T18:00', 'Tomorrow morning 2026-11-28T09:00']);
    const labels = (now: number): string[] => snoozeChoices(now).map((c) => c.label);
    assert.deepEqual(labels(at('2026-11-27T17:00:00')), ['In 1 hour', 'In 3 hours', 'This evening', 'Tomorrow morning'], 'an hour ahead: still');
    assert.deepEqual(labels(at('2026-11-27T17:01:00')), ['In 1 hour', 'In 3 hours', 'Tomorrow morning']);
    assert.deepEqual(show(at('2026-11-30T23:30:00')), ['In 1 hour 2026-12-01T00:30', 'In 3 hours 2026-12-01T02:30', 'Tomorrow morning 2026-12-01T09:00']);
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
  let reqs: { method: string; url: string; body?: string; answer: (status: number, body: unknown) => void }[];
  let unmount: () => Promise<void>;
  let container: HTMLElement;
  const home = (todos: TodoItem[]): OrchestratorView => ({ ...structuredClone(recorded.orchestrators[0]), todos });
  const show = async (o: OrchestratorView, now = NOW): Promise<void> => { ({ container, unmount } = await render(<Todos o={o} now={now} />)); };
  const row = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-todo="${id}"]`)!;
  const menu = (): HTMLElement | null => container.querySelector<HTMLElement>('[role="menu"]');
  const items = (): string[] => [...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((b) => b.querySelector('.mantine-Menu-itemLabel')!.textContent!);
  const rows = (): string[] => [...container.querySelectorAll<HTMLElement>('.home-todo')].map((r) => `${r.dataset.todo}:${r.textContent}`);

  beforeEach(() => {
    reqs = [];
    unmount = async () => {};
    vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
      reqs.push({ method: init.method ?? 'GET', url, body: init.body as string | undefined, answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
    }));
    clearToasts();
    setAppState(structuredClone(recorded));
  });
  afterEach(async () => { await unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });

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
    assert.deepEqual(rows(), ['a1b2c3:merge PR #119w-todogithub.com ↗⋮', '0a0b0c:run /login in sidedue today 09:00⋮']);
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
    assert.deepEqual(rows().slice(2), ['d4e5f6:delete ~/backup.tgztomorrow 09:00⋮']);
  });

  it("doesn't link a url that isn't http(s)", async () => {
    await show(home([item('a1b2c3', 'x', { url: 'javascript:alert(1)' })]));
    assert.equal(container.querySelector('.home-todo a'), null);
  });

  it("opens the worker's drawer by its herdr name (a phone's: a PC's opens it in herdr), not the item's menu", async () => {
    fakeMedia(WIDE_QUERY, false);
    await show(home([item('a1b2c3', 'merge it', { agent: 'w-review' })])); // p3's name in the recording
    location.hash = '#/home/personal';
    await fire(() => container.querySelector<HTMLElement>('[data-agent="w-review"]')!.click());
    assert.equal(location.hash, '#/pane/p3');
    assert.equal(menu(), null);
  });

  it('a tap on an item opens its menu: Mark done, Ask the orchestrator where the Home has a composer (off while its question is open), Dismiss', async () => {
    const o = home([item('a1b2c3', 'merge it')]);
    await show(o);
    assert.equal(menu(), null);
    await fire(() => row('a1b2c3').click());
    assert.deepEqual(items(), ['Mark done', 'Snooze…Remind me later', 'DismissNot needed: no follow-up']);
    await unmount();
    let asked = 0;
    ({ container, unmount } = await render(<Todos o={o} now={NOW} ask={() => { asked++; }} />));
    await fire(() => row('a1b2c3').click());
    assert.deepEqual(items(), ['Mark done', 'Snooze…Remind me later', 'Ask the orchestrator', 'DismissNot needed: no follow-up']);
    await fire(() => menu()!.querySelector<HTMLElement>('[data-action="todo-ask"]')!.click());
    assert.equal(asked, 1);
    assert.equal(menu(), null, 'closed by it');
    await unmount();
    o.headless = { ...structuredClone(recorded.orchestrators[0]).headless!, pending: { id: 'q', questions: [] } } as OrchestratorView['headless'];
    ({ container, unmount } = await render(<Todos o={o} now={NOW} ask={() => { asked++; }} />));
    await fire(() => row('a1b2c3').click());
    const ask = menu()!.querySelector<HTMLButtonElement>('[data-action="todo-ask"]')!;
    assert.deepEqual([ask.disabled, items()[2]], [true, 'Ask the orchestratorAnswer its question first']);
  });

  it('the keyboard: Enter or Space on an item opens its menu, the arrows move in it, Escape closes it and puts the focus back', async () => {
    await show(home([item('a1b2c3', 'merge it')]));
    const r = row('a1b2c3');
    assert.equal(r.tabIndex, 0);
    for (const key of ['Enter', ' ']) {
      r.focus();
      await fire(() => r.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
      assert.ok(menu(), key);
      await fire(() => menu()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
      assert.ok(document.activeElement === menu()!.querySelector('[data-action="todo-done"]'), `${key}: on Mark done`);
      // Mantine's Escape is the dropdown's own: sent from inside
      await fire(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      assert.equal(menu(), null, `${key}: Escape`);
      await fire(() => new Promise<void>((res) => { setTimeout(res, 30); })); // Mantine puts the focus back after 10 ms
      assert.ok(document.activeElement === r, `${key}: back on the item`);
    }
  });

  it('✓ ticks it off; a gone one is no error, a failure says so', async () => {
    await show(home([item('a1b2c3', 'merge it'), item('d4e5f6', 'log in')]));
    const tick = async (id: string): Promise<void> => {
      await fire(() => row(id).click());
      await fire(() => menu()!.querySelector<HTMLElement>('[data-action="todo-done"]')!.click());
    };
    await tick('a1b2c3');
    assert.deepEqual(reqs.map((r) => `${r.method} ${r.url}`), ['DELETE /api/orchestrators/personal/todos/a1b2c3']);
    assert.equal(row('a1b2c3').getAttribute('aria-busy'), 'true', 'busy until the State drops it');
    await fire(() => row('a1b2c3').click());
    assert.equal(menu(), null, 'no menu meanwhile');
    await fire(() => reqs[0].answer(404, { error: { code: 'not_found', message: 'no item' } }));
    assert.equal(getToasts().length, 0);
    await tick('d4e5f6');
    await fire(() => reqs[1].answer(500, { error: { code: 'error', message: 'could not save the to-do list: disk full' } }));
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`), ['Could not tick it off: could not save the to-do list: disk full']);
    assert.equal(row('d4e5f6').hasAttribute('aria-busy'), false, 'tappable again');
  });

  it('✕ dismisses it: the same DELETE with ?dismiss=1, never read as done; a failure says so', async () => {
    await show(home([item('a1b2c3', 'merge it'), item('d4e5f6', 'log in')]));
    const dismiss = async (id: string): Promise<void> => {
      await fire(() => row(id).click());
      await fire(() => menu()!.querySelector<HTMLElement>('[data-action="todo-dismiss"]')!.click());
    };
    await dismiss('a1b2c3');
    assert.deepEqual(reqs.map((r) => `${r.method} ${r.url}`), ['DELETE /api/orchestrators/personal/todos/a1b2c3?dismiss=1']);
    assert.equal(row('a1b2c3').getAttribute('aria-busy'), 'true', 'busy until the State drops it');
    await fire(() => reqs[0].answer(200, { ok: true }));
    await dismiss('d4e5f6');
    await fire(() => reqs[1].answer(500, { error: { code: 'error', message: 'could not save the to-do list: disk full' } }));
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`), ['Could not dismiss it: could not save the to-do list: disk full']);
    assert.equal(row('d4e5f6').hasAttribute('aria-busy'), false, 'tappable again');
  });

  it('Snooze… opens its panel under the item: a preset or a day and time of its own puts it off (PATCH {due}); one not ahead, or a failure, says so', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at('2026-11-27T12:00:00'));
    await show(home([item('a1b2c3', 'merge it'), item('d4e5f6', 'log in')]));
    const panel = (): HTMLElement | null => container.querySelector<HTMLElement>('[data-snooze="a1b2c3"]');
    const open = async (): Promise<void> => {
      await fire(() => row('a1b2c3').click());
      await fire(() => menu()!.querySelector<HTMLElement>('[data-action="todo-snooze"]')!.click());
    };
    await open();
    assert.equal(menu(), null, 'the menu closes');
    const presets = [...panel()!.querySelectorAll<HTMLButtonElement>('[data-snooze-at]')];
    assert.deepEqual(presets.map((b) => b.textContent), ['In 1 hour13:00', 'In 3 hours15:00', 'This evening18:00', 'Tomorrow morning09:00']);
    assert.equal(panel()!.querySelector<HTMLInputElement>('[data-snooze-input]')!.value, '2026-11-28T09:00');
    await fire(() => presets[1].click());
    assert.deepEqual(reqs.map((r) => `${r.method} ${r.url} ${r.body}`), [`PATCH /api/orchestrators/personal/todos/a1b2c3 {"due":${at('2026-11-27T15:00:00')}}`]);
    assert.ok(presets[1].disabled, 'busy');
    await fire(() => reqs[0].answer(200, { ok: true }));
    assert.equal(panel(), null, 'closed');
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`), ['Snoozed: Until today 15:00']);
    // its own day and time; one not ahead is refused here
    await open();
    const input = panel()!.querySelector<HTMLInputElement>('[data-snooze-input]')!;
    const at_ = panel()!.querySelector<HTMLElement>('[data-action="snooze-at"]')!;
    for (const v of ['2026-11-27T11:00', '']) {
      input.value = v;
      await fire(() => at_.click());
      assert.equal(panel()!.querySelector('[data-snooze-error]')?.textContent, 'Pick a time ahead.', v);
    }
    assert.equal(reqs.length, 1);
    input.value = '2026-11-29T20:30';
    await fire(() => at_.click());
    assert.equal(reqs[1].body, `{"due":${at('2026-11-29T20:30:00')}}`);
    await fire(() => reqs[1].answer(500, { error: { code: 'error', message: 'could not save the to-do list: disk full' } }));
    assert.equal(panel()!.querySelector('[data-snooze-error]')?.textContent, 'could not save the to-do list: disk full');
    assert.equal(at_.hasAttribute('disabled'), false, 'tappable again');
    await fire(() => panel()!.querySelector<HTMLElement>('[data-action="snooze-cancel"]')!.click());
    assert.equal(panel(), null, 'cancelled');
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
