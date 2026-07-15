import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLine, summarizeToolInput } from '../transcript-normalize.ts';

// Build one JSONL line as the transcript format stores it.
function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('normalizeLine — user turns', () => {
  it('maps a string user message to a user item', () => {
    const items = normalizeLine(line({ type: 'user', timestamp: '2026-07-15T00:00:00.000Z', message: { role: 'user', content: 'hello there' } }));
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], { kind: 'user', text: 'hello there', sidechain: false, ts: Date.parse('2026-07-15T00:00:00.000Z') });
  });

  it('skips an empty/whitespace user message', () => {
    assert.deepEqual(normalizeLine(line({ type: 'user', message: { role: 'user', content: '   ' } })), []);
  });

  it('maps a tool_result block to a tool_result item', () => {
    const items = normalizeLine(line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_123', content: 'ok output', is_error: false }] },
    }));
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'tool_result');
    assert.equal((items[0] as { forId: string }).forId, 'tu_123');
    assert.equal((items[0] as { text: string }).text, 'ok output');
    assert.equal((items[0] as { isError: boolean }).isError, false);
  });

  it('flattens array-form tool_result content and flags errors', () => {
    const items = normalizeLine(line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], is_error: true }] },
    }));
    assert.equal((items[0] as { text: string }).text, 'ab');
    assert.equal((items[0] as { isError: boolean }).isError, true);
  });
});

describe('normalizeLine — assistant turns', () => {
  it('maps thinking, text and tool_use blocks in order', () => {
    const items = normalizeLine(line({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'done' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la\nsecond line' } },
        ],
      },
    }));
    assert.deepEqual(items.map((i) => i.kind), ['thinking', 'assistant', 'tool_use']);
    assert.equal((items[0] as { text: string }).text, 'hmm');
    assert.equal((items[1] as { text: string }).text, 'done');
    assert.equal((items[2] as { name: string }).name, 'Bash');
    assert.equal((items[2] as { summary: string }).summary, 'ls -la'); // first line only
  });

  it('extracts TodoWrite items', () => {
    const items = normalizeLine(line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } }] },
    }));
    const todos = (items[0] as { todos: Array<{ content: string; status: string }> | null }).todos;
    assert.equal(todos?.length, 2);
    assert.deepEqual(todos?.[1], { content: 'b', status: 'in_progress' });
  });

  it('truncates very long thinking and marks it', () => {
    const long = 'x'.repeat(20_000);
    const items = normalizeLine(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: long }] } }));
    assert.equal(items[0].kind, 'thinking');
    assert.ok((items[0] as { text: string }).text.length < long.length);
    assert.equal((items[0] as { truncated: boolean }).truncated, true);
  });

  it('skips signature-only (empty-text) thinking blocks but keeps sibling text', () => {
    // Some sessions persist redacted thinking: a signature with no plaintext.
    const items = normalizeLine(line({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'redacted-sig' }, { type: 'text', text: 'answer' }] },
    }));
    assert.deepEqual(items.map((i) => i.kind), ['assistant']);
  });
});

describe('normalizeLine — skipped and malformed lines', () => {
  it('skips meta, system, and snapshot lines', () => {
    assert.deepEqual(normalizeLine(line({ type: 'user', isMeta: true, message: { role: 'user', content: 'ctx' } })), []);
    assert.deepEqual(normalizeLine(line({ type: 'system', content: 'hook' })), []);
    assert.deepEqual(normalizeLine(line({ type: 'file-history-snapshot', snapshot: {} })), []);
  });

  it('returns [] for unparseable JSON', () => {
    assert.deepEqual(normalizeLine('not json{'), []);
  });

  it('carries the sidechain flag from isSidechain', () => {
    const items = normalizeLine(line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub' }] } }));
    assert.equal((items[0] as { sidechain: boolean }).sidechain, true);
  });
});

describe('summarizeToolInput', () => {
  it('summarizes common tools by their key field', () => {
    assert.equal(summarizeToolInput('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
    assert.equal(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' }), 'foo in src');
    assert.equal(summarizeToolInput('Task', { subagent_type: 'Explore', description: 'find x' }), 'Explore: find x');
  });

  it('falls back to the first string field for unknown tools', () => {
    assert.equal(summarizeToolInput('Mystery', { note: 'hello', n: 3 }), 'hello');
  });
});
