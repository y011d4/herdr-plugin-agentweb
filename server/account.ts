/**
 * Which Claude account a process / pane / directory belongs to, so an
 * orchestrator only sees and drives agents of its own account (agentwebctl
 * overview + `agent` commands). An account is its transcript projects root —
 * CLAUDE_CONFIG_DIR/projects, default ~/.claude/projects — the same key
 * projectsRootForPid derives from a process. Every lookup answers null when it
 * can't tell, and callers treat null as "not yours" (fail closed).
 *
 * Accounts come from the environment: per-dir direnv `.envrc`s export
 * CLAUDE_CONFIG_DIR. Like projectsRootForPid, nothing here holds or prints any
 * other variable (an .envrc may carry secrets).
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { projectsRootForPid } from './transcript.ts';
import type { Rpc } from './agent-lifecycle.ts';

export function accountForConfigDir(configDir: string | undefined, home: string = process.env.HOME || homedir()): string {
  return resolve(configDir ? join(configDir, 'projects') : join(home, '.claude', 'projects'));
}

/** The environment that starts a claude under `account`: CLAUDE_CONFIG_DIR for any but
 *  the default account, which is left unset as it was (set, even to ~/.claude, Claude
 *  Code keeps its state elsewhere). undefined for the default or an unknown account. */
export function accountEnv(account: string | null, home: string = process.env.HOME || homedir()): Record<string, string> | undefined {
  return account && account !== accountForConfigDir(undefined, home) ? { CLAUDE_CONFIG_DIR: dirname(account) } : undefined;
}

/** `comm` and parent pid out of /proc/<pid>/stat ("pid (comm) state ppid …"; comm may hold spaces or parens). */
export function parseProcStat(stat: string): { comm: string; ppid: number } | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open === -1 || close < open) return null;
  const ppid = Number(stat.slice(close + 2).split(' ')[1]);
  return Number.isInteger(ppid) ? { comm: stat.slice(open + 1, close), ppid } : null;
}

function isClaude(pid: number, comm: string): boolean {
  if (comm === 'claude') return true;
  try {
    return basename(readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]) === 'claude';
  } catch {
    return false;
  }
}

/**
 * The caller's account: that of the nearest `claude` ancestor (an orchestrator runs
 * us from its Bash tool), so a command-line CLAUDE_CONFIG_DIR can't pose as another
 * account. With no claude ancestor (a person in a terminal), our own environment.
 */
export async function ownAccount(): Promise<string | null> {
  let pid = process.ppid;
  for (let hops = 0; hops < 64 && pid > 1; hops++) {
    let st: ReturnType<typeof parseProcStat>;
    try {
      st = parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      break;
    }
    if (!st) break;
    if (isClaude(pid, st.comm)) return projectsRootForPid(pid);
    pid = st.ppid;
  }
  return accountForConfigDir(process.env.CLAUDE_CONFIG_DIR);
}

/**
 * A pane's account: that of its foreground process group leader — the agent the
 * shell launched. A pane whose shell is in the foreground (no agent) is unknown:
 * the shell's own environ predates direnv, so it would misreport.
 */
export async function paneAccount(rpc: Rpc, paneId: string): Promise<string | null> {
  const res = (await rpc('pane.process_info', { pane_id: paneId })) as {
    process_info?: { foreground_process_group_id?: number; shell_pid?: number };
  } | null;
  const pid = res?.process_info?.foreground_process_group_id;
  if (typeof pid !== 'number' || pid === res?.process_info?.shell_pid) return null;
  return projectsRootForPid(pid);
}

/**
 * Each agent pane's account, for the per-orchestrator lists. `refresh` (with the panes
 * that have an agent now) looks a pane up when it has none yet and again once `ttlMs` has
 * passed, so an answer that couldn't tell (null) or one left by an agent swapped in the
 * same pane corrects itself; panes that lost their agent are forgotten. A lookup that
 * fails is tried again on the next refresh. `onChange` runs when an answer changes the map.
 * ponytail: a swapped agent keeps the old account for up to ttlMs; key on herdr's agent
 * session if that ever matters.
 */
export function paneAccountCache(
  lookup: (paneId: string) => Promise<string | null>,
  onChange: () => void,
  ttlMs = 60_000,
  now: () => number = Date.now,
): { accounts: ReadonlyMap<string, string | null>; refresh: (agentPanes: string[]) => void } {
  const accounts = new Map<string, string | null>();
  const checkedAt = new Map<string, number>();
  const pending = new Set<string>();
  function refresh(agentPanes: string[]): void {
    const live = new Set(agentPanes);
    for (const id of checkedAt.keys()) {
      if (!live.has(id)) { checkedAt.delete(id); accounts.delete(id); }
    }
    for (const id of live) {
      if (pending.has(id) || now() - (checkedAt.get(id) ?? -Infinity) < ttlMs) continue;
      pending.add(id);
      void lookup(id).then((account) => {
        checkedAt.set(id, now());
        if (accounts.has(id) && accounts.get(id) === account) return;
        accounts.set(id, account);
        onChange();
      }, () => { /* no answer: the next refresh tries again */ }).finally(() => pending.delete(id));
    }
  }
  return { accounts, refresh };
}

/**
 * The account a fresh shell in `dir` would run under: what direnv exports there,
 * starting from our environment minus any account and direnv state of our own.
 * null when direnv is missing, the dir doesn't exist, or its .envrc is blocked.
 */
export function dirAccount(dir: string): Promise<string | null> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== 'CLAUDE_CONFIG_DIR' && !k.startsWith('DIRENV_')) env[k] = v;
  }
  return new Promise((res) => {
    // print only the one variable, behind a marker that proves the .envrc loaded
    // (direnv itself fails before running the command when it can't)
    execFile('direnv', ['exec', dir, 'sh', '-c', 'printf "ok:%s" "${CLAUDE_CONFIG_DIR-}"'],
      { env, timeout: 15_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        // the marker ends the output (an .envrc may print lines of its own before it)
        const m = /(?:^|\n)ok:([^\n]*)$/.exec(stdout);
        if (err || !m) return res(null);
        res(accountForConfigDir(m[1] || undefined, env.HOME));
      });
  });
}
