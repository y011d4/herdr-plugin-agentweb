import { it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conversationItems } from '../src/transcript.ts';

// testdata/vectors/injected-turns.json is shared with the Go bridge's task line
// (internal/bridge/vectors_test.go): change the rule on one side only and a test fails.
const vectors = JSON.parse(readFileSync(new URL('../../testdata/vectors/injected-turns.json', import.meta.url), 'utf8')) as
  Array<{ text: string; injected: boolean }>;

it('the home chat hides exactly the injected user turns of the shared vectors', () => {
  assert.ok(vectors.length > 0);
  for (const { text, injected } of vectors) {
    const shown = conversationItems([{ kind: 'user', text, sidechain: false, ts: null }]).length === 1;
    assert.equal(shown, !injected, JSON.stringify(text));
  }
});
