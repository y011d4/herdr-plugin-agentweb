import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, promptIdentity, parsePrompt } from '../prompt-identity.ts';
import { parsePrompt as clientParsePrompt } from '../../web/src/prompt.ts';

// The bridge's verify-and-send compares the client's `expect_prompt` against a
// freshly-recomputed identity, so these must behave exactly like the client copy in
// web/src/app.ts. If this drifts, every tapped answer would 409.

describe('stripAnsi', () => {
  it('removes CSI and OSC escapes, keeps text', () => {
    // ESC written as \x1b (an escape, not a raw control byte).
    const s = '\x1b[1;32m❯ 1. Yes\x1b[0m\x1b]0;title\x07 tail';
    assert.equal(stripAnsi(s), '❯ 1. Yes tail');
  });
});

describe('promptIdentity', () => {
  const A = [
    '● Deploy the app to PRODUCTION now?',
    '',
    '❯ 1. Yes',
    '  2. No',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    '  [OMC] 17:20 (0h39m)',
  ].join('\n');
  const B = [
    '● Delete the PRODUCTION database now?',
    '',
    '❯ 1. Yes',
    '  2. No',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
    '  [OMC] 17:21 (0h40m)',
  ].join('\n');

  it('distinguishes two prompts that share a parsed signature', () => {
    // Same options (Yes/No), different question text — must get different ids.
    assert.notEqual(promptIdentity(A), promptIdentity(B));
  });

  it('is stable across ❯ cursor movement and status-bar ticks', () => {
    const AmovedCursor = A
      .replace('❯ 1. Yes', '  1. Yes')
      .replace('  2. No', '❯ 2. No')
      .replace('17:20 (0h39m)', '17:25 (0h44m)');
    assert.equal(promptIdentity(A), promptIdentity(AmovedCursor));
  });

  it('excludes everything below the navigation hint', () => {
    const withNoise = A + '\nfresh status line churn\nmore churn';
    assert.equal(promptIdentity(A), promptIdentity(withNoise));
  });

  it('includes the question text (not just options)', () => {
    assert.ok(promptIdentity(A).includes('Deploy the app to PRODUCTION now?'));
  });

  it('excludes the status bar for a ❯-only menu with no navigation hint', () => {
    // No recognized hint line — the bottom edge must fall back to the last option, or
    // the ticking status bar would churn the identity and 409 every tap.
    const base = ['● Keep going?', '❯ 1. Yes', '  2. No'].join('\n');
    const t1 = base + '\n' + '  [OMC] 17:20 (0h39m) ctx 12%';
    const t2 = base + '\n' + '  [OMC] 17:26 (0h45m) ctx 34%';
    assert.equal(promptIdentity(t1), promptIdentity(t2));
    assert.ok(promptIdentity(t1).includes('Keep going?'));
  });

  it('does not treat the composer status bar (shift+tab to cycle) as a menu hint', () => {
    // "Tab to"/"Space to" are NOT menu hints — the composer's "shift+tab to cycle"
    // line must not extend the identity into the ticking status bar, or it churns.
    const base = ['● Choose an action', '❯ 1. Commit', '  2. Amend'].join('\n');
    const hint = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
    const t1 = [base, hint, '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents', '[OMC] 0h39m'].join('\n');
    const t2 = [base, hint, '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents', '[OMC] 9h99m'].join('\n');
    assert.equal(promptIdentity(t1), promptIdentity(t2));
    assert.ok(!promptIdentity(t1).includes('shift+tab'));
  });

  it('keys off the bottom-most (active) prompt when an older hint is scrolled above', () => {
    // An older, answered prompt with its own nav hint remains visible above the active
    // one. The identity must reflect the ACTIVE prompt at the bottom (which parsePrompt
    // renders buttons for) — two different active prompts under the same old one must
    // still differ, i.e. truncation stops at the LAST hint, not the first.
    const old = ['● Old question already answered?', '❯ 1. Yes', '  2. No',
      'Enter to select · ↑/↓ to navigate · Esc to cancel', ''].join('\n');
    const activeX = ['● Ship release X now?', '❯ 1. Yes', '  2. No',
      'Enter to select · ↑/↓ to navigate · Esc to cancel', '  [OMC] 0h39m'].join('\n');
    const activeY = ['● Wipe caches now?', '❯ 1. Yes', '  2. No',
      'Enter to select · ↑/↓ to navigate · Esc to cancel', '  [OMC] 0h39m'].join('\n');
    assert.notEqual(promptIdentity(old + '\n' + activeX), promptIdentity(old + '\n' + activeY));
  });
});

describe('server parsePrompt matches the client copy (verify gating)', () => {
  const H = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
  const screens: Array<[string, string]> = [
    ['active menu', ['● Pick', '❯ 1. Red', '  2. Green', H].join('\n')],
    ['unhighlighted prose', ['1. step one', '2. step two', 'done'].join('\n')],
    ['stale menu above boxed text prompt', ['❯ 1. Yes', '  2. No', '', ' ──────── ', ' ☐ Confirm', '   Type a reason:', H].join('\n')],
    ['menu with an indented ✓ description on its last option', ['● Pick one', '❯ 1. Keep', '  2. Replace', '     ✓ recommended', H].join('\n')],
    ['stale menu above a hint-less boxed prompt', ['❯ 1. Yes', '  2. No', '', ' ────── ', ' ☐ Provide input', '   Enter a value:'].join('\n')],
    ['no menu', ['just some output', 'nothing to answer'].join('\n')],
  ];
  for (const [name, screen] of screens) {
    it(`agrees with the client on: ${name}`, () => {
      // The bridge gates the verify identity on this parsePrompt; if it disagreed with
      // the client's, a real answer would 409 or a stale one could slip through.
      assert.deepEqual(parsePrompt(screen), clientParsePrompt(screen));
    });
  }

  it('returns null for a stale menu so its identity gate is empty', () => {
    const stale = ['❯ 1. Yes', '  2. No', '', ' ──────── ', ' ☐ Confirm', '   Type a reason:', H].join('\n');
    assert.equal(parsePrompt(stale), null);
  });
});
