// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { clearToasts, getToasts } from '../src/notify.ts';
import { keptTasks, setAppState } from '../src/store.ts';
import { confirmModal, Modals, openAgentMenu, openNewAgent } from '../src/ui/Modals.tsx';
import { agentStart, errors, profiles, rename, state } from './contract.gen.ts';
import { fire, render } from './render.ts';

// The bridge, answering with the wire recordings (contract.gen.ts); every request is logged.
let reqs: Array<{ method: string; url: string; body: unknown }>;
function bridge(routes: Record<string, { status?: number; body: unknown }>): void {
  reqs = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    reqs.push({ method, url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const r = routes[`${method} ${url}`];
    if (!r) throw new Error(`unexpected ${method} ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const open = (): boolean => !!document.querySelector('.modal-overlay');
/** Lets the requests and React settle. */
const settle = (): Promise<void> => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
/** Types into a React-controlled field (the native setter, so React sees the change). */
function type(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  return fire(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const toastsShown = () => getToasts().map((t) => `${t.title}: ${t.body}`);

let unmount: () => Promise<void>;
beforeEach(async () => {
  clearToasts();
  location.hash = '';
  ({ unmount } = await render(<Modals />));
});
afterEach(async () => {
  await fire(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); // a modal left open
  await unmount();
  vi.unstubAllGlobals();
});

describe('Confirm', () => {
  it('resolves true on its button, false on Cancel, Escape or the backdrop; a tap inside keeps it', async () => {
    let p = confirmModal('Stop agent?', 'Closes the pane.', 'Stop', true);
    await settle();
    assert.equal($('.modal-title').textContent, 'Stop agent?');
    assert.equal($('#cf-ok').className, 'btn-primary danger');
    assert.equal($('#cf-ok').textContent, 'Stop');
    await fire(() => $('.modal-message').click());
    assert.ok(open());
    await fire(() => $('#cf-ok').click());
    assert.equal(await p, true);
    assert.ok(!open());

    for (const dismiss of [() => $('#cf-cancel').click(), () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
      () => $('.modal-overlay').click()]) {
      p = confirmModal('Clear agent?', 'm', 'Clear', false);
      await settle();
      assert.equal($('#cf-ok').className, 'btn-primary');
      await fire(dismiss);
      assert.equal(await p, false);
      assert.ok(!open());
    }
  });

  it('another modal opening resolves it false', async () => {
    const p = confirmModal('a', 'b', 'OK', false);
    await settle();
    void confirmModal('c', 'd', 'OK', false);
    assert.equal(await p, false);
    await settle();
    assert.equal($('.modal-title').textContent, 'c');
    await fire(() => $('#cf-cancel').click());
  });
});

describe('Agent actions and Rename', () => {
  const on = () => ({ clear: vi.fn(), stop: vi.fn(), renamed: vi.fn() });

  it('Clear and Stop close the menu and hand over', async () => {
    for (const [id, key] of [['#am-clear', 'clear'], ['#am-stop', 'stop']] as const) {
      const cb = on();
      await fire(() => openAgentMenu('p1', 'claude', cb));
      await fire(() => $(id).click());
      assert.ok(!open());
      assert.equal(cb[key].mock.calls.length, 1);
      assert.equal(cb.clear.mock.calls.length + cb.stop.mock.calls.length + cb.renamed.mock.calls.length, 1);
    }
  });

  it('renames: the current name selected, a name required, then the stored name toasted and the header refreshed', async () => {
    bridge({ 'POST /api/panes/p%2F1/rename': { body: rename[0] } });
    const cb = on();
    await fire(() => openAgentMenu('p/1', 'claude', cb));
    await fire(() => $('#am-rename').click());
    const input = $<HTMLInputElement>('#rn-name');
    assert.equal(input.value, 'claude');
    assert.equal(document.activeElement, input);

    await type(input, '  ');
    await fire(() => $('#rn-save').click());
    assert.equal($('#rn-error').textContent, 'Name is required.');
    assert.equal(reqs.length, 0);

    await type(input, ' Renamed One ');
    await fire(() => $('#rn-save').click());
    await settle();
    assert.deepEqual(reqs, [{ method: 'POST', url: '/api/panes/p%2F1/rename', body: { name: 'Renamed One' } }]);
    assert.ok(!open());
    assert.deepEqual(toastsShown(), ['Renamed: Agent renamed to renamed-one']);
    assert.equal(cb.renamed.mock.calls.length, 1);
  });

  it('a failed rename shows the error and can be saved again', async () => {
    bridge({ 'POST /api/panes/p1/rename': { status: 400, body: errors[0] } });
    const cb = on();
    await fire(() => openAgentMenu('p1', 'claude', cb));
    await fire(() => $('#am-rename').click());
    await fire(() => $('#rn-save').click());
    await settle();
    assert.equal($('#rn-error').textContent, 'unknown profile: bash');
    assert.equal($<HTMLButtonElement>('#rn-save').disabled, false);
    assert.equal(cb.renamed.mock.calls.length, 0);
    assert.deepEqual(toastsShown(), []);
  });
});

describe('New agent', () => {
  beforeEach(() => { setAppState(state); });

  async function openIt(post: { status?: number; body: unknown }): Promise<void> {
    bridge({ 'GET /api/profiles': { body: profiles[0] }, 'POST /api/agents': post });
    await act(async () => { await openNewAgent(); });
  }
  const start = async (): Promise<void> => { await fire(() => $('#na-start').click()); await settle(); };
  const posted = () => reqs.filter((r) => r.method === 'POST').map((r) => r.body);

  it('lists the profiles and the open workspaces, the focused one picked', async () => {
    await openIt({ body: agentStart[0] });
    assert.deepEqual([...$<HTMLSelectElement>('#na-profile').options].map((o) => [o.value, o.text]),
      [['claude', 'Claude Code'], ['codex', 'Codex'], ['opencode', 'opencode']]);
    const dir = $<HTMLSelectElement>('#na-dir');
    assert.deepEqual([...dir.options].map((o) => [o.value, o.text]),
      [['/home/u/repo', 'repo · main'], ['/home/u/repo-wt-feat', 'repo-wt-feat (worktree)'], ['__custom__', 'Custom path…']]);
    assert.equal(dir.value, '/home/u/repo');
    assert.equal($('#na-cwd-wrap').style.display, 'none');
    assert.equal($('#na-wt-wrap').style.display, 'none');
  });

  it("starts in a picked workspace: its cwd and id, the name and task; then opens the pane", async () => {
    await openIt({ body: agentStart[1] });
    await type($('#na-dir'), '/home/u/repo-wt-feat');
    await type($('#na-name'), ' w-tab ');
    await type($('#na-task'), 'do it\n');
    await start();
    assert.deepEqual(posted(), [{ profile: 'claude', name: 'w-tab', task: 'do it', cwd: '/home/u/repo-wt-feat', workspace: 'w2' }]);
    assert.ok(!open());
    assert.deepEqual(toastsShown(), ['Agent started: Started w-tab']);
    assert.equal(location.hash, '#/pane/p10');
    assert.equal(keptTasks.draft('p10'), null); // delivered
  });

  it('a new worktree: branched from the picked directory, with no cwd or workspace', async () => {
    await openIt({ body: agentStart[2] });
    await type($('#na-profile'), 'codex');
    await fire(() => $('#na-wt-toggle').click());
    assert.equal($('#na-wt-wrap').style.display, '');
    await type($('#na-wt-branch'), 'feat/x');
    await type($('#na-wt-base'), ' origin/main ');
    await start();
    assert.deepEqual(posted(), [{ profile: 'codex', worktree: { repo: '/home/u/repo', branch: 'feat/x', base: 'origin/main' } }]);
    assert.equal(location.hash, '#/pane/p12');
  });

  it('a custom path: its cwd, no workspace; a worktree needs one', async () => {
    await openIt({ body: agentStart[0] });
    await type($('#na-dir'), '__custom__');
    assert.equal($('#na-cwd-wrap').style.display, '');
    await fire(() => $('#na-wt-toggle').click());
    await start();
    assert.equal($('#na-error').textContent, 'Pick a working directory (or a custom path) to branch the worktree from.');
    assert.deepEqual(posted(), []);
    assert.equal($<HTMLButtonElement>('#na-start').disabled, false);
    await fire(() => $('#na-wt-toggle').click());
    await type($('#na-cwd'), ' /tmp/x ');
    await start();
    assert.deepEqual(posted(), [{ profile: 'claude', cwd: '/tmp/x' }]);
  });

  it('keeps a task the agent was not ready for, for its composer', async () => {
    await openIt({ body: { ...agentStart[1], taskDelivered: false } });
    await type($('#na-task'), 'review the diff');
    await start();
    assert.equal(keptTasks.draft('p10'), 'review the diff');
    assert.deepEqual(toastsShown(), ["Agent started: Started w-tab. The task wasn't sent yet — it's in the composer, tap Send when the agent is ready"]);
  });

  it('an error stays in the modal, Start enabled again', async () => {
    await openIt({ status: 400, body: errors[0] });
    await start();
    assert.ok(open());
    assert.equal($('#na-error').textContent, 'unknown profile: bash');
    assert.equal($<HTMLButtonElement>('#na-start').disabled, false);
    assert.equal(location.hash, '');
  });

  it('no modal without profiles: a toast says why', async () => {
    bridge({ 'GET /api/profiles': { body: { profiles: [] } } });
    await act(async () => { await openNewAgent(); });
    assert.ok(!open());
    assert.deepEqual(toastsShown(), ['No launch profiles: Configure launch_profiles in the bridge config.']);
  });
});
