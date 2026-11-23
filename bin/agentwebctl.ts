#!/usr/bin/env node
// Plugin entrypoint: run | start | stop | status | qr | overview | agent | worktree | orchestrator
// Invoked by herdr plugin actions/panes with cwd = plugin root, or manually.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSplitter, serialize } from '../server/ndjson.ts';
import { formatOverview, orderAgents, isTaskTurn, type AgentDetail, type RawAgent, type RawSnapshot } from '../server/overview.ts';
import { readTranscriptTail, resolveTranscriptPath, findLastItem } from '../server/transcript.ts';
import { placeWorktreeNextToRepo } from '../server/worktree-resolve.ts';
import { accountEnv, dirAccount, ownAccount, paneAccount } from '../server/account.ts';
import { parseOrchestrators } from '../server/config.ts';
import { startOrchestrator } from '../server/orchestrator.ts';
import { checkoutInUse, parseLaunchProfiles, startAgent, waitForDetectedAgent, type Rpc, type StartAgentInput } from '../server/agent-lifecycle.ts';

// Walk up from the script's directory until a directory containing package.json
// is found. This is necessary because this file runs from dist/bin/agentwebctl.js,
// so __dirname is dist/bin — not the project root.
function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not find project root (no package.json found)');
    dir = parent;
  }
}

const projectRoot = findProjectRoot();
// Use built dist/server/main.js if it exists; otherwise fall back to TS source
// for dev (Node >= 23.6 runs .ts natively).
const mainJs = fs.existsSync(path.join(projectRoot, 'dist', 'server', 'main.js'))
  ? path.join(projectRoot, 'dist', 'server', 'main.js')
  : path.join(projectRoot, 'server', 'main.ts');

