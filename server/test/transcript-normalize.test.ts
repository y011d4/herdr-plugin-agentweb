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

  // A message sent while the agent was working, taken in mid-turn: Claude Code records it
  // only as a queued_command attachment (shape as seen in real transcripts).
  const queued = (prompt: unknown, kind: string, extra: Record<string, unknown> = {}) => line({
    type: 'attachment', isSidechain: false, timestamp: '2026-11-23T11:52:30.000Z',
    attachment: { type: 'queued_command', prompt, commandMode: kind === 'human' ? 'prompt' : kind, origin: { kind }, ...extra },
  });

  it('maps a message the user sent mid-turn (queued_command attachment) to a user item', () => {
    assert.deepEqual(normalizeLine(queued('Also, reply with just the word TWO.', 'human', { humanTurn: true })), [
      { kind: 'user', text: 'Also, reply with just the word TWO.', sidechain: false, ts: Date.parse('2026-11-23T11:52:30.000Z') },
    ]);
  });

  it('takes the text blocks of an array-form queued prompt (e.g. with a pasted image)', () => {
    const items = normalizeLine(queued([{ type: 'text', text: 'look at this' }, { type: 'image', source: { type: 'base64', data: 'x' } }], 'human'));
    assert.deepEqual(items.map((i) => [i.kind, (i as { text: string }).text]), [['user', 'look at this']]);
  });

  it('keeps queued commands that are not the user\'s words, and other attachments, hidden', () => {
    assert.deepEqual(normalizeLine(queued('<task-notification>done</task-notification>', 'task-notification')), []);
    assert.deepEqual(normalizeLine(queued('message from another agent', 'peer')), []);
    assert.deepEqual(normalizeLine(line({ type: 'attachment', attachment: { type: 'skill_listing', content: 'x' } })), []);
    assert.deepEqual(normalizeLine(line({ type: 'attachment' })), []);
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

  it('returns [] for valid-but-non-object JSON without throwing', () => {
    for (const line of ['null', '123', '"a string"', '[1,2,3]', 'true']) {
      assert.deepEqual(normalizeLine(line), [], `line: ${line}`);
    }
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
