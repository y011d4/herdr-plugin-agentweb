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
});
