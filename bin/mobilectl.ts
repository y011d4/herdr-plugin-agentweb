#!/usr/bin/env node
// Plugin entrypoint: run | start | stop | status
// Invoked by herdr plugin actions/panes with cwd = plugin root, or manually.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Walk up from the script's directory until a directory containing package.json
// is found. This is necessary because this file runs from dist/bin/mobilectl.js,
// so __dirname is dist/bin — not the project root.
function findProjectRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
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
    || path.join(os.homedir(), '.local', 'state', 'herdr-mobile');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function configDir(): string {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || stateDir();
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
    return pid;
  } catch {
    return null;
  }
}

function baseUrl(): string {
  const cfg = readConfig();
  const host = process.env.HERDR_MOBILE_HOST || (cfg.host as string) || '127.0.0.1';
  const port = Number(process.env.HERDR_MOBILE_PORT || cfg.port || 8390);
  return `http://${host}:${port}/`;
}

// herdr captures action stdout into its plugin logs, so never print the token
// here. The tokenized connect link is printed by the server itself: visible in
// the "Mobile bridge" pane (run entrypoint) and in <state dir>/bridge.log.
function printConnectInfo(): void {
  console.log(`url: ${baseUrl()}`);
  console.log(`token file: ${path.join(stateDir(), 'token')}`);
  console.log(`full connect link: see the Mobile bridge pane or ${path.join(stateDir(), 'bridge.log')}`);
}

function notify(title: string, body: string): void {
  const herdr = process.env.HERDR_BIN_PATH;
  if (!herdr) return;
  spawnSync(herdr, ['notification', 'show', title, '--body', body], { stdio: 'ignore' });
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
  const child = spawn(process.execPath, [mainJs], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  fs.closeSync(log);
  fs.writeFileSync(daemonPidFile(), String(child.pid), { mode: 0o600 });
  console.log(`bridge started (pid ${child.pid})`);
  printConnectInfo();
  console.log(`log: ${logPath}`);
  notify('herdr mobile started', baseUrl());
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
  fs.rmSync(daemon ? daemonPidFile() : runPidFile(), { force: true });
  console.log(`bridge stopped (pid ${pid})`);
  notify('herdr mobile stopped', `pid ${pid}`);
  return 0;
}

function status(): number {
  const daemon = alivePid(daemonPidFile());
  const fg = alivePid(runPidFile());
  if (daemon || fg) {
    console.log(`bridge running (pid ${daemon || fg}${fg ? ', foreground pane' : ''})`);
    printConnectInfo();
    notify('herdr mobile running', baseUrl());
  } else {
    console.log('bridge is not running');
    notify('herdr mobile stopped', 'invoke y011d4.mobile.start to launch');
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
    console.error('no token yet — start the bridge first (action y011d4.mobile.start)');
    return 1;
  }
  const cfg = readConfig();
  const port = Number(process.env.HERDR_MOBILE_PORT || cfg.port || 8390);

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
      hint = `hint: set "public_url" in config.json (herdr plugin config-dir y011d4.mobile), or run \`tailscale serve --bg ${port}\` for tailnet-only HTTPS`;
    }
  }

  const enc = spawnSync('qrencode', ['-t', 'UTF8', url], { encoding: 'utf8' });
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

const command = process.argv[2];
const handlers: Record<string, () => number | Promise<number>> = { run, start, stop, status, qr };
const handler = handlers[command];
if (!handler) {
  console.error('usage: mobilectl.js <run|start|stop|status|qr>');
  process.exit(2);
}
process.exit(await handler());
