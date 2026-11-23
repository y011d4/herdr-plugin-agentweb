import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clip, formatOverview, type AgentDetail, type RawAgent } from '../overview.ts';
import type { TimelineItem } from '../transcript-normalize.ts';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const snapshot = {
  workspaces: [{ workspace_id: 'w1', label: 'repo' }],
  tabs: [{ tab_id: 't1', label: 'fix-auth' }],
};
const agent = (pane_id: string, agent_status: string, extra: Partial<RawAgent> = {}): RawAgent =>
  ({ pane_id, agent_status, workspace_id: 'w1', tab_id: 't1', ...extra });
const user = (text: string, sidechain = false, ts: number | null = null): TimelineItem => ({ kind: 'user', text, sidechain, ts });
const asst = (text: string, sidechain = false, ts: number | null = null): TimelineItem => ({ kind: 'assistant', text, sidechain, ts });
const tool = (name: string, summary: string): TimelineItem =>
  ({ kind: 'tool_use', id: 'x', name, summary, todos: null, ask: null, sidechain: false, ts: null });
const run = (agents: RawAgent[], details: Record<string, AgentDetail> = {}, self?: string) =>
  formatOverview(agents, snapshot, new Map(Object.entries(details)), self, NOW);

describe('formatOverview', () => {
  it('prints "no other agents" when only the caller exists', () => {
    assert.equal(run([], {}), 'no other agents');
    assert.equal(run([agent('p0', 'working')], {}, 'p0'), 'no other agents');
  });

  it('orders blocked, working, done, idle, unknown (stable) and skips the caller', () => {
    const out = run([
      agent('a', 'idle'), agent('b', 'unknown'), agent('c', 'done'), agent('self', 'blocked'),
      agent('d', 'working'), agent('e', 'blocked'), agent('f', 'idle'), agent('g', 'weird'),
    ], {}, 'self');
    const names = out.split('\n').filter((l) => !l.startsWith(' ')).map((l) => l.split('  ')[0]);
    assert.deepEqual(names, ['e', 'd', 'c', 'a', 'f', 'b', 'g']);
  });

  it('renders the header with name, labels, pane and last activity', () => {
    const out = run([agent('p2', 'blocked', { name: 'w-fix-auth' })], { p2: { items: [asst('hi', false, NOW - 3 * 60_000)] } });
    assert.equal(out.split('\n')[0], 'w-fix-auth  blocked  repo › fix-auth  (pane p2, last activity 3m ago)');
  });

  it('falls back to the pane id and omits unknown activity', () => {
    assert.equal(run([agent('p2', 'idle')]), 'p2  idle  repo › fix-auth  (pane p2)');
  });

  it('picks the last real user task and last main-thread assistant text', () => {
    const out = run([agent('p', 'idle')], { p: { items: [
      user('the real task'), asst('older reply'), asst('main reply'),
      user('<task-notification>done</task-notification>'), user('  <system-reminder>x'),
      user('sub task', true), asst('sub reply', true),
    ] } });
    assert.match(out, /\n {2}task: the real task\n/);
    assert.match(out, /\n {2}last: main reply$/);
  });

  it('shows the call still open in this turn, not just the final item (parallel calls)', () => {
    const res = (forId: string): TimelineItem => ({ kind: 'tool_result', forId, text: 'ok', truncated: false, isError: false, sidechain: false, ts: null });
    const call = (id: string, name: string): TimelineItem => ({ kind: 'tool_use', id, name, summary: id, todos: null, ask: null, sidechain: false, ts: null });
    const parallel = [user('t'), call('a', 'Bash'), call('b', 'Edit'), res('b')];
    assert.match(run([agent('p', 'blocked')], { p: { items: parallel } }), /\n {2}pending: Bash a$/);
    const done = [user('t'), call('a', 'Bash'), res('a')];
    assert.doesNotMatch(run([agent('p', 'working')], { p: { items: done } }), /doing/);
    const midTurn = [user('t'), call('a', 'Bash'), call('b', 'Edit'), res('b'), user('<task-notification>bg done</task-notification>')];
    assert.match(run([agent('p', 'blocked')], { p: { items: midTurn } }), /\n {2}pending: Bash a$/); // an injected turn doesn't end the turn
    const stale = [user('t'), call('old', 'Bash'), user('next'), asst('thinking about it')];
    assert.doesNotMatch(run([agent('p', 'working')], { p: { items: stale } }), /doing/); // an earlier turn's unanswered call
  });

  it('falls back to an older task found beyond the tail window', () => {
    const out = run([agent('p', 'working')], { p: { items: [asst('still going')], olderTask: 'refactor the parser' } });
    assert.match(out, /\n {2}task: refactor the parser\n/);
  });

  it('counts user text that merely starts with "<" (pastes, HTML) as the task', () => {
    for (const text of ['<pasted_content>stack trace</pasted_content>', '<div> is broken']) {
      const out = run([agent('p', 'idle')], { p: { items: [user('older'), user(text), user('<command-name>/clear</command-name>')] } });
      assert.ok(out.includes(`  task: ${text}`), out);
    }
  });

  it('adds "doing" for a working agent whose latest item is a tool_use', () => {
    const items = [user('t'), asst('looking'), tool('Bash', 'npm test')];
    assert.match(run([agent('p', 'working')], { p: { items } }), /\n {2}doing: Bash npm test$/);
    assert.match(run([agent('p', 'blocked')], { p: { items } }), /\n {2}pending: Bash npm test$/);
    assert.doesNotMatch(run([agent('p', 'idle')], { p: { items } }), /doing|pending/);
  });

  it('falls back to the last screen lines when there is no transcript', () => {
    const screen = 'old\nl1\n\n────\nl2  with   gaps\nl3\nl4\n   \n';
    const out = run([agent('p', 'idle', { agent: 'codex' })], { p: { screen } });
    assert.match(out, /\n {2}screen: l1 ⏎ l2 with gaps ⏎ l3 ⏎ l4$/);
  });

  it('prints only the header when nothing could be read', () => {
    assert.equal(run([agent('p', 'idle')], { p: {} }).split('\n').length, 1);
  });

  it('truncates and flattens long excerpts', () => {
    const out = run([agent('p', 'idle')], { p: { items: [user('x'.repeat(500)), asst('a\n\nb\tc '.repeat(200))] } });
    const task = out.split('\n').find((l) => l.startsWith('  task: '))!;
    assert.equal(Array.from(task.slice('  task: '.length)).length, 160);
    assert.ok(task.endsWith('…'));
    const last = out.split('\n').find((l) => l.startsWith('  last: '))!;
    assert.equal(Array.from(last.slice('  last: '.length)).length, 300);
    assert.doesNotMatch(last.slice('  last: '.length), /[\n\t]| {2}/);
  });
});

describe('clip', () => {
  it('strips control chars and never splits a surrogate pair', () => {
    assert.equal(clip('a\u001b[31mb', 10), 'a [31mb');
    assert.equal(clip('😀😀😀', 2), '😀…');
  });
});
