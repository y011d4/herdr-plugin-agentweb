import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statusOrder, workspaceUrgency, groupWorkspacesForDashboard } from '../src/dashboard-group.ts';
import type { AgentStatus, PaneNode, WorkspaceNode, WorktreeInfo } from '../src/types.ts';

function agentPane(id: string, status: AgentStatus): PaneNode {
  return {
    paneId: id, focused: false, cwd: null, title: null,
    agent: { name: 'claude', displayName: null, status, customStatus: null, message: null, sinceUnixMs: 0 },
  };
}

// A workspace with one agent pane at `status` (or no agent when status is null).
function wsNode(id: string, status: AgentStatus | null, worktree: WorktreeInfo | null): WorkspaceNode {
  const panes = status ? [agentPane(`${id}:p1`, status)] : [];
  return { workspaceId: id, label: id, cwd: null, worktree, tabs: [{ tabId: `${id}:t1`, label: 't', panes }] };
}

function wt(repoKey: string, isLinkedWorktree: boolean): WorktreeInfo {
  return { repoKey, repoName: 'repo', repoRoot: '/r', checkoutPath: `/r/${repoKey}`, isLinkedWorktree, branch: 'b' };
}

describe('statusOrder', () => {
  it('ranks blocked < working < done < idle < unknown, unrecognized last', () => {
    assert.ok(statusOrder('blocked') < statusOrder('working'));
    assert.ok(statusOrder('working') < statusOrder('done'));
    assert.ok(statusOrder('done') < statusOrder('idle'));
    assert.ok(statusOrder('idle') < statusOrder('unknown'));
    assert.ok(statusOrder('unknown') < statusOrder('nonsense'));
  });
});

describe('workspaceUrgency', () => {
  it('is the most urgent agent status across a workspace', () => {
    const ws: WorkspaceNode = {
      workspaceId: 'w', label: 'w', cwd: null, worktree: null,
      tabs: [{ tabId: 't', label: 't', panes: [agentPane('p1', 'idle'), agentPane('p2', 'blocked')] }],
    };
    assert.equal(workspaceUrgency(ws), statusOrder('blocked'));
  });

  it('sorts a workspace with no agents last (rank 6)', () => {
    assert.equal(workspaceUrgency(wsNode('w', null, null)), 6);
  });
});

describe('groupWorkspacesForDashboard', () => {
  it('groups a linked worktree under its main checkout (matched by repoKey)', () => {
    const main = wsNode('M', 'idle', wt('repoK', false));
    const linked = wsNode('Mwt', 'idle', wt('repoK', true));
    const groups = groupWorkspacesForDashboard([main, linked]);
    assert.equal(groups.length, 1); // the worktree is absorbed, not top-level
    assert.equal(groups[0].entry.workspaceId, 'M');
    assert.deepEqual(groups[0].members.map((w) => w.workspaceId), ['M', 'Mwt']);
  });

  it('sorts a group with a blocked worktree ahead of an idle main checkout', () => {
    // The finding's key behavior: a blocked worktree agent must pull its whole
    // group above an unrelated idle main-checkout workspace.
    const idleMain = wsNode('A', 'idle', wt('repoA', false));
    const busyMain = wsNode('B', 'idle', wt('repoB', false));
    const blockedWorktree = wsNode('Bwt', 'blocked', wt('repoB', true));
    const groups = groupWorkspacesForDashboard([idleMain, busyMain, blockedWorktree]);
    assert.deepEqual(groups.map((g) => g.entry.workspaceId), ['B', 'A']); // B's group first
    assert.deepEqual(groups[0].members.map((w) => w.workspaceId), ['B', 'Bwt']);
  });

  it('keeps an orphan worktree (its main checkout is not open) top-level', () => {
    const orphan = wsNode('O', 'working', wt('repoX', true));
    const groups = groupWorkspacesForDashboard([orphan]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].entry.workspaceId, 'O');
    assert.deepEqual(groups[0].members.map((w) => w.workspaceId), ['O']);
  });

  it('leaves a worktree-less workspace flat (a one-member group)', () => {
    const plain = wsNode('P', 'idle', null);
    const groups = groupWorkspacesForDashboard([plain]);
    assert.deepEqual(groups.map((g) => g.members.map((w) => w.workspaceId)), [['P']]);
  });

  it('does not mutate the input array or its order', () => {
    const input = [
      wsNode('A', 'idle', wt('repoA', false)),
      wsNode('B', 'idle', wt('repoB', false)),
      wsNode('Bwt', 'blocked', wt('repoB', true)),
    ];
    const before = input.map((w) => w.workspaceId);
    groupWorkspacesForDashboard(input);
    assert.deepEqual(input.map((w) => w.workspaceId), before);
  });
});
