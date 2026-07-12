import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSplitter, serialize } from '../ndjson.ts';

describe('createSplitter', () => {
  it('emits a complete line when chunk contains newline', () => {
    const s = createSplitter();
    const lines = s.push('{"a":1}\n');
    assert.deepEqual(lines, ['{"a":1}']);
  });

  it('buffers partial lines across chunks', () => {
    const s = createSplitter();
    assert.deepEqual(s.push('{"a":'), []);
    assert.deepEqual(s.push('1}\n'), ['{"a":1}']);
  });

  it('emits multiple lines from a single chunk', () => {
    const s = createSplitter();
    const lines = s.push('{"a":1}\n{"b":2}\n{"c":3}\n');
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('handles a split across the newline boundary', () => {
    const s = createSplitter();
    assert.deepEqual(s.push('{"x":1}'), []);
    assert.deepEqual(s.push('\n'), ['{"x":1}']);
  });

  it('handles two lines split across multiple small chunks', () => {
    const s = createSplitter();
    const collected: string[] = [];
    collected.push(...s.push('{"i'));
    collected.push(...s.push('d":1}'));
    collected.push(...s.push('\n{"id"'));
    collected.push(...s.push(':2}\n'));
    assert.deepEqual(collected, ['{"id":1}', '{"id":2}']);
  });

  it('ignores empty lines', () => {
    const s = createSplitter();
    const lines = s.push('\n\n{"a":1}\n\n');
    assert.deepEqual(lines, ['{"a":1}']);
  });

  it('reset clears internal buffer', () => {
    const s = createSplitter();
    s.push('{"partial"');
    s.reset();
    const lines = s.push('{"fresh":1}\n');
    assert.deepEqual(lines, ['{"fresh":1}']);
  });

  it('handles lines delivered one byte at a time', () => {
    const s = createSplitter();
    const input = '{"v":42}\n';
    let collected: string[] = [];
    for (const ch of input) {
      collected = collected.concat(s.push(ch));
    }
    assert.deepEqual(collected, ['{"v":42}']);
  });
});

describe('serialize', () => {
  it('appends a newline', () => {
    assert.ok(serialize({ a: 1 }).endsWith('\n'));
  });

  it('produces valid JSON before the newline', () => {
    const line = serialize({ x: 'hello' });
    assert.deepEqual(JSON.parse(line.trimEnd()), { x: 'hello' });
  });
});
