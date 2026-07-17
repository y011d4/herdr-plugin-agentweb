/**
 * Fills in git context herdr's session.snapshot omits — most importantly the
 * current branch, which the snapshot never carries — by resolving each
 * workspace's cwd with `git rev-parse`. repoKey uses git's shared
 * `--git-common-dir`, matching herdr's own repoKey, and isLinkedWorktree is
 * derived (git-dir differs from the common dir for a linked worktree).
 *
 * Resolution is asynchronous and cached so it never blocks the server event
 * loop: the snapshot path only READS the cache (`enrichStateWorktrees`), while
 * `refreshWorktrees` runs `git` off the hot path (bounded concurrency) and
 * invokes a callback when anything changed so the state can be re-broadcast.
 * A short TTL lets a `git checkout` surface on the next refresh. state.ts stays
 * pure — this all lives in the client I/O layer.
 */

import { execFile } from 'node:child_process';
import { dirname, basename } from 'node:path';
import type { NormalizedState, WorkspaceNode, WorktreeInfo } from './types.ts';

const TTL_MS = 30_000;
const MAX_CONCURRENCY = 4;
const cache = new Map<string, { at: number; info: WorktreeInfo | null }>();
const inflight = new Set<string>();

function parseGit(stdout: string): WorktreeInfo | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
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

// Resolve one cwd (already reserved in `inflight` by the caller) with `git
// rev-parse` off the event loop, update the cache, and clear the reservation.
// Resolves to true when the cached info changed. Never rejects.
function resolveCwd(cwd: string): Promise<boolean> {
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      { timeout: 2000 },
      (err, stdout) => {
        inflight.delete(cwd);
        const info = err ? null : parseGit(stdout);
        const prev = cache.get(cwd);
        cache.set(cwd, { at: Date.now(), info });
        done(!prev || JSON.stringify(prev.info) !== JSON.stringify(info));
      },
    );
  });
}

/** Synchronous cache read for a workspace cwd (null until a refresh has run). */
export function worktreeForCwd(cwd: string): WorktreeInfo | null {
  return cache.get(cwd)?.info ?? null;
}

/**
 * Return a state where every workspace with a cwd carries its cached git
 * worktree info. Reads only the cache — never spawns git — so it is safe on the
 * snapshot hot path. Input state is not mutated. `lookup` is injectable for tests.
 */
export function enrichStateWorktrees(
  state: NormalizedState,
  lookup: (cwd: string) => WorktreeInfo | null = worktreeForCwd,
): NormalizedState {
  let changed = false;
  const workspaces = state.workspaces.map((ws): WorkspaceNode => {
    if (!ws.cwd) return ws;
    const info = lookup(ws.cwd);
    if (!info) return ws;
    changed = true;
    return { ...ws, worktree: info };
  });
  if (!changed) return state;
  return { ...state, workspaces };
}

/**
 * Resolve git info for the given cwds that are missing or past their TTL, off
 * the event loop with bounded concurrency, updating the cache. Calls onChange()
 * once if any cached entry changed (so the caller can re-enrich + re-broadcast).
 */
export async function refreshWorktrees(cwds: string[], onChange: () => void): Promise<void> {
  const now = Date.now();
  const stale = [...new Set(cwds)].filter((cwd) => {
    if (inflight.has(cwd)) return false;
    const hit = cache.get(cwd);
    return !hit || now - hit.at >= TTL_MS;
  });
  if (stale.length === 0) return;
  // Reserve every selected cwd globally *before* awaiting, so a concurrent
  // refresh (snapshot + interval) filters these out instead of re-selecting and
  // re-spawning git for them — keeps total git concurrency bounded across callers.
  for (const cwd of stale) inflight.add(cwd);

  let anyChanged = false;
  for (let i = 0; i < stale.length; i += MAX_CONCURRENCY) {
    const results = await Promise.all(stale.slice(i, i + MAX_CONCURRENCY).map(resolveCwd));
    if (results.some(Boolean)) anyChanged = true;
  }
  if (anyChanged) onChange();
}
