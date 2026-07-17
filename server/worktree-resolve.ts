/**
 * Fills in git context herdr's session.snapshot omits — most importantly the
 * current branch, which the snapshot never carries — by resolving each
 * workspace's cwd with `git rev-parse`. repoKey uses git's shared
 * `--git-common-dir`, matching herdr's own repoKey, and isLinkedWorktree is
 * derived (git-dir differs from the common dir for a linked worktree).
 *
 * This is the I/O layer's job, not state.ts's: state.ts stays pure. Enrichment
 * runs on the createState result (herdr-client) before the state is delivered.
 */

import { spawnSync } from 'node:child_process';
import { dirname, basename } from 'node:path';
import type { NormalizedState, WorkspaceNode, WorktreeInfo } from './types.ts';

export type RepoResolver = (cwd: string) => WorktreeInfo | null;

// cwd → git info, cached with a short TTL so a `git checkout` (branch change
// without a cwd change) is picked up on the next snapshot within the window,
// while a burst of snapshots still costs at most one `git` per cwd per window.
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; info: WorktreeInfo | null }>();

function gitResolve(cwd: string): WorktreeInfo | null {
  const res = spawnSync(
    'git',
    ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'],
    { encoding: 'utf8', timeout: 2000 },
  );
  if (res.error || res.status !== 0 || !res.stdout) return null;
  const lines = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return null;
  const [commonDir, gitDir, toplevel, branchRaw] = lines;
  // repoKey is the shared common .git dir — identical for a main checkout and
  // all its linked worktrees, and byte-identical to herdr's own repoKey.
  const repoRoot = dirname(commonDir);
  return {
    repoKey: commonDir,
    // Name from the working tree (--show-toplevel): a submodule's common dir is
    // <super>/.git/modules/<name>, whose parent basename is a meaningless "modules".
    repoName: basename(toplevel),
    repoRoot,
    checkoutPath: toplevel,
    // linked worktrees have a per-worktree gitDir under <common>/worktrees/*.
    isLinkedWorktree: gitDir !== commonDir,
    // `--abbrev-ref HEAD` yields "HEAD" on a detached checkout.
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
  };
}

/** Resolve a workspace's git context from its cwd (cached). Returns null when
 *  the cwd is not inside a git repo, or git is unavailable. */
export function resolveRepoFromCwd(cwd: string): WorktreeInfo | null {
  const now = Date.now();
  const hit = cache.get(cwd);
  if (hit && now - hit.at < TTL_MS) return hit.info;
  const info = gitResolve(cwd);
  cache.set(cwd, { at: now, info });
  return info;
}

/**
 * Return a state where every workspace with a cwd carries git-derived worktree
 * info (adding the branch herdr omits, and filling worktree info for checkouts
 * herdr didn't tag). git is authoritative and consistent with herdr's fields;
 * a workspace keeps herdr's worktree (branch-less) when git can't resolve it.
 * Input state is not mutated. The resolver is injectable for tests.
 */
export function enrichStateWorktrees(
  state: NormalizedState,
  resolve: RepoResolver = resolveRepoFromCwd,
): NormalizedState {
  let changed = false;
  const workspaces = state.workspaces.map((ws): WorkspaceNode => {
    if (!ws.cwd) return ws;
    const derived = resolve(ws.cwd);
    if (!derived) return ws;
    changed = true;
    return { ...ws, worktree: derived };
  });
  if (!changed) return state;
  return { ...state, workspaces };
}
