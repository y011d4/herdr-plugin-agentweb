import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { enrichStateWorktrees, resolveRepoFromCwd } from '../worktree-resolve.ts';
import type { NormalizedState, WorkspaceNode, WorktreeInfo } from '../types.ts';

function mkState(workspaces: WorkspaceNode[]): NormalizedState {
  return {
    connected: true,
    herdr: { version: '0.7.3', protocol: 16 },
    focused: { workspaceId: null, tabId: null, paneId: null },
    workspaces,
    _paneById: new Map(),
    _tabById: new Map(),
  };
}

function ws(id: string, cwd: string | null, worktree: WorktreeInfo | null): WorkspaceNode {
  return { workspaceId: id, label: id, cwd, worktree, tabs: [] };
}

const DERIVED: WorktreeInfo = {
  repoKey: '/home/u/repo/.git',
  repoName: 'repo',
  repoRoot: '/home/u/repo',
  checkoutPath: '/home/u/repo',
  isLinkedWorktree: false,
  branch: 'main',
};

describe('enrichStateWorktrees', () => {
  it('derives git worktree info (incl. branch) from cwd', () => {
    const state = mkState([ws('w1', '/home/u/repo', null)]);
    const next = enrichStateWorktrees(state, () => DERIVED);
    assert.deepEqual(next.workspaces[0].worktree, DERIVED);
  });

  it('overrides herdr\'s branch-less worktree with the git-derived one (adds branch)', () => {
    const herdrWt: WorktreeInfo = { ...DERIVED, branch: null };
    const state = mkState([ws('w1', '/home/u/repo', herdrWt)]);
    const next = enrichStateWorktrees(state, () => DERIVED);
    assert.equal(next.workspaces[0].worktree!.branch, 'main');
  });

  it('keeps worktree null when the workspace has no cwd', () => {
    let called = false;
    const state = mkState([ws('w1', null, null)]);
    const next = enrichStateWorktrees(state, () => { called = true; return DERIVED; });
    assert.equal(called, false);
    assert.equal(next.workspaces[0].worktree, null);
  });

  it('keeps the existing worktree when git can\'t resolve the cwd', () => {
    const herdrWt: WorktreeInfo = { ...DERIVED, branch: null };
    const state = mkState([ws('w1', '/tmp/not-a-repo', herdrWt)]);
    const next = enrichStateWorktrees(state, () => null);
    assert.equal(next.workspaces[0].worktree, herdrWt);
  });

  it('gives two same-repo workspaces an identical repoKey (grouping enabler)', () => {
    const state = mkState([
      ws('w1', '/home/u/repo', null),
      ws('w2', '/home/u/repo/pkg/a', null),
    ]);
    const next = enrichStateWorktrees(state, (cwd) => ({ ...DERIVED, checkoutPath: cwd }));
    assert.equal(next.workspaces[0].worktree!.repoKey, next.workspaces[1].worktree!.repoKey);
  });

  it('returns the same state reference when nothing resolved', () => {
    const state = mkState([ws('w1', null, null)]);
    assert.equal(enrichStateWorktrees(state, () => null), state);
  });

  it('does not mutate the input state', () => {
    const state = mkState([ws('w1', '/home/u/repo', null)]);
    const before = JSON.stringify(state.workspaces);
    enrichStateWorktrees(state, () => DERIVED);
    assert.equal(JSON.stringify(state.workspaces), before);
    assert.equal(state.workspaces[0].worktree, null);
  });
});

describe('resolveRepoFromCwd (real git)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  it('resolves this repo: non-linked, .git repoKey, and the actual branch', () => {
    const info = resolveRepoFromCwd(repoRoot);
    assert.ok(info, 'expected a resolved worktree for the repo root');
    assert.equal(info!.isLinkedWorktree, false);
    assert.ok(info!.repoKey.endsWith('.git'), `repoKey should end with .git, got ${info!.repoKey}`);
    const raw = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(info!.branch, raw === 'HEAD' ? null : raw);
  });

  it('returns null for a path outside any repo', () => {
    assert.equal(resolveRepoFromCwd('/'), null);
  });
});
