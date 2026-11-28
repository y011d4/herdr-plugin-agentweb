/**
 * drafts.ts — the composer's unsent text, kept on this phone per target until it is sent, so
 * switching Home, leaving a pane or reloading doesn't lose it. A Home's draft is kept under its
 * orchestrator's name (it outlives a Clear's new pane), any other under its pane. A State drops the
 * drafts of the panes and orchestrators it no longer has: herdr reuses pane ids. A draft can have a
 * quote too (a Home's Reply on a message, Ask on a to-do item: transcript.ts's quote line), kept the
 * same way and sent before its text.
 */
import type { AppState } from './types.ts';

const STORAGE_DRAFTS = 'herdr_drafts'; // {[draftKey]: text}
const STORAGE_QUOTES = 'herdr_draft_quotes'; // {[draftKey]: its quote line}

type Drafts = Record<string, string>;

function load(name = STORAGE_DRAFTS): Drafts {
  try {
    const d = JSON.parse(localStorage.getItem(name) ?? '{}');
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}

function save(d: Drafts, name = STORAGE_DRAFTS): void {
  // best-effort: without storage a draft lasts as long as its textarea (a quote, as its composer)
  try { localStorage.setItem(name, JSON.stringify(d)); } catch { /* not kept */ }
}

/** Where a composer's draft is kept: a Home's orchestrator (`home`: its name), else the pane. */
export const draftKey = (paneId: string, home?: string): string => (home ? `home:${home}` : `pane:${paneId}`);

export const getDraft = (key: string): string => load()[key] ?? '';

/** The composer now holds `text` ('' forgets the draft). */
export function setDraft(key: string, text: string): void {
  const d = load();
  if (text) d[key] = text;
  else delete d[key];
  save(d);
}

export const getQuote = (key: string): string => load(STORAGE_QUOTES)[key] ?? '';

const quoteFns = new Set<(key: string, line: string) => void>();

/** Tells `fn` of each quote set (the composer under that key shows it). */
export function onQuote(fn: (key: string, line: string) => void): () => void {
  quoteFns.add(fn);
  return () => { quoteFns.delete(fn); };
}

/** The draft under `key` now quotes `line` ('' drops its quote). */
export function setQuote(key: string, line: string): void {
  const d = load(STORAGE_QUOTES);
  if (line) d[key] = line;
  else delete d[key];
  save(d, STORAGE_QUOTES);
  for (const fn of quoteFns) fn(key, line);
}

/** Drops the drafts (and quotes) of the panes and orchestrators a State no longer has. */
export function pruneDrafts(state: AppState): void {
  if (!state.connected) return; // herdr out of reach: its panes aren't known to be gone
  const live = new Set([
    ...(state.workspaces ?? []).flatMap((ws) => (ws.tabs ?? []).flatMap((t) => (t.panes ?? []).map((p) => draftKey(p.paneId)))),
    ...(state.orchestrators ?? []).map((o) => draftKey('', o.name)),
  ]);
  for (const name of [STORAGE_DRAFTS, STORAGE_QUOTES]) {
    const d = load(name);
    const stale = Object.keys(d).filter((k) => !live.has(k));
    if (!stale.length) continue;
    for (const k of stale) delete d[k];
    save(d, name);
  }
}
