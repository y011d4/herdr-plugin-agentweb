/**
 * Which server-side watches the active pane should have, kept out of the
 * DOM-coupled shell so it is unit-testable. Sent on reconnect, route changes, view
 * mode switches and visibilitychange — all through this one decision, so a
 * reconnect while hidden can't silently restart a paused watch.
 */
export type WatchMessage =
  | { type: 'watch_pane' | 'watch_transcript'; paneId: string }
  | { type: 'unwatch_pane' | 'unwatch_transcript' };

export function watchMessages(paneId: string | null, mode: 'terminal' | 'chat', hidden: boolean): WatchMessage[] {
  if (!paneId) return [{ type: 'unwatch_pane' }, { type: 'unwatch_transcript' }];
  // The transcript watch stays on while hidden: it only sends new items, and
  // restarting it resends the whole tail.
  if (mode === 'chat') return [{ type: 'unwatch_pane' }, { type: 'watch_transcript', paneId }];
  // A hidden page still gets a full screen per change (~1/s while an agent
  // works) — pause the pane watch until visible.
  return [{ type: 'unwatch_transcript' }, hidden ? { type: 'unwatch_pane' } : { type: 'watch_pane', paneId }];
}
