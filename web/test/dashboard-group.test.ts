import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { byUrgency, dashboardCards, homeGroups, homeSummary, markSeen, orchestratorStatus, shownStatus } from '../src/dashboard-group.ts';
import type { AgentStatus, OrchestratorView, PaneNode, WorkspaceNode, WorktreeInfo } from '../src/types.ts';

function agentPane(id: string, sinceUnixMs: number, status: AgentStatus = 'idle', completionSeq: number | null = null, stateChangeSeq: number | null = null): PaneNode {
  return {
    paneId: id, focused: false, cwd: null, launchCwd: null, title: null,
    agent: { name: 'claude', displayName: null, status, sinceUnixMs, completionSeq, stateChangeSeq },
  };
}
const shell = (id: string): PaneNode => ({ paneId: id, focused: false, cwd: null, launchCwd: null, title: null, agent: null });

function wsNode(id: string, panes: PaneNode[], worktree: WorktreeInfo | null = null): WorkspaceNode {
  return { workspaceId: id, label: `${id}-label`, cwd: null, worktree, tabs: [{ tabId: `${id}:t1`, label: 't', panes }] };
}

describe('dashboardCards', () => {
  it('lists agents from every workspace in one list, most recent change first', () => {
    const cards = dashboardCards([
      wsNode('A', [agentPane('a1', 100), agentPane('a2', 300)]),
      wsNode('B', [agentPane('b1', 200)]),
    ]);
    assert.deepEqual(cards.map((c) => c.pane.paneId), ['a2', 'b1', 'a1']);
    assert.deepEqual(cards.map((c) => c.workspaceLabel), ['A-label', 'B-label', 'A-label']);
  });

  it('leaves the orchestrators out, and with a scope keeps only its panes', () => {
    const ws = [wsNode('A', [agentPane('a1', 100), agentPane('a2', 300)]), wsNode('B', [agentPane('b1', 200)])];
    assert.deepEqual(dashboardCards(ws, ['a1']).map((c) => c.pane.paneId), ['a2', 'b1']);
    assert.deepEqual(dashboardCards(ws, ['gone', null]).map((c) => c.pane.paneId), ['a2', 'b1', 'a1']);
    assert.deepEqual(dashboardCards(ws, ['a1'], ['a1', 'b1']).map((c) => c.pane.paneId), ['b1']);
    assert.deepEqual(dashboardCards(ws, [], []).map((c) => c.pane.paneId), []);
  });

  it("orders by herdr's state_change_seq, not the bridge's clock; a change not fetched yet first", () => {
    // right after a bridge restart every sinceUnixMs is the restart time; w1 has been working
    // since before it (seq 30), i1/i2 went idle earlier (10, 20), n1 just changed (null, newer time)
    const cards = dashboardCards([
      wsNode('A', [agentPane('i1', 5, 'idle', 10, 10), agentPane('i2', 5, 'idle', 20, 20)]),
      wsNode('B', [agentPane('w1', 5, 'working', null, 30), agentPane('n1', 9, 'idle', null, null)]),
    ]);
    assert.deepEqual(cards.map((c) => c.pane.paneId), ['n1', 'w1', 'i2', 'i1']);
  });

  it('keeps workspace order for equal times (e.g. right after a bridge restart)', () => {
    const cards = dashboardCards([wsNode('A', [agentPane('a1', 5)]), wsNode('B', [agentPane('b1', 5)])]);
    assert.deepEqual(cards.map((c) => c.pane.paneId), ['a1', 'b1']);
  });

  it('skips non-agent panes and numbers agents within their tab', () => {
    const cards = dashboardCards([wsNode('A', [shell('s'), agentPane('a1', 1), agentPane('a2', 2)])]);
    assert.deepEqual(cards.map((c) => [c.pane.paneId, c.tabAgentIndex, c.tabAgentCount]), [['a2', 2, 2], ['a1', 1, 2]]);
  });

  it('carries each card its own workspace git context', () => {
    const wt: WorktreeInfo = { repoKey: 'k', repoName: 'repo', repoRoot: '/r', checkoutPath: '/r/w', isLinkedWorktree: true, branch: 'feat/x' };
    const [card] = dashboardCards([wsNode('W', [agentPane('w1', 1)], wt)]);
    assert.equal(card.branch, 'feat/x');
    assert.equal(card.isWorktree, true);
  });
});

describe('homeSummary', () => {
  it("lists blocked agents (newest first) and counts the rest, of the Home's agents only", () => {
    const ws = [wsNode('A', [
      agentPane('orch', 900, 'working'), agentPane('other', 1, 'working'),
      agentPane('b1', 100, 'blocked'), agentPane('b2', 300, 'blocked'),
      agentPane('w1', 1, 'working'), agentPane('d1', 1, 'done'), agentPane('i1', 1, 'idle'), agentPane('u1', 1, 'unknown'),
    ])];
    const s = homeSummary(dashboardCards(ws, ['orch'], ['orch', 'b1', 'b2', 'w1', 'd1', 'i1', 'u1']));
    assert.deepEqual(s.blocked.map((c) => c.pane.paneId), ['b2', 'b1']);
    assert.deepEqual([s.working, s.done, s.idle], [1, 1, 2]);
  });

  it('counts a done agent the phone has opened as idle', () => {
    const ws = [wsNode('A', [agentPane('d1', 10, 'done', 5), agentPane('d2', 10, 'done', 6)])];
    const s = homeSummary(dashboardCards(ws), markSeen({}, ws, 'd1'));
    assert.deepEqual([s.done, s.idle], [1, 1]);
  });
});

