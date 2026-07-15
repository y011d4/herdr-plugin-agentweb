import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptTail, readTranscriptFrom, slugForCwd } from '../transcript.ts';

// One JSONL line (a minimal user turn) whose content is `n` bytes of filler, so
// tests can build files of a known size.
function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), 'transcript-test-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

describe('slugForCwd', () => {
  it('replaces / . _ with - (case preserved)', () => {
    assert.equal(slugForCwd('/home/y011d4/ghq/github.com/y011d4/herdr-plugin-mobile'),
      '-home-y011d4-ghq-github-com-y011d4-herdr-plugin-mobile');
    assert.equal(slugForCwd('/a/b_c.d'), '-a-b-c-d');
  });
});

describe('readTranscriptTail', () => {
  it('returns all items with the cursor at EOF for a newline-terminated file', () => {
    const f = join(dir, 'a.jsonl');
    writeFileSync(f, userLine('one') + '\n' + userLine('two') + '\n');
    const { items, cursor, truncated } = readTranscriptTail(f, 300);
    assert.deepEqual(items.map((i) => (i as { text: string }).text), ['one', 'two']);
    assert.equal(truncated, false);
    // cursor at EOF → a follow-up read finds nothing new
    assert.equal(readTranscriptFrom(f, cursor).items.length, 0);
  });

  it('leaves a trailing partial line unconsumed (cursor before it)', () => {
    const f = join(dir, 'b.jsonl');
    const partial = userLine('incomplete'); // no trailing newline
    writeFileSync(f, userLine('done') + '\n' + partial);
    const { items, cursor } = readTranscriptTail(f, 300);
    assert.deepEqual(items.map((i) => (i as { text: string }).text), ['done']);
    // completing the partial line makes it appear on the next incremental read
    appendFileSync(f, '\n');
    const next = readTranscriptFrom(f, cursor);
    assert.deepEqual(next.items.map((i) => (i as { text: string }).text), ['incomplete']);
  });

  it('slices to the last maxItems and flags truncated', () => {
    const f = join(dir, 'c.jsonl');
    writeFileSync(f, Array.from({ length: 10 }, (_, i) => userLine(`m${i}`)).join('\n') + '\n');
    const { items, truncated } = readTranscriptTail(f, 3);
    assert.deepEqual(items.map((i) => (i as { text: string }).text), ['m7', 'm8', 'm9']);
    assert.equal(truncated, true);
  });

  it('bounds a large file to the byte cap and keeps the recent tail', () => {
    const f = join(dir, 'big.jsonl');
    // ~2.4 MB of ~1 KB lines — larger than TAIL_MAX_BYTES (2 MB).
    const filler = 'x'.repeat(1000);
    const lines = Array.from({ length: 2400 }, (_, i) => userLine(`${i}-${filler}`));
    writeFileSync(f, lines.join('\n') + '\n');
    const { items, cursor, truncated } = readTranscriptTail(f, 300);
    assert.equal(items.length, 300);
    assert.equal(truncated, true);
    // the tail must be the most recent lines, and end exactly at line 2399
    assert.ok((items[items.length - 1] as { text: string }).text.startsWith('2399-'));
    // cursor sits at EOF (file ends with a newline) → no phantom re-read
    assert.equal(readTranscriptFrom(f, cursor).items.length, 0);
  });
});

describe('readTranscriptFrom — byte cursor with multi-byte UTF-8', () => {
  it('advances the cursor by exact byte length across multi-byte chars', () => {
    const f = join(dir, 'utf8.jsonl');
    writeFileSync(f, userLine('café ☕ 日本語') + '\n');
    const first = readTranscriptTail(f, 300);
    assert.equal(first.items.length, 1);
    // append another multi-byte line and confirm only it comes back
    appendFileSync(f, userLine('二行目 🎉') + '\n');
    const inc = readTranscriptFrom(f, first.cursor);
    assert.deepEqual(inc.items.map((i) => (i as { text: string }).text), ['二行目 🎉']);
    assert.equal(inc.reset, false);
    // and the cursor is now at EOF
    assert.equal(readTranscriptFrom(f, inc.cursor).items.length, 0);
  });
});

describe('readTranscriptFrom — bounded when the cursor is far behind', () => {
  it('returns a rebuilt tail with reset=true when the gap exceeds the cap', () => {
    const f = join(dir, 'gap.jsonl');
    const filler = 'x'.repeat(1000);
    writeFileSync(f, Array.from({ length: 2400 }, (_, i) => userLine(`${i}-${filler}`)).join('\n') + '\n');
    // after=0 on a >2 MB file: must not stream the whole file
    const r = readTranscriptFrom(f, 0, 300);
    assert.equal(r.reset, true);
    assert.equal(r.items.length, 300);
    assert.ok((r.items[r.items.length - 1] as { text: string }).text.startsWith('2399-'));
    // a small gap does not reset
    const tail = readTranscriptTail(f, 300);
    const near = readTranscriptFrom(f, tail.cursor);
    assert.equal(near.reset, false);
    assert.equal(near.items.length, 0);
  });
});
