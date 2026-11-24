import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePrompt } from '../src/prompt.ts';

// The Go bridge's parsePrompt is tested against testdata/vectors/prompt.json (written
// by tools/vectors/prompt.ts); this keeps the web copy producing it, so changing either
// side alone fails a test. Regenerate the file after an intended change here.
const vectors = JSON.parse(readFileSync(new URL('../../testdata/vectors/prompt.json', import.meta.url), 'utf8')) as
  Array<{ name: string; input: string; want: unknown }>;

describe('parsePrompt produces testdata/vectors/prompt.json', () => {
  it('has vectors', () => {
    assert.ok(vectors.length > 0);
  });
  for (const v of vectors) {
    it(v.name, () => {
      assert.deepEqual(parsePrompt(v.input), v.want);
    });
  }
});
