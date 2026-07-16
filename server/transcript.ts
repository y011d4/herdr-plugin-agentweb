/**
 * Transcript file I/O: locate a Claude Code session's JSONL transcript on disk
 * and read it incrementally. The pure line→TimelineItem mapping lives in
 * transcript-normalize.ts; this module does the filesystem work only.
 *
 * Reads are confined to the Claude Code projects roots (~/.claude/projects and
 * ~/.config/claude/<name>/projects). The session id is supplied by herdr
 * (pane.agent_session.value) and the cwd by the pane — never by the client — so
 * a client can't steer these reads; the containment check is defence in depth.
 */

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { existsSync, readdirSync, statSync, realpathSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { normalizeLine, type TimelineItem } from './transcript-normalize.ts';

// Default Claude Code config root. Alternate CLAUDE_CONFIG_DIRs (per-org setups
// etc.) live under ~/.config/claude/<name>/ and each has its own projects/ dir,
// so both are searched — a pane whose claude uses a non-default config dir still
// resolves instead of falling back to the terminal.
const DEFAULT_PROJECTS_ROOT = resolve(join(homedir(), '.claude', 'projects'));
const CONFIG_BASE = resolve(join(homedir(), '.config', 'claude'));

// Cap the initial/reset read so a large transcript (many MB) can't block the
// event loop or exhaust memory; only the recent tail is needed for the chat view.
const TAIL_MAX_BYTES = 2 * 1024 * 1024;

// Discover the transcript "projects" roots present on this host: the default
// plus any ~/.config/claude/<name>/projects. Cheap (a couple of readdir/exists
// calls) and recomputed per resolve so a new config dir is picked up live.
function projectsRoots(): string[] {
  const roots = [DEFAULT_PROJECTS_ROOT];
  try {
    for (const name of readdirSync(CONFIG_BASE)) {
      const p = resolve(join(CONFIG_BASE, name, 'projects'));
      if (existsSync(p)) roots.push(p);
    }
  } catch { /* no ~/.config/claude — only the default root */ }
  return roots;
}

/**
 * Derive a claude process's transcript projects root from its own environment
 * via Linux /proc: CLAUDE_CONFIG_DIR/projects, else HOME/.claude/projects. This
 * follows a claude launched with ANY CLAUDE_CONFIG_DIR (not just the common
 * ~/.config/claude/<name>). Resolves null if the process is gone, unreadable, or
 * off-host (e.g. an ssh client — its remote claude's env isn't in local /proc).
 *
 * Least-privilege: this is a LAST RESORT (callers try the plain filesystem roots
 * first). The read + filter is delegated to a `grep` subprocess, so only the two
 * path vars ever reach this network-facing process — the rest of the environ
 * (unrelated secrets) transits grep's short-lived memory and is never held,
 * logged, or returned here. `pid` comes from herdr (not the client) and is passed
 * as an execFile arg (no shell), so it can't inject.
 */
export function projectsRootForPid(pid: number): Promise<string | null> {
  return new Promise((res) => {
    if (!Number.isInteger(pid) || pid <= 0) return res(null);
    execFile(
      'grep',
      ['-z', '-a', '-E', '^(CLAUDE_CONFIG_DIR|HOME)=', `/proc/${pid}/environ`],
      { timeout: 1000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err || !stdout) return res(null); // no match / unreadable / grep absent
        let configDir: string | undefined;
        let home: string | undefined;
        for (const rec of stdout.split('\0')) {
          if (rec.startsWith('CLAUDE_CONFIG_DIR=')) configDir = rec.slice('CLAUDE_CONFIG_DIR='.length);
          else if (rec.startsWith('HOME=')) home = rec.slice('HOME='.length);
        }
        if (configDir) return res(resolve(join(configDir, 'projects')));
        if (home) return res(resolve(join(home, '.claude', 'projects')));
        res(null);
      },
    );
  });
}

// A session id must be a bare file-stem (UUID in practice). Reject anything with
// path separators or dots so it can't escape a project directory.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * Claude Code derives the per-project directory name from the cwd where it was
 * launched by replacing '/', '.', '_' with '-' (letter case preserved).
 */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[/._]/g, '-');
}

