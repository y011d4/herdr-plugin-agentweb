import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { enrichStateWorktrees, refreshWorktrees, worktreeForCwd, isNotARepo, resolveOutcome, parseGit, _setGitRunForTest } from '../worktree-resolve.ts';
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

  it('keeps the existing worktree on a cache miss (undefined = not resolved yet)', () => {
    const herdrWt: WorktreeInfo = { ...DERIVED, branch: null };
    const state = mkState([ws('w1', '/home/u/repo', herdrWt)]);
    const next = enrichStateWorktrees(state, () => undefined);
    assert.equal(next.workspaces[0].worktree, herdrWt);
  });

  it('clears the worktree when the cwd resolves as not a repo (null, not a miss)', () => {
    // Regression: a repo that stops resolving must drop its stale branch/grouping.
    const state = mkState([ws('w1', '/home/u/repo', DERIVED)]);
    const next = enrichStateWorktrees(state, () => null);
    assert.equal(next.workspaces[0].worktree, null);
    assert.equal(state.workspaces[0].worktree, DERIVED); // input not mutated
  });

  it('gives two same-repo workspaces an identical repoKey (grouping enabler)', () => {
    const state = mkState([
      ws('w1', '/home/u/repo', null),
      ws('w2', '/home/u/repo/pkg/a', null),
    ]);
    const next = enrichStateWorktrees(state, (cwd) => ({ ...DERIVED, checkoutPath: cwd }));
    assert.equal(next.workspaces[0].worktree!.repoKey, next.workspaces[1].worktree!.repoKey);
  });

  it('returns the same state reference on a cache miss (nothing changed)', () => {
    const state = mkState([ws('w1', '/home/u/repo', null)]);
    assert.equal(enrichStateWorktrees(state, () => undefined), state);
  });

  it('does not mutate the input state', () => {
    const state = mkState([ws('w1', '/home/u/repo', null)]);
    const before = JSON.stringify(state.workspaces);
    enrichStateWorktrees(state, () => DERIVED);
    assert.equal(JSON.stringify(state.workspaces), before);
    assert.equal(state.workspaces[0].worktree, null);
  });
});

describe('resolveOutcome (what to cache from a git outcome)', () => {
  const A: WorktreeInfo = { ...DERIVED, branch: 'a' };
  const B: WorktreeInfo = { ...DERIVED, branch: 'b' };

  it('uses the parsed info on success', () => {
    assert.equal(resolveOutcome(A, false, B, false), B);
  });

  it('keeps the last known value on success with malformed output', () => {
    assert.equal(resolveOutcome(A, false, null, false), A);
  });

  it('resolves to null for an authoritative not-a-repo', () => {
    assert.equal(resolveOutcome(A, true, null, true), null);
  });

  it('keeps the last resolved value on a transient failure (branch survives a hiccup)', () => {
    assert.equal(resolveOutcome(A, true, null, false), A);
  });

  it('stays undefined on a transient failure with nothing resolved yet', () => {
    assert.equal(resolveOutcome(undefined, true, null, false), undefined);
  });
});

describe('parseGit', () => {
  it('names a linked worktree by its main repo, not its checkout dir', () => {
    const info = parseGit([
      '/home/u/repo/.git',                  // git-common-dir
      '/home/u/repo/.git/worktrees/feat-x', // git-dir (differs → linked worktree)
      '/home/u/.wt/repo/feat-x',            // show-toplevel (worktree checkout dir)
      'feat/x',                             // branch
    ].join('\n'));
    assert.ok(info);
    assert.equal(info!.isLinkedWorktree, true);
    assert.equal(info!.repoName, 'repo'); // the repo, not "feat-x"
    assert.equal(info!.repoKey, '/home/u/repo/.git');
    assert.equal(info!.branch, 'feat/x');
  });

  it('names a linked worktree of a submodule by the submodule, not "modules"', () => {
    const info = parseGit([
      '/super/.git/modules/sub',              // git-common-dir (submodule)
      '/super/.git/modules/sub/worktrees/wt', // git-dir (differs → linked worktree)
      '/home/u/.wt/sub-wt',                   // show-toplevel
      'feat/y',
    ].join('\n'));
    assert.equal(info!.isLinkedWorktree, true);
    assert.equal(info!.repoName, 'sub');
  });

  it('names a main checkout by its working-tree dir', () => {
    const info = parseGit(['/home/u/repo/.git', '/home/u/repo/.git', '/home/u/repo', 'main'].join('\n'));
    assert.equal(info!.isLinkedWorktree, false);
    assert.equal(info!.repoName, 'repo');
  });

  it('returns null for malformed (too-few-lines) output', () => {
    assert.equal(parseGit('/home/u/repo/.git\n'), null);
  });
});

