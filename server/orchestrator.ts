/**
 * Orchestrators the plugin manages (config `orchestrators`). Each gets a dir,
 * <data>/orchestrators/<name>/, which the plugin writes when the bridge starts and
 * again before each start of it:
 *   CLAUDE.md              imports rules.md, then local.md
 *   rules.md               the rules bundled with the plugin (orchestrator/rules.md),
 *                          with the real agentwebctl command filled in
 *   .claude/settings.json  the allowlist: agentwebctl only, nothing else asked or allowed
 *   local.md               this orchestrator's own rules — created once, never overwritten
 * (.claude/settings.local.json, which Claude Code also reads, is the user's too.)
 * It is started with its configured env (e.g. CLAUDE_CONFIG_DIR, picking its Claude
 * account), so no per-dir tool like direnv is needed, and the started agent's account
 * is checked against that env.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountForConfigDir, dirAccount, paneAccount } from './account.ts';
import { agentName, LifecycleError, startAgent, waitForDetectedAgent, type LaunchProfile, type Rpc } from './agent-lifecycle.ts';
import type { OrchestratorDef } from './types.ts';

/** The plugin's root: the nearest dir up from here with a package.json (works from server/ and dist/server/). */
export const PLUGIN_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
})();

/** A path as one shell word (quoted only when it needs to be). */
export function shellWord(p: string): string {
  return /^[\w./@%+=:,-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;
}

/** How an orchestrator runs agentwebctl: the exact command its allowlist permits. */
export const AGENTWEBCTL = `node ${shellWord(join(PLUGIN_ROOT, 'dist', 'bin', 'agentwebctl.js'))}`;

const LOCAL_TEMPLATE = `<!-- This orchestrator's own rules: which repos it takes on, what language to answer in,
     anything else. herdr-agentweb never changes this file (CLAUDE.md and rules.md are
     rewritten each time it starts the orchestrator). -->
`;

/** The plugin-written files of a managed orchestrator's dir (paths relative to it). */
export function orchestratorFiles(def: OrchestratorDef, rules: string, ctl = AGENTWEBCTL): Record<string, string> {
  const settings = {
    disableAgentView: true,
    permissions: {
      // anything not allowed below is refused without asking
      defaultMode: 'dontAsk',
      allow: [`Bash(${ctl} overview)`, `Bash(${ctl} agent *)`, `Bash(${ctl} worktree remove *)`],
      // dontAsk itself refuses most read-only commands (cat, ls, grep, git -C…) on paths outside
      // this dir, but runs these listers there; existence checks (test -e, realpath) still answer.
      // Not blockReadsOutsideWorkingDirectories: it also refuses agentwebctl, whose path and
      // --cwd/worktree paths lie outside this dir, and no allow rule or hook lifts that.
      // (Measured on Claude Code 2.1.322; recheck on upgrades.)
      deny: ['Edit', 'Write', 'NotebookEdit', 'Bash(herdr *)',
        'Bash(tree *)', 'Bash(du *)', 'Bash(fd *)', 'Bash(fdfind *)', 'Bash(lsof *)',
        'Read(~/.config/claude/**)', 'Read(~/.claude/projects/**)'],
    },
  };
  return {
    'CLAUDE.md': `<!-- Written by herdr-agentweb each time it starts this orchestrator: edits here are lost.
     This orchestrator's own rules go in local.md. -->

# Orchestrator: ${def.label}

@rules.md

@local.md
`,
    'rules.md': rules.replaceAll('{{agentwebctl}}', ctl),
    '.claude/settings.json': JSON.stringify(settings, null, 2) + '\n',
  };
}

/** Write a managed orchestrator's dir (see the top of this file); local.md only when missing. */
export function ensureOrchestratorDir(def: OrchestratorDef): void {
  const rules = readFileSync(join(PLUGIN_ROOT, 'orchestrator', 'rules.md'), 'utf8');
  mkdirSync(join(def.dir, '.claude'), { recursive: true });
  for (const [rel, text] of Object.entries(orchestratorFiles(def, rules))) writeFileSync(join(def.dir, rel), text);
  const local = join(def.dir, 'local.md');
  if (!existsSync(local)) writeFileSync(local, LOCAL_TEMPLATE);
}

// Always plain claude, whatever config does to the `claude` launch profile.
const ORCHESTRATOR_PROFILE: Record<string, LaunchProfile> = { claude: { argv: ['claude'], label: 'Claude Code' } };

/**
 * Start an orchestrator in a new workspace at its dir, with its env. Refused when one
 * already runs there. A managed dir is (re)written first; a legacy one must exist. The
 * started agent must come up under the account its env sets, else it is stopped again.
 */
export async function startOrchestrator(rpc: Rpc, def: OrchestratorDef): Promise<{ paneId: string; name: string }> {
  const agents = ((await rpc('agent.list')) as { agents?: Array<{ pane_id: string; cwd?: string }> } | null)?.agents ?? [];
  const running = agents.find((a) => a.cwd === def.dir || a.cwd?.startsWith(def.dir + '/'));
  if (running) throw new LifecycleError(409, 'already_running', `orchestrator ${def.name} already runs (pane ${running.pane_id})`);
  if (def.managed) ensureOrchestratorDir(def);
  else if (!existsSync(def.dir)) throw new LifecycleError(404, 'not_found', `${def.dir} does not exist`);
  // the account its env sets; else what its dir sets (a legacy dir's own .envrc), else the default
  const expected = def.env.CLAUDE_CONFIG_DIR ? accountForConfigDir(def.env.CLAUDE_CONFIG_DIR)
    : (await dirAccount(def.dir)) ?? accountForConfigDir(undefined);
  const out = await startAgent(rpc, ORCHESTRATOR_PROFILE, {
    profile: 'claude', name: agentName(`orch-${def.name}`) ?? 'orch', cwd: def.dir, newWorkspace: true, env: def.env,
  }, {
    verify: async (paneId) => {
      await waitForDetectedAgent(rpc, paneId);
      if ((await paneAccount(rpc, paneId)) !== expected) {
        throw new LifecycleError(409, 'account_mismatch', 'it came up under another Claude account than its env sets');
      }
    },
  });
  return { paneId: out.paneId, name: out.name };
}
