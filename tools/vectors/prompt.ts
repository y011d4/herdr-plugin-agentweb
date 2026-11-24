// Writes testdata/vectors/prompt.json: web/src/prompt.ts's parsePrompt on the screens
// below, null where it finds no prompt. The Go bridge's parsePrompt is tested against it
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
  // Real Claude Code screens (v2.1.322, a 74-column pane):
  ['AskUserQuestion whose description wraps over six lines', [
    '──────────────────────────────────────────────────────────────────────────',
    '←  ☐ Color  ☐ Size  ✔ Submit  →',
    '',
    'Which color should the button use?',
    '',
    '❯ 1. Red',
    '     A warm, high-contrast color that draws attention.',
    '  2. Blue',
    '     落ち着いた印象の色です。説明がとても長い場合にどう折り返されるかを確',
    '     かめるため、この説明文はわざと長くしてあります。スマートフォンの狭い',
    '     画面でも読みやすく表示されるかどうか、ボタンの押しやすさが損なわれな',
    '     いかどうかを確認します。さらにもう少し文章を足して、端末の幅を超えて',
    '     二行以上に折り返されるようにします。ここまで書けば十分な長さになるは',
    '     ずです。',
    '  3. Green',
    '     Short.',
    '  4. Type something.',
    '──────────────────────────────────────────────────────────────────────────',
    '  5. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n')],
  ['permission prompt whose option label wraps', [
    '──────────────────────────────────────────────────────────────────────────',
    ' Bash command',
    ' Tip: auto mode handles these prompts for you — choose "switch to auto',
    ' mode" below',
    ' Create a deeply nested test directory',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' │ mkdir -p some/really/long/directory/name/that/keeps/going/and/going/fo',
    ' │ r/a/while/so/the/permission/prompt/wraps && echo done',
    '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don’t ask again for: mkdir *',
    '   3. Yes, and switch to auto mode · auto mode handles these prompts for',
    '      you',
    '   4. No',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n')],
  ['multi-select AskUserQuestion with its Submit row', [
    '──────────────────────────────────────────────────────────────────────────',
    '←  ☐ Toppings  ✔ Submit  →',
    '',
    'Which toppings?',
    '',
    '❯ 1. [ ] Cheese',
    '         Melted mozzarella on top, added generously across the whole pizza',
    '         so every slice gets some of it',
    '  2. [ ] Olives',
    '         黒オリーブ',
    '  3. [ ] Basil',
    '         Fresh leaves',
    '  4. [ ] Type something',
    '     Submit',
    '──────────────────────────────────────────────────────────────────────────',
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')],
];

const dir = new URL('../../testdata/vectors/', import.meta.url);
mkdirSync(dir, { recursive: true });
const vectors = screens.map(([name, input]) => ({ name, input, want: parsePrompt(input) }));
writeFileSync(new URL('prompt.json', dir), JSON.stringify(vectors, null, 2) + '\n');
