// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, showToast } from '../src/notify.ts';
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

  it('draws each toast as the legacy markup', async () => {
    await fire(() => showToast('A <b>', 'x & y'));
    const [a] = toasts();
    assert.equal(a.parentElement!.children.length, 1);
    assert.equal(a.outerHTML, '<div class="toast"><div class="toast-main">' +
      '<div class="toast-header">A &lt;b&gt;</div><div class="toast-body">x &amp; y</div></div>' +
      '<button class="toast-close" aria-label="Dismiss">✕</button></div>');
  });

  it('keeps the newest 10', async () => {
    for (let i = 1; i <= 12; i++) await fire(() => showToast(`t${i}`, ''));
    assert.deepEqual(titles(), Array.from({ length: 10 }, (_, i) => `t${i + 3}`));
  });

  it('fades out after 4s, then goes', async () => {
    await fire(() => showToast('brief', ''));
    await tick(3999);
    assert.deepEqual(toasts().map((t) => t.className), ['toast']);
    await tick(1);
    assert.deepEqual(toasts().map((t) => t.className), ['toast fading']);
    await tick(299);
    assert.equal(toasts().length, 1);
    await tick(1);
    assert.equal(toasts().length, 0);
  });

  it('a right swipe past 72px dismisses: 73px does, 71px does not', async () => {
    await fire(() => showToast('far', ''));
    await fire(() => showToast('near', ''));
    const [far, near] = toasts();
    await swipe(far, 73);
    assert.equal(far.style.transform, 'translateX(120%)');
    await swipe(near, 71);
    assert.equal(near.style.transform, '');
    await tick(150);
    assert.deepEqual(titles(), ['near']);
  });

  it('✕ fades it out at once', async () => {
    await fire(() => showToast('t', ''));
    const [t] = toasts();
    await fire(() => (t.querySelector('.toast-close') as HTMLElement).click());
    assert.equal(t.className, 'toast fading');
    await tick(300);
    assert.equal(toasts().length, 0);
  });
});
