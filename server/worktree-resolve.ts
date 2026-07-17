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

// Process-wide concurrency limit for git: a counting semaphore shared by every
// refreshWorktrees call, so overlapping refreshes can't collectively exceed it.
let running = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  if (running < MAX_CONCURRENCY) { running++; return Promise.resolve(); }
  return new Promise((res) => waiters.push(res));
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot straight to a waiter; running stays put
  else running--;
}

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
async function resolveCwd(cwd: string): Promise<boolean> {
  await acquire();
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      { timeout: 2000 },
      (err, stdout) => {
        release();
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
// undefined = not resolved yet (cache miss); null = git resolved it as not a
// repo; WorktreeInfo = a resolved git checkout.
export function worktreeForCwd(cwd: string): WorktreeInfo | null | undefined {
  const hit = cache.get(cwd);
  return hit ? hit.info : undefined;
}

/**
 * Return a state where every workspace with a cwd carries its cached git
 * worktree info. Reads only the cache — never spawns git — so it is safe on the
 * snapshot hot path. Input state is not mutated. `lookup` is injectable for tests.
 */
export function enrichStateWorktrees(
  state: NormalizedState,
  lookup: (cwd: string) => WorktreeInfo | null | undefined = worktreeForCwd,
): NormalizedState {
  let changed = false;
  const workspaces = state.workspaces.map((ws): WorkspaceNode => {
    if (!ws.cwd) return ws;
    const info = lookup(ws.cwd);
    // Cache miss (undefined): not resolved yet — keep whatever baseline the
    // snapshot carried. Resolved (WorktreeInfo or null): apply it, which also
    // clears a previously-shown worktree when the cwd is no longer a git repo.
    if (info === undefined) return ws;
    if (JSON.stringify(ws.worktree ?? null) === JSON.stringify(info)) return ws;
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
  // refresh (snapshot + interval) filters these out instead of re-selecting the
  // same cwds. Actual git concurrency is bounded process-wide by the semaphore in
  // resolveCwd, so all stale cwds can be launched at once here.
  for (const cwd of stale) inflight.add(cwd);
  const results = await Promise.all(stale.map(resolveCwd));
  if (results.some(Boolean)) onChange();
}
