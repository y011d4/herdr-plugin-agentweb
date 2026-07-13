import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createState, applyEvent, toClientState, getPaneIds,
  PANE_SET_CHANGING_EVENTS, APPLIED_EVENTS,
} from '../state.ts';
import type { RawSnapshot } from '../types.ts';

// Minimal snapshot fixture matching the real herdr API shape observed in live testing.
function makeSnapshot(overrides: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    version: '0.7.3',
    protocol: 16,
    focused_workspace_id: 'w0',
    focused_tab_id: 'w0:t1',
    focused_pane_id: 'w0:p1',
    workspaces: [
      { workspace_id: 'w0', label: 'herdr', active_tab_id: 'w0:t1' },
    ],
    tabs: [
      { tab_id: 'w0:t1', workspace_id: 'w0', label: '1', number: 1 },
    ],
    panes: [
      {
        pane_id: 'w0:p1',
        workspace_id: 'w0',
        tab_id: 'w0:t1',
        focused: true,
        agent: 'claude',
        agent_status: 'working',
        cwd: '/home/user/proj',
        foreground_cwd: '/home/user/proj',
      },
      {
        pane_id: 'w0:p2',
        workspace_id: 'w0',
        tab_id: 'w0:t1',
        focused: false,
        agent_status: 'unknown',
        cwd: '/home/user/proj',
        foreground_cwd: '/home/user/proj',
      },
    ],
    agents: [],
    layouts: [],
    ...overrides,
  };
}

describe('createState', () => {
  it('sets connected=true and copies herdr version/protocol', () => {
    const state = createState(makeSnapshot());
    assert.equal(state.connected, true);
    assert.equal(state.herdr.version, '0.7.3');
    assert.equal(state.herdr.protocol, 16);
  });

  it('normalizes herdr scroll metadata into noScrollback/viewportRows', () => {
    const state = createState(makeSnapshot({
      panes: [
        { pane_id: 'w0:p1', workspace_id: 'w0', tab_id: 'w0:t1', agent: 'claude',
          scroll: { max_offset_from_bottom: 0, viewport_rows: 78 } },
        { pane_id: 'w0:p2', workspace_id: 'w0', tab_id: 'w0:t1',
          scroll: { max_offset_from_bottom: 5581, viewport_rows: 40 } },
        { pane_id: 'w0:p3', workspace_id: 'w0', tab_id: 'w0:t1' }, // no scroll field
      ],
    }));
    const p1 = state._paneById.get('w0:p1')!;
    const p2 = state._paneById.get('w0:p2')!;
    const p3 = state._paneById.get('w0:p3')!;
    assert.equal(p1.noScrollback, true);   // max_offset 0 → alt-screen / no scrollback
    assert.equal(p1.viewportRows, 78);
    assert.equal(p2.noScrollback, false);  // real scrollback present
    assert.equal(p2.viewportRows, 40);
    assert.equal(p3.noScrollback, true);   // missing scroll defaults safely
    assert.equal(p3.viewportRows, 0);
  });

  it('sets focused ids from snapshot', () => {
    const state = createState(makeSnapshot());
    assert.equal(state.focused.workspaceId, 'w0');
    assert.equal(state.focused.tabId, 'w0:t1');
    assert.equal(state.focused.paneId, 'w0:p1');
  });

  it('builds workspace > tab > pane hierarchy', () => {
    const state = createState(makeSnapshot());
    assert.equal(state.workspaces.length, 1);
    assert.equal(state.workspaces[0].workspaceId, 'w0');
    assert.equal(state.workspaces[0].tabs.length, 1);
    assert.equal(state.workspaces[0].tabs[0].tabId, 'w0:t1');
    assert.equal(state.workspaces[0].tabs[0].panes.length, 2);
  });

  it('normalizes pane with agent info', () => {
    const state = createState(makeSnapshot(), 1000);
    const pane = state.workspaces[0].tabs[0].panes[0];
    assert.equal(pane.paneId, 'w0:p1');
    assert.equal(pane.focused, true);
    assert.equal(pane.agent!.name, 'claude');
    assert.equal(pane.agent!.status, 'working');
    assert.equal(pane.agent!.sinceUnixMs, 1000);
  });

  it('sets agent=null for panes without an agent field', () => {
    const state = createState(makeSnapshot());
    const pane = state.workspaces[0].tabs[0].panes[1];
    assert.equal(pane.paneId, 'w0:p2');
    assert.equal(pane.agent, null);
  });

  it('tolerates missing optional fields in snapshot', () => {
    const minimal: RawSnapshot = {
      panes: [],
      tabs: [],
      workspaces: [],
    };
    const state = createState(minimal);
    assert.equal(state.connected, true);
    assert.equal(state.workspaces.length, 0);
  });

  it('returns all pane ids via getPaneIds', () => {
    const state = createState(makeSnapshot());
    const ids = getPaneIds(state);
    assert.deepEqual(ids.sort(), ['w0:p1', 'w0:p2'].sort());
  });
});