describe('isNotARepo (git failure classification)', () => {
  it('is authoritative only for exit 128 with git\'s "fatal: not a git repository" line', () => {
    assert.equal(isNotARepo(128, 'fatal: not a git repository (or any parent up to /)'), true);
  });

  it('does not match the phrase mid-line (e.g. inside a path)', () => {
    assert.equal(isNotARepo(128, "fatal: cannot open '/tmp/not a git repository/x'"), false);
  });

  it('treats other exit-128 fatals (dubious ownership, permissions) as transient', () => {
    assert.equal(isNotARepo(128, 'fatal: detected dubious ownership in repository at ...'), false);
    assert.equal(isNotARepo(128, 'fatal: could not read Permission denied'), false);
  });

  it('treats a missing git, a timeout, or any other failure as transient', () => {
    assert.equal(isNotARepo('ENOENT', ''), false); // git binary not found
    assert.equal(isNotARepo(undefined, ''), false); // killed by timeout
    assert.equal(isNotARepo(1, 'some error'), false); // other non-zero exit
  });
});

describe('git concurrency limit (process-wide MAX_CONCURRENCY)', () => {
  it('caps simultaneous resolutions across overlapping refreshes of disjoint cwds', async () => {
    let active = 0;
    let peak = 0;
    _setGitRunForTest((_cwd) => new Promise((res) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        res({ code: 0, stdout: '/r/.git\n/r/.git\n/r\nmain\n', stderr: '' });
      }, 15);
    }));
    try {
      const setA = ['a', 'b', 'c', 'd', 'e'].map((x) => `/conc/${x}`);
      const setB = ['f', 'g', 'h', 'i', 'j'].map((x) => `/conc/${x}`); // disjoint from setA
      await Promise.all([refreshWorktrees(setA, () => {}), refreshWorktrees(setB, () => {})]);
      assert.ok(peak > 0, 'expected the stub runner to be exercised');
      assert.ok(peak <= 4, `peak concurrency ${peak} exceeded MAX_CONCURRENCY (4)`);
    } finally {
      _setGitRunForTest(null);
    }
  });
});

describe('refreshWorktrees + worktreeForCwd (real git)', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

  it('resolves this repo into the cache (branch, non-linked, .git repoKey) and fires onChange', async () => {
    let changed = false;
    await refreshWorktrees([repoRoot], () => { changed = true; });
    assert.equal(changed, true);
    const info = worktreeForCwd(repoRoot);
    assert.ok(info, 'expected cached worktree info after refresh');
    assert.equal(info!.isLinkedWorktree, false);
    assert.ok(info!.repoKey.endsWith('.git'), `repoKey should end with .git, got ${info!.repoKey}`);
    const raw = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert.equal(info!.branch, raw === 'HEAD' ? null : raw);
  });

  it('does not re-resolve or fire onChange within the TTL', async () => {
    const cwd = join(repoRoot, 'bin'); // self-contained: primed within this test
    await refreshWorktrees([cwd], () => {}); // first resolve populates the cache
    let changed = false;
    await refreshWorktrees([cwd], () => { changed = true; }); // still fresh → no-op
    assert.equal(changed, false);
  });

  it('caches null for a path outside any repo', async () => {
    await refreshWorktrees(['/'], () => {});
    assert.equal(worktreeForCwd('/'), null);
  });

  it('coalesces concurrent refreshes of the same uncached cwd (reserved before await)', async () => {
    // A fresh cache key (a real subdir of this repo, not resolved by earlier tests).
    const cwd = join(repoRoot, 'server');
    let fires = 0;
    await Promise.all([
      refreshWorktrees([cwd], () => { fires++; }),
      refreshWorktrees([cwd], () => { fires++; }),
    ]);
    // The first call reserves the cwd synchronously before awaiting, so the
    // second sees it in-flight and does nothing — only one resolution/onChange.
    assert.equal(fires, 1);
    assert.ok(worktreeForCwd(cwd));
  });
});
