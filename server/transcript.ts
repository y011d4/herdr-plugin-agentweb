/**
 * Transcript file I/O: locate a Claude Code session's JSONL transcript on disk
 * and read it incrementally. The pure line→TimelineItem mapping lives in
 * transcript-normalize.ts; this module does the filesystem work only.
 *
 * Reads are confined to ~/.claude/projects. The session id is supplied by herdr
 * (pane.agent_session.value) and the cwd by the pane — never by the client — so
 * a client can't steer these reads; the containment check is defence in depth.
 */

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { normalizeLine, type TimelineItem } from './transcript-normalize.ts';

const PROJECTS_ROOT = resolve(join(homedir(), '.claude', 'projects'));

// Cap the initial/reset read so a large transcript (many MB) can't block the
// event loop or exhaust memory; only the recent tail is needed for the chat view.
const TAIL_MAX_BYTES = 2 * 1024 * 1024;

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

function contained(p: string): string | null {
  const abs = resolve(p);
  return abs === PROJECTS_ROOT || abs.startsWith(PROJECTS_ROOT + sep) ? abs : null;
}

/**
 * Resolve the on-disk transcript for a claude session. `sessionId` comes from
 * herdr's `agent_session.value`, `cwd` from the pane. Returns an absolute path
 * under ~/.claude/projects, or null if this session's transcript is not on this
 * host (e.g. a remote/containerized claude, or an alternate CLAUDE_CONFIG_DIR).
 */
export function resolveTranscriptPath(sessionId: string | null | undefined, cwd: string | null): string | null {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const fileName = `${sessionId}.jsonl`;

  // Fast path: the pane's current cwd slug. Correct when claude was launched in
  // the directory the pane still reports.
  if (cwd) {
    const direct = contained(join(PROJECTS_ROOT, slugForCwd(cwd), fileName));
    if (direct && existsSync(direct)) return direct;
  }

  // Fallback: claude's launch cwd can differ from the pane's current
  // foreground_cwd, so scan project dirs for the globally-unique session id.
  let dirs: string[];
  try { dirs = readdirSync(PROJECTS_ROOT); } catch { return null; }
  for (const d of dirs) {
    const cand = contained(join(PROJECTS_ROOT, d, fileName));
    if (cand && existsSync(cand)) return cand;
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
      // Only reset when the tail read strictly advances past byteOffset. A cursor
      // at or behind it means no forward progress (a truncate/recreate race, or a
      // huge trailing partial line) — a same-session file only grows, so treat it
      // as no-update rather than clearing/rebuilding the client without advancing.
      if (tail.cursor <= byteOffset) return { items: [], cursor: byteOffset, reset: false };
      return { items: tail.items, cursor: tail.cursor, reset: true };
    }
    const len = size - byteOffset;
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, byteOffset); } finally { closeSync(fd); }
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { items: [], cursor: byteOffset, reset: false }; // no complete line yet
    const complete = text.slice(0, lastNl);
    const consumed = Buffer.byteLength(complete, 'utf8') + 1; // +1 for the newline
    const items = complete.split('\n').filter(Boolean).flatMap(normalizeLine);
    return { items, cursor: byteOffset + consumed, reset: false };
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
// reset that would clear the client's log.
function tailUnsafe(file: string, maxItems: number): TranscriptTail {
  const size = statSync(file).size;
  const start = Math.max(0, size - TAIL_MAX_BYTES);
  const len = size - start;
  if (len === 0) return { items: [], cursor: size, truncated: false };
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
  let text = buf.toString('utf8');
  // When we start mid-file the first line is partial (its start was cut off) —
  // drop it up to the first newline, which is a clean byte boundary so the
  // remainder decodes without splitting a multi-byte character.
  const cappedFromStart = start > 0;
  if (cappedFromStart) {
    const firstNl = text.indexOf('\n');
    text = firstNl === -1 ? '' : text.slice(firstNl + 1);
  }
  // Exclude a trailing partial line; the cursor (an absolute byte offset) sits
  // before it so a later readTranscriptFrom re-reads it whole once it completes.
  const lastNl = text.lastIndexOf('\n');
  const trailingPartial = lastNl === -1 ? text : text.slice(lastNl + 1);
  const cursor = size - Buffer.byteLength(trailingPartial, 'utf8');
  const usable = lastNl === -1 ? '' : text.slice(0, lastNl + 1);
  const all = usable.split('\n').filter(Boolean).flatMap(normalizeLine);
  const truncated = cappedFromStart || all.length > maxItems;
  return { items: all.length > maxItems ? all.slice(-maxItems) : all, cursor, truncated };
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
  try { return tailUnsafe(file, maxItems); }
  catch { return { items: [], cursor: 0, truncated: false }; } // removed/rotated/unreadable
}