function containedIn(p: string, root: string): string | null {
  const abs = resolve(p);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

// Confirm a candidate transcript is a REGULAR FILE that, after symlinks are
// resolved on both it and the root, still lives under the root. The lexical
// containedIn check can't see through a symlink, and existsSync/openSync follow
// links — so a `<root>/<slug>/<uuid>.jsonl` that is really a symlink to a file
// outside the roots would otherwise be tailed. Returns the real path, or null.
function safeRealFile(candidate: string, root: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(candidate); // resolves symlinks; throws if missing
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
    return statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/**
 * Resolve the on-disk transcript for a claude session. `sessionId` comes from
 * herdr's `agent_session.value`, `cwd` from the pane. Returns an absolute path
 * under one of the projects roots, or null if this session's transcript is not
 * on this host (e.g. a remote/containerized claude).
 */
export function resolveTranscriptPath(sessionId: string | null | undefined, cwd: string | null, extraRoots: string[] = []): string | null {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const fileName = `${sessionId}.jsonl`;
  // extraRoots (a process-derived CLAUDE_CONFIG_DIR) take priority, then the
  // discovered defaults; dedupe so a shared root isn't scanned twice.
  const seen = new Set<string>();
  const roots = [...extraRoots.map((r) => resolve(r)), ...projectsRoots()].filter((r) => (seen.has(r) ? false : (seen.add(r), true)));

  // Fast path: the pane's current cwd slug under each root. Correct when claude
  // was launched in the directory the pane still reports.
  if (cwd) {
    const slug = slugForCwd(cwd);
    for (const root of roots) {
      const direct = containedIn(join(root, slug, fileName), root);
      const safe = direct ? safeRealFile(direct, root) : null;
      if (safe) return safe;
    }
  }

  // Fallback: claude's launch cwd can differ from the pane's current
  // foreground_cwd, so scan each root's project dirs for the globally-unique
  // session id.
  for (const root of roots) {
    let dirs: string[];
    try { dirs = readdirSync(root); } catch { continue; }
    for (const d of dirs) {
      const cand = containedIn(join(root, d, fileName), root);
      const safe = cand ? safeRealFile(cand, root) : null;
      if (safe) return safe;
    }
  }
  return null;
}

export interface TranscriptChunk {
  items: TimelineItem[];
  /** byte offset just past the last complete line consumed */
  cursor: number;
  /** true when the cursor was too far behind: items are a rebuilt tail to
   *  replace, not append (the caller must forward reset to the client). */
  reset: boolean;
}

/**
 * Read new complete lines from `byteOffset` to EOF and normalize them. A
 * trailing partial line (mid-append, no newline yet) is left unconsumed so the
 * next read picks it up whole; `cursor` only advances past complete lines.
 * `byteOffset` always lands on a newline boundary, so it can't split a
 * multi-byte character.
 *
 * If the gap from `byteOffset` to EOF exceeds TAIL_MAX_BYTES (a stale or
 * caller-supplied `after`, or a huge burst), the incremental read is abandoned
 * and a bounded tail is returned with `reset: true` so the read stays bounded
 * and the caller rebuilds instead of streaming megabytes.
 */
export function readTranscriptFrom(file: string, byteOffset: number, resetMaxItems = 300): TranscriptChunk {
  try {
    const size = statSync(file).size;
    if (size <= byteOffset) return { items: [], cursor: byteOffset, reset: false }; // nothing new
    if (size - byteOffset > TAIL_MAX_BYTES) {
      // tailUnsafe (not readTranscriptTail) so a tail-read failure throws into the
      // catch below and becomes "no update", never an empty reset that would
      // clear the client's log and rewind the cursor.
      const tail = tailUnsafe(file, resetMaxItems);
      // No complete line in the capped window (a single >cap unterminated line),
      // or no forward progress (a truncate/recreate race): don't advance or reset
      // — the next read makes progress once a complete line lands.
      if (!tail.hadCompleteLine || tail.cursor <= byteOffset) {
        return { items: [], cursor: byteOffset, reset: false };
      }
      // Complete lines exist past the cursor. Advance past them; rebuild the
      // client log only when there's something to show. A window of only skipped
      // lines (system/meta/summary) advances the cursor silently so the watcher
      // catches up instead of re-reading the same window every poll.
      return { items: tail.items, cursor: tail.cursor, reset: tail.items.length > 0 };
    }
    const len = size - byteOffset;
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    let read = 0;
    try { read = readSync(fd, buf, 0, len, byteOffset); } finally { closeSync(fd); }
    if (read === 0) return { items: [], cursor: byteOffset, reset: false };
    // Reason only over the bytes actually read (a truncate/recreate between stat
    // and read yields a short read; the rest of buf is zero-fill). Byte-space
    // newline boundary keeps the cursor byte-exact even mid multi-byte char.
    const data = buf.subarray(0, read);
    const lastNlByte = data.lastIndexOf(0x0a);
    if (lastNlByte === -1) return { items: [], cursor: byteOffset, reset: false }; // no complete line yet
    const completeText = data.toString('utf8', 0, lastNlByte + 1); // ends on a newline → no split char
    const items = completeText.split('\n').filter(Boolean).flatMap(normalizeLine);
    return { items, cursor: byteOffset + lastNlByte + 1, reset: false };
  } catch {
    // file removed / rotated / unreadable between stat and read — no update this round
    return { items: [], cursor: byteOffset, reset: false };
  }
}

export interface TranscriptTail {
  items: TimelineItem[];
  cursor: number;
  /** true when older items were dropped (byte cap or maxItems) */
  truncated: boolean;
}

// Core tail read; MAY THROW on fs errors. Callers pick how to treat a failure:
// readTranscriptTail swallows it (empty tail), while readTranscriptFrom lets it
// propagate so a failed large-gap read becomes "no update" rather than an empty
// reset that would clear the client's log. `hadCompleteLine` distinguishes a
// window with at least one complete line (cursor may advance) from one holding a
// single >cap unterminated line (no progress possible) — separate from whether
// those complete lines produced any renderable item.
type TailResult = TranscriptTail & { hadCompleteLine: boolean };

function tailUnsafe(file: string, maxItems: number): TailResult {
  const fd = openSync(file, 'r');
  try {
    // fstat the open fd (not a separate statSync) so the size and the read see
    // the same file handle; a truncate after this still yields a short read,
    // handled below, so the cursor never exceeds bytes confirmed from the file.
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_MAX_BYTES);
    const len = size - start;
    if (len === 0) return { items: [], cursor: size, truncated: false, hadCompleteLine: false };
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, start);
    // Truncated below `start` since fstat: clamp the cursor to the real current
    // EOF, not the stale `start`, so a later incremental read isn't stuck past EOF.
    if (read === 0) return { items: [], cursor: fstatSync(fd).size, truncated: false, hadCompleteLine: false };
    // Reason only over the bytes actually read (a truncate leaves the tail
    // zero-filled). Find newline boundaries in BYTE space so an incomplete
    // multi-byte char at EOF (U+FFFD) can't skew the cursor; hadCompleteLine uses
    // the whole read window so a completed >cap line still advances the cursor.
    const data = buf.subarray(0, read);
    const NL = 0x0a;
    const lastNlByte = data.lastIndexOf(NL); // byte index within the read bytes, or -1
    const hadCompleteLine = lastNlByte !== -1;
    const cursor = hadCompleteLine ? start + lastNlByte + 1 : start; // just past the last newline
    // For PARSING, drop a leading partial line when we began mid-file, then decode
    // only the complete-line byte range (both bounds are newlines → no split char).
    let bodyStart = 0;
    if (start > 0) {
      const firstNlByte = data.indexOf(NL);
      bodyStart = firstNlByte === -1 ? read : firstNlByte + 1;
    }
    const usable = hadCompleteLine && bodyStart <= lastNlByte ? data.toString('utf8', bodyStart, lastNlByte + 1) : '';
    const all = usable.split('\n').filter(Boolean).flatMap(normalizeLine);
    const truncated = start > 0 || all.length > maxItems;
    return { items: all.length > maxItems ? all.slice(-maxItems) : all, cursor, truncated, hadCompleteLine };
  } finally {
    closeSync(fd);
  }
}

/**
 * Initial load: read at most the last TAIL_MAX_BYTES of the file, normalize the
 * complete lines within, and return the last `maxItems` items with a cursor at
 * the end of the last complete line. Older history (beyond the cap or maxItems)
 * is dropped — chat views only need the recent tail — which also bounds the work
 * so a large transcript can't stall the event loop. `truncated` flags that older
 * items exist above. Returns an empty tail if the file can't be read.
 */
export function readTranscriptTail(file: string, maxItems: number): TranscriptTail {
  try {
    const { items, cursor, truncated } = tailUnsafe(file, maxItems);
    return { items, cursor, truncated };
  } catch {
    return { items: [], cursor: 0, truncated: false }; // removed/rotated/unreadable
  }
}
