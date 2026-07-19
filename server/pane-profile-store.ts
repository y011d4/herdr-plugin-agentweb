import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Durable pane_id → launch-profile map so `clear` can relaunch the exact profile
 * an agent was started with — even across a bridge restart. herdr keeps panes
 * alive across the bridge's reconnect but only reports the *detected* agent type
 * ("claude"), which can't distinguish a custom "claude-yolo" variant; without
 * this the profile would be forgotten on restart and clear would drop the variant.
 *
 * Backed by a small JSON file in the state dir (0600). Entries are removed when an
 * agent is stopped or cleared; a pane closed outside the bridge leaves one small
 * residual string until its id is reused or the file is cleared — bounded and cheap.
 * Writes are best-effort: an unwritable state dir just costs durability, never a request.
 */
export interface PaneProfileStore {
  get(paneId: string): string | undefined;
  set(paneId: string, profile: string): void;
  delete(paneId: string): void;
}

export function createPaneProfileStore(filePath: string): PaneProfileStore {
  // null-proto so a pane id like "__proto__" can never hit the prototype setter
  // or shadow an inherited name through `in`.
  const map: Record<string, string> = Object.create(null);

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [k, v] of Object.entries(parsed)) {
        if (k !== '__proto__' && typeof v === 'string') map[k] = v;
      }
    }
  } catch { /* no file yet / unreadable / malformed — start empty */ }

  function persist(): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(map), { mode: 0o600 });
    } catch { /* best-effort; losing durability must not fail a request */ }
  }

  return {
    get: (paneId) => map[paneId],
    set: (paneId, profile) => { map[paneId] = profile; persist(); },
    delete: (paneId) => { if (Object.hasOwn(map, paneId)) { delete map[paneId]; persist(); } },
  };
}
