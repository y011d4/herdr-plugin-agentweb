import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startAgent,
  stopAgent,
  renameAgent,
  clearAgent,
  parseLaunchProfiles,
  DEFAULT_LAUNCH_PROFILES,
  LifecycleError,
} from '../agent-lifecycle.ts';

// A fake herdr rpc: records every (method, params) and answers from a canned
// table, so the lifecycle orchestration can be tested with zero I/O.
function fakeRpc(responses: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method in responses) {
      const r = responses[method];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? (r as (p: Record<string, unknown>) => unknown)(params) : r;
    }
    return {};
  };
  return { rpc, calls };
}

const PROFILES = DEFAULT_LAUNCH_PROFILES;

// ── parseLaunchProfiles ──────────────────────────────────────────────────────

test('parseLaunchProfiles: undefined/invalid returns the defaults', () => {
  assert.deepEqual(parseLaunchProfiles(undefined), DEFAULT_LAUNCH_PROFILES);
  assert.deepEqual(parseLaunchProfiles(null), DEFAULT_LAUNCH_PROFILES);
  assert.deepEqual(parseLaunchProfiles('nope'), DEFAULT_LAUNCH_PROFILES);
  assert.deepEqual(parseLaunchProfiles([1, 2]), DEFAULT_LAUNCH_PROFILES);
});

test('parseLaunchProfiles: adds new profiles and keeps the defaults', () => {
  const p = parseLaunchProfiles({ 'claude-danger': { argv: ['claude', '--dangerously-skip-permissions'], label: 'Claude (yolo)' } });
  assert.deepEqual(p['claude-danger'], { argv: ['claude', '--dangerously-skip-permissions'], label: 'Claude (yolo)' });
  assert.deepEqual(p.claude, DEFAULT_LAUNCH_PROFILES.claude); // defaults preserved
});

test('parseLaunchProfiles: overrides a default argv and defaults the label to the key', () => {
  const p = parseLaunchProfiles({ codex: { argv: ['codex', '--full-auto'] } });
  assert.deepEqual(p.codex.argv, ['codex', '--full-auto']);
  assert.equal(p.codex.label, 'codex'); // label falls back to the profile key
});

test('parseLaunchProfiles: a "__proto__" key does not corrupt the map or pollute Object.prototype', () => {
  const p = parseLaunchProfiles({ __proto__: { argv: ['evil'], label: 'x' } });
  assert.equal(Object.hasOwn(p, '__proto__'), false, '__proto__ is not added as a profile');
  assert.equal(({} as Record<string, unknown>).argv, undefined, 'Object.prototype not polluted');
  assert.ok(p.claude, 'defaults intact');
});

test('parseLaunchProfiles: malformed entries are ignored (graceful)', () => {
  const p = parseLaunchProfiles({
    a: { argv: 'claude' },      // argv not an array
    b: { argv: [] },            // empty argv
    c: { argv: ['ok', 1] },     // non-string element
    d: {},                      // no argv
    e: 'string',                // not an object
    good: { argv: ['ok'] },
  });
  for (const bad of ['a', 'b', 'c', 'd', 'e']) assert.equal(p[bad], undefined, `${bad} should be dropped`);
  assert.deepEqual(p.good, { argv: ['ok'], label: 'good' });
  assert.ok(p.claude, 'defaults still present');
});

// ── startAgent ───────────────────────────────────────────────────────────────

function startResponse(paneId = 'w1:t1:p1', name = 'n', agent = 'claude') {
  return { 'agent.start': (p: Record<string, unknown>) => ({ type: 'agent_started', agent: { pane_id: paneId, name: p.name ?? name, agent }, argv: p.argv }) };
}

