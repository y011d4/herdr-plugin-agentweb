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

  it('keeps the cursor byte-exact when the tail ends mid multi-byte char (no replay)', () => {
    const f = join(dir, 'mb-partial.jsonl');
    const line = userLine('done') + '\n';
    writeFileSync(f, line);
    const afterLine = Buffer.byteLength(line, 'utf8');
    // append the first 2 of the 3 bytes of ☕ (e2 98 95) — an unterminated char
    appendFileSync(f, Buffer.from([0xe2, 0x98]));
    const tail = readTranscriptTail(f, 300);
    assert.deepEqual(tail.items.map((i) => (i as { text: string }).text), ['done']);
    // cursor must sit exactly after the complete line's newline, not skewed back
    // by the U+FFFD replacement char's byte length
    assert.equal(tail.cursor, afterLine);
    // an incremental read from there must not replay 'done'
    assert.equal(readTranscriptFrom(f, tail.cursor).items.length, 0);
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

  it('treats an unreadable file as no-update, never an empty reset', () => {
    const missing = join(dir, 'does-not-exist.jsonl');
    const r = readTranscriptFrom(missing, 12345, 300);
    assert.equal(r.reset, false); // must NOT clear the client's log
    assert.equal(r.cursor, 12345); // cursor preserved, not rewound to 0
    assert.equal(r.items.length, 0);
    assert.equal(readTranscriptTail(missing, 300).items.length, 0);
  });

  it('does not reset past a single >cap unterminated line (no skip)', () => {
    const f = join(dir, 'giant.jsonl');
    const first = userLine('first');
    writeFileSync(f, first + '\n'); // one complete line
    const afterFirst = Buffer.byteLength(first + '\n', 'utf8');
    // a single unterminated line larger than the 2 MB cap
    appendFileSync(f, 'y'.repeat(2_300_000));
    const stuck = readTranscriptFrom(f, afterFirst, 300);
    assert.equal(stuck.reset, false); // no complete line in the window → no reset
    assert.equal(stuck.cursor, afterFirst); // cursor not advanced past the unshown line
    assert.equal(stuck.items.length, 0);
    // once the giant line ends and a normal line follows, progress resumes
    appendFileSync(f, '\n' + userLine('next') + '\n');
    const resumed = readTranscriptFrom(f, afterFirst, 300);
    assert.equal(resumed.reset, true);
    assert.ok(resumed.items.some((i) => (i as { text: string }).text === 'next'));
    assert.ok(resumed.cursor > afterFirst);
  });

  it('advances the cursor over a large all-skipped tail without resetting', () => {
    const f = join(dir, 'meta.jsonl');
    const first = userLine('first');
    writeFileSync(f, first + '\n');
    const afterFirst = Buffer.byteLength(first + '\n', 'utf8');
    // >2 MB of complete lines that normalize to nothing (system/meta)
    const metaLine = JSON.stringify({ type: 'system', content: 'x'.repeat(500) });
    let bytes = 0;
    const chunks: string[] = [];
    while (bytes < 2_300_000) { chunks.push(metaLine); bytes += metaLine.length + 1; }
    appendFileSync(f, chunks.join('\n') + '\n');
    const r = readTranscriptFrom(f, afterFirst, 300);
    assert.equal(r.reset, false); // nothing renderable → don't clear the log
    assert.equal(r.items.length, 0);
    assert.ok(r.cursor > afterFirst); // but the cursor advances — no re-read loop
  });

  it('advances past a completed >cap line with no following line (no loop)', () => {
    const f = join(dir, 'giant-done.jsonl');
    const first = userLine('first');
    writeFileSync(f, first + '\n');
    const afterFirst = Buffer.byteLength(first + '\n', 'utf8');
    // a single COMPLETE line larger than the cap, terminated, with nothing after
    writeFileSync(f, first + '\n' + 'z'.repeat(2_300_000) + '\n');
    const size = Buffer.byteLength(first + '\n' + 'z'.repeat(2_300_000) + '\n', 'utf8');
    const r = readTranscriptFrom(f, afterFirst, 300);
    assert.equal(r.reset, false);   // giant line is unrenderable → no reset
    assert.equal(r.items.length, 0);
    assert.equal(r.cursor, size);   // cursor advances to EOF past the completed line
    // and a follow-up read finds nothing new — no re-read loop
    assert.equal(readTranscriptFrom(f, r.cursor, 300).items.length, 0);
    assert.equal(readTranscriptFrom(f, r.cursor, 300).reset, false);
  });
});
