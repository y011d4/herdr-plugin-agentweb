import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startAgent,
  stopAgent,
  renameAgent,
  clearAgent,
  createWorktree,
  parseLaunchProfiles,
  agentName,
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

// herdr >= 0.8: tab.create opens the shell pane, agent.start launches into it.
function startResponse(paneId = 'w1:t1:p1', agent = 'claude') {
  return {
    'tab.create': { type: 'tab_created', tab: { tab_id: 'w1:t1' }, root_pane: { pane_id: paneId } },
    'agent.start': (p: Record<string, unknown>) => ({ type: 'agent_started', agent: { pane_id: p.pane_id, name: p.name, agent }, argv: [p.kind, ...(p.args as string[])] }),
    'agent.get': { type: 'agent_info', agent: { pane_id: paneId, interactive_ready: true } },
  };
}

function herdrError(code: string): Error {
  return Object.assign(new Error(code), { herdrCode: code });
}

test('agentName: fits herdr\'s ^[a-z][a-z0-9_-]{0,31}$ rule', () => {
  assert.equal(agentName('My Agent!'), 'my-agent');
  assert.equal(agentName('  Review_2 '), 'review_2');
  assert.equal(agentName('2nd try'), 'nd-try');
  assert.equal(agentName('a'.repeat(40)), 'a'.repeat(32));
  for (const bad of ['', '   ', '123', '日本', 5, null]) assert.equal(agentName(bad), null, String(bad));
});

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
  assert.equal(calls.length, 0, 'no rpc fired for a bogus profile');
});

test('startAgent: opens a tab at cwd in the workspace, then agent.start launches the profile kind into it', async () => {
  const profiles = parseLaunchProfiles({ yolo: { argv: ['claude', '--dangerously-skip-permissions'] } });
  const { rpc, calls } = fakeRpc(startResponse('w9:t9:p9'));
  const out = await startAgent(rpc, profiles, { profile: 'yolo', name: 'My Agent', cwd: '/home/u/proj', workspace: 'ws-7' });
  assert.deepEqual(calls.map((c) => c.method), ['tab.create', 'agent.start']);
  assert.deepEqual(calls[0].params, { label: 'my-agent', focus: false, cwd: '/home/u/proj', workspace_id: 'ws-7' });
  assert.deepEqual(calls[1].params, { name: 'my-agent', kind: 'claude', pane_id: 'w9:t9:p9', args: ['--dangerously-skip-permissions'] });
  assert.deepEqual(out, { paneId: 'w9:t9:p9', name: 'my-agent', agent: 'claude' });
});

test('startAgent: auto-generates a valid name from the profile when none is given, omits cwd/workspace when absent', async () => {
  const { rpc, calls } = fakeRpc(startResponse());
  const out = await startAgent(rpc, PROFILES, { profile: 'codex', name: '  ' });
  assert.match(out.name, /^codex-[a-z0-9]+$/);
  assert.equal('cwd' in calls[0].params, false);
  assert.equal('workspace_id' in calls[0].params, false);
  assert.equal(calls[1].params.kind, 'codex');
});

test('startAgent: retries agent.start while the new pane\'s shell is still starting (agent_pane_busy)', async () => {
  let tries = 0;
  const base = startResponse('P:new');
  const { rpc } = fakeRpc({
    ...base,
    'agent.start': (p: Record<string, unknown>) => {
      if (++tries < 3) throw herdrError('agent_pane_busy');
      return base['agent.start'](p);
    },
  });
  const out = await startAgent(rpc, PROFILES, { profile: 'claude' });
  assert.equal(tries, 3);
  assert.equal(out.paneId, 'P:new');
});

test('startAgent: a failed agent start closes the tab it opened', async () => {
  const { rpc, calls } = fakeRpc({ ...startResponse('P:new'), 'agent.start': herdrError('unsupported_agent_kind') });
  await assert.rejects(() => startAgent(rpc, PROFILES, { profile: 'claude' }), /unsupported_agent_kind/);
  assert.equal(calls.filter((c) => c.method === 'agent.start').length, 1, 'only agent_pane_busy is retried');
  assert.deepEqual(calls.find((c) => c.method === 'pane.close')?.params, { pane_id: 'P:new' });
});

