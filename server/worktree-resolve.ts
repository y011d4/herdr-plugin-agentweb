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
// info: resolved repo (WorktreeInfo), confirmed non-repo (null), or unknown
// (undefined — never successfully resolved). A transient failure keeps the last
// known info rather than overwriting it, so a resolved branch survives a timeout
// or a git hiccup; `at` records the last attempt so failures still back off.
const cache = new Map<string, { at: number; info: WorktreeInfo | null | undefined }>();
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

export function parseGit(stdout: string): WorktreeInfo | null {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 4) return null;
  const [commonDir, gitDir, toplevel, branchRaw] = lines;
  // repoKey is the shared common .git dir — identical for a main checkout and
  // all its linked worktrees, and byte-identical to herdr's own repoKey.
  const repoRoot = dirname(commonDir);
  // linked worktrees have a per-worktree gitDir under <common>/worktrees/*.
  const isLinkedWorktree = gitDir !== commonDir;
  return {
    repoKey: commonDir,
    // Repo name: a linked worktree's own checkout dir isn't the repo, so name it
    // from the main repo root (dirname of the shared .git). A main checkout or a
    // submodule uses its working-tree dir — a submodule's repoRoot would be the
    // meaningless ".../modules".
    repoName: isLinkedWorktree ? basename(repoRoot) : basename(toplevel),
    repoRoot,
    checkoutPath: toplevel,
    isLinkedWorktree,
    // `--abbrev-ref HEAD` yields "HEAD" on a detached checkout.
    branch: branchRaw && branchRaw !== 'HEAD' ? branchRaw : null,
  };
}

// Classify a `git rev-parse` failure. git exits 128 for many fatal conditions
// (dubious ownership, permission errors, a deleted cwd, ...), so only the actual
// "not a git repository" message is an authoritative negative that should clear
// worktree data. A missing git binary (string code like ENOENT), a timeout
// (killed, code null), and every other 128 are tooling failures that must NOT
// erase herdr-provided worktree data. Requires LC_ALL=C so the message is English.
export function isNotARepo(code: string | number | undefined, stderr: string): boolean {
  // Anchor to git's actual diagnostic line so an unrelated 128 whose path/detail
  // merely contains the phrase isn't misread as authoritative.
  return code === 128 && /^fatal: not a git repository/m.test(stderr);
}

// Decide the value to cache from a git outcome, given the last known value:
//   - success with valid output → the parsed repo info
//   - authoritative "not a git repository" → null
//   - anything else (transient failure, or success with malformed output) → keep
//     the last known value, so a resolved branch survives a git hiccup.
export function resolveOutcome(
  prevInfo: WorktreeInfo | null | undefined,
  failed: boolean,
  parsed: WorktreeInfo | null,
  notARepo: boolean,
): WorktreeInfo | null | undefined {
  if (!failed) return parsed !== null ? parsed : prevInfo;
  if (notARepo) return null;
  return prevInfo;
}

// Resolve one cwd (already reserved in `inflight` by the caller) with `git
// rev-parse` off the event loop, update the cache, and clear the reservation.
// Resolves to true when the effective value changed. Never rejects.
async function resolveCwd(cwd: string): Promise<boolean> {
  await acquire();
  return new Promise((done) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      // LC_ALL=C so a "not a git repository" failure is reported in English.
      { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        release();
        inflight.delete(cwd);
        const prevInfo = cache.get(cwd)?.info;
        const info = resolveOutcome(prevInfo, !!err, err ? null : parseGit(stdout), !!err && isNotARepo(err.code, stderr));
        // `at` records the attempt (even a failed one) so transient failures back off.
        cache.set(cwd, { at: Date.now(), info });
        done(JSON.stringify(prevInfo) !== JSON.stringify(info));
      },
    );
  });
}

// Synchronous cache read for a workspace cwd. undefined = not resolved (cache
// miss, or only ever a transient failure); null = git confirmed it isn't a repo;
// WorktreeInfo = a resolved checkout (also returned through a later transient
// failure, since the last known value is preserved).
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
