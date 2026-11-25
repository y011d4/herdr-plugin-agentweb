import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { agentsScope, nextPaneBackRoute, paneGoneRoute, paneRoute, resolveRoute } from '../src/routes.ts';
import type { AppState, OrchestratorView } from '../src/types.ts';

const orch = (name: string, paneId: string | null): OrchestratorView => ({ name, label: '', paneId, agents: null });
const state = (...orchestrators: OrchestratorView[]): AppState => ({
  connected: true, herdr: { version: null, protocol: null }, focused: { workspaceId: null, tabId: null, paneId: null },
  workspaces: [], orchestrators, orchestratorPaneId: null,
});
const replace = (hash: string) => ({ kind: 'redirect', hash, replace: true });
const push = (hash: string) => ({ kind: 'redirect', hash, replace: false });

describe('resolveRoute — the default Home (a fresh open, and #/home)', () => {
  const two = state(orch('a', 'p1'), orch('stopped', null), orch('b', 'p2'));

  for (const hash of ['', '#/home']) {
    it(`${hash || '(empty)'}: the Home used last while it runs, else the first running one`, () => {
      assert.deepEqual(resolveRoute(hash, two, 'b'), replace('#/home/b'));
      assert.deepEqual(resolveRoute(hash, two, null), replace('#/home/a'));
      assert.deepEqual(resolveRoute(hash, two, 'stopped'), replace('#/home/a'));
      assert.deepEqual(resolveRoute(hash, two, 'gone'), replace('#/home/a'));
      assert.deepEqual(resolveRoute(hash, state(orch('wc o1', 'p1')), null), replace('#/home/wc%20o1'));
    });

    it(`${hash || '(empty)'}: the list when no orchestrator runs`, () => {
      assert.deepEqual(resolveRoute(hash, state(), null), replace('#/agents'));
      assert.deepEqual(resolveRoute(hash, state(orch('stopped', null)), 'stopped'), replace('#/agents'));
    });
  }

  it('waits for the first state: an empty hash shows the list, #/home a spinner', () => {
    assert.deepEqual(resolveRoute('', null, 'a'), { kind: 'agents' });
    assert.deepEqual(resolveRoute('#/home', null, 'a'), { kind: 'loading' });
  });
});

describe('resolveRoute — #/home/<name>', () => {
  const s = state(orch('a', 'p1'), orch('stopped', null), orch('wc o1', 'p3'));

  it('a running orchestrator opens its Home on its pane', () => {
    assert.deepEqual(resolveRoute('#/home/a', s, null), { kind: 'home', name: 'a', paneId: 'p1' });
    assert.deepEqual(resolveRoute('#/home/wc%20o1', s, null), { kind: 'home', name: 'wc o1', paneId: 'p3' });
  });

  it('a stopped, unknown or broken name goes to the list (a new history entry)', () => {
    for (const hash of ['#/home/stopped', '#/home/nope', '#/home/%E0%A4%A']) assert.deepEqual(resolveRoute(hash, s, null), push('#/agents'), hash);
  });

  it('waits for the first state', () => {
    assert.deepEqual(resolveRoute('#/home/a', null, null), { kind: 'loading' });
  });
});

describe('resolveRoute — #/pane/<id>', () => {
  const s = state(orch('a', 'p1'));

  it("an orchestrator's pane is replaced by its Home", () => {
    assert.deepEqual(resolveRoute('#/pane/p1', s, null), replace('#/home/a'));
  });

  it('any other pane opens, its id decoded', () => {
    assert.deepEqual(resolveRoute('#/pane/p2', s, null), { kind: 'pane', paneId: 'p2' });
    assert.deepEqual(resolveRoute('#/pane/w%3A1%2F2', s, null), { kind: 'pane', paneId: 'w:1/2' });
    assert.deepEqual(resolveRoute('#/pane/p1', null, null), { kind: 'pane', paneId: 'p1' }); // no state: can't tell
  });
});

describe('resolveRoute — the rest', () => {
  const s = state(orch('a', 'p1'));

  it('a broken or unknown hash goes to the list', () => {
    for (const hash of ['#/pane/%E0%A4%A', '#/nope', '#/agentsx', '#settings']) assert.deepEqual(resolveRoute(hash, s, null), push('#/agents'), hash);
  });

  it('the lists and settings', () => {
    for (const hash of ['#/agents', '#/agents/a', '#/agents/nope', '#/']) assert.deepEqual(resolveRoute(hash, s, null), { kind: 'agents' }, hash);
    assert.deepEqual(resolveRoute('#/settings', s, null), { kind: 'settings' });
    assert.deepEqual(resolveRoute('#/settings', null, null), { kind: 'settings' });
  });
});

describe('route helpers', () => {
  const a = orch('a', 'p1');
  const s = state(a, orch('wc o2', 'p2'));

  it("agentsScope: #/agents/<name> is that orchestrator's account; anything else every agent", () => {
    assert.equal(agentsScope('#/agents/a', s), a);
    assert.equal(agentsScope('#/agents/wc%20o2', s)?.name, 'wc o2');
    for (const hash of ['#/agents', '#/agents/nope', '#/agents/%E0%A4%A', '#/home/a']) assert.equal(agentsScope(hash, s), undefined, hash);
  });

  it("paneRoute: an orchestrator's pane is its Home", () => {
    assert.equal(paneRoute(s, 'p2'), '#/home/wc%20o2');
    assert.equal(paneRoute(s, 'w:1/2'), '#/pane/w%3A1%2F2');
    assert.equal(paneRoute(null, 'p1'), '#/pane/p1');
  });

  it("nextPaneBackRoute: a Home or an account's list it came from; pane to pane keeps it", () => {
    assert.equal(nextPaneBackRoute('#/home/a', '#/agents'), '#/home/a');
    assert.equal(nextPaneBackRoute('#/agents/a', '#/agents'), '#/agents/a');
    assert.equal(nextPaneBackRoute('#/pane/p9', '#/agents/a'), '#/agents/a');
    for (const from of ['#/agents', '#/settings', '', null]) assert.equal(nextPaneBackRoute(from, '#/home/a'), '#/agents', String(from));
  });

  it("paneGoneRoute: back to the account's list a pane came from, else the list", () => {
    assert.equal(paneGoneRoute({ homeMode: false, paneBackRoute: '#/agents/a' }), '#/agents/a');
    assert.equal(paneGoneRoute({ homeMode: false, paneBackRoute: '#/home/a' }), '#/agents');
    assert.equal(paneGoneRoute({ homeMode: true, paneBackRoute: '#/agents/a' }), '#/agents');
  });
});