test('startAgent: no pane from tab.create is a 502 and nothing is started', async () => {
  const { rpc, calls } = fakeRpc({ ...startResponse(), 'tab.create': {} });
  await assert.rejects(() => startAgent(rpc, PROFILES, { profile: 'claude' }), (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 502);
  assert.equal(calls.some((c) => c.method === 'agent.start'), false);
});

test('startAgent: with no workspace at all, opens a workspace instead of a tab', async () => {
  const { rpc, calls } = fakeRpc({
    ...startResponse(),
    'tab.create': herdrError('workspace_not_found'),
    'workspace.create': { type: 'workspace_created', root_pane: { pane_id: 'wN:p1' } },
  });
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', cwd: '/p' });
  assert.deepEqual(calls.find((c) => c.method === 'workspace.create')?.params, { label: 'a', focus: false, cwd: '/p' });
  assert.equal(out.paneId, 'wN:p1');
  // an explicit workspace that is gone is an error, not a silent new workspace
  const strict = fakeRpc({ ...startResponse(), 'tab.create': herdrError('workspace_not_found') });
  await assert.rejects(() => startAgent(strict.rpc, PROFILES, { profile: 'claude', workspace: 'gone' }), /workspace_not_found/);
  assert.equal(strict.calls.some((c) => c.method === 'workspace.create'), false);
});

test('startAgent: a long profile key is trimmed, never the timestamp that keeps auto names unique', async () => {
  const key = 'claude-skip-permissions-mode-extra-long';
  const profiles = parseLaunchProfiles({ [key]: { argv: ['claude'] } });
  const before = Date.now();
  const { rpc } = fakeRpc(startResponse());
  const out = await startAgent(rpc, profiles, { profile: key });
  assert.match(out.name, /^[a-z][a-z0-9_-]{0,31}$/);
  assert.ok(parseInt(out.name.split('-').pop()!, 36) >= before, `timestamp kept in ${out.name}`);
});

test('startAgent: an agent blocked on a startup dialog gets no task, without waiting out the timeout', async () => {
  const { rpc, calls } = fakeRpc({ ...startResponse(), 'agent.get': { agent: { agent_status: 'blocked', interactive_ready: false } } });
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', task: 'hi' });
  assert.equal(out.taskDelivered, false);
  assert.equal(calls.some((c) => c.method === 'agent.prompt'), false);
});

test('startAgent: waits for the agent to be interactive, then delivers the task via agent.prompt to its pane id', async () => {
  let polls = 0;
  const { rpc, calls } = fakeRpc({
    ...startResponse('w5:t5:p5'),
    'agent.get': () => ({ agent: { pane_id: 'w5:t5:p5', interactive_ready: ++polls >= 2 } }),
  });
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', task: 'do the thing' });
  assert.equal(polls, 2, 'polled until interactive_ready');
  assert.deepEqual(calls.find((c) => c.method === 'agent.prompt')?.params, { target: 'w5:t5:p5', text: 'do the thing' });
  assert.equal(out.taskDelivered, true);
});

test('startAgent: an empty task is skipped but still reports taskDelivered:false (not omitted)', async () => {
  const { rpc, calls } = fakeRpc(startResponse());
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', task: '' });
  assert.equal(calls.some((c) => c.method === 'agent.prompt'), false, 'no prompt for an empty task');
  assert.equal(out.taskDelivered, false);
});

test('startAgent: a failed task prompt is non-fatal — the agent still started', async () => {
  const { rpc } = fakeRpc({ ...startResponse('P:started'), 'agent.prompt': herdrError('agent_not_ready') });
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', task: 'hi' });
  assert.equal(out.paneId, 'P:started');
  assert.equal(out.taskDelivered, false);
});

test('startAgent: rejects malformed cwd/task/workspace/name with a 400, before opening anything', async () => {
  const { rpc, calls } = fakeRpc(startResponse());
  for (const bad of [{ cwd: 5 }, { task: 5 }, { workspace: 5 }, { name: 5 }, { cwd: '' }, { name: '日本' }]) {
    await assert.rejects(
      () => startAgent(rpc, PROFILES, { profile: 'claude', ...(bad as object) }),
      (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400,
    );
  }
  assert.equal(calls.length, 0);
});

test('startAgent: a worktree spec creates the worktree first, then launches the agent in its root pane', async () => {
  const { rpc, calls } = fakeRpc({
    ...startResponse(),
    ...worktreeCreateResponse('/wt/new', 'wNEW', 'feat/x', 'wNEW:p1'),
  });
  const out = await startAgent(rpc, PROFILES, { profile: 'claude', name: 'a', worktree: { repo: '/proj', branch: 'feat/x' } });
  assert.deepEqual(calls.map((c) => c.method), ['worktree.create', 'agent.start']); // no extra tab
  assert.equal(calls[1].params.pane_id, 'wNEW:p1');
  assert.equal(out.paneId, 'wNEW:p1');
});

test('startAgent: a failed agent start rolls the just-created worktree back', async () => {
  const { rpc, calls } = fakeRpc({
    ...worktreeCreateResponse('/wt/new', 'wNEW'),
    'agent.start': new Error('boom'),
  });
  await assert.rejects(() => startAgent(rpc, PROFILES, { profile: 'claude', worktree: { repo: '/proj' } }), /boom/);
  assert.deepEqual(calls.find((c) => c.method === 'worktree.remove')?.params, { workspace_id: 'wNEW', force: true });
  assert.equal(calls.some((c) => c.method === 'pane.close'), false);
});

// ── stopAgent ────────────────────────────────────────────────────────────────

test('stopAgent: closes the pane', async () => {
  const { rpc, calls } = fakeRpc();
  const out = await stopAgent(rpc, 'w:t:p');
  assert.deepEqual(calls, [{ method: 'pane.close', params: { pane_id: 'w:t:p' } }]);
  assert.deepEqual(out, { paneId: 'w:t:p' });
});

// ── renameAgent ──────────────────────────────────────────────────────────────

test('renameAgent: renames via agent.rename with target + a herdr-valid name', async () => {
  const { rpc, calls } = fakeRpc();
  const out = await renameAgent(rpc, 'w:t:p', '  New name  ');
  assert.deepEqual(calls, [{ method: 'agent.rename', params: { target: 'w:t:p', name: 'new-name' } }]);
  assert.deepEqual(out, { name: 'new-name' });
});

test('renameAgent: an empty, non-string or letterless name is a 400', async () => {
  const { rpc, calls } = fakeRpc();
  for (const bad of ['', '   ', 5, null, '日本']) {
    await assert.rejects(
      () => renameAgent(rpc, 'w:t:p', bad as unknown as string),
      (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400,
    );
  }
  assert.equal(calls.length, 0);
});

// ── clearAgent ───────────────────────────────────────────────────────────────

function agentGetResponse(agent = 'claude', paneId = 'old:pane', cwd = '/home/u/proj', wsId = 'wOLD') {
  return { 'agent.get': { agent: { pane_id: paneId, name: 'orig', agent, cwd, foreground_cwd: cwd, workspace_id: wsId } } };
}

// The replacement's shell is a split of the old pane; agent.start launches into it.
function replacement(paneId = 'new:pane') {
  return {
    'pane.split': { type: 'pane_info', pane: { pane_id: paneId } },
    'agent.start': (p: Record<string, unknown>) => ({ type: 'agent_started', agent: { pane_id: p.pane_id, name: p.name, agent: p.kind }, argv: [p.kind, ...(p.args as string[])] }),
  };
}

test('clearAgent: splits the old pane at its cwd, starts the replacement there, then closes the old pane', async () => {
  const { rpc, calls } = fakeRpc({ ...agentGetResponse('claude', 'old:pane', '/home/u/proj'), ...replacement() });
  const out = await clearAgent(rpc, PROFILES, 'old:pane');
  assert.deepEqual(calls.map((c) => c.method), ['agent.get', 'pane.split', 'agent.start', 'pane.close']);
  assert.deepEqual(calls[1].params, { target_pane_id: 'old:pane', direction: 'right', focus: false, cwd: '/home/u/proj' });
  assert.equal(calls[2].params.kind, 'claude');
  assert.equal(calls[2].params.pane_id, 'new:pane');
  assert.deepEqual(calls[3].params, { pane_id: 'old:pane' });
  assert.equal(out.paneId, 'new:pane');
  assert.equal(out.closedOld, true);
});

test('clearAgent: relaunches in the launch cwd, not a wandered foreground cwd', async () => {
  const { rpc, calls } = fakeRpc({
    'agent.get': { agent: { pane_id: 'old:pane', name: 'orig', agent: 'claude', cwd: '/home/u/orch', foreground_cwd: '/tmp', workspace_id: 'wOLD' } },
    ...replacement(),
  });
  await clearAgent(rpc, PROFILES, 'old:pane');
  assert.equal(calls.find((c) => c.method === 'pane.split')?.params.cwd, '/home/u/orch');
});

test('clearAgent: an agent whose type matches no profile is a LifecycleError, nothing opened', async () => {
  const { rpc, calls } = fakeRpc(agentGetResponse('some-unknown-agent'));
  await assert.rejects(() => clearAgent(rpc, PROFILES, 'old:pane'), (e: unknown) => e instanceof LifecycleError);
  assert.deepEqual(calls.map((c) => c.method), ['agent.get'], 'must not open or start a replacement');
});

test('clearAgent: a failed replacement start closes the split, and keeps the old pane', async () => {
  const { rpc, calls } = fakeRpc({ ...agentGetResponse('claude', 'old:pane'), ...replacement(), 'agent.start': new Error('boom') });
  await assert.rejects(() => clearAgent(rpc, PROFILES, 'old:pane'), /boom/);
  assert.deepEqual(calls.filter((c) => c.method === 'pane.close').map((c) => c.params), [{ pane_id: 'new:pane' }]);
});

test('clearAgent: a failed old-pane close is non-fatal but reported', async () => {
  const { rpc } = fakeRpc({ ...agentGetResponse('claude', 'old:pane'), ...replacement(), 'pane.close': new Error('gone') });
  const out = await clearAgent(rpc, PROFILES, 'old:pane');
  assert.equal(out.paneId, 'new:pane');
  assert.equal(out.closedOld, false);
});

test('clearAgent: a recorded preferred profile is reused over type inference (keeps a custom variant\'s args)', async () => {
  // herdr detects the agent type as "claude", but it was started from a custom
  // variant — inference would drop the extra flag; the preferred profile must win.
  const profiles = parseLaunchProfiles({ 'claude-yolo': { argv: ['claude', '--dangerously-skip-permissions'], label: 'yolo' } });
  const { rpc, calls } = fakeRpc({ ...agentGetResponse('claude', 'old:pane', '/home/u/proj'), ...replacement() });
  const out = await clearAgent(rpc, profiles, 'old:pane', (pid) => (pid === 'old:pane' ? 'claude-yolo' : undefined));
  const start = calls.find((c) => c.method === 'agent.start');
  assert.equal(start?.params.kind, 'claude');
  assert.deepEqual(start?.params.args, ['--dangerously-skip-permissions']);
  assert.equal(out.profile, 'claude-yolo');
  assert.equal(out.oldPaneId, 'old:pane');
});

test('clearAgent: an unknown preferred profile falls back to type inference', async () => {
  const { rpc } = fakeRpc({ ...agentGetResponse('claude', 'old:pane'), ...replacement() });
  const out = await clearAgent(rpc, PROFILES, 'old:pane', () => 'ghost-profile');
  assert.equal(out.profile, 'claude'); // inferred from the detected type
});

test('clearAgent: looks up the profile + reports oldPaneId by the RESOLVED pane id when target is a name', async () => {
  const profiles = parseLaunchProfiles({ 'claude-yolo': { argv: ['claude', '--danger'], label: 'y' } });
  // target is an agent NAME; agent.get resolves it to a different pane id.
  const { rpc, calls } = fakeRpc({
    'agent.get': { agent: { pane_id: 'resolved:pane', name: 'myagent', agent: 'claude', cwd: '/w', foreground_cwd: '/w' } },
    ...replacement(),
  });
  const seen: string[] = [];
  const out = await clearAgent(rpc, profiles, 'myagent', (pid) => { seen.push(pid); return pid === 'resolved:pane' ? 'claude-yolo' : undefined; });
  assert.deepEqual(seen, ['resolved:pane']); // keyed by the resolved pane id, not the "myagent" target
  assert.equal(out.oldPaneId, 'resolved:pane');
  assert.equal(calls.find((c) => c.method === 'pane.split')?.params.target_pane_id, 'resolved:pane');
  assert.deepEqual(calls.find((c) => c.method === 'agent.start')?.params.args, ['--danger']);
  assert.deepEqual(calls.find((c) => c.method === 'pane.close')?.params, { pane_id: 'resolved:pane' });
});

// ── createWorktree ────────────────────────────────────────────────────────────

function worktreeCreateResponse(checkoutPath = '/home/u/.herdr/wt/x', wsId = 'w9', branch = 'feat/x', paneId = 'w9:p1') {
  // Mirrors herdr's real worktree_created shape (checkout dir is worktree.path).
  return { 'worktree.create': {
    type: 'worktree_created',
    worktree: { path: checkoutPath, branch, open_workspace_id: wsId },
    workspace: { workspace_id: wsId, worktree: { checkout_path: checkoutPath } },
    root_pane: { pane_id: paneId },
  } };
}

test('createWorktree: requires a repo (cwd) or workspace, else 400', async () => {
  const { rpc, calls } = fakeRpc(worktreeCreateResponse());
  await assert.rejects(() => createWorktree(rpc, {}), (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400);
  await assert.rejects(() => createWorktree(rpc, { repo: 5 }), (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400);
  await assert.rejects(() => createWorktree(rpc, { repo: '/r', branch: 5 }), (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 400);
  assert.equal(calls.length, 0);
});

test('createWorktree: builds worktree.create with cwd/branch/base and returns the new worktree', async () => {
  const { rpc, calls } = fakeRpc(worktreeCreateResponse('/home/u/.herdr/wt/feat', 'wNEW', 'feat/task', 'wNEW:p1'));
  const out = await createWorktree(rpc, { repo: '/home/u/proj', branch: '  feat/task  ', base: 'origin/main' });
  assert.equal(calls[0].method, 'worktree.create');
  assert.deepEqual(calls[0].params, { focus: false, cwd: '/home/u/proj', branch: 'feat/task', base: 'origin/main' });
  assert.deepEqual(out, { workspaceId: 'wNEW', checkoutPath: '/home/u/.herdr/wt/feat', branch: 'feat/task', paneId: 'wNEW:p1' });
});

test('createWorktree: a blank branch/base is omitted (herdr auto-generates)', async () => {
  const { rpc, calls } = fakeRpc(worktreeCreateResponse());
  await createWorktree(rpc, { workspace: 'w7', branch: '   ', base: '' });
  assert.deepEqual(calls[0].params, { focus: false, workspace_id: 'w7' });
});

test('createWorktree: a missing checkout path is a 502', async () => {
  const { rpc } = fakeRpc({ 'worktree.create': { type: 'worktree_created', worktree: {}, workspace: { workspace_id: 'w9' } } });
  await assert.rejects(() => createWorktree(rpc, { repo: '/r' }), (e: unknown) => e instanceof LifecycleError && (e as LifecycleError).status === 502);
});