describe('byUrgency', () => {
  it('puts blocked, then working, done, idle and unknown, each newest first; a done the phone has opened is idle', () => {
    const ws = [wsNode('A', [
      agentPane('i1', 900, 'idle'), agentPane('d1', 800, 'done', 5), agentPane('w1', 700, 'working'), agentPane('u1', 600, 'unknown'),
      agentPane('b1', 500, 'blocked'), agentPane('w2', 400, 'working'), agentPane('d2', 300, 'done', 6), agentPane('b2', 200, 'blocked'),
    ])];
    assert.deepEqual(byUrgency(dashboardCards(ws)).map((c) => c.pane.paneId), ['b1', 'b2', 'w1', 'w2', 'd1', 'd2', 'i1', 'u1']);
    assert.deepEqual(byUrgency(dashboardCards(ws), markSeen({}, ws, 'd1')).map((c) => c.pane.paneId), ['b1', 'b2', 'w1', 'w2', 'd2', 'i1', 'd1', 'u1']);
  });
});

describe('phone-seen done', () => {
  // completionSeq is herdr's completion_seq: which completion this is (stable across bridge restarts)
  const done = (id: string, seq: number | null, since = 1): PaneNode => agentPane(id, since, 'done', seq);
  const ws1 = (...panes: PaneNode[]) => [wsNode('A', panes)];

  it('shows a done pane the phone has opened as idle, until its next completion', () => {
    const seen = markSeen({}, ws1(done('a1', 10)), 'a1');
    assert.equal(shownStatus(done('a1', 10), seen), 'idle');
    assert.equal(shownStatus(done('a1', 10, 999), seen), 'idle'); // bridge restart: new sinceUnixMs, same completion
    assert.equal(shownStatus(done('a1', 20), seen), 'done'); // a new completion
    assert.equal(shownStatus(done('b1', 10), seen), 'done'); // another pane
  });

  it('only records a done pane whose completion is known, and drops entries that went stale', () => {
    assert.deepEqual(markSeen({}, ws1(agentPane('w', 1, 'idle', 3)), 'w'), {}); // not done
    // seq not fetched yet: nothing to tie the view to (it would have to guess which completion)
    assert.deepEqual(markSeen({}, ws1(done('n', null)), 'n'), {});
    let seen = markSeen({}, ws1(done('a1', 10), done('a2', 11)), 'a1');
    seen = markSeen(seen, ws1(done('a1', 30), done('a2', 11)), 'a2');
    assert.deepEqual(seen, { a2: 11 }); // a1 completed again since it was seen
  });

  it("keeps a done pane's record while its completionSeq is being refetched (bridge restart)", () => {
    assert.deepEqual(markSeen({ a1: 42 }, ws1(done('a1', null), done('b1', 3)), 'b1'), { a1: 42, b1: 3 });
  });
});

describe('homeGroups', () => {
  const ws = [wsNode('A', [agentPane('a1', 100), agentPane('a2', 300)]), wsNode('B', [agentPane('b1', 200), agentPane('b2', 50)])];
  const orch = (name: string, agents: string[] | null, paneId: string | null = null): OrchestratorView =>
    ({ name, label: '', paneId, agents, mode: 'tui', headless: null });
  const ids = (groups: ReturnType<typeof homeGroups>): Array<[string | null, string[]]> =>
    groups.map((g) => [g.home?.name ?? null, g.cards.map((c) => c.pane.paneId)]);

  it("puts each orchestrator's account's agents under it, in config order, the list's order within", () => {
    const groups = homeGroups(dashboardCards(ws), [orch('work', ['b1', 'b2']), orch('personal', ['a1', 'a2'])]);
    assert.deepEqual(ids(groups), [['work', ['b1', 'b2']], ['personal', ['a2', 'a1']]]);
  });

  it('ends with Other (home null): the agents no orchestrator lists, left out when there are none', () => {
    assert.deepEqual(ids(homeGroups(dashboardCards(ws), [orch('personal', ['a1', 'a2'])])), [['personal', ['a2', 'a1']], [null, ['b1', 'b2']]]);
    assert.deepEqual(ids(homeGroups(dashboardCards(ws), [])), [[null, ['a2', 'b1', 'a1', 'b2']]]);
    assert.deepEqual(ids(homeGroups([], [orch('personal', [])])), [['personal', []]]);
  });

  it("gives an orchestrator whose account isn't known none (its Home counts every agent, a list of them all would repeat them)", () => {
    assert.deepEqual(ids(homeGroups(dashboardCards(ws), [orch('personal', ['a1']), orch('work', null)])),
      [['personal', ['a1']], ['work', []], [null, ['a2', 'b1', 'b2']]]);
  });

  it('lists an agent under every orchestrator of its account, as each Home counts it', () => {
    assert.deepEqual(ids(homeGroups(dashboardCards(ws), [orch('o1', ['a1', 'b1', 'a2', 'b2']), orch('o2', ['a1', 'b1', 'a2', 'b2'])])),
      [['o1', ['a2', 'b1', 'a1', 'b2']], ['o2', ['a2', 'b1', 'a1', 'b2']]]);
  });
});

describe('orchestratorStatus', () => {
  const o = (paneId: string | null): OrchestratorView => ({ name: 'p', label: '', paneId, agents: null, mode: 'tui', headless: null });
  it('is stopped without a pane, unknown while its pane has no agent, else its shown status', () => {
    assert.equal(orchestratorStatus(o(null), undefined, {}), 'stopped');
    assert.equal(orchestratorStatus(o('x'), shell('x'), {}), 'unknown');
    assert.equal(orchestratorStatus(o('x'), undefined, {}), 'unknown');
    assert.equal(orchestratorStatus(o('x'), agentPane('x', 1, 'working'), {}), 'working');
    assert.equal(orchestratorStatus(o('x'), agentPane('x', 1, 'done', 4), { x: 4 }), 'idle'); // a seen done
  });
});
