import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentStatusMessage } from '../notify.ts';
import type { NormalizedState, StatusChange } from '../types.ts';

describe('buildAgentStatusMessage', () => {
  const state = {
    workspaces: [
      { workspaceId: 'w0', label: 'proj', cwd: null, tabs: [{ tabId: 'w0:t1', label: 'main', panes: [{ paneId: 'w0:p1', focused: false, cwd: null, title: null, agent: null }] }] },
    ],
  } as unknown as NormalizedState;

  it('emits agent as a display string with labels', () => {
    const change: StatusChange = { paneId: 'w0:p1', from: 'working', to: 'blocked', agent: { name: 'claude', displayName: 'Claude: auth', status: 'blocked', customStatus: null, message: null, sinceUnixMs: 0 } };
    const msg = buildAgentStatusMessage(change, state);
    assert.equal(msg.type, 'agent_status');
    assert.equal(msg.agent, 'Claude: auth');
    assert.equal(msg.from, 'working');
    assert.equal(msg.to, 'blocked');
    assert.equal(msg.workspaceLabel, 'proj');
    assert.equal(msg.tabLabel, 'main');
  });

  it('falls back to name, then null', () => {
    const changeWithName: StatusChange = { paneId: 'x', from: 'a', to: 'b', agent: { name: 'codex', displayName: null, status: 'idle', customStatus: null, message: null, sinceUnixMs: 0 } };
    assert.equal(
      buildAgentStatusMessage(changeWithName, state).agent,
      'codex'
    );
    const changeNullAgent = { paneId: 'x', from: 'a', to: 'b', agent: null as unknown as StatusChange['agent'] };
    assert.equal(
      buildAgentStatusMessage(changeNullAgent, state).agent,
      null
    );
  });
});
