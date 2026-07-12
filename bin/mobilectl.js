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

// The detached daemon (start/stop) and the foreground pane (run) own separate
// pidfiles so one lifecycle can't clobber the other's bookkeeping.
const daemonPidFile = () => path.join(stateDir(), 'bridge.pid');
const runPidFile = () => path.join(stateDir(), 'bridge-run.pid');

function alivePid(file) {
  let pid;
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

function baseUrl() {
  const cfg = readConfig();
  const host = process.env.HERDR_MOBILE_HOST || cfg.host || '127.0.0.1';
  const port = Number(process.env.HERDR_MOBILE_PORT || cfg.port || 8390);
  return `http://${host}:${port}/`;
}

// herdr captures action stdout into its plugin logs, so never print the token
// here. The tokenized connect link is printed by the server itself: visible in
// the "Mobile bridge" pane (run entrypoint) and in <state dir>/bridge.log.
function printConnectInfo() {
  console.log(`url: ${baseUrl()}`);
  console.log(`token file: ${path.join(stateDir(), 'token')}`);
  console.log(`full connect link: see the Mobile bridge pane or ${path.join(stateDir(), 'bridge.log')}`);
}

function notify(title, body) {
  const herdr = process.env.HERDR_BIN_PATH;
  if (!herdr) return;
  spawnSync(herdr, ['notification', 'show', title, '--body', body], { stdio: 'ignore' });
}

function start() {
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

function stop() {
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

function status() {
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

function run() {
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
  const forward = (sig) => child.kill(sig);
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
const handlers = { run, start, stop, status };
const handler = handlers[command];
if (!handler) {
  console.error('usage: mobilectl.js <run|start|stop|status>');
  process.exit(2);
}
process.exit(await handler());
