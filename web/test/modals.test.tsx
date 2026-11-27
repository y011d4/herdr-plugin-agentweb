// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { clearToasts, getToasts } from '../src/notify.ts';
import { keptTasks, setAppState } from '../src/store.ts';
import { confirmModal, Modals, openNewAgent, openRename, previewImage } from '../src/ui/Modals.tsx';
import { AgentMenu } from '../src/ui/Pane.tsx';
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
// a modal: Overlay's, or the confirm's on Mantine's Modal
const open = (): boolean => !!document.querySelector('.modal-overlay, [data-modal-backdrop]');
/** Escape, from the focused element as a browser sends it (Mantine's handler reads its target's attributes). */
const escape = (): void => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); };
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
  await fire(() => escape()); // a modal left open
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

    for (const dismiss of [() => $('#cf-cancel').click(), escape,
      () => $('[data-modal-backdrop]').click()]) {
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

  it('gives the focus back to its opener on close', async () => {
    const opener = document.body.appendChild(document.createElement('button'));
    for (const dismiss of [() => $('#cf-cancel').click(), () => $('#cf-ok').click(), escape]) {
      opener.focus();
      void confirmModal('a', 'b', 'OK', false);
      await settle();
      $('#cf-ok').focus(); // where Mantine's focus trap puts it
      await fire(dismiss);
      assert.ok(!open());
      assert.ok(document.activeElement === opener);
    }
    // another modal taking its place keeps the focus, and gives it back to the first one's opener
    opener.focus();
    void confirmModal('a', 'b', 'OK', false);
    await settle();
    $('#cf-ok').focus();
    await fire(() => previewImage('data:image/png;base64,iVBORw0KGgo=', 'x'));
    assert.ok(document.activeElement === $('.image-preview-close'));
    await fire(() => $('.image-preview-close').click());
    assert.ok(!open());
    assert.ok(document.activeElement === opener);
    opener.remove();
  });

  it("from a ⋮ item (gone once picked): back to the ⋮", async () => {
    const { unmount } = await render(<AgentMenu actions={{ rename: vi.fn(), clear: vi.fn(), stop: () => { void confirmModal('a', 'b', 'Stop', true); } }} />);
    await fire(() => $('#btn-agent-menu').click());
    $('#am-stop').focus(); // a click focuses the button it lands on (Chrome)
    await fire(() => $('#am-stop').click());
    await settle();
    assert.ok(open() && !$('#am-stop'));
    await fire(() => $('#cf-cancel').click());
    assert.ok(document.activeElement === $('#btn-agent-menu'));
    await unmount();
  });
});