describe('applyEvent - pane_agent_status_changed', () => {
  it('updates agent status and returns a change record', () => {
    const state = createState(makeSnapshot(), 1000);
    const { state: next, changes } = applyEvent(
      state,
      'pane_agent_status_changed',
      { pane_id: 'w0:p1', agent_status: 'idle' },
      2000,
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].paneId, 'w0:p1');
    assert.equal(changes[0].from, 'working');
    assert.equal(changes[0].to, 'idle');
    assert.equal(changes[0].agent.sinceUnixMs, 2000);

    const pane = next.workspaces[0].tabs[0].panes[0];
    assert.equal(pane.agent!.status, 'idle');
  });

  it('returns no changes when status is unchanged', () => {
    const state = createState(makeSnapshot());
    const { changes } = applyEvent(
      state,
      'pane_agent_status_changed',
      { pane_id: 'w0:p1', agent_status: 'working' },
    );
    assert.equal(changes.length, 0);
  });

  it('is a no-op for unknown pane id', () => {
    const state = createState(makeSnapshot());
    const { changes } = applyEvent(
      state,
      'pane_agent_status_changed',
      { pane_id: 'w99:p99', agent_status: 'idle' },
    );
    assert.equal(changes.length, 0);
  });

  it('handles pane with no prior agent field', () => {
    const state = createState(makeSnapshot());
    const { state: next, changes } = applyEvent(
      state,
      'pane_agent_status_changed',
      { pane_id: 'w0:p2', agent_status: 'working' },
      3000,
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].from, 'unknown');
    assert.equal(changes[0].to, 'working');
    const pane = next.workspaces[0].tabs[0].panes[1];
    assert.equal(pane.agent!.status, 'working');
  });

  it('merges agent/display_agent/custom_status/title from event payload', () => {
    const state = createState(makeSnapshot(), 1000);
    const { state: next, changes } = applyEvent(
      state,
      'pane_agent_status_changed',
      {
        pane_id: 'w0:p1',
        agent_status: 'idle',
        agent: 'codex',
        display_agent: 'Codex: auth',
        custom_status: 'waiting',
        title: 'new title',
      },
      4000,
    );
    assert.equal(changes.length, 1);
    const { agent } = changes[0];
    assert.equal(agent.name, 'codex');
    assert.equal(agent.displayName, 'Codex: auth');
    assert.equal(agent.customStatus, 'waiting');
    assert.equal(agent.status, 'idle');
    assert.equal(agent.sinceUnixMs, 4000);
    const pane = next.workspaces[0].tabs[0].panes[0];
    assert.equal(pane.title, 'new title');
  });

  it('falls back to agent field when display_agent absent', () => {
    const state = createState(makeSnapshot(), 1000);
    const { changes } = applyEvent(
      state,
      'pane_agent_status_changed',
      { pane_id: 'w0:p1', agent_status: 'idle', agent: 'codex' },
      5000,
    );
    assert.equal(changes[0].agent.name, 'codex');
    assert.equal(changes[0].agent.displayName, 'codex');
  });

  it('preserves existing name/displayName when event omits agent fields', () => {
    const state = createState(makeSnapshot(), 1000);
    // first event sets the name
    const { state: s2 } = applyEvent(
      state,
      'pane_agent_status_changed',
      { pane_id: 'w0:p1', agent_status: 'idle', agent: 'codex', display_agent: 'Codex: auth' },
      2000,
    );
    // second event only changes status, no agent fields
    const { changes } = applyEvent(
      s2,
      'pane_agent_status_changed',
      { pane_id: 'w0:p1', agent_status: 'working' },
      3000,
    );
    assert.equal(changes[0].agent.name, 'codex');
    assert.equal(changes[0].agent.displayName, 'Codex: auth');
  });
});

describe('applyEvent - pane_focused', () => {
  it('updates focused flag and focused pane id', () => {
    const state = createState(makeSnapshot());
    const { state: next } = applyEvent(state, 'pane_focused', { pane_id: 'w0:p2' });
    assert.equal(next.focused.paneId, 'w0:p2');
    const panes = next.workspaces[0].tabs[0].panes;
    assert.equal(panes.find(p => p.paneId === 'w0:p1')!.focused, false);
    assert.equal(panes.find(p => p.paneId === 'w0:p2')!.focused, true);
  });
});

describe('applyEvent - workspace_renamed', () => {
  it('updates workspace label', () => {
    const state = createState(makeSnapshot());
    const { state: next } = applyEvent(state, 'workspace_renamed', { workspace_id: 'w0', label: 'renamed' });
    assert.equal(next.workspaces[0].label, 'renamed');
  });
});

describe('applyEvent - unknown events', () => {
  it('is a no-op for completely unknown event', () => {
    const state = createState(makeSnapshot());
    const { changes } = applyEvent(state, 'some_future_event', {});
    assert.equal(changes.length, 0);
  });
});

describe('toClientState', () => {
  it('strips internal index fields', () => {
    const state = createState(makeSnapshot());
    const client = toClientState(state);
    assert.equal('_paneById' in client, false);
    assert.equal('_tabById' in client, false);
    assert.equal(client.connected, true);
  });
});

