// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, dismissToastsForPane, showToast } from '../src/notify.ts';
import { Toasts } from '../src/ui/Toasts.tsx';
import { fire, render } from './render.ts';

const toasts = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.toast')];
const titles = (): string[] => toasts().map((t) => t.querySelector('.toast-header')!.textContent!);
const tick = (ms: number): Promise<void> => fire(() => { vi.advanceTimersByTime(ms); });

/** A finger from x=100 to 100+dx, then lifted. */
async function swipe(el: HTMLElement, dx: number): Promise<void> {
  const touch = (type: string, x?: number) =>
    el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: x === undefined ? [] : [{ clientX: x } as Touch] }));
  await fire(() => {
    touch('touchstart', 100);
    touch('touchmove', 100 + dx);
    touch('touchend');
  });
}

describe('Toasts', () => {
  let unmount: () => Promise<void>;
  beforeEach(async () => {
    vi.useFakeTimers();
    clearToasts();
    ({ unmount } = await render(<Toasts />));
  });
  afterEach(async () => {
    await unmount();
    vi.useRealTimers();
  });

  it('draws Clear all, then each toast as the legacy markup', async () => {
    await fire(() => showToast('A <b>', 'x & y', { sticky: true, paneId: 'p1', onclick: () => {} }));
    await fire(() => showToast('B', 'plain', { sticky: true }));
    const [a, b] = toasts();
    assert.equal(a.parentElement!.firstElementChild!.outerHTML, '<button type="button" id="toast-clear-all">Clear all</button>');
    assert.equal(a.outerHTML, '<div class="toast" data-pane-id="p1" style="cursor: pointer;"><div class="toast-main">' +
      '<div class="toast-header">A &lt;b&gt;</div><div class="toast-body">x &amp; y</div></div>' +
      '<button class="toast-close" aria-label="Dismiss">✕</button></div>');
    assert.equal(b.outerHTML, '<div class="toast"><div class="toast-main"><div class="toast-header">B</div>' +
      '<div class="toast-body">plain</div></div><button class="toast-close" aria-label="Dismiss">✕</button></div>');
  });

  it('keeps the newest 10', async () => {
    for (let i = 1; i <= 12; i++) await fire(() => showToast(`t${i}`, '', { sticky: true }));
    assert.deepEqual(titles(), Array.from({ length: 10 }, (_, i) => `t${i + 3}`));
  });

  it('Clear all removes every toast at once', async () => {
    for (const t of ['a', 'b', 'c']) await fire(() => showToast(t, '', { sticky: true }));
    await fire(() => document.getElementById('toast-clear-all')!.click());
    assert.equal(toasts().length, 0);
  });

  it("dismissToastsForPane fades out that pane's toasts, then removes them", async () => {
    await fire(() => showToast('a', '', { sticky: true, paneId: 'p1' }));
    await fire(() => showToast('b', '', { sticky: true, paneId: 'p2' }));
    await fire(() => showToast('c', '', { sticky: true, paneId: 'p1' }));
    await fire(() => dismissToastsForPane('p1'));
    assert.deepEqual(toasts().map((t) => t.className), ['toast fading', 'toast', 'toast fading']);
    await tick(299);
    assert.equal(toasts().length, 3);
    await tick(1);
    assert.deepEqual(titles(), ['b']);
  });

  it('a non-sticky toast fades out after 4s; a sticky one stays', async () => {
    await fire(() => showToast('brief', ''));
    await fire(() => showToast('sticky', '', { sticky: true }));
    await tick(3999);
    assert.deepEqual(toasts().map((t) => t.className), ['toast', 'toast']);
    await tick(1);
    assert.deepEqual(toasts().map((t) => t.className), ['toast fading', 'toast']);
    await tick(300);
    assert.deepEqual(titles(), ['sticky']);
    await tick(60_000);
    assert.deepEqual(titles(), ['sticky']);
  });

  it('a right swipe past 72px dismisses: 73px does, 71px does not', async () => {
    await fire(() => showToast('far', '', { sticky: true }));
    await fire(() => showToast('near', '', { sticky: true }));
    const [far, near] = toasts();
    await swipe(far, 73);
    assert.equal(far.style.transform, 'translateX(120%)');
    await swipe(near, 71);
    assert.equal(near.style.transform, '');
    await tick(150);
    assert.deepEqual(titles(), ['near']);
    await tick(10_000);
    assert.deepEqual(titles(), ['near']);
  });

  it("a swipe isn't a tap; the tap after it is, and ✕ isn't one", async () => {
    const onclick = vi.fn();
    await fire(() => showToast('t', '', { sticky: true, onclick }));
    const [t] = toasts();
    await swipe(t, 40); // springs back
    await fire(() => t.click()); // the click a swipe can leave behind
    assert.equal(onclick.mock.calls.length, 0);
    assert.equal(toasts().length, 1);
    await fire(() => (t.querySelector('.toast-close') as HTMLElement).click());
    assert.equal(onclick.mock.calls.length, 0);
    assert.equal(t.className, 'toast fading');
    await fire(() => t.click());
    assert.equal(onclick.mock.calls.length, 1);
    assert.equal(toasts().length, 0); // a tap removes it at once
  });
});
