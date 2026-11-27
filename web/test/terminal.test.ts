// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createTerminal, type Terminal } from '../src/terminal.ts';
import { read } from './contract.gen.ts';

// The bridge: every request waits until the test answers it.
interface Req { method: string; url: string; answer: (status: number, body: unknown) => void }
let reqs: Req[];
beforeEach(() => {
  reqs = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => new Promise((res) => {
    reqs.push({ method: init.method ?? 'GET', url, answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
  }));
});
const reads = () => reqs.filter((r) => r.url.includes('/read?source=visible'));
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** A touch event carrying the fingers still down (happy-dom has no TouchList to build). */
const touch = (el: HTMLElement, type: string, points: Array<[number, number]> = []) =>
  el.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { touches: points.map(([clientX, clientY]) => ({ clientX, clientY })) }));
const tap = (el: HTMLElement, moveBy = 0) => {
  touch(el, 'touchstart', [[10, 10]]);
  if (moveBy) touch(el, 'touchmove', [[10, 10 + moveBy]]);
  touch(el, 'touchend');
};

let el: HTMLElement;
let term: Terminal;
beforeEach(() => {
  el = document.body.appendChild(document.createElement('div'));
  term = createTerminal(el, { paneId: 'p1' });
});
afterEach(() => { term.destroy(); el.remove(); });
const live = () => el.querySelector('#term-live')!;

describe('terminal', () => {
  it('defers a screen that arrives while a finger is down, and draws it on touchend', () => {
    term.render('first');
    const shown = live().firstChild;
    touch(el, 'touchstart', [[10, 10]]);
    term.render('second');
    assert.equal(live().textContent, 'first');
    assert.ok(live().firstChild === shown, 'the live DOM is not replaced under the finger');
    touch(el, 'touchend');
    assert.equal(live().textContent, 'second');
  });

  it('takes two stationary taps as a double-tap (fit, bottom, re-read), and two moved ones not', async () => {
    term.render('x');
    // pinch: the distance between two fingers doubles
    touch(el, 'touchstart', [[0, 0], [0, 50]]);
    touch(el, 'touchmove', [[0, 0], [0, 100]]);
    touch(el, 'touchend');
    const font = () => parseFloat(el.style.fontSize);
    const pinched = font();
    assert.ok(pinched > 6, `pinched to ${pinched}px`); // happy-dom lays out nothing: the fit clamps to 6px

    tap(el, 15);
    tap(el, 15);
    assert.equal(reads().length, 0, 'moved taps are not a double-tap');
    term.render('y');
    assert.equal(font(), pinched, 'the pinched size stays');

    tap(el);
    tap(el);
    assert.equal(reads().length, 1, 'a double-tap re-reads the screen');
    term.render('z');
    assert.equal(font(), 6, 'back to fit-to-width');
  });

  it('writes nothing for a response that lands after destroy()', async () => {
    const refreshed = term.refresh();
    term.destroy();
    reads()[0].answer(200, read[1]);
    await refreshed;
    assert.ok(live().querySelector('.loading-spinner'), 'still the spinner');

    const term2 = createTerminal(el, { paneId: 'p1' });
    const failed = term2.refresh();
    term2.destroy();
    reads()[1].answer(500, { error: { code: 'x', message: 'boom' } });
    await failed;
    await flush();
    assert.ok(live().querySelector('.loading-spinner'), 'no error text either');
  });

  it('held (a Home under a drawer) it reads nothing, and a read in flight never applies, also once released', async () => {
    const inFlight = term.refresh();
    term.setHeld(true);
    await term.refresh();
    await term.loadHistory();
    assert.equal(reqs.length, 1, 'no read while held');
    reads()[0].answer(200, read[1]);
    await inFlight;
    term.setHeld(false);
    await flush();
    assert.ok(live().querySelector('.loading-spinner'), 'the held read not drawn');
    const again = term.refresh();
    reads()[1].answer(200, read[1]);
    await again;
    assert.match(live().textContent!, /hello 日本語/, 'released: it reads and draws');
  });

  it('renders a read that lands while it lives', async () => {
    const refreshed = term.refresh();
    reads()[0].answer(200, read[1]);
    await refreshed;
    assert.match(live().textContent!, /hello 日本語/);
  });
});
