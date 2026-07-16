import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// The live-prompt parser lives in the web module; it is DOM-free so it runs here.
import { parsePrompt, stripAnsi } from '../../web/src/prompt.ts';

const HINT = 'Enter to select · ↑/↓ to navigate · Esc to cancel';

describe('parsePrompt — real menus', () => {
  it('parses a highlighted AskUserQuestion menu with its question', () => {
    const screen = [
      '────────────────────────────',
      ' ☐ Fruit',
      'Which fruit would you like to pick?',
      '',
      '❯ 1. apple',
      '     Pick an apple.',
      '  2. banana',
      '     Pick a banana.',
      '  3. cherry',
      HINT,
      '  [OMC] status 0h39m',
    ].join('\n');
    const p = parsePrompt(screen);
    assert.ok(p, 'should parse');
    assert.equal(p!.options.length, 3);
    assert.equal(p!.selected, 1);
    assert.equal(p!.options[2].send, '3');
    assert.ok(p!.question!.includes('Which fruit'));
  });

  it('captures a highlight that is not on the first option', () => {
    const p = parsePrompt(['● Proceed?', '  1. Yes', '❯ 2. No', HINT].join('\n'));
    assert.equal(p!.selected, 2);
  });

  it('accepts a menu whose final option has an indented ✓/☐ description', () => {
    // An indented description below the last option that starts with ✓ (or ☐/☑) is
    // menu continuation, NOT a new box/category — it must not be mistaken for a lower
    // prompt and hide the buttons.
    const p = parsePrompt(['● Pick one', '❯ 1. Keep', '  2. Replace', '     ✓ recommended', HINT].join('\n'));
    assert.ok(p, 'should still parse');
    assert.equal(p!.options.length, 2);
    assert.equal(p!.selected, 1);
  });
});

describe('parsePrompt — rejects non-menus', () => {
  it('rejects ordinary numbered prose (no highlight)', () => {
    const prose = ['Plan:', '1. read the config', '2. validate', '3. write output', 'done'].join('\n');
    assert.equal(parsePrompt(prose), null);
  });

  it('rejects a single numbered item', () => {
    assert.equal(parsePrompt('❯ 1. only one option here\nsome text'), null);
  });

  // The regression the branch review asked for: numbered prose sitting just above a
  // DIFFERENT, non-numbered prompt whose navigation hint would otherwise be borrowed.
  it('does not turn numbered prose above a separate hinted prompt into buttons', () => {
    const screen = [
      'Here is the plan:',
      '1. do the first thing',
      '2. do the second thing',
      '',
      'Type your answer below:',
      HINT, // this hint belongs to the text prompt, NOT the numbered list above
    ].join('\n');
    assert.equal(parsePrompt(screen), null);
  });

  it('rejects an unhighlighted numbered block even with a nearby hint', () => {
    // Without a ❯ marker it is not an actionable menu, regardless of a hint below.
    assert.equal(parsePrompt(['  1. Alpha', '  2. Bravo', HINT].join('\n')), null);
  });

  it('rejects a highlighted menu when a different hinted prompt is active below it', () => {
    // An old highlighted menu still on screen above a NEW, lower prompt that owns the
    // active menu hint. The upper block must not be offered as buttons — the digit
    // would land on the lower active prompt.
    const screen = [
      '❯ 1. Yes',            // stale, already-answered menu above
      '  2. No',
      '',
      '● Now a different question is active',
      '❯ 1. Keep',           // this lower block is what parsePrompt should pick…
      '  2. Discard',
      HINT,
    ].join('\n');
    // parsePrompt picks the bottom-most block ("Keep/Discard"), which is correct here.
    assert.equal(parsePrompt(screen)!.options[0].label, 'Keep');

    // But when the lower active prompt is NON-numbered (free text) with its own hint,
    // the bottom-most NUMBERED block is the stale upper menu — reject it.
    const stale = [
      '❯ 1. Yes',
      '  2. No',
      '',
      '● Type a commit message:',
      'Enter to select · Esc to cancel', // belongs to the lower text prompt
    ].join('\n');
    assert.equal(parsePrompt(stale), null);
  });

  it('rejects a stale menu above an indented BOXED lower prompt', () => {
    // The lower prompt is a box: after border (│) stripping its inner text is
    // indented, so it must be recognized by its ─ top rule / ☐ category, not the
    // indent, or the stale upper menu would stay tappable.
    const stale = [
      '❯ 1. Approve',
      '  2. Reject',
      '',
      '│ ──────────────────────────── │', // lower prompt's box top rule
      '│ ☐ Confirm                    │',
      '│ Are you absolutely sure?     │', // indented boxed text
      '│ ❯ 1. Yes really              │',
      '│   2. Back                    │',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    // Bottom-most block is the lower "Yes really/Back" menu (correct pick), but if a
    // non-numbered box sat there instead the guard would still reject the stale upper.
    assert.equal(parsePrompt(stale)!.options[0].label, 'Yes really');

    const staleText = [
      '❯ 1. Approve',
      '  2. Reject',
      '',
      ' ──────────────────────────── ', // box top rule (raw ─)
      ' ☐ Confirm',
      '   Type your reason:', // indented boxed free-text prompt (no numbers)
      'Enter to select · Esc to cancel',
    ].join('\n');
    assert.equal(parsePrompt(staleText), null);
  });

  it('rejects a stale menu above a lower prompt that has NO hint of its own (EOF)', () => {
    // The lower boxed prompt carries no recognized navigation hint, so the scan runs
    // to EOF with foreign content seen — the stale upper menu must still be rejected.
    const stale = [
      '❯ 1. Yes',
      '  2. No',
      '',
      ' ──────────────────────────── ', // lower prompt's box top rule
      ' ☐ Provide input',
      '   Enter a value and press return:', // free-text, no "Enter to select"-style hint
    ].join('\n');
    assert.equal(parsePrompt(stale), null);
  });
});

describe('parsePrompt — with ANSI', () => {
  it('parses after stripping ANSI escapes', () => {
    const ansi = '\x1b[1m❯ 1. Yes\x1b[0m\n  2. No\n' + HINT;
    const p = parsePrompt(stripAnsi(ansi));
    assert.equal(p!.options.length, 2);
    assert.equal(p!.selected, 1);
  });
});
