import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { watchMessages } from '../src/watch.ts';
import type { WatchMessage } from '../src/watch.ts';

// What the bridge ends up watching for one socket (internal/bridge/ws.go semantics:
// watch_* replaces that watch, unwatch_* clears it). A reconnect is a fresh socket.
type Watches = { pane: string | null; transcript: string | null };
const fresh = (): Watches => ({ pane: null, transcript: null });
function apply(w: Watches, msgs: WatchMessage[]): Watches {
  for (const m of msgs) {
    if (m.type === 'watch_pane') w.pane = m.paneId;
    else if (m.type === 'unwatch_pane') w.pane = null;
    else if (m.type === 'watch_transcript') w.transcript = m.paneId;
    else w.transcript = null;
  }
  return w;
}

describe('watchMessages — terminal view', () => {
  it('pauses the pane watch while hidden and resumes it when shown', () => {
    const w = apply(fresh(), watchMessages('p1', 'terminal', false));
    assert.deepEqual(w, { pane: 'p1', transcript: null });
    apply(w, watchMessages('p1', 'terminal', true)); // visibilitychange → hidden
    assert.deepEqual(w, { pane: null, transcript: null });
    apply(w, watchMessages('p1', 'terminal', false)); // visibilitychange → visible
    assert.deepEqual(w, { pane: 'p1', transcript: null });
  });

  it('a reconnect while hidden does not restart the pane watch; showing does', () => {
    const w = apply(fresh(), watchMessages('p1', 'terminal', true)); // ws open while hidden
    assert.equal(w.pane, null);
    apply(w, watchMessages('p1', 'terminal', false));
    assert.equal(w.pane, 'p1');
  });
});

describe('watchMessages — chat view', () => {
  it('keeps the transcript watch while hidden (no tail resend on return)', () => {
    for (const hidden of [false, true]) {
      assert.deepEqual(apply(fresh(), watchMessages('p1', 'chat', hidden)), { pane: null, transcript: 'p1' });
    }
  });
});

describe('watchMessages — no active pane', () => {
  it('clears both watches', () => {
    const w: Watches = { pane: 'p1', transcript: 'p2' };
    assert.deepEqual(apply(w, watchMessages(null, 'terminal', false)), fresh());
  });
});
