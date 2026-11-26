/**
 * drafts.ts — the composer's unsent text, kept on this phone per target until it is sent, so
 * switching Home, leaving a pane or reloading doesn't lose it. A Home's draft is kept under its
 * orchestrator's name (it outlives a Clear's new pane), any other under its pane. A State drops the
 * drafts of the panes and orchestrators it no longer has: herdr reuses pane ids.
 */
import type { AppState } from './types.ts';

const STORAGE_DRAFTS = 'herdr_drafts'; // {[draftKey]: text}

type Drafts = Record<string, string>;

function load(): Drafts {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_DRAFTS) ?? '{}');
    return d && typeof d === 'object' ? d : {};
  } catch { return {}; }
}

function save(d: Drafts): void {
  // best-effort: without storage a draft lasts as long as its textarea
  try { localStorage.setItem(STORAGE_DRAFTS, JSON.stringify(d)); } catch { /* not kept */ }
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

/** Drops the drafts of the panes and orchestrators a State no longer has. */
export function pruneDrafts(state: AppState): void {
  if (!state.connected) return; // herdr out of reach: its panes aren't known to be gone
  const live = new Set([
    ...(state.workspaces ?? []).flatMap((ws) => (ws.tabs ?? []).flatMap((t) => (t.panes ?? []).map((p) => draftKey(p.paneId)))),
    ...(state.orchestrators ?? []).map((o) => draftKey('', o.name)),
  ]);
  const d = load();
  const stale = Object.keys(d).filter((k) => !live.has(k));
  if (!stale.length) return;
  for (const k of stale) delete d[k];
  save(d);
}