function stateDir(): string {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR
    || path.join(os.homedir(), '.local', 'state', 'herdr-agentweb');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function configDir(): string {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) return process.env.HERDR_PLUGIN_CONFIG_DIR;
  // run outside herdr's plugin env (e.g. from an orchestrator's Bash): ask herdr
  const r = spawnSync('herdr', ['plugin', 'config-dir', 'y011d4.agentweb'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : stateDir();
}

function readConfig(): Record<string, unknown> {
  const file = path.join(configDir(), 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// The detached daemon (start/stop) and the foreground pane (run) own separate
// pidfiles so one lifecycle can't clobber the other's bookkeeping.
const daemonPidFile = () => path.join(stateDir(), 'bridge.pid');
const runPidFile = () => path.join(stateDir(), 'bridge-run.pid');

// A live PID from a pidfile isn't proof it's still our bridge — the file can be
// stale and the PID reused by an unrelated same-user process. Best-effort verify
// via `ps` that the process is still running our bridge entry (main.js/main.ts,
// how both start() and run() launch it). If `ps` is unavailable or gives no
// output, fall back to trusting the PID rather than risk ignoring a real bridge.
function looksLikeBridge(pid: number): boolean {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  if (ps.status !== 0 || typeof ps.stdout !== 'string') return true;
  const cmd = ps.stdout.trim();
  if (!cmd) return true;
  const mainTs = path.join(projectRoot, 'server', 'main.ts');
  const mainJsBuilt = path.join(projectRoot, 'dist', 'server', 'main.js');
  return cmd.includes(mainJsBuilt) || cmd.includes(mainTs);
}

function alivePid(file: string): number | null {
  let pid: number;
  try {
    pid = Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  if (!looksLikeBridge(pid)) {
    fs.rmSync(file, { force: true }); // stale pidfile whose PID was reused
    return null;
  }
  return pid;
}

function baseUrl(): string {
  const cfg = readConfig();
  const host = process.env.HERDR_AGENTWEB_HOST || (cfg.host as string) || '127.0.0.1';
  const port = Number(process.env.HERDR_AGENTWEB_PORT || cfg.port || 8390);
  return `http://${host}:${port}/`;
}

// herdr captures action stdout into its plugin logs, so never print the token
// here. The tokenized connect link is printed by the server itself: visible in
// the "Agent Web bridge" pane (run entrypoint) and in <state dir>/bridge.log.
function printConnectInfo(): void {
  console.log(`url: ${baseUrl()}`);
  console.log(`token file: ${path.join(stateDir(), 'token')}`);
  console.log(`full connect link: see the Agent Web bridge pane or ${path.join(stateDir(), 'bridge.log')}`);
}

function notify(title: string, body: string): void {
  const herdr = process.env.HERDR_BIN_PATH;
  if (!herdr) return;
  spawnSync(herdr, ['notification', 'show', title, '--body', body], { stdio: 'ignore' });
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Synchronous sleep — this CLI is entirely synchronous; block the thread on a
// throwaway SharedArrayBuffer for `ms` rather than busy-looping.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Wait until `pid` exits or the timeout elapses; returns true if it exited.
function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    sleepSync(100);
  }
  return true;
}

function start(): number {
  const daemon = alivePid(daemonPidFile());
  const fg = alivePid(runPidFile());
  if (daemon || fg) {
    console.log(`bridge already running (pid ${daemon || fg}${fg ? ', foreground pane' : ''})`);
    printConnectInfo();
    return 0;
  }
  const logPath = path.join(stateDir(), 'bridge.log');
  const log = fs.openSync(logPath, 'a', 0o600);
  // mode on open only applies when the file is created; the server writes the
  // tokenized connect URL to this log, so tighten an existing log's perms too.
  fs.chmodSync(logPath, 0o600);
  const child = spawn(process.execPath, [mainJs], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(daemonPidFile(), String(child.pid), { mode: 0o600 });
  // Give the child a moment to bind the port; if it died immediately (e.g. a
  // previous bridge still held the port) surface the failure instead of
  // reporting a false success and leaving a stale pidfile behind.
  sleepSync(400);
  if (child.pid === undefined || !pidAlive(child.pid)) {
    fs.rmSync(daemonPidFile(), { force: true });
    console.error(`bridge failed to start; see ${logPath}`);
    return 1;
  }
  console.log(`bridge started (pid ${child.pid})`);
  printConnectInfo();
  console.log(`log: ${logPath}`);
  notify('herdr agent web started', baseUrl());
  return 0;
}

function stop(): number {
  const daemon = alivePid(daemonPidFile());
  const fg = alivePid(runPidFile());
  const pid = daemon || fg;
  if (!pid) {
    console.log('bridge is not running');
    fs.rmSync(daemonPidFile(), { force: true });
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  // Wait for the process to actually release the port before returning, so a
  // following start() doesn't race the dying bridge into EADDRINUSE. Do NOT
  // escalate to SIGKILL: a stale pidfile's PID may have been reused by an
  // unrelated same-user process, and force-killing that is worse than a slow
  // stop. If SIGTERM doesn't take within the timeout, warn and clear the pidfile.
  const exited = waitForExit(pid, 5000);
  fs.rmSync(daemon ? daemonPidFile() : runPidFile(), { force: true });
  if (!exited) {
    console.error(`bridge (pid ${pid}) did not exit within 5s of SIGTERM; not force-killing`);
    notify('herdr agent web stop timed out', `pid ${pid}`);
    return 1;
  }
  console.log(`bridge stopped (pid ${pid})`);
  notify('herdr agent web stopped', `pid ${pid}`);
  return 0;
}

function status(): number {
  const daemon = alivePid(daemonPidFile());
  const fg = alivePid(runPidFile());
  if (daemon || fg) {
    console.log(`bridge running (pid ${daemon || fg}${fg ? ', foreground pane' : ''})`);
    printConnectInfo();
    notify('herdr agent web running', baseUrl());
  } else {
    console.log('bridge is not running');
    notify('herdr agent web stopped', 'invoke y011d4.agentweb.start to launch');
  }
  return 0;
}

interface TailscaleInfo {
  dns: string | null;
  ip: string | null;
  serveActive: boolean;
}

function tailscaleInfo(port: number): TailscaleInfo {
  try {
    const statusResult = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
    if (statusResult.status !== 0) return { dns: null, ip: null, serveActive: false };
    const st = JSON.parse(statusResult.stdout) as Record<string, unknown>;
    const self = st?.Self as Record<string, unknown> | undefined;
    const dns = ((self?.DNSName as string) || '').replace(/\.$/, '') || null;
    const ips = self?.TailscaleIPs as string[] | undefined;
    const ip = ips?.[0] || null;
    const serve = spawnSync('tailscale', ['serve', 'status'], { encoding: 'utf8' });
    const serveActive = serve.status === 0 && serve.stdout.includes(`:${port}`);
    return { dns, ip, serveActive };
  } catch {
    return { dns: null, ip: null, serveActive: false };
  }
}

// Show the connect link as a QR code (pane entrypoint "connect", or manual CLI).
// Unlike start/status this is an explicit, interactive surface, so the
// tokenized URL is intentionally shown here.
async function qr(): Promise<number> {
  let token: string;
  try {
    token = fs.readFileSync(path.join(stateDir(), 'token'), 'utf8').trim();
  } catch {
    console.error('no token yet — start the bridge first (action y011d4.agentweb.start)');
    return 1;
  }
  const cfg = readConfig();
  const port = Number(process.env.HERDR_AGENTWEB_PORT || cfg.port || 8390);

  // config public_url wins; tailscale auto-detection is only a zero-config
  // convenience fallback, not a dependency.
  const publicUrl =
    typeof cfg.public_url === 'string' && cfg.public_url.trim() !== ''
      ? cfg.public_url.trim().replace(/\/+$/, '')
      : null;

  let url: string;
  let hint: string | null = null;
  if (publicUrl) {
    url = `${publicUrl}/?token=${token}`;
  } else {
    const ts = tailscaleInfo(port);
    if (ts.serveActive && ts.dns) {
      url = `https://${ts.dns}/?token=${token}`;
    } else if (ts.ip) {
      url = `http://${ts.ip}:${port}/?token=${token}`;
    } else {
      url = `${baseUrl()}?token=${token}`;
    }
    if (!ts.serveActive) {
      hint = `hint: set "public_url" in config.json (herdr plugin config-dir y011d4.agentweb) to your reverse-proxy / tunnel / VPN address (Cloudflare Tunnel, Caddy, ngrok, ...). Tailscale is auto-detected; for tailnet HTTPS run: tailscale serve --bg ${port}`;
    }
  }

  // Feed the tokenized URL to qrencode via stdin, not argv — a command-line
  // argument would expose the bearer token in process listings (ps).
  const enc = spawnSync('qrencode', ['-t', 'UTF8'], { encoding: 'utf8', input: url });
  if (enc.status === 0) {
    console.log(enc.stdout);
  } else {
    console.log('(qrencode not found — install it for a scannable QR code)\n');
  }
  console.log(url);
  if (hint) {
    console.log(`\n${hint}`);
  }
  if (process.env.HERDR_PLUGIN_ENTRYPOINT_ID) {
    console.log('\npress Enter to close');
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  }
  return 0;
}

function run(): Promise<number> | number {
  const daemon = alivePid(daemonPidFile());
  const fg = alivePid(runPidFile());
  if (daemon || fg) {
    console.error(`bridge already running (pid ${daemon || fg}); stop it first`);
    return 1;
  }
  const child = spawn(process.execPath, [mainJs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  fs.writeFileSync(runPidFile(), String(child.pid), { mode: 0o600 });
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      fs.rmSync(runPidFile(), { force: true });
      resolve(code ?? 1);
    });
  });
}

// One-shot herdr RPC: herdr answers one request per connection, then closes.
// Errors carry herdr's code as `herdrCode` (agent-lifecycle retries on some).
function herdrRpc(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<any> {
  const socketPath = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    const splitter = createSplitter();
    conn.setTimeout(timeoutMs, () => conn.destroy(new Error(`${method}: timeout`)));
    conn.setEncoding('utf8'); // decodes across chunk boundaries (a split multi-byte char stays whole)
    conn.on('connect', () => conn.write(serialize({ type: 'request', id: 'agentwebctl', method, params })));
    conn.on('data', (chunk: string) => {
      const line = splitter.push(chunk)[0];
      if (!line) return;
      conn.destroy();
      try {
        const msg = JSON.parse(line);
        if (msg.error) reject(Object.assign(new Error(msg.error.message || `${method} failed`), { herdrCode: msg.error.code }));
        else resolve(msg.result);
      } catch (e) { reject(e); }
    });
    conn.on('error', reject);
    conn.on('close', () => reject(new Error(`${method}: connection closed`)));
  });
}

// Read-only, LLM-facing summary of every other herdr agent of the caller's Claude
// account (for an orchestrator agent's Bash tool; agents of other accounts, or whose
// account can't be told, are left out). Touches only the herdr socket and the
// claude transcripts, never the state dir or the bridge token.
async function overview(): Promise<number> {
  let snapshot: RawSnapshot;
  let agents: RawAgent[];
  try {
    const [list, snap] = await Promise.all([herdrRpc('agent.list'), herdrRpc('session.snapshot')]);
    agents = list.agents ?? [];
    snapshot = snap.snapshot ?? {};
  } catch (e) {
    console.error(`herdr unreachable: ${(e as Error).message}`);
    return 1;
  }
  const own = await ownAccount();
  const mine = await Promise.all(agents.map(async (a) =>
    own !== null && (await paneAccount(herdrRpc, a.pane_id).catch(() => null)) === own));
  agents = agents.filter((_, i) => mine[i]);
  const self = process.env.HERDR_PANE_ID;
  const details = new Map<string, AgentDetail>();
  await Promise.all(orderAgents(agents, self).map(async (a) => {
    const detail: AgentDetail = {};
    details.set(a.pane_id, detail);
    const sess = a.agent_session;
    if (sess?.source?.startsWith('herdr:claude') && sess.value) {
      // own: every listed agent runs under it, wherever its CLAUDE_CONFIG_DIR lives
      const file = resolveTranscriptPath(sess.value, a.foreground_cwd || a.cwd || null, own ? [own] : []);
      if (file) {
        detail.items = readTranscriptTail(file, 1000).items;
        // the request scrolled out of the tail window: look further back for it
        if (!detail.items.some(isTaskTurn)) {
          const older = findLastItem(file, isTaskTurn);
          if (older?.kind === 'user') detail.olderTask = older.text;
        }
      }
    }
    if (detail.items?.length) return;
    try {
      detail.screen = (await herdrRpc('pane.read', { pane_id: a.pane_id, source: 'recent', lines: 40, format: 'text' })).read?.text;
    } catch { /* header only, no screen excerpt */ }
  }));
  console.log(formatOverview(agents, snapshot, details, self, Date.now()));
  return 0;
}

// ── orchestrator agent commands ───────────────────────────────────────────────
// The herdr agent commands an orchestrator needs, refused for any agent or place
// outside its own Claude account (server/account.ts) — so an orchestrator allowed
// only these (not the herdr CLI) can't see or drive another account's agents.
// Once checked, get/read/prompt/wait run herdr's own CLI on the resolved pane, so
// output, flags and --wait behave exactly like `herdr agent …`.

const AGENT_USAGE = `usage: agentwebctl.js agent get|read|prompt|wait <target> [herdr agent flags]
       agentwebctl.js agent start <name> --cwd <dir> [--profile <launch profile>] [--worktree <branch> [--base <ref>]]`;

async function agent(): Promise<number> {
  const [sub, ...args] = process.argv.slice(3);
  if (sub === 'start') return agentStart(args);
  const [target, ...rest] = args;
  if (!['get', 'read', 'prompt', 'wait'].includes(sub) || !target || target.startsWith('-')) {
    console.error(AGENT_USAGE);
    return 2;
  }
  let paneId: string | undefined;
  try {
    paneId = (await herdrRpc('agent.get', { target })).agent?.pane_id;
  } catch (e) {
    console.error(`${target}: ${(e as Error).message}`);
    return 1;
  }
  const own = await ownAccount();
  const theirs = paneId ? await paneAccount(herdrRpc, paneId).catch(() => null) : null;
  if (own === null || theirs !== own) {
    console.error(`refused: ${target} is not an agent of this Claude account (or its account can't be told)`);
    return 1;
  }
  // the pane id, not the name: what was checked is what herdr acts on
  return spawnSync('herdr', ['agent', sub, paneId!, ...rest], { stdio: 'inherit' }).status ?? 1;
}

// Start an agent from a launch profile (config launch_profiles; never a raw command)
// in a dir of the caller's account: a new tab in the workspace already at that dir
// (else a new workspace), or a new worktree of the repo there. The dir's account is
// checked before anything is created, the started agent's after; a mismatch closes it.
async function agentStart(args: string[]): Promise<number> {
  const [name, ...flags] = args;
  const opt: Record<string, string> = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--cwd', '--profile', '--worktree', '--base'].includes(flags[i]) || flags[i + 1] === undefined) {
      console.error(AGENT_USAGE);
      return 2;
    }
    opt[flags[i].slice(2)] = flags[i + 1];
  }
  if (!name || name.startsWith('-') || !opt.cwd || (opt.base && !opt.worktree)) {
    console.error(AGENT_USAGE);
    return 2;
  }
  const dir = path.resolve(opt.cwd);
  const input: StartAgentInput = { profile: opt.profile ?? 'claude', name, cwd: dir };
  const places = [dir];
  if (opt.worktree) {
    // next to the repo, so an .envrc above it (e.g. one per org dir) sets the checkout's account too
    try {
      input.worktree = await placeWorktreeNextToRepo({ repo: dir, branch: opt.worktree, base: opt.base });
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
    places.push(path.dirname(input.worktree.path as string));
  }
  // A new tab/workspace is started with the caller's account (CLAUDE_CONFIG_DIR), so it
  // needs no direnv; it is refused only where direnv says another account applies. A
  // worktree gets no env from herdr, so its account must come from the dir itself.
  const own = await ownAccount();
  if (!input.worktree) input.env = accountEnv(own);
  for (const p of places) {
    const theirs = await dirAccount(p);
    if (own === null || (theirs !== own && (theirs !== null || input.worktree))) {
      console.error(`refused: ${p} is not under this Claude account (its direnv CLAUDE_CONFIG_DIR differs${input.worktree ? ', or can\'t be read' : ''})`);
      return 1;
    }
  }

  // agent.start waits for the agent to come up, and worktree.create runs git: allow time
  const rpc: Rpc = (method, params) => herdrRpc(method, params, 60_000);
  if (!input.worktree) {
    // the workspace already at this dir (a worktree checkout, or any pane launched there)
    const snap = ((await rpc('session.snapshot')) as { snapshot?: {
      workspaces?: Array<{ workspace_id: string; worktree?: { checkout_path?: string } }>;
      panes?: Array<{ workspace_id?: string; cwd?: string }>;
    } }).snapshot ?? {};
    const ws = snap.workspaces?.find((w) => w.worktree?.checkout_path === dir)?.workspace_id
      ?? snap.panes?.find((p) => p.cwd === dir)?.workspace_id;
    if (ws) input.workspace = ws;
    else input.newWorkspace = true;
  }
  try {
    const out = await startAgent(rpc, parseLaunchProfiles(readConfig().launch_profiles), input, {
      verify: async (paneId) => {
        await waitForDetectedAgent(rpc, paneId);
        if ((await paneAccount(rpc, paneId)) !== own) throw new Error('the agent came up under another Claude account');
      },
    });
    console.log(`started ${out.name} (pane ${out.paneId}) in ${input.worktree?.path ?? dir}`);
    return 0;
  } catch (e) {
    console.error(`start failed: ${(e as Error).message}`);
    return 1;
  }
}

// Clean up a finished worker's worktree: remove the checkout (herdr's worktree.remove,
// which itself refuses uncommitted or untracked files) and delete its branch — only
// for a linked worktree of the caller's account with no agent left in it, whose
// branch is merged upstream (an ancestor of origin's default branch, or the head of
// a merged PR, for squash merges). Anything else is refused and left as it is.
async function worktree(): Promise<number> {
  const [sub, target] = process.argv.slice(3);
  if (sub !== 'remove' || !target) {
    console.error('usage: agentwebctl.js worktree remove <checkout path>');
    return 2;
  }
  const dir = path.resolve(target);
  const refuse = (why: string): number => { console.error(`refused: ${why}; ${dir} was left as it is`); return 1; };
  const snap = ((await herdrRpc('session.snapshot')) as { snapshot?: {
    workspaces?: Array<{ workspace_id: string; worktree?: { checkout_path?: string; repo_root?: string; is_linked_worktree?: boolean } }>;
    panes?: Array<{ workspace_id?: string; agent?: string | null; cwd?: string; foreground_cwd?: string }>;
  } }).snapshot ?? {};
  const ws = snap.workspaces?.find((w) => w.worktree?.checkout_path === dir && w.worktree.is_linked_worktree);
  if (!ws?.worktree?.repo_root) return refuse('not a linked worktree open in herdr');
  const own = await ownAccount();
  if (own === null || (await dirAccount(dir)) !== own) return refuse('it is not under this Claude account');
  if (checkoutInUse(snap.panes ?? [], ws.workspace_id, dir)) return refuse('an agent still runs in it (end it with /exit first)');

  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
  const branch = git('symbolic-ref', '--short', 'HEAD').stdout?.trim();
  if (!branch) return refuse('its HEAD is not on a branch');
  const tip = git('rev-parse', 'HEAD').stdout.trim();
  git('fetch', '--quiet', 'origin'); // best effort: judge against what's upstream now
  const upstream = git('rev-parse', '--abbrev-ref', 'origin/HEAD').stdout?.trim() || 'origin/main';
  const merged = git('merge-base', '--is-ancestor', tip, upstream).status === 0
    || spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid', '--jq', '.[].headRefOid'],
      { cwd: dir, encoding: 'utf8', timeout: 60_000 }).stdout?.split('\n').includes(tip);
  if (!merged) return refuse(`${branch} has commits not merged into ${upstream} (nor the head of a merged PR)`);

  try {
    await herdrRpc('worktree.remove', { workspace_id: ws.workspace_id }, 60_000);
  } catch (e) {
    const dirty = (e as { herdrCode?: string }).herdrCode === 'dirty_worktree_requires_force';
    return refuse(dirty ? 'it has uncommitted or untracked files' : (e as Error).message);
  }
  // merge verified above (a squash merge isn't an ancestor, so -d would balk)
  const del = spawnSync('git', ['-C', ws.worktree.repo_root, 'branch', '-D', branch], { encoding: 'utf8' });
  console.log(`removed ${dir}${del.status === 0 ? ` and branch ${branch}` : ` (branch ${branch} kept: ${del.stderr.trim()})`}`);
  return 0;
}

// Start a configured orchestrator (config.json `orchestrators`) the way the phone's Start
// button does: write its dir, then start it in a new workspace with its env.
async function orchestrator(): Promise<number> {
  const [sub, name] = process.argv.slice(3);
  if (sub !== 'start' || !name) {
    console.error('usage: agentwebctl.js orchestrator start <name>');
    return 2;
  }
  const cfg = readConfig();
  const def = parseOrchestrators(cfg.orchestrators, cfg.orchestrator_dir).find((o) => o.name === name);
  if (!def) {
    console.error(`no orchestrator named ${name} in config.json`);
    return 1;
  }
  try {
    const out = await startOrchestrator((method, params) => herdrRpc(method, params, 60_000), def);
    console.log(`started orchestrator ${name} (pane ${out.paneId}) in ${def.dir}`);
    return 0;
  } catch (e) {
    console.error(`start failed: ${(e as Error).message}`);
    return 1;
  }
}

const command = process.argv[2];
const handlers: Record<string, () => number | Promise<number>> = { run, start, stop, status, qr, overview, agent, worktree, orchestrator };
const handler = handlers[command];
if (!handler) {
  console.error('usage: agentwebctl.js <run|start|stop|status|qr|overview|agent|worktree|orchestrator>');
  process.exit(2);
}
process.exit(await handler());