test('startAgent: unknown / missing profile is a 400 LifecycleError, no rpc fired', async () => {
  const { rpc, calls } = fakeRpc();
  await assert.rejects(() => startAgent(rpc, PROFILES, { profile: 'ghost' }), (e: unknown) => {
    assert.ok(e instanceof LifecycleError);
    assert.equal((e as LifecycleError).status, 400);
    return true;
  });
  await assert.rejects(() => startAgent(rpc, PROFILES, {}), (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400);
  assert.equal(calls.length, 0, 'no rpc on validation failure');
});

test('startAgent: inherited Object.prototype names are NOT valid profiles (in-operator hazard)', async () => {
  const { rpc, calls } = fakeRpc(startResponse());
  for (const bad of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    await assert.rejects(
      () => startAgent(rpc, PROFILES, { profile: bad }),
      (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400,
      `profile "${bad}" must be rejected`,
    );
  }
  assert.equal(calls.length, 0, 'no agent.start fired for a bogus profile');
});

test('startAgent: builds agent.start with the profile argv and passed name/cwd/workspace', async () => {
  const { rpc, calls } = fakeRpc(startResponse('w9:t9:p9'));
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'my-agent', cwd: '/home/u/proj', workspace: 'ws-7' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'agent.start');
  assert.deepEqual(calls[0].params, { name: 'my-agent', argv: ['claude'], focus: false, cwd: '/home/u/proj', workspace_id: 'ws-7' });
  assert.deepEqual(out, { paneId: 'w9:t9:p9', name: 'my-agent', agent: 'claude' });
});

test('startAgent: auto-generates a name from the profile when none is given, omits cwd/workspace when absent', async () => {
  const { rpc, calls } = fakeRpc(startResponse());
  const out = await startAgent(rpc, PROFILES, { profile: 'codex' });
  assert.match(out.name, /^codex-/);
  assert.equal('cwd' in calls[0].params, false);
  assert.equal('workspace_id' in calls[0].params, false);
  assert.deepEqual(calls[0].params.argv, ['codex']);
});

test('startAgent: delivers an initial task via agent.send targeting the returned paneId (not the name)', async () => {
  const { rpc, calls } = fakeRpc(startResponse('w5:t5:p5'));
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', task: 'do the thing' });
  const send = calls.find((c) => c.method === 'agent.send');
  assert.ok(send, 'agent.send fired');
  assert.deepEqual(send.params, { target: 'w5:t5:p5', text: 'do the thing' }); // pane id, not the ambiguous name
  assert.equal(out.taskDelivered, true);
});

test('startAgent: an empty task is skipped but still reports taskDelivered:false (not omitted)', async () => {
  const { rpc, calls } = fakeRpc(startResponse());
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', task: '' });
  assert.equal(calls.some((c) => c.method === 'agent.send'), false, 'no send for an empty task');
  assert.equal(out.taskDelivered, false);
});

test('startAgent: a failed task send is non-fatal — the agent still started', async () => {
  const { rpc } = fakeRpc({ ...startResponse('P:started'), 'agent.send': new Error('not ready') });
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', task: 'hi' });
  assert.equal(out.paneId, 'P:started');
  assert.equal(out.taskDelivered, false);
});

test('startAgent: rejects malformed cwd/task/workspace/name types with a 400', async () => {
  const { rpc } = fakeRpc(startResponse());
  for (const bad of [{ cwd: 5 }, { task: 5 }, { workspace: 5 }, { name: 5 }, { cwd: '' }]) {
    await assert.rejects(
      () => startAgent(rpc, PROFILES, { profile: 'claude', ...(bad as object) }),
      (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400,
    );
  }
});

// ── stopAgent ────────────────────────────────────────────────────────────────

test('stopAgent: closes the pane', async () => {
  const { rpc, calls } = fakeRpc();
  const out = await stopAgent(rpc, 'w:t:p');
  assert.deepEqual(calls, [{ method: 'pane.close', params: { pane_id: 'w:t:p' } }]);
  assert.deepEqual(out, { paneId: 'w:t:p' });
});

// ── renameAgent ──────────────────────────────────────────────────────────────

test('renameAgent: renames via agent.rename with target + name', async () => {
  const { rpc, calls } = fakeRpc();
  const out = await renameAgent(rpc, 'w:t:p', '  new name  ');
  assert.deepEqual(calls, [{ method: 'agent.rename', params: { target: 'w:t:p', name: 'new name' } }]);
  assert.deepEqual(out, { name: 'new name' });
});

test('renameAgent: an empty or non-string name is a 400', async () => {
  const { rpc, calls } = fakeRpc();
  for (const bad of ['', '   ', 5, null]) {
    await assert.rejects(
      () => renameAgent(rpc, 'w:t:p', bad as unknown as string),
      (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400,
    );
  }
  assert.equal(calls.length, 0);
});

// ── clearAgent ───────────────────────────────────────────────────────────────

function agentGetResponse(agent = 'claude', paneId = 'old:pane', cwd = '/home/u/proj') {
  return { 'agent.get': { agent: { pane_id: paneId, name: 'orig', agent, cwd, foreground_cwd: cwd } } };
}

test('clearAgent: starts a replacement (inferred argv + cwd) then closes the old pane', async () => {
  const { rpc, calls } = fakeRpc({
    ...agentGetResponse('claude', 'old:pane', '/home/u/proj'),
    'agent.start': (p: Record<string, unknown>) => ({ type: 'agent_started', agent: { pane_id: 'new:pane', name: p.name, agent: 'claude' }, argv: p.argv }),
  });
  const out = await clearAgent(rpc, PROFILES, 'old:pane');
  const start = calls.find((c) => c.method === 'agent.start');
  assert.ok(start);
  assert.deepEqual(start.params.argv, ['claude']);
  assert.equal(start.params.cwd, '/home/u/proj');
  const close = calls.find((c) => c.method === 'pane.close');
  assert.deepEqual(close?.params, { pane_id: 'old:pane' });
  // order: get → start → close
  assert.deepEqual(calls.map((c) => c.method), ['agent.get', 'agent.start', 'pane.close']);
  assert.equal(out.paneId, 'new:pane');
  assert.equal(out.closedOld, true);
});

test('clearAgent: an agent whose type matches no profile is a LifecycleError, nothing started', async () => {
  const { rpc, calls } = fakeRpc(agentGetResponse('some-unknown-agent'));
  await assert.rejects(() => clearAgent(rpc, PROFILES, 'old:pane'), (e: unknown) => e instanceof LifecycleError);
  assert.equal(calls.filter((c) => c.method === 'agent.start').length, 0, 'must not start a replacement');
});

test('clearAgent: a failed old-pane close is non-fatal but reported', async () => {
  const { rpc } = fakeRpc({
    ...agentGetResponse('claude', 'old:pane'),
    'agent.start': { type: 'agent_started', agent: { pane_id: 'new:pane', name: 'x', agent: 'claude' }, argv: ['claude'] },
    'pane.close': new Error('gone'),
  });
  const out = await clearAgent(rpc, PROFILES, 'old:pane');
  assert.equal(out.paneId, 'new:pane');
  assert.equal(out.closedOld, false);
});

test('clearAgent: a recorded preferred profile is reused over type inference (keeps a custom variant\'s argv)', async () => {
  // herdr detects the agent type as "claude", but it was started from a custom
  // variant — inference would drop the extra flag; the preferred profile must win.
  const profiles = parseLaunchProfiles({ 'claude-yolo': { argv: ['claude', '--dangerously-skip-permissions'], label: 'yolo' } });
  const { rpc, calls } = fakeRpc({
    ...agentGetResponse('claude', 'old:pane', '/home/u/proj'),
    'agent.start': (p: Record<string, unknown>) => ({ type: 'agent_started', agent: { pane_id: 'new:pane', name: p.name, agent: 'claude' }, argv: p.argv }),
  });
  const out = await clearAgent(rpc, profiles, 'old:pane', 'claude-yolo');
  const start = calls.find((c) => c.method === 'agent.start');
  assert.deepEqual(start?.params.argv, ['claude', '--dangerously-skip-permissions']);
  assert.equal(out.profile, 'claude-yolo');
});

test('clearAgent: an unknown preferred profile falls back to type inference', async () => {
  const { rpc } = fakeRpc({
    ...agentGetResponse('claude', 'old:pane'),
    'agent.start': (p: Record<string, unknown>) => ({ type: 'agent_started', agent: { pane_id: 'new:pane', name: p.name, agent: 'claude' }, argv: p.argv }),
  });
  const out = await clearAgent(rpc, PROFILES, 'old:pane', 'ghost-profile');
  assert.equal(out.profile, 'claude'); // inferred from the detected type
});
