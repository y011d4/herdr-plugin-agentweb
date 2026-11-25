// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { dashboardCards } from '../src/dashboard-group.ts';
import { clearToasts, getToasts } from '../src/notify.ts';
import { setAppState, setStartingHome, store } from '../src/store.ts';
import type { AppState } from '../src/types.ts';
import { Dashboard, dashboardTopbar } from '../src/ui/Dashboard.tsx';
import { state as recorded } from './contract.gen.ts';
import { renderCard } from './legacy-card.ts';
import { fire, render } from './render.ts';

const fresh = (): AppState => structuredClone(recorded);
const SINCE = recorded.workspaces[0].tabs[0].panes[0].agent!.sinceUnixMs; // every recorded agent's
/** Lets the timers and React settle. */
const settle = (): Promise<void> => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

/** Every element of a card in document order: tag, class, attributes and text. Whitespace-only
 *  text (the legacy template's indentation, inside flex rows: never rendered) is left out. */
function shape(card: Element): string[] {
  const text = (n: Node): string => (n.nodeType === Node.TEXT_NODE ? (n.nodeValue!.trim() ? n.nodeValue! : '') : [...n.childNodes].map(text).join(''));
  return [card, ...card.querySelectorAll('*')].map((el) =>
    `${el.tagName} .${el.className} [${['data-pane-id', 'role', 'tabindex'].map((a) => el.getAttribute(a)).join(',')}] ${text(el)}`);
}

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
  setStartingHome(null);
  clearToasts();
  localStorage.clear();
});
afterEach(async () => {
  for (const u of unmounts) await u();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Dashboard cards', () => {
  // The recorded State, and one that reaches the rest of the card: a message, a pane title, a tab
  // without a label, no time, a branch, HTML in the text; at each relative-time unit, a seen done.
  const variant = (): AppState => {
    const s = fresh();
    const [repo, feat] = s.workspaces;
    repo.worktree!.branch = 'feat/<b>&"x"';
    repo.tabs[0].panes[0].agent!.sinceUnixMs = 0;
    repo.tabs[1].label = '';
    repo.tabs[1].panes[1].title = 'vim <x>';
    feat.tabs[0].panes[1].agent!.message = 'needs <you> & "me"';
    return s;
  };
  const cases: Array<[string, AppState, Record<string, number>, number]> = [
    ['recorded, just now', fresh(), {}, SINCE + 3_000],
    ['variant, seconds, done seen', variant(), { p3: 4 }, SINCE + 42_000],
    ['variant, minutes', variant(), {}, SINCE + 5 * 60_000],
    ['variant, hours', variant(), { p3: 3 }, SINCE + 3 * 3_600_000],
  ];
  for (const [name, state, seen, now] of cases) {
    it(`renders each card as the legacy renderCard did (${name})`, async () => {
      vi.spyOn(Date, 'now').mockReturnValue(now);
      store.seenDone = seen;
      const oracle = document.createElement('div');
      oracle.innerHTML = dashboardCards(state.workspaces, state.orchestrators.map((o) => o.paneId)).map(renderCard).join('');
      const want = [...oracle.querySelectorAll('.agent-card')].map(shape);
      const got = [...(await show('#/agents', state)).querySelectorAll('.agent-card')].map(shape);
      assert.equal(want.length, 4);
      assert.deepEqual(got, want);
    });
  }

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
    assert.ok(c.querySelector('#screen-agents .loading-spinner'));
    await fire(() => setAppState(fresh()));
    assert.equal(c.querySelector<HTMLElement>('#screen-agents')!.dataset.ready, '1');
  });

  it("Start: POSTs, the button shows it's starting; a failure says so and frees it", async () => {
    let status = 200;
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      posts.push(`${init.method} ${url}`);
      return new Response(JSON.stringify(status === 200 ? { paneId: 'p9' } : { error: { code: 'already_running', message: 'it runs' } }), { status });
    });
    const c = await show('#/agents', fresh());
    const btn = () => c.querySelector<HTMLButtonElement>('.orch-start .orch-start-btn[data-orch="work"]')!;
    assert.equal(c.querySelector('.orch-start-label')!.textContent, 'Start');
    assert.equal(c.querySelectorAll('.orch-start-btn').length, 1); // personal runs
    assert.deepEqual([btn().disabled, btn().textContent], [false, 'work']); // no label: the name
    await fire(() => btn().click());
    await settle();
    assert.deepEqual(posts, ['POST /api/orchestrators/work/start']);
    assert.deepEqual([btn().disabled, btn().textContent, store.startingHome], [true, 'work …', 'work']);

    setStartingHome(null);
    status = 409;
    await settle();
    await fire(() => btn().click());
    await settle();
    assert.deepEqual([btn().disabled, btn().textContent, store.startingHome], [false, 'work', null]);
    assert.deepEqual(getToasts().map((t) => `${t.title}: ${t.body}`), ['Could not start the orchestrator: it runs']);
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

  it('the full list: ← Home to the one used last while it runs, else the first running; none without one', async () => {
    let c = await bar('#/agents', fresh());
    assert.equal(c.querySelector('#t')!.textContent, 'Agents');
    await fire(() => c.querySelector<HTMLElement>('#l .topbar-back')!.click());
    assert.equal(location.hash, '#/home/personal');
    localStorage.setItem('herdr_home', 'work'); // not running: the first running one
    location.hash = '#/agents';
    await fire(() => c.querySelector<HTMLElement>('#l .topbar-back')!.click());
    assert.equal(location.hash, '#/home/personal');
    const stopped = fresh();
    stopped.orchestrators[0].paneId = null;
    c = await bar('#/agents', stopped);
    assert.equal(c.querySelector('#l')!.children.length, 0);
  });

  it('+ (New agent) and ⚙ (Settings)', async () => {
    const c = await bar('#/agents', fresh());
    const btns = [...c.querySelectorAll<HTMLElement>('#r button')];
    assert.deepEqual(btns.map((b) => [b.id, b.className, b.getAttribute('aria-label'), b.textContent]),
      [['btn-new-agent', 'topbar-action', 'New agent', '+'], ['btn-settings', 'topbar-action', 'Settings', '⚙']]);
    await fire(() => btns[1].click());
    assert.equal(location.hash, '#/settings');
  });
});