describe('Agent actions (the ⋮) and Rename', () => {
  const actions = () => ({ rename: vi.fn(), clear: vi.fn(), stop: vi.fn() });
  const menuOpen = (): boolean => !!document.querySelector('[data-menu-dropdown]');
  const calls = (cb: ReturnType<typeof actions>): number[] => [cb.rename, cb.clear, cb.stop].map((f) => f.mock.calls.length);
  // a pane's ⋮ (its drawer's header)
  const topbar = (cb: ReturnType<typeof actions>) => render(<AgentMenu actions={cb} />);

  it('the ⋮ opens Rename, Clear and Stop; a pick closes it and hands over', async () => {
    for (const [i, id] of ['#am-rename', '#am-clear', '#am-stop'].entries()) {
      const cb = actions();
      const { unmount } = await topbar(cb);
      assert.ok(!menuOpen());
      await fire(() => $('#btn-agent-menu').click());
      assert.deepEqual([...document.querySelectorAll('[data-menu-item]')].map((b) => `${b.id} ${b.textContent}`),
        ['am-rename Rename…', 'am-clear Clear (fresh session)…', 'am-stop Stop agent…']);
      await fire(() => $(id).click());
      assert.ok(!menuOpen());
      assert.deepEqual(calls(cb), [0, 1, 2].map((j) => (j === i ? 1 : 0)));
      await unmount();
    }
  });

  it('Escape, a tap outside or the ⋮ again closes it and hands nothing over', async () => {
    const cb = actions();
    const { unmount } = await topbar(cb);
    for (const dismiss of [escape,
      () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })), () => $('#btn-agent-menu').click()]) {
      await fire(() => $('#btn-agent-menu').click());
      assert.ok(menuOpen());
      await fire(dismiss);
      assert.ok(!menuOpen());
    }
    assert.deepEqual(calls(cb), [0, 0, 0]);
    await unmount();
  });

  it('renames: the current name selected, a name required, then the stored name toasted', async () => {
    bridge({ 'POST /api/panes/p%2F1/rename': { body: rename[0] } });
    await fire(() => openRename('p/1', 'claude'));
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
  });

  it('a failed rename shows the error and can be saved again', async () => {
    bridge({ 'POST /api/panes/p1/rename': { status: 400, body: errors[0] } });
    await fire(() => openRename('p1', 'claude'));
    await fire(() => $('#rn-save').click());
    await settle();
    assert.equal($('#rn-error').textContent, 'unknown profile: bash');
    assert.equal($<HTMLButtonElement>('#rn-save').disabled, false);
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

describe('Image preview', () => {
  const popped = (): Promise<void> => new Promise((r) => { addEventListener('popstate', () => r(), { once: true }); });
  /** A hash change as a browser makes it: the new entry has no state, and a popstate fires (happy-dom keeps the state and fires none). */
  async function hashChange(hash: string): Promise<void> {
    location.hash = hash;
    history.replaceState(null, '');
    await fire(() => dispatchEvent(new PopStateEvent('popstate', { state: null })));
    await settle();
  }
  async function go(delta: number): Promise<void> {
    const moved = popped();
    history.go(delta);
    await moved;
    await settle();
  }
  it('shows the image with focus on ×; a tap on it or around it, ×, Escape or Back closes it and the route stays', async () => {
    location.hash = '#/home/pilot';
    const opener = document.body.appendChild(document.createElement('button'));
    for (const dismiss of [() => $('.image-preview-close').click(), () => $('.image-preview img').click(), () => $('.modal-overlay').click(),
      escape]) {
      opener.focus();
      await fire(() => previewImage('data:image/png;base64,x', 'Attached image'));
      assert.equal($<HTMLImageElement>('.image-preview img').alt, 'Attached image');
      assert.ok(document.activeElement === $('.image-preview-close'));
      assert.equal(typeof history.state?.imagePreview, 'number');
      const back = popped();
      await fire(dismiss);
      assert.ok(!open());
      await back; // its history entry taken back off
      assert.equal(history.state?.imagePreview, undefined);
      assert.ok(document.activeElement === opener);
    }
    await fire(() => previewImage('data:image/png;base64,x', 'image'));
    const back = popped();
    history.back(); // the phone's Back
    await back;
    assert.ok(!open());
    await settle();
    assert.equal(location.hash, '#/home/pilot', 'one step back, not two');
    let moved = popped();
    history.forward(); // onto the closed preview's entry: it shows again
    await moved;
    await settle();
    assert.equal($<HTMLImageElement>('.image-preview img').alt, 'image');
    moved = popped();
    history.back();
    await moved;
    await settle();
    assert.ok(!open());
    assert.equal(location.hash, '#/home/pilot');
    opener.remove();
  });

  it('a hash change closes it; Back shows it again and Forward still reaches the later route', async () => {
    location.hash = '#/home/pilot';
    await fire(() => previewImage('data:image/png;base64,x', 'image'));
    await hashChange('#/agents'); // e.g. a notification's link
    assert.ok(!open());
    assert.equal(location.hash, '#/agents', 'no step back');
    await go(-1);
    assert.ok(open());
    assert.equal(location.hash, '#/home/pilot');
    await go(1);
    assert.ok(!open());
    assert.equal(location.hash, '#/agents');
  });

  it('shows only the last 5 again: an older entry stays blank', async () => {
    location.hash = '#/x0';
    for (let i = 1; i <= 6; i++) {
      await fire(() => previewImage('data:image/png;base64,x', `image ${i}`));
      await hashChange(`#/x${i}`);
    }
    await go(-11); // x0 [P1] x1 P2 x2 … P6 x6
    assert.ok(!open());
    await go(2); // P2
    assert.equal($<HTMLImageElement>('.image-preview img').alt, 'image 2');
  });
});
