import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountEnv, accountForConfigDir, paneAccount, paneAccountCache, parseProcStat } from '../account.ts';

describe('paneAccountCache', () => {
  it('looks each agent pane up again after the ttl, retries failures, and forgets panes without an agent', async () => {
    let clock = 0;
    const answers: Record<string, string | null | Error> = { p1: 'A', p2: null, p3: new Error('no answer') };
    const asked: string[] = [];
    let changes = 0;
    const cache = paneAccountCache((id) => {
      asked.push(id);
      const a = answers[id];
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
    }, () => { changes++; }, 100, () => clock);
    const settle = () => new Promise((r) => setTimeout(r, 0));

    cache.refresh(['p1', 'p2', 'p3']);
    await settle();
    assert.deepEqual([...cache.accounts], [['p1', 'A'], ['p2', null]]); // p3 failed: not stored
    assert.equal(changes, 2);

    asked.length = 0;
    clock = 50; // within the ttl: only the failed one is asked again
    cache.refresh(['p1', 'p2', 'p3']);
    await settle();
    assert.deepEqual(asked, ['p3']);

    asked.length = 0;
    clock = 200; // past the ttl: p2 can now be told, and p1 was swapped for another account's agent
    Object.assign(answers, { p1: 'B', p2: 'A' });
    cache.refresh(['p1', 'p2']); // p3 lost its agent
    await settle();
    assert.deepEqual(asked, ['p1', 'p2']);
    assert.deepEqual([...cache.accounts], [['p1', 'B'], ['p2', 'A']]);
    assert.equal(changes, 4);

    clock = 400; // the same answers again: no change pushed
    cache.refresh(['p1', 'p2']);
    await settle();
    assert.equal(changes, 4);
  });
});

describe('accountForConfigDir', () => {
  it('is CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects, normalized', () => {
    assert.equal(accountForConfigDir('/home/u/.config/claude/work/', '/home/u'), '/home/u/.config/claude/work/projects');
    assert.equal(accountForConfigDir(undefined, '/home/u'), '/home/u/.claude/projects');
    assert.equal(accountForConfigDir('', '/home/u'), '/home/u/.claude/projects');
    // an explicit default dir is the same account as an unset one
    assert.equal(accountForConfigDir('/home/u/.claude', '/home/u'), accountForConfigDir(undefined, '/home/u'));
  });
});

describe('accountEnv', () => {
  it('sets CLAUDE_CONFIG_DIR for any account but the default (left unset), nothing for an unknown one', () => {
    assert.deepEqual(accountEnv('/home/u/.config/claude/work/projects', '/home/u'), { CLAUDE_CONFIG_DIR: '/home/u/.config/claude/work' });
    assert.equal(accountEnv('/home/u/.claude/projects', '/home/u'), undefined);
    assert.equal(accountEnv(null, '/home/u'), undefined);
  });
});

describe('parseProcStat', () => {
  it('reads comm and ppid, even when comm holds spaces or parens', () => {
    assert.deepEqual(parseProcStat('4177341 (bash) S 3920697 4177341 3919750 34817'), { comm: 'bash', ppid: 3920697 });
    assert.deepEqual(parseProcStat('12 (a (b) c) R 7 12 12 0'), { comm: 'a (b) c', ppid: 7 });
    assert.equal(parseProcStat('garbage'), null);
  });
});

describe('paneAccount', () => {
  const rpcFor = (process_info: unknown) => async () => ({ process_info });
  it('is unknown when no agent is in the foreground (the shell itself, or no group)', async () => {
    assert.equal(await paneAccount(rpcFor({ foreground_process_group_id: 50, shell_pid: 50 }), 'p'), null);
    assert.equal(await paneAccount(rpcFor({ shell_pid: 50 }), 'p'), null);
    assert.equal(await paneAccount(async () => null, 'p'), null);
  });
});