describe('createState with prevState', () => {
  it('carries over sinceUnixMs when agent status is unchanged', () => {
    const prev = createState(makeSnapshot(), 1000);
    const next = createState(makeSnapshot(), 5000, prev);
    const pane = next.workspaces[0].tabs[0].panes.find(p => p.paneId === 'w0:p1');
    assert.equal(pane!.agent!.sinceUnixMs, 1000);
  });

  it('resets sinceUnixMs when agent status changed between snapshots', () => {
    const prev = createState(makeSnapshot(), 1000);
    const snap = makeSnapshot();
    snap.panes![0].agent_status = 'idle';
    const next = createState(snap, 5000, prev);
    const pane = next.workspaces[0].tabs[0].panes.find(p => p.paneId === 'w0:p1');
    assert.equal(pane!.agent!.status, 'idle');
    assert.equal(pane!.agent!.sinceUnixMs, 5000);
  });

  it('uses nowMs for panes not present in prevState', () => {
    const prev = createState(makeSnapshot(), 1000);
    const snap = makeSnapshot();
    snap.panes!.push({
      pane_id: 'w0:p3', workspace_id: 'w0', tab_id: 'w0:t1',
      focused: false, agent: 'codex', agent_status: 'working', cwd: '/x',
    });
    const next = createState(snap, 5000, prev);
    const pane = next.workspaces[0].tabs[0].panes.find(p => p.paneId === 'w0:p3');
    assert.equal(pane!.agent!.sinceUnixMs, 5000);
  });
});

describe('applyEvent - dot-form event names', () => {
  it('handles pane.agent_status_changed (dot form, as herdr sends it)', () => {
    const state = createState(makeSnapshot(), 1000);
    const { changes } = applyEvent(
      state,
      'pane.agent_status_changed',
      { pane_id: 'w0:p1', workspace_id: 'w0', agent_status: 'blocked' },
      2000
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].from, 'working');
    assert.equal(changes[0].to, 'blocked');
  });
});

describe('event routing table', () => {
  // Every lifecycle event the client subscribes to (herdr-client.ts
  // buildSubscriptions) must be either rebuild-triggering or applied by
  // applyEvent — anything else is silently dropped and the phone view drifts.
  const SUBSCRIBED_LIFECYCLE_EVENTS = [
    'workspace_created', 'workspace_updated', 'workspace_renamed',
    'workspace_moved', 'workspace_closed', 'workspace_focused',
    'tab_created', 'tab_closed', 'tab_focused', 'tab_renamed', 'tab_moved',
    'pane_created', 'pane_closed', 'pane_focused', 'pane_moved', 'pane_exited',
    'worktree_created', 'worktree_opened', 'worktree_removed',
  ];

  it('every subscribed lifecycle event is rebuild-triggering or applied', () => {
    for (const ev of SUBSCRIBED_LIFECYCLE_EVENTS) {
      assert.ok(
        PANE_SET_CHANGING_EVENTS.has(ev) || APPLIED_EVENTS.has(ev),
        `subscribed event '${ev}' would be silently dropped`
      );
    }
  });

  it('agent status events are applied, not rebuild-triggering', () => {
    assert.ok(APPLIED_EVENTS.has('pane_agent_status_changed'));
    assert.ok(!PANE_SET_CHANGING_EVENTS.has('pane_agent_status_changed'));
  });
});

describe('applyEvent immutability', () => {
  it('does not mutate the input state', () => {
    const s0 = createState(makeSnapshot(), 1000);
    const before = JSON.stringify(toClientState(s0));
    const paneBefore = s0._paneById.get('w0:p1');

    applyEvent(s0, 'pane_agent_status_changed', { pane_id: 'w0:p1', workspace_id: 'w0', agent_status: 'blocked' }, 2000);
    applyEvent(s0, 'pane_focused', { pane_id: 'w0:p2' }, 2000);
    applyEvent(s0, 'tab_renamed', { tab_id: 'w0:t1', label: 'renamed' }, 2000);

    assert.equal(JSON.stringify(toClientState(s0)), before);
    assert.equal(s0._paneById.get('w0:p1'), paneBefore);
    assert.equal(s0._paneById.get('w0:p1')!.agent!.status, 'working');
    assert.equal(s0._tabById.get('w0:t1')!.label, '1');
  });

  it('returns a state with independent indexes', () => {
    const s0 = createState(makeSnapshot(), 1000);
    const { state: s1 } = applyEvent(
      s0, 'pane_agent_status_changed',
      { pane_id: 'w0:p1', workspace_id: 'w0', agent_status: 'blocked' }, 2000
    );
    assert.notEqual(s1._paneById, s0._paneById);
    assert.notEqual(s1._tabById, s0._tabById);
    assert.equal(s1._paneById.get('w0:p1')!.agent!.status, 'blocked');
    assert.equal(s0._paneById.get('w0:p1')!.agent!.status, 'working');
  });
});
