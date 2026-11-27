// theme.ts against the CSS: Mantine's breakpoints are Tailwind's (app.css), and its colors style.css's.
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { theme } from '../src/theme.ts';

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
  });
});
