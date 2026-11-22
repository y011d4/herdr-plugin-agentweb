import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardCards } from '../src/dashboard-group.ts';
import type { PaneNode, WorkspaceNode, WorktreeInfo } from '../src/types.ts';

function agentPane(id: string, sinceUnixMs: number): PaneNode {
  return {
    paneId: id, focused: false, cwd: null, title: null,
    agent: { name: 'claude', displayName: null, status: 'idle', customStatus: null, message: null, sinceUnixMs },
  };
}
const shell = (id: string): PaneNode => ({ paneId: id, focused: false, cwd: null, title: null, agent: null });

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
