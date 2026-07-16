import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi, promptIdentity } from '../prompt-identity.ts';

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

  it('recognizes the same hint variants parsePrompt accepts (Tab/Space to …)', () => {
    const base = ['● Choose an action', '❯ 1. Commit', '  2. Amend'].join('\n');
    const withHint = base + '\n' + 'Tab to expand · Space to toggle' + '\n' + '  [OMC] volatile 0h39m';
    // The hint is recognized, so the volatile status line after it is excluded.
    const churned = base + '\n' + 'Tab to expand · Space to toggle' + '\n' + '  [OMC] volatile 9h99m';
    assert.equal(promptIdentity(withHint), promptIdentity(churned));
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
