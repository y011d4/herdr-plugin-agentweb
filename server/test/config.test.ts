import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrchestrators } from '../config.ts';

const HOME = '/home/u';
const DATA = '/home/u/.local/share/herdr-agentweb';
const none = () => false;

describe('parseOrchestrators', () => {
  it('manages each entry in <data>/orchestrators/<name>, with its env (~ expanded)', () => {
    assert.deepEqual(parseOrchestrators([
      { name: 'personal', label: 'Personal' },
      { name: 'work', label: ' Work ', env: { CLAUDE_CONFIG_DIR: '~/.config/claude/work', OTHER: '/x' }, dir: '/ignored' },
    ], undefined, HOME, DATA, none), [
      { name: 'personal', label: 'Personal', dir: `${DATA}/orchestrators/personal`, env: {}, managed: true },
      { name: 'work', label: 'Work', dir: `${DATA}/orchestrators/work`, env: { CLAUDE_CONFIG_DIR: '/home/u/.config/claude/work', OTHER: '/x' }, managed: true },
    ]);
  });

  it('labels an entry by its name, and keeps only string env vars with plain names', () => {
    assert.deepEqual(parseOrchestrators([{ name: 'w', env: { 'BAD-NAME': 'x', N: 1, OK: 'y' } }], undefined, HOME, DATA, none),
      [{ name: 'w', label: 'w', dir: `${DATA}/orchestrators/w`, env: { OK: 'y' }, managed: true }]);
  });

  it('drops malformed entries and repeated names', () => {
    const out = parseOrchestrators([null, 'x', { label: 'no name' }, { name: '../up' }, { name: 'a b' }, { name: 'ok' }, { name: 'ok', label: 'again' }],
      undefined, HOME, DATA, none);
    assert.deepEqual(out.map((o) => [o.name, o.label]), [['ok', 'ok']]);
  });

  it('without orchestrators keeps the older setup: orchestrator_dir, else the old default dir if present, unmanaged', () => {
    const legacy = (dir: string) => [{ name: 'default', label: '', dir, env: {}, managed: false }];
    assert.deepEqual(parseOrchestrators(undefined, '~/orch/', HOME, DATA, none), legacy('/home/u/orch'));
    assert.deepEqual(parseOrchestrators([], undefined, HOME, DATA, (p) => p === `${DATA}/dispatcher`), legacy(`${DATA}/dispatcher`));
    // a valid list wins over both
    assert.equal(parseOrchestrators([{ name: 'a' }], '/legacy', HOME, DATA, () => true)[0].dir, `${DATA}/orchestrators/a`);
  });

  it('with nothing configured or left over, is one managed orchestrator named default', () => {
    assert.deepEqual(parseOrchestrators([{ name: 'bad/name' }], ' ', HOME, DATA, none),
      [{ name: 'default', label: '', dir: `${DATA}/orchestrators/default`, env: {}, managed: true }]);
  });
});
