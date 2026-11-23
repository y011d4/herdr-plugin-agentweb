import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOrchestrators } from '../config.ts';

const HOME = '/home/u';
const DEFAULT_DIR = '/home/u/.local/share/herdr-agentweb/dispatcher';

describe('parseOrchestrators', () => {
  it('reads name/label/dir in order, expanding ~ and dropping a trailing slash', () => {
    assert.deepEqual(parseOrchestrators([
      { name: 'personal', label: 'Personal', dir: '~/.local/share/herdr-agentweb/dispatcher/' },
      { name: 'work', label: ' Work ', dir: '/srv/orch-work' },
    ], undefined, HOME), [
      { name: 'personal', label: 'Personal', dir: DEFAULT_DIR },
      { name: 'work', label: 'Work', dir: '/srv/orch-work' },
    ]);
  });

  it('labels an entry by its name when it has none', () => {
    assert.deepEqual(parseOrchestrators([{ name: 'work', dir: '/w' }], undefined, HOME), [{ name: 'work', label: 'work', dir: '/w' }]);
  });

  it('drops malformed entries and repeated names', () => {
    assert.deepEqual(parseOrchestrators([
      null, 'x', { name: 'no-dir' }, { dir: '/no-name' }, { name: 'bad/name', dir: '/b' }, { name: ' ', dir: '/s' },
      { name: 'ok', dir: '/a' }, { name: 'ok', dir: '/again' },
    ], undefined, HOME), [{ name: 'ok', label: 'ok', dir: '/a' }]);
  });

  it('falls back to the legacy single orchestrator_dir, or its default dir', () => {
    const legacy = (dir: string) => [{ name: 'default', label: '', dir }];
    assert.deepEqual(parseOrchestrators(undefined, '~/orch', HOME), legacy('/home/u/orch'));
    assert.deepEqual(parseOrchestrators([], undefined, HOME), legacy(DEFAULT_DIR));
    assert.deepEqual(parseOrchestrators([{ name: 'bad/name', dir: '/b' }], ' ', HOME), legacy(DEFAULT_DIR));
    // a valid list wins over the legacy key
    assert.equal(parseOrchestrators([{ name: 'a', dir: '/a' }], '/legacy', HOME)[0].dir, '/a');
  });
});
