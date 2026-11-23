import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardCards, homeSummary, markSeen, shownStatus } from '../src/dashboard-group.ts';
import type { AgentStatus, PaneNode, WorkspaceNode, WorktreeInfo } from '../src/types.ts';

function agentPane(id: string, sinceUnixMs: number, status: AgentStatus = 'idle', completionSeq: number | null = null): PaneNode {
  return {
    paneId: id, focused: false, cwd: null, launchCwd: null, title: null,
    agent: { name: 'claude', displayName: null, status, customStatus: null, message: null, sinceUnixMs, completionSeq },
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

  it('pins the orchestrator first, then the rest by recency', () => {
    const ws = [wsNode('A', [agentPane('a1', 100), agentPane('a2', 300)]), wsNode('B', [agentPane('b1', 200)])];
    assert.deepEqual(dashboardCards(ws, 'a1').map((c) => c.pane.paneId), ['a1', 'a2', 'b1']);
    assert.deepEqual(dashboardCards(ws, 'gone').map((c) => c.pane.paneId), ['a2', 'b1', 'a1']);
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
  it('lists blocked agents (newest first) and counts the rest, excluding the orchestrator', () => {
    const ws = [wsNode('A', [
      agentPane('orch', 900, 'working'),
      agentPane('b1', 100, 'blocked'), agentPane('b2', 300, 'blocked'),
      agentPane('w1', 1, 'working'), agentPane('d1', 1, 'done'), agentPane('i1', 1, 'idle'), agentPane('u1', 1, 'unknown'),
    ])];
    const s = homeSummary(ws, 'orch');
    assert.deepEqual(s.blocked.map((c) => c.pane.paneId), ['b2', 'b1']);
    assert.deepEqual([s.working, s.done, s.idle], [1, 1, 2]);
  });

  it('counts a done agent the phone has opened as idle', () => {
    const ws = [wsNode('A', [agentPane('d1', 10, 'done', 5), agentPane('d2', 10, 'done', 6)])];
    const s = homeSummary(ws, null, markSeen({}, ws, 'd1'));
    assert.deepEqual([s.done, s.idle], [1, 1]);
  });
});

describe('phone-seen done', () => {
  // completionSeq is herdr's completion_seq: which completion this is (stable across bridge restarts)
  const done = (id: string, seq: number | null, since = 1): PaneNode => agentPane(id, since, 'done', seq);

  it('shows a done pane the phone has opened as idle, until its next completion', () => {
    const seen = markSeen({}, [wsNode('A', [done('a1', 10)])], 'a1');
    assert.equal(shownStatus(done('a1', 10), seen), 'idle');
    assert.equal(shownStatus(done('a1', 10, 999), seen), 'idle'); // bridge restart: new sinceUnixMs, same completion
    assert.equal(shownStatus(done('a1', 20), seen), 'done'); // a new completion
    assert.equal(shownStatus(done('b1', 10), seen), 'done'); // another pane
  });

  it('only records done panes with a known completion and drops entries that went stale', () => {
    assert.deepEqual(markSeen({}, [wsNode('A', [agentPane('w', 1, 'idle', 3)])], 'w'), {}); // not done
    assert.deepEqual(markSeen({}, [wsNode('A', [done('n', null)])], 'n'), {}); // seq not fetched yet
    let seen = markSeen({}, [wsNode('A', [done('a1', 10), done('a2', 11)])], 'a1');
    seen = markSeen(seen, [wsNode('A', [done('a1', 30), done('a2', 11)])], 'a2');
    assert.deepEqual(seen, { a2: 11 }); // a1 completed again since it was seen
  });
});
