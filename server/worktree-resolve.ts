/**
 * Fills in git context herdr's session.snapshot omits — most importantly the
 * current branch, which the snapshot never carries — by resolving a workspace's
 * path with `git rev-parse`. A herdr-tagged worktree is resolved from its stable
 * checkout path (not the mutable pane cwd) and only has its branch layered in;
 * an untagged checkout derives its full worktree info from the pane cwd. repoKey
 * uses git's shared
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
  // Repo name: a linked worktree's own checkout dir isn't the repo, so name it
  // from the shared common dir — `<repo>/.git` → its parent (the repo), or a
  // submodule's `<super>/.git/modules/<name>` → its last segment. A main checkout
  // or a submodule main uses its working-tree dir.
  const repoName = isLinkedWorktree
    ? (basename(commonDir) === '.git' ? basename(repoRoot) : basename(commonDir))
    : basename(toplevel);
  return {
    repoKey: commonDir,
    repoName,
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

// The one-cwd git call, isolated behind a seam so tests can drive resolution
// (e.g. to assert the concurrency cap) without spawning real git.
type GitResult = { code: string | number | undefined; stdout: string; stderr: string };
const defaultRunGit = (cwd: string): Promise<GitResult> =>
  new Promise((res) => {
    execFile(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir', '--show-toplevel', '--abbrev-ref', 'HEAD'],
      // LC_ALL=C so a "not a git repository" failure is reported in English.
      { timeout: 2000, env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => res({ code: err ? (err.code ?? -1) : 0, stdout, stderr }),
    );
  });
let runGit = defaultRunGit;
/** Test seam: override the git runner (pass null to restore the default). */
export function _setGitRunForTest(fn: ((cwd: string) => Promise<GitResult>) | null): void {
  runGit = fn ?? defaultRunGit;
}

// Resolve one cwd (already reserved in `inflight` by the caller) off the event
// loop under the process-wide semaphore, update the cache, and clear the
// reservation. Resolves to true when the effective value changed. Never rejects.
async function resolveCwd(cwd: string): Promise<boolean> {
  await acquire();
  try {
    const { code, stdout, stderr } = await runGit(cwd);
    const failed = code !== 0;
    const prevInfo = cache.get(cwd)?.info;
    const info = resolveOutcome(prevInfo, failed, failed ? null : parseGit(stdout), failed && isNotARepo(code, stderr));
    // `at` records the attempt (even a failed one) so transient failures back off.
    cache.set(cwd, { at: Date.now(), info });
    return JSON.stringify(prevInfo) !== JSON.stringify(info);
  } finally {
    release();
    inflight.delete(cwd);
  }
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
 * The cwd to resolve git from for a workspace. When herdr already tagged the
 * workspace with a worktree, resolve from its stable checkout path so an agent
 * that `cd`s the pane out of the checkout (changing foreground_cwd) can't
 * repoint the workspace to another repo or clear its grouping. Only an untagged
 * checkout — which carries no herdr repo identity — falls back to the
 * (pane-derived) workspace cwd.
 */
export function resolveCwdFor(ws: Pick<WorkspaceNode, 'cwd' | 'worktree'>): string | null {
  return ws.worktree?.checkoutPath || ws.cwd;
}

/**
 * Return a state where every workspace carries its cached git worktree info.
 * Reads only the cache — never spawns git — so it is safe on the snapshot hot
 * path. Input state is not mutated. `lookup` is injectable for tests.
 *
 * When herdr tagged the workspace with a worktree, its repo identity
 * (repoKey/paths/isLinkedWorktree) is authoritative: only the git-resolved
 * branch is layered in, so a moved pane cwd or a git hiccup can neither repoint
 * the workspace to another repo nor drop its grouping. An untagged checkout has
 * no herdr identity, so the git result is authoritative for it — including
 * clearing it (null) once its cwd no longer resolves as a git repo.
 */
export function enrichStateWorktrees(
  state: NormalizedState,
  lookup: (cwd: string) => WorktreeInfo | null | undefined = worktreeForCwd,
): NormalizedState {
  let changed = false;
  const workspaces = state.workspaces.map((ws): WorkspaceNode => {
    const cwd = resolveCwdFor(ws);
    if (!cwd) return ws;
    const info = lookup(cwd);
    // Cache miss (undefined): not resolved yet — keep whatever baseline the
    // snapshot carried.
    if (info === undefined) return ws;
    // A resolved WorktreeInfo is authoritative for the branch — including a null
    // branch (detached HEAD), which must replace a previously-shown one. Only a
    // null info (checkout path no longer a repo) falls back to herdr's last-known
    // branch, so the tagged identity/grouping survives rather than being cleared.
    const merged: WorktreeInfo | null = ws.worktree
      ? { ...ws.worktree, branch: info ? info.branch : ws.worktree.branch }
      : info;
    if (JSON.stringify(ws.worktree ?? null) === JSON.stringify(merged)) return ws;
    changed = true;
    return { ...ws, worktree: merged };
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
