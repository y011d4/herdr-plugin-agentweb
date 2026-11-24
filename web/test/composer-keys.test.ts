import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enterSends } from '../src/composer-keys.ts';

const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: k === 'Enter' ? 13 : 65, ...mods,
});

describe('enterSends — PC', () => {
  it('sends on Enter', () => {
    assert.equal(enterSends(key('Enter'), true), true);
  });
  it('leaves Shift+Enter (and other modifiers) to insert a newline', () => {
    for (const m of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey'] as const) {
      assert.equal(enterSends(key('Enter', { [m]: true }), true), false, m);
    }
  });
  it('never sends on the Enter that confirms an IME conversion', () => {
    assert.equal(enterSends(key('Enter', { isComposing: true }), true), false);
    // Safari: fired after compositionend, so isComposing is false; keyCode is 229
    assert.equal(enterSends(key('Enter', { keyCode: 229 }), true), false);
  });
  it('ignores other keys', () => {
    assert.equal(enterSends(key('a'), true), false);
  });
});

describe('enterSends — touch device', () => {
  it('never sends: Enter inserts a newline as before', () => {
    assert.equal(enterSends(key('Enter'), false), false);
  });
});
