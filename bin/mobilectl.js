#!/usr/bin/env node
// Plugin entrypoint: run | start | stop | status
// Invoked by herdr plugin actions/panes with cwd = plugin root, or manually.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = path.join(projectRoot, 'server', 'main.js');

function stateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR
    || path.join(os.homedir(), '.local', 'state', 'herdr-mobile');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function configDir() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR || stateDir();
}

function readConfig() {
  const file = path.join(configDir(), 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function pidFile() {
  return path.join(stateDir(), 'bridge.pid');
}

function runningPid() {
  let pid;
  try {
    pid = Number(fs.readFileSync(pidFile(), 'utf8').trim());
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

function connectUrl() {
  const cfg = readConfig();
  const host = process.env.HERDR_MOBILE_HOST || cfg.host || '127.0.0.1';
  const port = Number(process.env.HERDR_MOBILE_PORT || cfg.port || 8390);
  let token = '';
  try {
    token = fs.readFileSync(path.join(stateDir(), 'token'), 'utf8').trim();
  } catch {
    // token is created on first bridge startup
  }
  const base = `http://${host}:${port}/`;
  return token ? `${base}?token=${token}` : base;
}

function notify(title, body) {
  const herdr = process.env.HERDR_BIN_PATH;
  if (!herdr) return;
  spawnSync(herdr, ['notification', 'show', title, '--body', body], { stdio: 'ignore' });
}

async function waitForToken(timeoutMs) {
  const file = path.join(stateDir(), 'token');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(file);
}

function start() {
  const existing = runningPid();
  if (existing) {
    console.log(`bridge already running (pid ${existing})`);
    console.log(`url: ${connectUrl()}`);
    return Promise.resolve(0);
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
  fs.writeFileSync(pidFile(), String(child.pid), { mode: 0o600 });
  return waitForToken(5000).then(() => {
    const url = connectUrl();
    console.log(`bridge started (pid ${child.pid})`);
    console.log(`url: ${url}`);
    console.log(`log: ${logPath}`);
    notify('herdr mobile started', url);
    return 0;
  });
}

function stop() {
  const pid = runningPid();
  if (!pid) {
    console.log('bridge is not running');
    fs.rmSync(pidFile(), { force: true });
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  fs.rmSync(pidFile(), { force: true });
  console.log(`bridge stopped (pid ${pid})`);
  notify('herdr mobile stopped', `pid ${pid}`);
  return 0;
}

function status() {
  const pid = runningPid();
  if (pid) {
    const url = connectUrl();
    console.log(`bridge running (pid ${pid})`);
    console.log(`url: ${url}`);
    notify('herdr mobile running', url);
  } else {
    console.log('bridge is not running');
    notify('herdr mobile stopped', 'invoke y011d4.mobile.start to launch');
  }
  return 0;
}

function run() {
  const existing = runningPid();
  if (existing) {
    console.error(`bridge already running detached (pid ${existing}); stop it first`);
    return 1;
  }
  const child = spawn(process.execPath, [mainJs], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: process.env,
  });
  fs.writeFileSync(pidFile(), String(child.pid), { mode: 0o600 });
  const forward = (sig) => child.kill(sig);
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      fs.rmSync(pidFile(), { force: true });
      resolve(code ?? 1);
    });
  });
}

const command = process.argv[2];
const handlers = { run, start, stop, status };
const handler = handlers[command];
if (!handler) {
  console.error('usage: mobilectl.js <run|start|stop|status>');
  process.exit(2);
}
process.exit(await handler());
