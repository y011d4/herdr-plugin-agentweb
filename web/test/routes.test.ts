import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { isOverlay, nextOverlayBase, nextOverlayOverBase, paneRoute, resolveRoute } from '../src/routes.ts';
import type { AppState, OrchestratorView } from '../src/types.ts';

const orch = (name: string, paneId: string | null): OrchestratorView => ({ name, label: '', paneId, agents: null, mode: 'tui', headless: null });
const state = (...orchestrators: OrchestratorView[]): AppState => ({
  connected: true, herdr: { version: null, protocol: null }, focused: { workspaceId: null, tabId: null, paneId: null },
  workspaces: [], orchestrators, orchestratorPaneId: null,
});
const replace = (hash: string) => ({ kind: 'redirect', hash, replace: true });

describe('resolveRoute — the default Home (a fresh open, and #/home)', () => {
  const two = state(orch('a', 'p1'), orch('stopped', null), orch('b', 'p2'));

  for (const hash of ['', '#/home']) {
    it(`${hash || '(empty)'}: the Home used last, running or not, else the first running one`, () => {
      assert.deepEqual(resolveRoute(hash, two, 'b'), replace('#/home/b'));
      assert.deepEqual(resolveRoute(hash, two, null), replace('#/home/a'));
      assert.deepEqual(resolveRoute(hash, two, 'stopped'), replace('#/home/stopped'));
      assert.deepEqual(resolveRoute(hash, two, 'gone'), replace('#/home/a'));
      assert.deepEqual(resolveRoute(hash, state(orch('wc o1', 'p1')), null), replace('#/home/wc%20o1'));
    });

    it(`${hash || '(empty)'}: none running, the first configured (stopped); a spinner without any (the bridge always has one)`, () => {
      assert.deepEqual(resolveRoute(hash, state(orch('x', null), orch('y', null)), null), replace('#/home/x'));
      assert.deepEqual(resolveRoute(hash, state(), null), { kind: 'loading' });
    });
  }

  it('waits for the first state: an empty hash and #/home show a spinner', () => {
    assert.deepEqual(resolveRoute('', null, 'a'), { kind: 'loading' });
    assert.deepEqual(resolveRoute('#/home', null, 'a'), { kind: 'loading' });
  });
});

describe('resolveRoute — #/home/<name>', () => {
  const s = state(orch('a', 'p1'), orch('stopped', null), orch('wc o1', 'p3'));

  it('a running orchestrator opens its Home on its pane', () => {
    assert.deepEqual(resolveRoute('#/home/a', s, null), { kind: 'home', name: 'a', paneId: 'p1' });
    assert.deepEqual(resolveRoute('#/home/wc%20o1', s, null), { kind: 'home', name: 'wc o1', paneId: 'p3' });
  });

  it('a stopped orchestrator opens its Home too, without a pane', () => {
    assert.deepEqual(resolveRoute('#/home/stopped', s, null), { kind: 'home', name: 'stopped', paneId: null });
  });

  it('an unknown or broken name goes to the default Home, in its place (Back past it)', () => {
    for (const hash of ['#/home/nope', '#/home/%E0%A4%A']) assert.deepEqual(resolveRoute(hash, s, null), replace('#/home'), hash);
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

  it('a broken or unknown hash goes to the default Home, in its place', () => {
    for (const hash of ['#/pane/%E0%A4%A', '#/nope', '#/agentsx', '#settings', '#/']) assert.deepEqual(resolveRoute(hash, s, null), replace('#/home'), hash);
  });

  it("the agents list's old routes: #/agents/<name> its Home, else the default Home, in their place", () => {
    assert.deepEqual(resolveRoute('#/agents/a', s, null), replace('#/home/a'));
    for (const hash of ['#/agents', '#/agents/nope', '#/agents/%E0%A4%A']) assert.deepEqual(resolveRoute(hash, s, null), replace('#/home'), hash);
    assert.deepEqual(resolveRoute('#/agents/a', null, null), { kind: 'loading' }, 'its Home once the State says which');
  });

  it('settings', () => {
    assert.deepEqual(resolveRoute('#/settings', s, null), { kind: 'settings' });
    assert.deepEqual(resolveRoute('#/settings', null, null), { kind: 'settings' });
  });
});

describe('route helpers', () => {
  const a = orch('a', 'p1');
  const s = state(a, orch('wc o2', 'p2'));

  it("paneRoute: an orchestrator's pane is its Home", () => {
    assert.equal(paneRoute(s, 'p2'), '#/home/wc%20o2');
    assert.equal(paneRoute(s, 'w:1/2'), '#/pane/w%3A1%2F2');
    assert.equal(paneRoute(null, 'p1'), '#/pane/p1');
  });

  it('isOverlay: a pane (its drawer) and Settings', () => {
    for (const h of ['#/pane/p1', '#/settings']) assert.ok(isOverlay(h), h);
    for (const h of ['#/home/a', '#/settings/x', '']) assert.ok(!isOverlay(h), h);
  });

  it("nextOverlayBase: a Home it came from; from an overlay (it replaced) the same; else #/home, the default Home", () => {
    assert.equal(nextOverlayBase('#/home/a', '#/home'), '#/home/a');
    assert.equal(nextOverlayBase('#/pane/p9', '#/home/b'), '#/home/b');
    assert.equal(nextOverlayBase('#/settings', '#/home/a'), '#/home/a');
    for (const from of ['#/', '#/nope', '', null]) assert.equal(nextOverlayBase(from, '#/home/a'), '#/home', String(from));
  });

  it('nextOverlayOverBase: opened from the screen under it; from an overlay the same; a fresh open or another screen not', () => {
    assert.equal(nextOverlayOverBase('#/home/a', '#/home/a', false), true);
    for (const from of ['#/pane/p9', '#/settings']) {
      assert.equal(nextOverlayOverBase(from, '#/home/a', true), true, from);
      assert.equal(nextOverlayOverBase(from, '#/home/a', false), false, from);
    }
    for (const from of ['#/', '', null]) assert.equal(nextOverlayOverBase(from, '#/home/a', true), false, String(from));
  });
});
