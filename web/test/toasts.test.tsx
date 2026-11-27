// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, showToast } from '../src/notify.ts';
import { Toasts } from '../src/ui/Toasts.tsx';
import { fire, render } from './render.ts';

const toasts = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.toast')];
const titles = (): string[] => toasts().map((t) => t.querySelector('.mantine-Notification-title')!.textContent!);
const fading = (): boolean[] => toasts().map((t) => t.classList.contains('fading'));
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

  it("draws each toast as Mantine's Notification: the title, the body as text, ✕ (Dismiss), no alert role", async () => {
    await fire(() => showToast('A <b>', 'x & y'));
    const [a] = toasts();
    assert.equal(a.parentElement!.children.length, 1);
    assert.ok(a.classList.contains('mantine-Notification-root'));
    assert.equal(titles()[0], 'A <b>');
    assert.equal(a.querySelector('.mantine-Notification-description')!.innerHTML, 'x &amp; y');
    assert.ok(a.querySelector('button[aria-label="Dismiss"]'));
    // the container is the live region: an alert role would have it read out twice
    assert.equal(a.getAttribute('role'), 'none');
  });

  it('keeps the newest 10', async () => {
    for (let i = 1; i <= 12; i++) await fire(() => showToast(`t${i}`, ''));
    assert.deepEqual(titles(), Array.from({ length: 10 }, (_, i) => `t${i + 3}`));
  });

  it('fades out after 4s, then goes', async () => {
    await fire(() => showToast('brief', ''));
    await tick(3999);
    assert.deepEqual(fading(), [false]);
    await tick(1);
    assert.deepEqual(fading(), [true]);
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
    await fire(() => t.querySelector<HTMLElement>('button[aria-label="Dismiss"]')!.click());
    assert.deepEqual(fading(), [true]);
    await tick(300);
    assert.equal(toasts().length, 0);
  });
});

describe('Toasts in #toast-container', () => {
  it('mark it while the stack overflows (its scrollbar then takes the mouse: style.css)', async () => {
    vi.useFakeTimers();
    clearToasts();
    const { unmount } = await render(<div id="toast-container"><Toasts /></div>);
    const box = document.getElementById('toast-container')!;
    // happy-dom has no layout: a toast is 100px, the box at most 250px (its max-height), and the
    // newest toast's entry slide (8px down) overflows it even when it isn't full
    box.style.maxHeight = '250px';
    Object.defineProperty(box, 'clientHeight', { get: () => Math.min(100 * box.children.length, 250) });
    Object.defineProperty(box, 'scrollHeight', { get: () => 100 * box.children.length + 8 });
    await fire(() => { showToast('a', ''); showToast('b', ''); });
    assert.equal(box.hasAttribute('data-overflow'), false, 'not full: the slide is no overflow');
    await fire(() => showToast('c', ''));
    assert.equal(box.hasAttribute('data-overflow'), true);
    await fire(() => box.querySelector<HTMLElement>('button[aria-label="Dismiss"]')!.click());
    await fire(() => { vi.advanceTimersByTime(300); });
    assert.equal(box.hasAttribute('data-overflow'), false);
    await unmount();
    vi.useRealTimers();
  });

  it('a box just full, its newest toast still sliding in, is no overflow once the slide ends; a fractional cap is full', async () => {
    clearToasts();
    const { unmount } = await render(<div id="toast-container"><Toasts /></div>);
    const box = document.getElementById('toast-container')!;
    let slide = 8; // the entry's transform, until its animation ends
    box.style.maxHeight = '250.4px'; // clientHeight rounds it down
    Object.defineProperty(box, 'clientHeight', { get: () => Math.min(125 * box.children.length, 250) });
    Object.defineProperty(box, 'scrollHeight', { get: () => 125 * box.children.length + slide });
    await fire(() => { showToast('a', ''); showToast('b', ''); });
    assert.equal(box.hasAttribute('data-overflow'), true, 'full, and the slide overflows it');
    slide = 0;
    await fire(() => box.lastElementChild!.dispatchEvent(new Event('animationend', { bubbles: true })));
    assert.equal(box.hasAttribute('data-overflow'), false, 'the slide is over: no overflow');
    await fire(() => showToast('c', ''));
    assert.equal(box.hasAttribute('data-overflow'), true, 'a third toast overflows the 250.4px cap at clientHeight 250');
    await unmount();
  });
});
