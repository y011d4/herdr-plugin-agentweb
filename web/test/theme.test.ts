// theme.ts against the CSS: Mantine's breakpoints are Tailwind's (app.css), and its colors style.css's.
import { readFileSync } from 'node:fs';
import { rem, type MantineTheme } from '@mantine/core';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { WIDE_QUERY, theme } from '../src/theme.ts';

const css = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const vars = (text: string, prefix: string): Record<string, string> =>
  Object.fromEntries([...text.matchAll(new RegExp(`--${prefix}-([\\w-]+):\\s*([^;]+);`, 'g'))].map((m) => [m[1], m[2].trim()]));

describe('theme', () => {
  it("has app.css's breakpoints, the same five", () => {
    const { '*': _all, ...tailwind } = vars(css('app.css'), 'breakpoint');
    assert.deepEqual(tailwind, theme.breakpoints);
  });

  it("has style.css's colors where Mantine's dark scheme reads them", () => {
    const color = vars(css('style.css'), 'color');
    const dark = theme.colors!.dark!;
    assert.deepEqual(
      [dark[0], dark[2], dark[4], dark[6], dark[7], dark[8], theme.colors!.accent![0]],
      [color.text, color['text-dim'], color.border, color['surface-2'], color.surface, color.bg, color.accent],
    );
    // the statuses' (ui/Status.tsx; unknown is the theme's alone)
    for (const st of ['idle', 'working', 'blocked', 'done']) assert.equal(theme.colors![st]![6], color[st], st);
  });

  it("makes a button given no size, and an input at its default (sm), style.css's touch target tall", () => {
    const touch = rem(css('style.css').match(/--touch-min:\s*([\d.]+px);/)![1]);
    const vars = (name: 'Button' | 'Input', size?: string): unknown =>
      theme.components![name].vars!(theme as MantineTheme, { size } as never, {} as never);
    assert.deepEqual(vars('Button'), { root: { '--button-height': touch, '--button-fz': 'var(--mantine-font-size-md)' } });
    assert.deepEqual(vars('Input', 'sm'), { wrapper: { '--input-height': touch, '--input-fz': rem(16) } });
    // any other size is Mantine's own
    assert.deepEqual(vars('Button', 'compact-sm'), { root: {} });
    assert.deepEqual(vars('Input', 'xs'), { wrapper: {} });
  });

  it("has the PC layout's width as style.css's last block and the lg breakpoint", () => {
    assert.equal(css('style.css').match(/@media \(min-width: \d+px\)/g)?.at(-1), `@media ${WIDE_QUERY}`);
    assert.equal(`(min-width: ${parseFloat(theme.breakpoints!.lg!) * 16}px)`, WIDE_QUERY);
  });
});
