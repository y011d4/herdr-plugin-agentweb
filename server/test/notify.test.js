import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentStatusMessage } from '../notify.js';

describe('buildAgentStatusMessage', () => {
  const state = {
    workspaces: [
      { label: 'proj', tabs: [{ label: 'main', panes: [{ paneId: 'w0:p1' }] }] },
    ],
  };

  it('emits agent as a display string with labels', () => {
    const msg = buildAgentStatusMessage(
      { paneId: 'w0:p1', from: 'working', to: 'blocked', agent: { name: 'claude', displayName: 'Claude: auth' } },
      state
    );
    assert.equal(msg.type, 'agent_status');
    assert.equal(msg.agent, 'Claude: auth');
    assert.equal(msg.from, 'working');
    assert.equal(msg.to, 'blocked');
    assert.equal(msg.workspaceLabel, 'proj');
    assert.equal(msg.tabLabel, 'main');
  });

  it('falls back to name, then null', () => {
    assert.equal(
      buildAgentStatusMessage({ paneId: 'x', from: 'a', to: 'b', agent: { name: 'codex' } }, state).agent,
      'codex'
    );
    assert.equal(
      buildAgentStatusMessage({ paneId: 'x', from: 'a', to: 'b', agent: null }, state).agent,
      null
    );
  });
});
