// Writes testdata/vectors/prompt.json: web/src/prompt.ts's parsePrompt on the screens of
// the "server parsePrompt matches the client copy" suite (server/test/prompt-identity.test.ts),
// null where it finds no prompt. The Go bridge's parsePrompt is tested against it
// (internal/bridge/prompt_identity_test.go), and web/test/prompt-vectors.test.ts keeps the
// web copy producing it, so changing either side alone fails a test.
// Usage: node tools/vectors/prompt.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { parsePrompt } from '../../web/src/prompt.ts';

const H = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
const screens: Array<[string, string]> = [
  ['active menu', ['● Pick', '❯ 1. Red', '  2. Green', H].join('\n')],
  ['unhighlighted prose', ['1. step one', '2. step two', 'done'].join('\n')],
  ['stale menu above boxed text prompt', ['❯ 1. Yes', '  2. No', '', ' ──────── ', ' ☐ Confirm', '   Type a reason:', H].join('\n')],
  ['menu with an indented ✓ description on its last option', ['● Pick one', '❯ 1. Keep', '  2. Replace', '     ✓ recommended', H].join('\n')],
  ['stale menu above a hint-less boxed prompt', ['❯ 1. Yes', '  2. No', '', ' ────── ', ' ☐ Provide input', '   Enter a value:'].join('\n')],
  ['no menu', ['just some output', 'nothing to answer'].join('\n')],
];

const dir = new URL('../../testdata/vectors/', import.meta.url);
mkdirSync(dir, { recursive: true });
const vectors = screens.map(([name, input]) => ({ name, input, want: parsePrompt(input) }));
writeFileSync(new URL('prompt.json', dir), JSON.stringify(vectors, null, 2) + '\n');
