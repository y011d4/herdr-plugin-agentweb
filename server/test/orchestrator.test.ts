import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOrchestratorDir, orchestratorFiles, shellWord, startOrchestrator } from '../orchestrator.ts';
import { LifecycleError } from '../agent-lifecycle.ts';
import type { OrchestratorDef } from '../types.ts';

const def = (over: Partial<OrchestratorDef> = {}): OrchestratorDef =>
  ({ name: 'work', label: 'Work', dir: '/data/orchestrators/work', env: {}, managed: true, ...over });

describe('orchestratorFiles', () => {
  const files = orchestratorFiles(def(), 'run {{agentwebctl}} overview; {{agentwebctl}} agent get x', 'node /p/agentwebctl.js');

  it('CLAUDE.md names the orchestrator and imports the rules, then local.md', () => {
    assert.match(files['CLAUDE.md'], /# Orchestrator: Work/);
    assert.ok(files['CLAUDE.md'].indexOf('@rules.md') < files['CLAUDE.md'].indexOf('@local.md'));
  });

  it('fills the real agentwebctl command into the rules', () => {
    assert.equal(files['rules.md'], 'run node /p/agentwebctl.js overview; node /p/agentwebctl.js agent get x');
  });

  it('settings allow only that command (overview, agent, worktree remove) and refuse anything else unasked', () => {
    const p = JSON.parse(files['.claude/settings.json']).permissions;
    assert.equal(p.defaultMode, 'dontAsk');
    assert.deepEqual(p.allow, ['Bash(node /p/agentwebctl.js overview)', 'Bash(node /p/agentwebctl.js agent *)', 'Bash(node /p/agentwebctl.js worktree remove *)']);
    assert.ok(p.deny.includes('Bash(herdr *)') && p.deny.includes('Read(~/.config/claude/**)'));
    // listers dontAsk would run on any dir
    for (const lister of ['tree', 'du', 'fd', 'fdfind', 'lsof']) assert.ok(p.deny.includes(`Bash(${lister} *)`), lister);
    // it refuses agentwebctl itself: its path and the --cwd/worktree paths are outside the dir
    assert.equal(p.blockReadsOutsideWorkingDirectories, undefined);
  });
});

describe('shellWord', () => {
  it('leaves a plain path alone and single-quotes one with spaces or quotes', () => {
    assert.equal(shellWord('/home/u/plugin/dist/bin/agentwebctl.js'), '/home/u/plugin/dist/bin/agentwebctl.js');
    assert.equal(shellWord('/home/u/my plugin/x.js'), "'/home/u/my plugin/x.js'");
    assert.equal(shellWord("/it's/x.js"), "'/it'\\''s/x.js'");
  });
});

describe('ensureOrchestratorDir', () => {
  it('writes the dir, and creates local.md once without ever overwriting it', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'orch-')), 'work');
    ensureOrchestratorDir(def({ dir }));
    for (const f of ['CLAUDE.md', 'rules.md', '.claude/settings.json', 'local.md']) assert.ok(existsSync(join(dir, f)), f);
    assert.ok(!readFileSync(join(dir, 'rules.md'), 'utf8').includes('{{agentwebctl}}'));
    const mine = 'answer in Japanese\n';
    writeFileSync(join(dir, 'local.md'), mine); // the user's own edit
    ensureOrchestratorDir(def({ dir }));
    assert.equal(readFileSync(join(dir, 'local.md'), 'utf8'), mine);
    rmSync(join(dir, '..'), { recursive: true });
  });
});

describe('startOrchestrator', () => {
  const rpcWith = (agents: unknown[]) => async (method: string) => (method === 'agent.list' ? { agents } : {});
  it('refuses when one already runs in its dir (or below), and starts nothing', async () => {
    await assert.rejects(() => startOrchestrator(rpcWith([{ pane_id: 'p9', cwd: '/data/orchestrators/work/sub' }]), def()),
      (e: unknown) => e instanceof LifecycleError && e.status === 409 && /already runs \(pane p9\)/.test(e.message));
  });

  it('refuses a legacy (unmanaged) dir that does not exist, without writing anything', async () => {
    await assert.rejects(() => startOrchestrator(rpcWith([]), def({ managed: false, dir: '/nonexistent/orch' })),
      (e: unknown) => e instanceof LifecycleError && e.status === 404);
  });
});
