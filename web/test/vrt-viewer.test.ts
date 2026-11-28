// The PR screenshots' viewer (site/static/vrt/index.html): the page as served, in a happy-dom window of its own
// per case, its inline script run (happy-dom loads no image: the srcs are what is checked).
import { afterEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const HTML = readFileSync(new URL('../../site/static/vrt/index.html', import.meta.url), 'utf8');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const RAW = `https://raw.githubusercontent.com/y011d4/herdr-yoicks/${SHA}/`;
let win: Window | null = null;

async function open(query: string): Promise<Window> {
  win = new Window({ url: `https://yoicks.y011d4.com/vrt/${query}`, settings: { enableJavaScriptEvaluation: true } });
  win.document.write(HTML);
  await win.happyDOM.waitUntilComplete();
  return win;
}
const tick = (w: Window) => new Promise((r) => w.setTimeout(r, 10));
const srcs = (w: Window) => [...w.document.querySelectorAll('#view img')].map((i) => i.getAttribute('src')?.replace(RAW, ''));
const pressed = (w: Window) => w.document.querySelector('#modes [aria-pressed="true"]')?.getAttribute('data-mode');
const text = (w: Window, id: string) => w.document.getElementById(id)?.textContent;

afterEach(async () => { await win?.happyDOM.close(); win = null; });

describe('vrt viewer', () => {
  for (const [why, query] of [['no values', ''], ['a short sha', `?sha=abc&s=a-pc`], ['no shots', `?sha=${SHA}`],
    ['a name out of [a-z0-9-]', `?sha=${SHA}&s=a-pc,../x`], ['markup in a name', `?sha=${SHA}&s=%3Cimg%3E`]]) {
    it(`${why}: a hint, no controls, no image`, async () => {
      const w = await open(query);
      assert.match(text(w, 'msg') ?? '', /open it from the screenshots comment/);
      assert.ok(w.document.getElementById('nav')?.hidden && w.document.getElementById('modes')?.hidden);
      assert.equal(w.document.querySelectorAll('img').length, 0);
    });
  }

  it("the hash's shot, its PNGs from that commit, the PR's link, slider first", async () => {
    const w = await open(`?sha=${SHA}&s=agent-card-blocked-phone,home-pc,token-phone&pr=170#home-pc`);
    assert.equal(text(w, 'count'), '2 / 3');
    assert.deepEqual([...w.document.querySelectorAll('#pick option')].map((o) => o.textContent), ['agent-card-blocked-phone', 'home-pc', 'token-phone']);
    assert.equal(pressed(w), 'slider');
    assert.deepEqual(srcs(w), ['home-pc.before.png', 'home-pc.after.png']);
    assert.ok(w.document.getElementById('range'));
    // each image only on its side of the bar, so a smaller after never shows the before's pixels around it
    assert.deepEqual([...w.document.querySelectorAll('#view img')].map((i) => (i as unknown as HTMLElement).style.clipPath !== ''), [true, true]);
    const pr = w.document.getElementById('pr');
    assert.ok(!pr?.hidden && pr?.getAttribute('href') === 'https://github.com/y011d4/herdr-yoicks/pull/170' && pr.textContent === '#170');
  });

  it('a PR number that is not one: no link; an unknown hash: the first shot', async () => {
    const w = await open(`?sha=${SHA}&s=a-pc,b-pc&pr=1x#nope`);
    assert.ok(w.document.getElementById('pr')?.hidden);
    assert.equal(text(w, 'count'), '1 / 2');
    assert.deepEqual(srcs(w), ['a-pc.before.png', 'a-pc.after.png']);
  });

  it('steps through the shots by the buttons and the arrow keys, not past either end', async () => {
    const w = await open(`?sha=${SHA}&s=a-pc,b-pc,c-pc`);
    const prev = w.document.getElementById('prev') as unknown as HTMLButtonElement;
    const next = w.document.getElementById('next') as unknown as HTMLButtonElement;
    assert.ok(prev.disabled && !next.disabled);
    next.click(); await tick(w);
    assert.equal(w.location.hash, '#b-pc');
    assert.equal(text(w, 'count'), '2 / 3');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick(w);
    assert.equal(text(w, 'count'), '3 / 3');
    assert.ok(next.disabled);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick(w);
    assert.equal(w.location.hash, '#c-pc');
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await tick(w);
    assert.equal(text(w, 'count'), '2 / 3');
  });

  // happy-dom lays nothing out and loads no image: the sizes are given, the loads dispatched
  const size = (o: object, k: string, v: unknown) => Object.defineProperty(o, k, { configurable: true, get: () => v });
  const loaded = (w: Window, widths: number[]) => {
    const imgs = [...w.document.querySelectorAll('#view img')] as unknown as HTMLImageElement[];
    imgs.forEach((i, k) => { size(i, 'naturalWidth', widths[k]); size(i, 'complete', true); });
    imgs.forEach((i) => i.dispatchEvent(new w.Event('load')));
    return imgs;
  };

  it('scales both shots by one factor, from the widest, never up, again on a resize; clips each at the bar', async () => {
    const w = await open(`?sha=${SHA}&s=a-pc`);
    const view = w.document.getElementById('view') as unknown as HTMLElement;
    size(view, 'clientWidth', 500);
    size(w.document.querySelector('.frame') as object, 'clientWidth', 500);
    const [before, after] = loaded(w, [1000, 800]);
    assert.deepEqual([before.style.width, after.style.width], ['500px', '400px']);
    size(before, 'clientWidth', 500);
    (w.document.getElementById('range') as unknown as HTMLInputElement).value = '400';
    w.document.getElementById('range')?.dispatchEvent(new w.Event('input'));
    assert.deepEqual([before.style.clipPath, after.style.clipPath].map((c) => c.replace(/\b0(?!px)\b/g, '0px')),
      ['inset(0px 300px 0px 0px)', 'inset(0px 0px 0px 200px)']);
    size(view, 'clientWidth', 2000);
    w.dispatchEvent(new w.Event('resize'));
    assert.deepEqual([before.style.width, after.style.width], ['1000px', '800px']);
  });

  it("a phone's shots at their CSS size (taken at 2x), side by side scaled to a column", async () => {
    const w = await open(`?sha=${SHA}&s=a-phone`);
    size(w.document.getElementById('view') as object, 'clientWidth', 1000);
    assert.deepEqual(loaded(w, [780, 780]).map((i) => i.style.width), ['390px', '390px']);
    (w.document.querySelector('[data-mode="side"]') as unknown as HTMLButtonElement).click();
    size(w.document.querySelector('#view figure') as object, 'clientWidth', 195);
    assert.deepEqual(loaded(w, [780, 700]).map((i) => i.style.width), ['195px', '175px']);
  });

  it('the modes: diff, side by side, blink; a key picks one; the last one is remembered', async () => {
    const w = await open(`?sha=${SHA}&s=a-phone`);
    (w.document.querySelector('[data-mode="diff"]') as unknown as HTMLButtonElement).click();
    assert.equal(pressed(w), 'diff');
    assert.deepEqual(srcs(w), ['a-phone.diff.png']);
    (w.document.querySelector('[data-mode="side"]') as unknown as HTMLButtonElement).click();
    assert.deepEqual([...w.document.querySelectorAll('#view figcaption')].map((c) => c.textContent), ['before', 'after']);
    assert.deepEqual(srcs(w), ['a-phone.before.png', 'a-phone.after.png']);
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: '2', bubbles: true }));
    assert.equal(pressed(w), 'blink');
    assert.equal(w.document.querySelector('#view .tag')?.textContent, 'after');
    // one at a time: the after shown, the before hidden
    assert.deepEqual([...w.document.querySelectorAll('#view img')].map((i) => (i as unknown as HTMLElement).style.visibility), ['hidden', '']);
    assert.equal(w.localStorage.getItem('yoicks-vrt-mode'), 'blink');
  });
});
