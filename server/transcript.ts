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
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { normalizeLine, type TimelineItem } from './transcript-normalize.ts';

const PROJECTS_ROOT = resolve(join(homedir(), '.claude', 'projects'));

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
}

/**
 * Read new complete lines from `byteOffset` to EOF and normalize them. A
 * trailing partial line (mid-append, no newline yet) is left unconsumed so the
 * next read picks it up whole; `cursor` only advances past complete lines.
 * `byteOffset` always lands on a newline boundary, so it can't split a
 * multi-byte character.
 */
export function readTranscriptFrom(file: string, byteOffset: number): TranscriptChunk {
  let size: number;
  try { size = statSync(file).size; } catch { return { items: [], cursor: byteOffset }; }
  if (size <= byteOffset) return { items: [], cursor: byteOffset }; // nothing new
  const len = size - byteOffset;
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, byteOffset); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return { items: [], cursor: byteOffset }; // no complete line yet
  const complete = text.slice(0, lastNl);
  const consumed = Buffer.byteLength(complete, 'utf8') + 1; // +1 for the newline
  const items = complete.split('\n').filter(Boolean).flatMap(normalizeLine);
  return { items, cursor: byteOffset + consumed };
}

export interface TranscriptTail extends TranscriptChunk {
  /** true when older items were dropped to respect maxItems */
  truncated: boolean;
}

/**
 * Initial load: read the whole file once, normalize every line, and return the
 * last `maxItems` items with a cursor at the end of the last complete line.
 * Older items are dropped (chat views only need the recent tail; lazy older
 * history can be layered on later).
 */
export function readTranscriptTail(file: string, maxItems: number): TranscriptTail {
  let content: string;
  try { content = readFileSync(file, 'utf8'); } catch { return { items: [], cursor: 0, truncated: false }; }
  // Drop a trailing partial line and set the cursor before it, so a
  // subsequent readTranscriptFrom re-reads that line whole once it completes.
  let usable = content;
  const lastNl = content.lastIndexOf('\n');
  if (lastNl !== content.length - 1) usable = lastNl === -1 ? '' : content.slice(0, lastNl + 1);
  const cursor = Buffer.byteLength(usable, 'utf8');
  const all = usable.split('\n').filter(Boolean).flatMap(normalizeLine);
  const truncated = all.length > maxItems;
  return { items: truncated ? all.slice(-maxItems) : all, cursor, truncated };
}
