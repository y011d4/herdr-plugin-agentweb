#!/usr/bin/env node
/**
 * tools/webcheck.ts: the headless-Chrome checks of the web UI (the gate before every deploy).
 * Dependency-free; run as `node tools/webcheck.ts …` (Node >= 22.18 type stripping).
 *
 *   node tools/webcheck.ts preview start --bin bin/yoicks [--port 8395] [--web-dir DIR] [--fake-claude BIN]
 *   node tools/webcheck.ts preview stop [--port 8395]
 *   node tools/webcheck.ts check --base http://127.0.0.1:8395 [--tier 1|2|1,2] [--only P10,P12] [--profile DIR]
 *   node tools/webcheck.ts setup --gonogo --base URL   # go/no-go: wc-less + a blocked wc-claude, held until SIGINT/SIGTERM
 *   node tools/webcheck.ts block                       # go/no-go B5: report that wc-less as blocked
 *   node tools/webcheck.ts teardown                    # clean every unfinished run
 *   node tools/webcheck.ts herdr start|stop            # a private headless herdr for this WEBCHECK_ROOT
 *   node tools/webcheck.ts shots --after DIR [--before DIR] --out DIR [--only home,agents]   # the PR screenshots
 *
 * shots needs no herdr and no bridge: it serves tools/shots-fixture.ts's made-up data and a web build (DIR = a
 * web/dist), shoots each scene on a phone and a PC, before and after: its screen (<scene>-<phone|pc>.<side>.png,
 * unless `screen: false`) and each of its parts, cut out of the same page (<part>-<phone|pc>.<side>.png), and writes
 * for each changed one <name>.diff.png (where its pixels differ), and manifest.json (screen or part; which changed:
 * the PNGs' bytes differ; how many pixels) into --out. Each shot gets a browser context of its own
 * (the app keeps seen-done, the last Home, drafts in localStorage), a frozen clock (the fixture's T0 + 30s), UTC,
 * en-US, no animations (CSS transitions off: Mantine's JS-timed ones then show their end state two frames in), and
 * its images decoded, so the same build shoots the same bytes. CI (.github/workflows/screenshots.yml) posts the
 * changed ones on the PR and fails its `screens` check until the user approves them with the ui-change label.
 *
 * A preview is a throwaway bridge (state/config under $WC_ROOT/preview-<port>, `env -u HERDR_BIN_PATH`)
 * over the REAL herdr, which production also shows, unless the root has a private herdr: `herdr start` runs a
 * headless `herdr server` under $WC_ROOT/herdr (its own HOME, so none of the desktop herdr's config or plugins),
 * and while that dir exists every herdr call of this root and its previews go to that server, never to the
 * desktop's. With a WEBCHECK_ROOT of its own (and a port of its own), a run then shows nowhere and waits for no
 * other worker's. Tier 1 runs there; Tier 2's Claude needs the desktop's (its HOME, direnv). check/setup/teardown take $WC_ROOT/lock
 * (WC_ROOT = $WEBCHECK_ROOT or ~/.local/state/herdr-yoicks-webcheck) through a separate
 * `flock -n -o` holder process, so the lock lasts from setup to teardown and never reaches the
 * preview bridge or Chrome. Every mutation goes through guard(): only ids this run recorded in
 * $RUN/webcheck.json whose live tab or workspace label starts with wc-. Each check prints
 * `PASS|FAIL <id> <measured> <condition>`; the exit code is the number of failures.
 * Tier 2 (real Claude) needs $WC_ROOT/.envrc pinning CLAUDE_CONFIG_DIR (direnv allow'ed).
 * The headless orchestrators need --fake-claude (tools/fakeclaude built as `claude`): the preview then
 * has wc-h1 on it, for Tier 1's H items, and with an account pinned the real wc-h2 for H-T2 (the fake
 * execs the real claude for it: FAKECLAUDE_REAL; haiku, through its dir's settings.local.json). Both
 * with YOICKS_HEADLESS_NO_TOOLS=1. Without --fake-claude the H items fail (ENV) and the rest runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_ROOT = path.join(os.homedir(), '.local/state/herdr-yoicks-webcheck');
const WC_ROOT = process.env.WEBCHECK_ROOT || DEFAULT_ROOT;
const LOCK = path.join(WC_ROOT, 'lock');
const WORK = path.join(WC_ROOT, 'work');
// A private herdr (`herdr start`): while $WC_ROOT/herdr exists, everything this root runs (its herdr calls, the preview
// bridge) goes to that server's socket and never to the desktop's; a stopped one fails closed, never falls back.
const PRIV = path.join(WC_ROOT, 'herdr');
const PRIV_SOCK = path.join(PRIV, '.config', 'herdr', 'herdr.sock'); // where herdr puts it under its own HOME
/** The env for a herdr CLI call to the private server: none of the desktop herdr's pane variables. */
const privCliEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR_'))), HERDR_SOCKET_PATH: PRIV_SOCK });
const PRIV_AT_START = fs.existsSync(PRIV);
if (PRIV_AT_START) {
  for (const k of Object.keys(process.env)) if (k.startsWith('HERDR_')) delete process.env[k];
  process.env.HERDR_SOCKET_PATH = PRIV_SOCK;
}
const PROD_PORT = '8390';
const ASK_PROMPT = 'Use the AskUserQuestion tool exactly once to ask "Pick a fruit" with exactly three options: apple, banana, cherry. Do nothing else.';
const OK_PROMPT = 'Reply with exactly the word OK and nothing else.';
const NOTE_PROMPT = 'Read the file wc-note.txt in the current directory with the Read tool, then reply with its first line only.';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const js = JSON.stringify;
class EnvError extends Error {}
const env = (msg: string) => new EnvError(msg);

async function waitFn<T>(fn: () => T | Promise<T>, ms: number, step = 100): Promise<{ v: T; ms: number; timeout: boolean }> {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => undefined as T);
    if (v) return { v, ms: Date.now() - t0, timeout: false };
    if (Date.now() - t0 >= ms) return { v, ms: Date.now() - t0, timeout: true };
    await sleep(step);
  }
}

// ── herdr, the guard, the run record ──────────────────────────────────────────

function herdr(args: string[]): any {
  const r = spawnSync('herdr', args, { encoding: 'utf8' });
  let j: any = null;
  try { j = JSON.parse(r.stdout || r.stderr); } catch { /* plain text output */ }
  if (r.status !== 0 || j?.error) {
    const e = new Error(`herdr ${args.slice(0, 2).join(' ')}: ${j?.error?.message ?? (r.stderr || r.stdout).trim()}`) as Error & { code?: string };
    e.code = j?.error?.code;
    throw e;
  }
  return j?.result ?? r.stdout;
}

/** gonogo: the `setup --gonogo` process holding this run (pid + start time), the only record `block` may act on */
interface Rec { dir: string; base: string; gonogo?: { pid: number; start: string }; chrome?: { pid: number; dir: string };
  workspaces: string[]; tabs: string[]; panes: string[]; reported: string[]; names: Record<string, string> }

const save = (rec: Rec) => fs.writeFileSync(path.join(rec.dir, 'webcheck.json'), js(rec, null, 1));

function labelOf(kind: 'tab' | 'workspace', id: string): string | null {
  const l = herdr([kind, 'get', id])[kind]?.label;
  return typeof l === 'string' ? l : null; // a numeric label never matches
}

/** The one gate for every mutation: recorded by this run, and live-labelled wc- (ids are reused after a herdr restart). */
function guard(rec: Rec, id: string): void {
  if (![...rec.workspaces, ...rec.tabs, ...rec.panes].includes(id)) throw new Error(`REFUSED ${id}: not recorded by this run`);
  let tab: string | null = null;
  let ws = id;
  if (rec.panes.includes(id)) ({ tab_id: tab, workspace_id: ws } = herdr(['pane', 'get', id]).pane);
  else if (rec.tabs.includes(id)) { tab = id; ws = herdr(['tab', 'get', id]).tab.workspace_id; }
  const labels = [tab && labelOf('tab', tab), labelOf('workspace', ws)];
  if (!labels.some((l) => l?.startsWith('wc-'))) throw new Error(`REFUSED ${id}: live labels ${js(labels)} lack wc-`);
}

function mutate(rec: Rec, id: string, args: string[]): any {
  guard(rec, id);
  return herdr(args);
}

function record(rec: Rec, o: { workspace?: string; tab?: string; pane?: string }, name?: string): void {
  if (o.workspace && !rec.workspaces.includes(o.workspace)) rec.workspaces.push(o.workspace);
  if (o.tab && !rec.tabs.includes(o.tab)) rec.tabs.push(o.tab);
  if (o.pane && !rec.panes.includes(o.pane)) rec.panes.push(o.pane);
  if (name && o.pane) rec.names[name] = o.pane;
  save(rec);
}

/** Close what a run recorded (report-agent released first); idempotent, also for an earlier unfinished run.
 *  The record goes only once everything is closed or gone: what failed stays recorded for the next run. */
function teardown(dir: string): void {
  let rec: Rec | null = null;
  try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'webcheck.json'), 'utf8')); } catch { /* nothing recorded */ }
  killChrome(rec);
  // a just-killed Chrome's helpers may still write to its profile: retry, and never stop the closing for it
  const rm = (p: string) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.log(`WARN ${(e as Error).message}`); } };
  // the headless orchestrators it started stop (best-effort: stopping the preview ends them too)
  for (const n of Object.keys(rec?.names ?? {}).filter((k) => /^wc-h[12]$/.test(k))) stopHeadless(rec!.base, n);
  if (rec) {
    const r = rec;
    const step = (id: string, args: string[]): boolean => {
      try { mutate(r, id, args); return false; } catch (e) {
        if (/_not_found$/.test((e as { code?: string }).code ?? '')) return false;
        console.log(`WARN teardown ${id}: ${(e as Error).message}`);
        return true;
      }
    };
    const left = {
      // herdr 0.9.5's release-agent parses the pane id only before the options
      reported: r.reported.filter((p) => step(p, ['pane', 'release-agent', p, '--source', 'webcheck', '--agent', 'claude'])),
      tabs: r.tabs.filter((t) => step(t, ['tab', 'close', t])),
      workspaces: r.workspaces.filter((w) => step(w, ['workspace', 'close', w])),
    };
    if (left.reported.length + left.tabs.length + left.workspaces.length) {
      save({ ...r, ...left, chrome: undefined, gonogo: undefined }); // a kept record is never an active go/no-go
      console.log(`WARN kept ${path.join(dir, 'webcheck.json')}: ${js(left)} not closed`);
      rm(path.join(dir, 'chrome'));
      return;
    }
  }
  rm(dir);
}

/** The Chrome a run recorded, while its cmdline still names the run's profile (a reused pid is left alone). */
function killChrome(rec: Rec | null): void {
  const c = rec?.chrome;
  try { if (c && fs.readFileSync(`/proc/${c.pid}/cmdline`, 'utf8').includes(c.dir)) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ }
}

/** POST …/stop for a headless orchestrator of the preview at `base`; synchronous, for teardown (a signal
 *  too). The token goes on curl's stdin, never in its argv, which any local user can read. */
function stopHeadless(base: string, name: string): void {
  let token = '';
  try { token = fs.readFileSync(path.join(previewDir(new URL(base).port), 'state', 'token'), 'utf8').trim(); } catch { return; }
  spawnSync('curl', ['-sf', '-m', '8', '-X', 'POST', '-H', '@-', `${base}/api/orchestrators/${name}/stop`],
    { input: `Authorization: Bearer ${token}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
}

function teardownAll(): void {
  const runs = path.join(WC_ROOT, 'run');
  for (const d of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
    try { teardown(path.join(runs, d)); } catch (e) { console.log(`WARN teardown ${d}: ${(e as Error).message}`); }
  }
  try {
    const wsLabel = new Map<string, string>(herdr(['workspace', 'list']).workspaces.map((w: any) => [w.workspace_id, w.label]));
    for (const t of herdr(['tab', 'list']).tabs) {
      const l = [t.label, wsLabel.get(t.workspace_id)];
      if (l.some((x) => typeof x === 'string' && x.startsWith('wc-'))) console.log(`WARN unrecorded wc- tab left open: ${t.tab_id} ${js(l)}`);
    }
  } catch (e) { console.log(`WARN listing tabs: ${(e as Error).message}`); }
}

// ── lock: a detached `flock -n -o` holder lives as long as our pipe to it ────────

async function lock(): Promise<() => void> {
  fs.mkdirSync(WC_ROOT, { recursive: true });
  const p = spawn('flock', ['-n', '-E', '75', '-o', LOCK, 'sh', '-c', 'echo locked; exec cat >/dev/null'],
    { stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  const got = await new Promise<boolean>((res, rej) => {
    p.stdout!.once('data', () => res(true));
    p.once('exit', () => res(false));
    p.once('error', (e) => rej(env(`flock: ${e.message}`)));
  });
  if (!got) throw env('another webcheck run');
  if (spawnSync('flock', ['-n', LOCK, 'true']).status === 0) throw env('run without lock');
  // this process chose its herdr (its env) at its start; a herdr start|stop since then would leave it on the other
  if (fs.existsSync(PRIV) !== PRIV_AT_START) { p.stdin!.end(); throw env('the root switched herdr since this command started: run it again'); }
  return () => p.stdin!.end();
}

// ── preview bridge ───────────────────────────────────────────────────────────

/** herdr: the private herdr's socket it was started on (absent: the desktop's); a run refuses a preview on the other one */
interface Preview { bin: string; port: string; webDir?: string; fakeClaude?: string; herdr?: string }
const previewDir = (port: string) => path.join(WC_ROOT, `preview-${port}`);

function previewEnv(p: Preview): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.HERDR_BIN_PATH;
  delete e.YOICKS_WEB_DIR;
  delete e.YOICKS_CLAUDE_BIN;
  // a headless orchestrator gets no yoicks tools, only its questions (as wc-o1/wc-o2 get no tasks)
  e.YOICKS_HEADLESS_NO_TOOLS = '1';
  if (p.fakeClaude) e.YOICKS_CLAUDE_BIN = p.fakeClaude;
  Object.assign(e, { HERDR_PLUGIN_STATE_DIR: path.join(previewDir(p.port), 'state'), HERDR_PLUGIN_CONFIG_DIR: path.join(previewDir(p.port), 'config'),
    XDG_DATA_HOME: path.join(WC_ROOT, 'data'), HERDR_YOICKS_PORT: p.port, HERDR_YOICKS_HOST: '127.0.0.1' });
  if (p.webDir) e.YOICKS_WEB_DIR = p.webDir;
  return e;
}

function readPreview(port: string): Preview | null {
  try { return JSON.parse(fs.readFileSync(path.join(previewDir(port), 'preview.json'), 'utf8')); } catch { return null; }
}

async function previewCtl(p: Preview, action: 'start' | 'stop'): Promise<void> {
  await new Promise<void>((res, rej) => {
    const c = spawn(p.bin, [action], { env: previewEnv(p), stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout!.resume();
    c.once('error', rej);
    c.once('exit', (code) => (code === 0 ? res() : rej(new Error(`${p.bin} ${action} exited ${code}`))));
  });
  if (action === 'start') {
    const h = await waitFn(() => fetch(`http://127.0.0.1:${p.port}/healthz`).then((r) => r.json()).then((j) => j.ok && j.herdrConnected), 30_000, 200);
    if (h.timeout) throw env(`preview on ${p.port} not healthy`);
  }
}

/** The account $WC_ROOT/.envrc pins: CLAUDE_CONFIG_DIR as direnv resolves it in wc-claude's dir. */
/** '' when it leaves CLAUDE_CONFIG_DIR unset: the default account (set even to ~/.claude, Claude Code reads a
 *  stale ~/.claude/.claude.json instead of ~/.claude.json, so "default" means unset). */
function pinnedAccount(): string {
  const envrc = path.join(WC_ROOT, '.envrc');
  if (!fs.existsSync(envrc)) throw env(`no account pinned (${envrc} missing)`);
  const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CLAUDE_CONFIG_DIR' && !k.startsWith('DIRENV_')));
  fs.mkdirSync(path.join(WORK, 'wc-claude'), { recursive: true });
  const out = spawnSync('direnv', ['exec', path.join(WORK, 'wc-claude'), 'sh', '-c', 'printf "ok:%s" "${CLAUDE_CONFIG_DIR-}"'],
    { encoding: 'utf8', env: e }).stdout ?? '';
  if (!out.startsWith('ok:')) throw env(`${envrc} not allowed (direnv allow it)`);
  const v = out.slice(3);
  if (v && !path.isAbsolute(v)) throw env('CLAUDE_CONFIG_DIR must be absolute');
  return v && path.normalize(v);
}

const accountName = (account: string) => account || 'the default account (CLAUDE_CONFIG_DIR unset)';

/** Every Claude webcheck starts runs in the pinned account: the same CLAUDE_CONFIG_DIR, or none for the default. */
function checkAccount(pane: string, name: string, account: string): void {
  const got = paneConfigDir(pane);
  if (got !== account) throw env(`${name} account mismatch (want ${accountName(account)}, got ${got === null ? 'no agent process' : got || 'unset'})`);
}

/** The real claude on PATH, which the fake execs for wc-h2. */
const realClaude = (): string => spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();

// wc-h1 runs the fake claude, unverified version and all (H6); wc-h2 the real one, in the pinned account
const orchConfig = (account: string | null, fake: string | null) => js({ orchestrators: [
  ...['wc-o1', 'wc-o2'].map((name) => ({ name, label: name.toUpperCase(), ...(account ? { env: { CLAUDE_CONFIG_DIR: account } } : {}) })),
  ...(fake ? [{ name: 'wc-h1', label: 'WC-H1', mode: 'headless', env: { CLAUDE_CONFIG_DIR: path.join(WC_ROOT, 'fake-claude'), FAKECLAUDE_VERSION: '0.0.0-webcheck' } }] : []),
  ...(fake && account !== null ? [{ name: 'wc-h2', label: 'WC-H2', mode: 'headless', env: { ...(account ? { CLAUDE_CONFIG_DIR: account } : {}), FAKECLAUDE_REAL: realClaude() } }] : []),
] });

async function previewCmd(sub: string, o: Record<string, any>): Promise<number> {
  const port = String(o.port ?? '8395');
  if (port === PROD_PORT) throw env(`refusing port ${PROD_PORT} (production)`);
  if (sub !== 'stop' && (sub !== 'start' || !o.bin)) throw new Error('usage: preview start --bin PATH [--port N] [--web-dir DIR] [--fake-claude BIN] | preview stop [--port N]');
  const unlock = await lock(); // never under a run; the holder process keeps the lock from the bridge
  try {
    const old = readPreview(port);
    // the record goes only once nothing answers on its port, whatever the stop said (a stop that timed out has
    // already dropped the bridge's pid file: a second one "succeeds"): a bridge still up stays on the herdr it began on
    if (old) {
      const said = await previewCtl(old, 'stop').then(() => '', (e) => (e as Error).message);
      // quiet = refused; a request left hanging (a stopped process still holding the port) is not quiet
      const quiet = () => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })
        .then(() => false, (e) => (e as Error).name !== 'TimeoutError');
      if ((await waitFn(quiet, 5000, 200)).timeout) {
        throw env(`preview ${port} still answers after its stop${said ? ` (${said})` : ''}: stop its bridge by hand`);
      }
      if (said) console.log(`WARN ${said} (nothing answers on ${port}: stopped)`);
    }
    if (sub === 'stop') {
      fs.rmSync(path.join(previewDir(port), 'preview.json'), { force: true }); // no record: not running (herdr start/stop look)
      console.log(`preview ${port} stopped`);
      return 0;
    }
    const p: Preview = { bin: path.resolve(o.bin), port, webDir: o['web-dir'] && path.resolve(o['web-dir']), fakeClaude: o['fake-claude'] && path.resolve(o['fake-claude']),
      herdr: fs.existsSync(PRIV) ? PRIV_SOCK : undefined };
    if (p.fakeClaude && path.basename(p.fakeClaude) !== 'claude') throw env('--fake-claude must be named claude (go build -o DIR/claude ./tools/fakeclaude)');
    if (p.fakeClaude) fs.mkdirSync(path.join(WC_ROOT, 'fake-claude'), { recursive: true });
    // the orchestrators start with Tier 2's account (the bridge checks the started agent against it)
    const account = fs.existsSync(path.join(WC_ROOT, '.envrc')) ? pinnedAccount() : null;
    fs.rmSync(previewDir(port), { recursive: true, force: true });
    for (const d of ['state', 'config']) fs.mkdirSync(path.join(previewDir(port), d), { recursive: true });
    fs.writeFileSync(path.join(previewDir(port), 'config', 'config.json'), orchConfig(account, p.fakeClaude ?? null));
    fs.writeFileSync(path.join(previewDir(port), 'preview.json'), js(p));
    await previewCtl(p, 'start');
    console.log(`preview ${port} up: http://127.0.0.1:${port} (token ${path.join(previewDir(port), 'state', 'token')}, account ${account === null ? 'none: Tier 1 only' : accountName(account)}, ` +
      `headless ${!p.fakeClaude ? 'none (no --fake-claude: the H items fail)' : account !== null ? 'wc-h1 (fake) and wc-h2 (real)' : 'wc-h1 (fake)'})`);
    return 0;
  } finally {
    unlock();
  }
}

/** herdr start|stop: the private herdr (see PRIV). Headless (`herdr server`) under its own HOME and XDG dirs, so it
 *  never reads the desktop herdr's config (its plugins.json would start a second yoicks) nor shares its socket;
 *  no HERDR_* of the desktop's panes, no D-Bus (no desktop notifications), panes in /bin/sh. */
async function herdrCmd(sub: string): Promise<number> {
  if (sub !== 'start' && sub !== 'stop') throw new Error('usage: herdr start|stop');
  if (PRIV_SOCK.length > 100) throw env(`${PRIV_SOCK} is too long for a unix socket: set a shorter WEBCHECK_ROOT`);
  // what herdr says, never a guess: a failed status call must not read as stopped (stop would drop a live server's dir)
  const running = (): boolean => {
    const r = spawnSync('herdr', ['status', 'server'], { encoding: 'utf8', env: privCliEnv() });
    const st = /^status: (running|not running)$/m.exec(r.stdout ?? '')?.[1];
    if (!st) throw env(`herdr status server: ${r.error?.message ?? ((r.stderr || r.stdout || '').trim() || `exit ${r.status}`)}`);
    return st === 'running';
  };
  // the default root is the desktop herdr's, shared by every worker: a private herdr there would switch their runs too
  // through symlinks, the nearest existing ancestor's too (the default root may not exist yet)
  const real = (d: string): string => {
    const abs = path.resolve(d);
    try { return fs.realpathSync(abs); } catch { return path.dirname(abs) === abs ? abs : path.join(real(path.dirname(abs)), path.basename(abs)); }
  };
  if (!process.env.WEBCHECK_ROOT || real(WC_ROOT) === real(DEFAULT_ROOT)) throw env('a private herdr needs a WEBCHECK_ROOT of its own (export WEBCHECK_ROOT=$(mktemp -d /tmp/wc-XXXX))');
  const unlock = await lock();
  try {
    // a preview, and an unfinished run's record, stay on the herdr they began on: switching under them would guard ids
    // in one herdr and act on the other's
    const previews = fs.readdirSync(WC_ROOT).filter((d) => /^preview-\d+$/.test(d) && fs.existsSync(path.join(WC_ROOT, d, 'preview.json')));
    if (previews.length) throw env(`stop this root's previews first (${previews.map((d) => `preview stop --port ${d.slice(8)}`).join(', ')})`);
    const live = fs.existsSync(PRIV) && running();
    const runs = path.join(WC_ROOT, 'run');
    const unfinished = () => fs.existsSync(runs) && fs.readdirSync(runs).length > 0;
    if (fs.existsSync(PRIV) && !live) { // a gone private herdr took its panes: only the runs' Chrome is left to end
      for (const d of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
        try { killChrome(JSON.parse(fs.readFileSync(path.join(runs, d, 'webcheck.json'), 'utf8'))); } catch { /* no record */ }
      }
      fs.rmSync(runs, { recursive: true, force: true });
    }
    if (unfinished()) teardownAll();
    if (unfinished()) throw env(`unfinished runs left in ${runs}: teardown first`);
    if (sub === 'stop') {
      if (live) spawnSync('herdr', ['server', 'stop'], { env: privCliEnv(), stdio: 'ignore' });
      if ((await waitFn(() => !running(), 10_000, 200)).timeout) throw env(`the private herdr (${PRIV_SOCK}) did not stop`);
      fs.rmSync(PRIV, { recursive: true, force: true });
      console.log('private herdr stopped');
      return 0;
    }
    if (live) { console.log(`private herdr already running: ${PRIV_SOCK}`); return 0; }
    fs.mkdirSync(PRIV, { recursive: true });
    const e: NodeJS.ProcessEnv = { ...privCliEnv(), HOME: PRIV, XDG_CONFIG_HOME: path.join(PRIV, '.config'), XDG_STATE_HOME: path.join(PRIV, '.local/state'),
      XDG_DATA_HOME: path.join(PRIV, '.local/share'), XDG_CACHE_HOME: path.join(PRIV, '.cache'), SHELL: '/bin/sh' };
    delete e.HERDR_SOCKET_PATH; // the server's own place, under its HOME (= PRIV_SOCK)
    delete e.DBUS_SESSION_BUS_ADDRESS;
    const log = fs.openSync(path.join(PRIV, 'server.log'), 'a');
    spawn('herdr', ['server'], { env: e, detached: true, stdio: ['ignore', log, log] }).unref();
    fs.closeSync(log);
    if ((await waitFn(running, 15_000, 200)).timeout) throw env(`the private herdr did not start (${path.join(PRIV, 'server.log')})`);
    console.log(`private herdr up: ${PRIV_SOCK}`);
    return 0;
  } finally {
    unlock();
  }
}

// ── CDP over Node's WebSocket ────────────────────────────────────────────────

type Cdp = { send: (method: string, params?: object, sessionId?: string) => Promise<any>; on: (fn: (m: any) => void) => void; close: () => void };

async function connectCdp(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let n = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; method: string }>();
  const fns: Array<(m: any) => void> = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const p = m.id ? pending.get(m.id) : undefined;
    if (p) { pending.delete(m.id); if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`)); else p.res(m.result); }
    else for (const f of fns) f(m);
  };
  return {
    send: (method, params = {}, sessionId) => new Promise((res, rej) => {
      pending.set(++n, { res, rej, method });
      ws.send(js({ id: n, method, params, sessionId }));
    }),
    on: (f) => fns.push(f),
    close: () => ws.close(),
  };
}

interface Req { t: number; method: string; url: string; body: any }
interface Frame { t: number; payload: string; msg?: any }

class Page {
  cdp!: Cdp; sid = ''; targetId = ''; proc!: ReturnType<typeof spawn>;
  reqs: Req[] = []; resps: Array<{ t: number; id: string; url: string; status: number; type: string; sw: boolean }> = [];
  wsSent: Frame[] = []; wsRecv: Frame[] = []; wsCreated: number[] = []; swFails = 0; refused: string[] = [];
  /** GETs whose URL contains `hold` are held unsent in `held` until release(): a bridge that answers late */
  hold: string | null = null; held: any[] = [];
  /** state frames aren't kept: stateMarkT is when the first one containing stateMark arrived (0: none yet) */
  stateMark = ''; stateMarkT = 0;
  c: Ctx;
  constructor(c: Ctx) { this.c = c; }

  S = (method: string, params: object = {}) => this.cdp.send(method, params, this.sid);

  async ev(expr: string): Promise<any> {
    const r = await this.S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  until = (expr: string, ms: number, step = 50) => waitFn(() => this.ev(expr), ms, step);
  hash = () => this.ev('location.hash');
  async goto(hash: string) { await this.ev(`location.hash = ${js(hash)}`); await sleep(300); }
  async load(url: string) {
    const loaded = new Promise<void>((res) => this.onceLoad = res);
    await this.S('Page.navigate', { url });
    await Promise.race([loaded, sleep(10_000)]);
  }
  onceLoad: () => void = () => {};
  touch = (type: string, pts: Array<[number, number]>) =>
    this.S('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
  async drag(x: number, y: number, dy: number, steps: number, stepMs: number, holdMs = 0): Promise<number> {
    await this.touch('touchStart', [[x, y]]);
    for (let i = 1; i <= steps; i++) { await sleep(stepMs); await this.touch('touchMove', [[x, y + (dy * i) / steps]]); }
    if (holdMs) await sleep(holdMs);
    await this.touch('touchEnd', []);
    return Date.now();
  }
  async tap(x: number, y: number, moveY = 0) {
    await this.touch('touchStart', [[x, y]]);
    if (moveY) await this.touch('touchMove', [[x, y + moveY]]);
    await sleep(30);
    await this.touch('touchEnd', []);
  }
  async pinch(x: number, y: number, from: number, to: number) {
    await this.touch('touchStart', [[x, y - from], [x, y + from]]);
    for (let i = 1; i <= 10; i++) { const d = from + ((to - from) * i) / 10; await sleep(16); await this.touch('touchMove', [[x, y - d], [x, y + d]]); }
    await this.touch('touchEnd', []);
    await sleep(200);
  }
  /** Center of the element `el` (a JS expression) after scrolling it into view, once it has stopped moving (5
   *  frames alike): an opening sheet or drawer slides it in (Mantine's transitions, far longer under CPU load),
   *  and a point taken on the way lands on whatever is there by the time of the tap (P16.toggle, under load). */
  async at(el: string): Promise<{ x: number; y: number }> {
    const r = await this.ev(`(async () => { const e = ${el}; if (!e) return null; e.scrollIntoView({ block: 'center' });
      const tick = () => new Promise((f) => (document.hidden ? setTimeout(f, 50) : requestAnimationFrame(() => f())));
      let last = '', still = 0;
      for (let i = 0; i < 300 && still < 5; i++) {
        await tick();
        const b = e.getBoundingClientRect(), k = [b.x, b.y, b.width, b.height].map(Math.round).join();
        still = k === last ? still + 1 : 0;
        last = k;
      }
      const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!r) throw new Error(`no element: ${el}`);
    return r;
  }
  async tapEl(el: string) { const p = await this.at(el); await this.tap(p.x, p.y); return Date.now(); }
  /** Waits (10s at most) until a touch at p lands on `el`: a toast over it goes after 4s. */
  uncovered = (el: string, p: { x: number; y: number }) =>
    this.until(`(() => { const e = ${el}; return !!e && e.contains(document.elementFromPoint(${p.x}, ${p.y})); })()`, 10_000);
  /** Stops holding, and sends the held requests on; returns them (Fetch.requestPaused params). */
  async release(): Promise<any[]> {
    this.hold = null;
    const ps = this.held.splice(0);
    for (const p of ps) await this.S('Fetch.continueRequest', { requestId: p.requestId });
    return ps;
  }
  posts = (t: number, suffix: string) => this.reqs.filter((q) => q.t >= t && q.method === 'POST' && q.url.endsWith(suffix));
  /** The page's own API mutations go through the same guard: a UI bug must not reach a real agent. */
  async guardRequest(p: any) {
    if (this.hold && p.request.method === 'GET' && p.request.url.includes(this.hold)) { this.held.push(p); return; }
    const u = new URL(p.request.url);
    try {
      const id = u.pathname.match(/^\/api\/(?:panes|agents)\/([^/]+)/)?.[1];
      if (p.request.method !== 'GET' && !/^\/api\/orchestrators\/(?:wc-o[12]\/start|wc-h[12]\/(?:start|send|answer|interrupt|clear|stop))$/.test(u.pathname)) {
        if (!id) throw new Error(`REFUSED ${p.request.method} ${u.pathname}`);
        guard(this.c.rec, decodeURIComponent(id));
      }
      await this.S('Fetch.continueRequest', { requestId: p.requestId });
    } catch (e) {
      this.refused.push((e as Error).message);
      console.log((e as Error).message);
      await this.S('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  }
}

// A runner's first Chrome start reads much of its ~450 MB install from a disk that is still cold: 0.6–17 s over 16
// fresh GitHub runners, against 0.1 s for each one's second start (so CI starts one early, in a step of its own). The
// timeout only bounds a Chrome that hangs: one that exits fails at once, with its stderr.
const CHROME_START_MS = 60_000;

/** Headless Chrome on `dir` as its user-data-dir; `url` resolves to the browser's CDP WebSocket once it listens. */
function startChrome(dir: string, args: string[]): { proc: ReturnType<typeof spawn>; url: Promise<string> } {
  fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true });
  const t0 = Date.now();
  const proc = spawn('google-chrome-stable', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    ...args, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let tail = '';
  proc.stderr!.on('data', (b) => { tail = (tail + b).slice(-2000); });
  // a spawn failure or an early exit rejects into the caller's teardown instead of waiting out the timeout
  const gone = new Promise<never>((_, rej) => {
    proc.on('error', (e) => rej(env(`chrome: ${e.message}`)));
    // stderr read to its end, or 0.5 s on: chrome_crashpad_handler holds it and can outlive Chrome
    proc.on('exit', (code, sig) => {
      const fail = () => rej(env(`chrome exited (${sig ?? code}) before it listened:\n${tail}`));
      proc.stderr!.once('close', fail);
      setTimeout(fail, 500);
    });
  });
  gone.catch(() => {});
  const url = (async () => {
    const port = await Promise.race([waitFn(() => fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0], CHROME_START_MS), gone]);
    if (port.timeout) throw env(`chrome did not start in ${CHROME_START_MS / 1000} s:\n${tail}`);
    console.log(`chrome started in ${Date.now() - t0} ms`);
    return (await (await fetch(`http://127.0.0.1:${port.v}/json/version`)).json()).webSocketDebuggerUrl as string;
  })();
  return { proc, url };
}

async function openPage(c: Ctx, profile?: string): Promise<Page> {
  const pg = new Page(c);
  const dir = profile ? path.resolve(profile) : path.join(c.rec.dir, 'chrome');
  fs.mkdirSync(dir, { recursive: true });
  // headless Linux swallows touchmoves within ~30px of the touchstart; 3 makes it ~8px, a phone's 8dp. Without touch
  // emulation headless has no pointer: the blink settings make it a PC's mouse (hover, fine), from the next document on
  const chrome = startChrome(dir, ['--touch-slop-distance=3',
    '--blink-settings=primaryPointerType=4,primaryHoverType=2,availablePointerTypes=4,availableHoverTypes=2']);
  pg.proc = chrome.proc;
  if (pg.proc.pid) { c.rec.chrome = { pid: pg.proc.pid, dir }; save(c.rec); }
  pg.cdp = await connectCdp(await chrome.url);
  ({ targetId: pg.targetId } = await pg.cdp.send('Target.createTarget', { url: 'about:blank' }));
  ({ sessionId: pg.sid } = await pg.cdp.send('Target.attachToTarget', { targetId: pg.targetId, flatten: true }));
  pg.cdp.on((m) => {
    const p = m.params;
    if (m.method === 'Network.loadingFailed' && m.sessionId !== pg.sid) pg.swFails++;
    if (m.sessionId !== pg.sid) return;
    const t = Date.now();
    if (m.method === 'Page.loadEventFired') pg.onceLoad();
    else if (m.method === 'Network.requestWillBeSent') {
      let body: any = p.request.postData;
      try { body = JSON.parse(body); } catch { /* not JSON */ }
      pg.reqs.push({ t, method: p.request.method, url: p.request.url, body });
    } else if (m.method === 'Network.responseReceived') {
      pg.resps.push({ t, id: p.requestId, url: p.response.url, status: p.response.status, type: p.type, sw: !!p.response.fromServiceWorker });
    } else if (m.method === 'Network.webSocketCreated') pg.wsCreated.push(t);
    else if (m.method === 'Network.webSocketFrameSent') pg.wsSent.push({ t, payload: p.response.payloadData });
    else if (m.method === 'Network.webSocketFrameReceived') {
      const payload: string = p.response.payloadData;
      if (/^\{"type":"state"/.test(payload)) { // big and frequent: only the marked one's time is kept
        if (pg.stateMark && !pg.stateMarkT && payload.includes(pg.stateMark)) pg.stateMarkT = t;
        return;
      }
      let msg: any;
      try { msg = JSON.parse(payload); } catch { return; }
      if (msg.type === 'pane_output' && !c.rec.panes.includes(msg.paneId)) return;
      pg.wsRecv.push({ t, payload, msg });
    } else if (m.method === 'Fetch.requestPaused') void pg.guardRequest(p);
  });
  await pg.S('Page.enable');
  await pg.S('Network.enable');
  await pg.S('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
  await mobile(pg, true);
  await pg.cdp.send('Browser.grantPermissions', { origin: c.base, permissions: ['notifications'] });
  return pg;
}

/** A 390x844 phone with touch, or a PC (mouse, 1x). */
async function mobile(pg: Page, on: boolean): Promise<void> {
  await pg.S('Emulation.setDeviceMetricsOverride', on ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true } : { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
  await pg.S('Emulation.setTouchEmulationEnabled', on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await sleep(300);
}


// ── context, setup ───────────────────────────────────────────────────────────

interface Ctx { base: string; port: string; token: string; rec: Rec; pg: Page; preview: Preview | null;
  build: { vite: boolean; hash: string | null; swName: string; assets: string[] }; failures: number; out: string[] }

async function api(c: Ctx, method: string, p: string, body?: object): Promise<any> {
  const r = await fetch(c.base + p, { method, headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: body && js(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${js(j)}`);
  return j;
}
const allPanes = (st: any): any[] => st.workspaces.flatMap((w: any) => w.tabs.flatMap((t: any) => t.panes));
const paneOf = async (c: Ctx, id: string) => allPanes(await api(c, 'GET', '/api/state')).find((p) => p.paneId === id);
const screen = (id: string): string => String(herdr(['pane', 'read', id, '--source', 'visible', '--format', 'text']));

function result(c: Ctx, ok: boolean, id: string, measured: string, cond: string): void {
  const line = `${ok ? 'PASS' : 'FAIL'} ${id} ${measured.replace(/\s+/g, '_') || '-'} ${cond}`;
  c.out.push(line);
  if (!ok) c.failures++;
}

async function newTab(c: Ctx, ws: string, label: string): Promise<string> {
  const r = herdr(['tab', 'create', '--workspace', ws, '--cwd', WORK, '--label', label, '--no-focus']);
  record(c.rec, { tab: r.tab.tab_id, pane: r.root_pane.pane_id }, label.slice(3));
  return r.root_pane.pane_id;
}

/** A just-started claude: accept the folder-trust prompt if it shows, then wait until it is idle. The prompt's
 *  default is "No, exit" (Enter alone would quit), so Enter goes only once the cursor is on "Yes, I trust…". */
async function agentReady(c: Ctx, pane: string, ms: number): Promise<void> {
  const r = await waitFn(async () => {
    const st = (await paneOf(c, pane))?.agent?.status;
    if (st === 'idle' || st === 'done') return true;
    const s = screen(pane);
    if (!/Yes, I trust this folder/.test(s)) return false;
    mutate(c.rec, pane, ['pane', 'send-keys', pane, /❯\s*(?:\d+\.\s*)?Yes, I trust/.test(s) ? 'enter' : 'down']);
    return false;
  }, ms, 1000);
  if (r.timeout) throw env('no trust prompt or agent not started');
}

/** The CLAUDE_CONFIG_DIR of a pane's agent (its foreground process group leader), '' when unset, null without one. */
function paneConfigDir(pane: string): string | null {
  const pi = herdr(['pane', 'process-info', '--pane', pane]).process_info;
  const pid = pi?.foreground_process_group_id;
  if (!pid || pid === pi.shell_pid) return null;
  const v = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((kv) => kv.startsWith('CLAUDE_CONFIG_DIR='));
  return v ? path.normalize(v.slice('CLAUDE_CONFIG_DIR='.length)) : '';
}

async function setup(c: Ctx, needs: Set<string>): Promise<void> {
  let account = '';
  const fake = c.preview?.fakeClaude ?? null;
  if (needs.has('claude') || needs.has('orch') || needs.has('hl2')) {
    account = pinnedAccount();
    // preview start gives the orchestrators that account as env; a preview from before the .envrc has none
    let cfg = '';
    try { cfg = fs.readFileSync(path.join(previewDir(c.port), 'config', 'config.json'), 'utf8'); } catch { /* not ours */ }
    if (cfg !== orchConfig(account, fake)) throw env(`the preview's orchestrators are not pinned to ${accountName(account)} (restart it with preview start)`);
  }
  if (!needs.size) return;
  fs.mkdirSync(WORK, { recursive: true });
  const w = herdr(['workspace', 'create', '--cwd', WORK, '--label', 'wc-webcheck', '--no-focus']);
  const ws = w.workspace.workspace_id;
  record(c.rec, { workspace: ws, tab: w.tab.tab_id, pane: w.root_pane.pane_id });
  const shell = needs.has('shell') ? await newTab(c, ws, 'wc-shell') : '';
  const less = needs.has('less') ? await newTab(c, ws, 'wc-less') : '';
  const stop = needs.has('stop') ? await newTab(c, ws, 'wc-stop') : ''; // a shell for P15 to stop
  const probe = needs.has('probe') ? await newTab(c, ws, 'wc-probe') : ''; // a second agent, for P18 to move above wc-less
  for (const id of [...c.rec.workspaces, ...c.rec.tabs, ...c.rec.panes]) {
    try { guard(c.rec, id); } catch { throw env(`wc- label not found for ${id}`); }
  }
  // and the guard refuses a real tab even when it is recorded (read-only: nothing is mutated)
  const real = herdr(['tab', 'list']).tabs.find((t: any) => !String(t.label).startsWith('wc-') && t.workspace_id !== ws &&
    !String(herdr(['workspace', 'get', t.workspace_id]).workspace.label).startsWith('wc-'));
  if (real) {
    let refused = false;
    try { guard({ ...c.rec, tabs: [real.tab_id] }, real.tab_id); } catch { refused = true; }
    if (!refused) throw env(`guard accepted the non-wc- tab ${real.tab_id}`);
  }
  for (const p of [shell, less, stop, probe].filter(Boolean)) {
    if ((await waitFn(() => screen(p).trim(), 15_000, 300)).timeout) throw env(`no shell prompt in ${p}`);
  }
  if (shell) mutate(c.rec, shell, ['pane', 'run', shell, 'seq 1 3000; echo wc-A']);
  if (less) {
    const file = path.join(WORK, 'wc-B.txt');
    fs.writeFileSync(file, Array.from({ length: 3000 }, (_, i) => `wc-B-${i + 1}\n`).join(''));
    // typed into the pane's shell (sh-like or fish): single quotes mean the same in both unless ' or \ is inside
    if (/['\\]/.test(file)) throw env(`WC_ROOT must not contain ' or \\: ${WC_ROOT}`);
    mutate(c.rec, less, ['pane', 'run', less, `less --mouse '${file}'`]);
    c.rec.reported.push(less);
    save(c.rec);
    mutate(c.rec, less, ['pane', 'report-agent', '--source', 'webcheck', '--agent', 'claude', '--state', 'idle', less]);
    const st = await waitFn(async () => { const a = (await paneOf(c, less))?.agent; return a?.name === 'claude' && a.status === 'idle'; }, 10_000, 300);
    if (st.timeout) throw env('report-agent not reflected');
    const rd = await waitFn(async () => (await api(c, 'GET', `/api/panes/${enc(less)}/read?source=visible&lines=200&format=ansi`)).appScroll === true, 10_000, 300);
    if (rd.timeout) throw env('no appScroll pane');
  }
  if (probe) {
    c.rec.reported.push(probe);
    save(c.rec);
    mutate(c.rec, probe, ['pane', 'report-agent', '--source', 'webcheck', '--agent', 'claude', '--state', 'idle', probe]);
  }
  if (shell && (await waitFn(() => /^wc-A$/m.test(screen(shell)), 15_000, 300)).timeout) throw env('wc-shell output missing');
  if (needs.has('claude')) {
    const dir = path.join(WORK, 'wc-claude');
    fs.writeFileSync(path.join(dir, 'wc-note.txt'), 'wc-note-line-1\n');
    const out = await api(c, 'POST', '/api/agents', { profile: 'claude', cwd: dir, name: 'wc-claude', workspace: ws });
    record(c.rec, { pane: out.paneId, tab: herdr(['pane', 'get', out.paneId]).pane.tab_id }, 'claude');
    guard(c.rec, out.paneId);
    await agentReady(c, out.paneId, 30_000);
    // it gets its account from .envrc via direnv in its dir (POST /api/agents takes no env)
    checkAccount(out.paneId, 'wc-claude', account);
  }
  // wc-o1 starts later (startOrchs), so the items before it (P8) see no orchestrator running
}

/** Starts wc-o1 once, when the first item that needs it begins (P8-T2 starts wc-o2 from the list's Start button). */
async function startOrchs(c: Ctx): Promise<void> {
  if (!c.rec.names.o1) await startOrch(c, 'wc-o1');
}

async function startOrch(c: Ctx, name: string): Promise<string> {
  const out = await api(c, 'POST', `/api/orchestrators/${name}/start`);
  recordPane(c, out.paneId, name.slice(3));
  await agentReady(c, out.paneId, 60_000);
  checkAccount(out.paneId, name, pinnedAccount());
  return out.paneId;
}

function recordPane(c: Ctx, pane: string, name: string): void {
  const p = herdr(['pane', 'get', pane]).pane;
  record(c.rec, { pane, tab: p.tab_id, workspace: p.workspace_id }, name);
  guard(c.rec, pane);
}

// ── page probes ──────────────────────────────────────────────────────────────

const TERM = `document.getElementById('terminal-output')`;
const gapJs = `(() => { const e = ${TERM}; return e.scrollHeight - e.scrollTop - e.clientHeight })()`;
const fontJs = `parseFloat(getComputedStyle(${TERM}).fontSize)`;
const firstNum = (text: string): number | null => { const m = text.match(/^\s*(\d+)\s*$/m); return m ? +m[1] : null; };
// the first line from the top of the terminal's viewport that is a plain number (seq output)
const topLineJs = `(() => { const el = ${TERM}; const r = el.getBoundingClientRect(); const x = r.left + parseFloat(getComputedStyle(el).paddingLeft) + 2;
  for (let y = r.top + 2; y < r.top + 200; y += 3) {
    const c = document.caretRangeFromPoint(x, y); const box = c && c.startContainer.parentElement?.closest('#term-history,#term-live');
    if (!box) continue; const pre = document.createRange(); pre.setStart(box, 0); pre.setEnd(c.startContainer, c.startOffset);
    const all = box.textContent, at = pre.toString().length; const s = all.lastIndexOf('\\n', at - 1) + 1; let e = all.indexOf('\\n', at); if (e < 0) e = all.length;
    const m = all.slice(s, e).match(/^\\s*(\\d+)\\s*$/); if (m) return +m[1]; } return null; })()`;
const swState = (ms: number) => `Promise.race([navigator.serviceWorker.ready.then((r) => r.active && r.active.state), new Promise((r) => setTimeout(() => r(null), ${ms}))])`;
const cachesJs = `(async () => { const ks = await caches.keys(); const urls = ks.length ? (await (await caches.open(ks[0])).keys()).map((r) => r.url) : []; return { ks, urls }; })()`;
const notifsJs = `navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((ns) => ns.map((n) => n.tag))`;

async function loadApp(c: Ctx, hash = '#/agents'): Promise<void> {
  await c.pg.load(`${c.base}/?token=${enc(c.token)}${hash}`);
  await c.pg.until(`!!document.querySelector('#screen-agents[data-ready], #screen-pane, #screen-settings')`, 8000);
}

const expectedCards = (st: any, scopeName?: string): number => {
  const orch = st.orchestrators.map((o: any) => o.paneId);
  const scope = scopeName ? st.orchestrators.find((o: any) => o.name === scopeName)?.agents ?? null : null;
  return allPanes(st).filter((p) => p.agent && !orch.includes(p.paneId) && (!scope || scope.includes(p.paneId))).length;
};

// ── Tier 1 items ─────────────────────────────────────────────────────────────

async function p1(c: Ctx) {
  const m = await fetch(`${c.base}/manifest.webmanifest`);
  const ct = m.headers.get('content-type') ?? '';
  const icons: any[] = (await m.json()).icons ?? [];
  const fetchType = async (u: string) => { const r = await fetch(new URL(u, `${c.base}/`)); return `${r.status}:${r.headers.get('content-type')}`; };
  const got = await Promise.all(icons.map((i) => fetchType(i.src)));
  const maskable = icons.filter((i) => i.purpose === 'maskable').length;
  const dom = await c.pg.ev(`[document.querySelectorAll('link[rel=manifest]').length, document.querySelectorAll('meta[name=apple-mobile-web-app-capable]').length]`);
  const links: string[] = await c.pg.ev(`[...document.querySelectorAll('link[rel~=icon], link[rel=apple-touch-icon]')].map((l) => l.href)`);
  const linked = await Promise.all(links.map(fetchType));
  result(c, m.status === 200 && ct.startsWith('application/manifest+json') && got.length === 3 && got.every((g) => g === '200:image/png') && maskable === 1 &&
    dom.join() === '1,1' && linked.length === 3 && linked.every((g) => g.startsWith('200:image/')),
    'P1', `manifest=${m.status}:${ct},icons=${got.join('+')},maskable=${maskable},link/meta=${dom.join('/')},links=${linked.join('+')}`,
    'manifest 200 application/manifest+json; 3 icons 200 image/png, 1 maskable; 1 link[rel=manifest], 1 apple-mobile-web-app-capable; 3 icon links (ico, svg, apple-touch) 200 image/*');
}

async function p2(c: Ctx) {
  const { vite, swName, assets } = c.build;
  const re = vite ? /^herdr-yoicks-[0-9a-f]{8}$/ : /^herdr-yoicks-v\d+$/;
  const st = await c.pg.until(`${swState(1000)}.then((s) => s === 'activated' && s)`, 15_000, 200);
  await loadApp(c); // a ?token= navigation through the active SW: it must not be cached
  await sleep(1500);
  const { ks, urls } = await c.pg.ev(cachesJs);
  const paths = urls.map((u: string) => { const x = new URL(u); return x.pathname + x.search; });
  const missing = assets.filter((a) => !paths.includes(a));
  const q = paths.filter((p: string) => p.includes('?'));
  result(c, !st.timeout && ks.length === 1 && ks[0] === swName && re.test(swName) && paths.length === assets.length && !missing.length && !q.length,
    'P2.sw', `build=${vite ? 'vite' : 'legacy'},sw=${st.v},caches=${ks.join('+')},cached=${paths.length},assets=${assets.length},missing=${missing.join('+') || 0},query=${q.length}`,
    `activated; one cache = sw.js's name ~ ${re}; cached URLs = the asset list; none with '?'`);

  // offline reload: the page and the SW both offline (CDP network emulation is per target)
  const sw = (await c.pg.cdp.send('Target.getTargets')).targetInfos.find((t: any) => t.type === 'service_worker' && t.url.startsWith(c.base));
  const swSid = sw && (await c.pg.cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  const net = (offline: boolean, sid?: string) => c.pg.cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sid);
  if (swSid) { await c.pg.cdp.send('Network.enable', {}, swSid); await net(true, swSid); }
  await net(true, c.pg.sid);
  const fails0 = c.pg.swFails;
  const t0 = Date.now();
  await c.pg.S('Page.reload');
  const app = await c.pg.until(`document.readyState === 'complete' && !!document.getElementById('app')`, 8000);
  const viaSw = c.pg.resps.some((r) => r.t >= t0 && r.type === 'Document' && r.sw);
  const pageNet = await c.pg.ev(`fetch('/healthz').then(() => 'online', () => 'offline')`);
  await net(false, c.pg.sid);
  if (swSid) { await net(false, swSid); await c.pg.cdp.send('Target.detachFromTarget', { sessionId: swSid }); }
  result(c, !app.timeout && viaSw && pageNet === 'offline' && c.pg.swFails > fails0,
    'P2.offline', `app=${!app.timeout},docFromSW=${viaSw},page=${pageNet},swNetFails=${c.pg.swFails - fails0}`, 'offline reload (page and SW offline) still renders #app');
  await loadApp(c);

  const cc = async (p: string) => (await fetch(c.base + p)).headers.get('cache-control') ?? '';
  const sws = await cc('/sw.js');
  const root = await cc('/');
  const js1 = vite ? await cc(`/assets/index-${c.build.hash}.js`) : 'n/a';
  result(c, sws.includes('no-cache') && root.includes('no-cache') && (!vite || js1.includes('immutable')),
    'P2.headers', `sw.js=${sws},/=${root},assets=${vite ? js1 : 'legacy:no-/assets'}`, 'Cache-Control: /sw.js and / no-cache; /assets/*.js immutable (Vite build only)');
}

// The old build (P2.old, P2.downgrade) is a legacy one from before S0 or an earlier Vite build; the
// new one (P2.upgrade) a Vite build. P2.old records what it was served in the reused --profile, and
// the next two compare against that record: the upgrade must be served another cache and BUILD, the
// downgrade the recorded ones again. Without a record they fail.
async function p2Round(c: Ctx, id: string) {
  if (id === 'P2.upgrade' && !c.build.vite) {
    result(c, false, id, 'ENV:legacy-build-served', `${id} needs the vite build served (see the S0 old-SW round trip)`);
    return;
  }
  const re = c.build.vite ? /^herdr-yoicks-[0-9a-f]{8}$/ : /^herdr-yoicks-v\d+$/;
  const st = await c.pg.until(`${swState(1000)}.then((s) => s === 'activated' && s)`, 15_000, 200);
  if (id !== 'P2.old') for (let i = 0; i < 2; i++) { await c.pg.load(`${c.base}/#/agents`); await sleep(1500); }
  await sleep(1000);
  const { ks } = await c.pg.ev(cachesJs);
  const n404 = c.pg.resps.filter((r) => r.status === 404).map((r) => new URL(r.url).pathname); // the first load's too
  let build = '';
  if (id === 'P2.downgrade') {
    await c.pg.goto('#/settings');
    build = (await c.pg.until(`[...document.querySelectorAll('.settings-row')].find((r) => /App version/.test(r.textContent))?.textContent.match(/\\(([^)]+)\\)/)?.[1]`, 3000)).v ?? '';
  }
  // the served BUILD: a Vite build's JS hash, a legacy build's app.js constant
  const appBuild = c.build.vite ? c.build.hash : (await (await fetch(`${c.base}/app.js`)).text()).match(/BUILD\s*=\s*['"]([^'"]+)['"]/)?.[1];
  const served = { cache: c.build.swName, build: appBuild ?? '' };
  const recFile = path.join(c.rec.chrome?.dir ?? c.rec.dir, 'webcheck-p2-old.json');
  let old: typeof served | null = null;
  if (id === 'P2.old') fs.writeFileSync(recFile, js(served));
  else try { old = JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { /* no P2.old in this profile */ }
  // An upgrade renames the cache; BUILD (the JS hash) may stay, e.g. for a CSS-only change.
  const round = id === 'P2.old' || (old !== null && (id === 'P2.upgrade'
    ? old.cache !== served.cache
    : old.cache === served.cache && old.build === served.build));
  result(c, round && !st.timeout && ks.length === 1 && ks[0] === c.build.swName && re.test(ks[0]) && !n404.length && (id !== 'P2.downgrade' || build === appBuild),
    id, `served=${served.build}/${served.cache}${id === 'P2.old' ? '(recorded)' : `,old=${old ? `${old.build}/${old.cache}` : 'none'}`},sw=${st.v},caches=${ks.join('+')},404=${n404.join('+') || 0}${id === 'P2.downgrade' ? `,build=${build}` : ''}`,
    `only sw.js's cache (${re}) after ${id === 'P2.old' ? 'install' : '2 reloads'}; no 404${id === 'P2.old' ? '' : `; P2.old's record in the profile, and ${id === 'P2.upgrade' ? 'another cache' : 'its cache and BUILD again'}`}${id === 'P2.downgrade' ? '; Settings shows the old BUILD' : ''}`);
}

async function p3(c: Ctx) {
  const less = c.rec.names.less;
  const nav = async (url: string, want: string) => {
    await c.pg.goto('#/agents');
    await c.pg.ev(`navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', url: ${js(url)} } })), 1`);
    return c.pg.until(`location.hash === ${js(want)}`, 2000);
  };
  const a = await nav(`#/pane/${enc(less)}`, `#/pane/${enc(less)}`);
  const o = (await api(c, 'GET', '/api/state')).orchestrators.find((x: any) => x.paneId && x.name.startsWith('wc-'));
  const b = o ? await nav(`#/pane/${enc(o.paneId)}`, `#/home/${enc(o.name)}`) : null;
  result(c, !a.timeout && (!b || !b.timeout), 'P3', `pane=${a.timeout ? 'timeout' : `${a.ms}ms`},orch=${b ? (b.timeout ? 'timeout' : `${b.ms}ms`) : 'n/a(none running)'}`,
    "SW 'navigate' message -> hash within 2s; an orchestrator's pane -> its #/home/<name>");
}

async function p7(c: Ctx) {
  const counts: string[] = [];
  let ok = true;
  for (const route of ['#/agents', '#/agents/wc-o1']) {
    await c.pg.goto(route);
    let last = '';
    const r = await waitFn(async () => {
      const dom = await c.pg.ev(`document.querySelector('#screen-agents[data-ready]') ? document.querySelectorAll('.agent-card').length : -1`);
      const want = expectedCards(await api(c, 'GET', '/api/state'), route.split('/')[2]);
      last = `${dom}/${want}`;
      return dom === want;
    }, 5000, 300);
    ok &&= !r.timeout;
    counts.push(`${route}=${last}`);
  }
  await c.pg.goto('#/agents');
  const btns = await c.pg.ev(`document.querySelectorAll('#topbar-right button').length`);
  const less = c.rec.names.less;
  await c.pg.tapEl(`document.querySelector('.agent-card[data-pane-id=${js(less)}]')`);
  const nav = await c.pg.until(`location.hash === ${js(`#/pane/${enc(less)}`)}`, 2000);
  result(c, ok && btns === 1 && !nav.timeout, 'P7', `cards(dom/state):${counts.join(',')},topbarButtons=${btns},tap=${nav.timeout ? 'timeout' : `${nav.ms}ms`}`,
    '.agent-card count = /api/state (#/agents, #/agents/wc-o1); 1 topbar button (Settings); tapping wc-less opens #/pane/<it> within 2s');
  // a Home's own list: its ← names that Home and opens its Home, on a phone (a tap) and a PC (a click, the sidebar beside it)
  const BACK = `document.querySelector('#topbar-left .topbar-back')`;
  const back = async (phone: boolean) => {
    await c.pg.goto('#/agents/wc-o1');
    const shown = await c.pg.until(`(() => { const b = ${BACK}; return !!b && b.getBoundingClientRect().width > 0; })()`, 3000);
    const [text, label] = shown.timeout ? ['', ''] : await c.pg.ev(`[${BACK}.textContent, ${BACK}.getAttribute('aria-label')]`);
    if (shown.timeout) return { text, label, nav: shown };
    const p = await c.pg.at(BACK);
    if (phone) await c.pg.tap(p.x, p.y);
    else for (const type of ['mousePressed', 'mouseReleased']) await c.pg.S('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    return { text, label, nav: await c.pg.until(`location.hash === '#/home/wc-o1'`, 2000) };
  };
  const named = (r: { text: string; label: string }) => /^\u2190 \S/.test(r.text) && r.text !== '\u2190 Home' && r.label === `Back to ${r.text.slice(2)}`;
  const ph = await back(true);
  await mobile(c.pg, false);
  let pc: Awaited<ReturnType<typeof back>>;
  try { pc = await back(false); } finally { await mobile(c.pg, true); }
  result(c, named(ph) && !ph.nav.timeout && named(pc) && !pc.nav.timeout, 'P7.back',
    `phone=${js(ph.text)}:${ph.nav.timeout ? 'timeout' : `${ph.nav.ms}ms`},pc=${js(pc.text)}:${pc.nav.timeout ? 'timeout' : `${pc.nav.ms}ms`}`,
    "#/agents/wc-o1's topbar has '\u2190 <its Home>' (aria-label 'Back to <it>'), shown at 390px and at 1280px; it opens #/home/wc-o1 within 2s");
}

/** Without a running orchestrator, a fresh open (/) and #/home land on #/agents by location.replace. */
/** A Home's status bar total: its counts (working, done, idle) plus its blocked agents (Needs you's data-blocked, none without it). */
const HOME_TOTAL = `[...document.querySelectorAll('.home-counts [data-count]')].reduce((n, e) => n + parseInt(e.textContent), 0)
  + Number(document.querySelector('#home-status [data-action="needs"]')?.dataset.blocked ?? 0)`;

/** The stopped Home of `name` (Start) within `wait`, and its status bar total = /api/state's agents of its account (within 5s, as P7). */
async function stoppedHome(c: Ctx, name: string, wait: number): Promise<{ ok: boolean; s: string }> {
  const r = await c.pg.until(`location.hash === ${js(`#/home/${enc(name)}`)} && !!document.querySelector('#screen-home-stopped #btn-home-start')`, wait);
  let last = '';
  const n = await waitFn(async () => {
    const dom = await c.pg.ev(HOME_TOTAL);
    const want = expectedCards(await api(c, 'GET', '/api/state'), name);
    last = `${dom}/${want}`;
    return dom === want;
  }, 5000, 300);
  return { ok: !r.timeout && !n.timeout, s: `${ms(r)}:agents=${last}` };
}

async function p8(c: Ctx) {
  const { pg } = c;
  const st = await api(c, 'GET', '/api/state');
  const running = st.orchestrators.filter((o: any) => o.paneId).map((o: any) => o.name);
  if (running.length) {
    result(c, true, 'P8', `n/a(running:${running.join('+')})`, 'needs no orchestrator running (/api/state)');
    return;
  }
  const first = st.orchestrators[0].name; // no Home used last on this phone (cleared below): the first configured
  await pg.ev(`localStorage.removeItem('herdr_home')`);
  // a fresh document's history.length already counts its own entry: a replace keeps it, a push adds one
  const { identifier } = await pg.S('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__wcHist0 = history.length' });
  try { await pg.load(`${c.base}/`); } finally { await pg.S('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
  const root = await stoppedHome(c, first, 3000);
  const [h1, h0] = await pg.ev(`[history.length, window.__wcHist0]`);
  // in the app: the hash assignment adds one entry, the redirect none
  const g0 = await pg.ev('history.length');
  await pg.ev(`location.hash = '#/home'`);
  const home = await stoppedHome(c, first, 3000);
  const g1 = await pg.ev('history.length');
  result(c, root.ok && h1 === h0 && home.ok && g1 === g0 + 1, 'P8',
    `/=${root.s},history=${h0}->${h1};#/home=${home.s},history=${g0}->${g1}`,
    `nothing running: / and #/home are replaced by #/home/${first} (the first configured) within 3s, a stopped Home with Start (history.length +0, +1 for the #/home assignment itself); its status bar total = /api/state's agents of its account`);
}

async function p10(c: Ctx) {
  const { pg, rec } = c;
  const { shell, less } = rec.names;
  // ── wc-shell: local scrollback ──
  await pg.goto(`#/pane/${enc(shell)}`);
  await pg.until(`document.getElementById('term-live')?.textContent.includes('wc-A') && document.getElementById('term-history')?.textContent.length > 0`, 8000);
  await sleep(1000);
  const g0 = await pg.ev(gapJs);
  result(c, g0 <= 1, 'P10.open', `gap=${g0}px`, 'a pane opens at the bottom (gap <= 1px)');
  const { x, y } = await pg.at(TERM);

  const mark = `wc-A-live-${Date.now() % 100000}`;
  await pg.touch('touchStart', [[x, y]]);
  const before = await pg.ev(`document.getElementById('term-live').innerHTML`);
  const t0 = Date.now();
  mutate(rec, shell, ['pane', 'run', shell, `echo ${mark}`]);
  const pushed = await waitFn(() => pg.wsRecv.some((f) => f.t >= t0 && f.msg.paneId === shell && f.payload.includes(mark)), 3000);
  await sleep(300);
  const held = (await pg.ev(`document.getElementById('term-live').innerHTML`)) === before;
  await pg.touch('touchEnd', []);
  const after = await pg.until(`document.getElementById('term-live').textContent.includes(${js(mark)})`, 1000);
  result(c, !pushed.timeout && held && !after.timeout, 'P10.live-defer', `push=${!pushed.timeout},unchangedWhileDown=${held},afterLift=${after.timeout ? 'timeout' : `${after.ms}ms`}`,
    '#term-live keeps still while a finger is down; changes within 1s of lifting');

  await sleep(600);
  const n0 = await pg.ev(topLineJs);
  await pg.drag(x, y - 150, 300, 15, 16, 150);
  await sleep(800);
  const n1 = await pg.ev(topLineJs);
  result(c, n0 != null && n1 != null && n0 - n1 >= 10, 'P10.swipe', `top=${n0}->${n1}`, 'a 300px downward drag shows lines >= 10 older');

  const first = firstNum((await api(c, 'GET', `/api/panes/${enc(shell)}/read?source=recent&lines=1000&format=text`)).text);
  await pg.ev(`${TERM}.scrollTop = 0`);
  const top = await waitFn(async () => { const n = firstNum(await pg.ev(`document.getElementById('term-history').textContent`)); return n != null && first != null && n <= first && n >= first - 20 ? n : null; }, 3000);
  result(c, !top.timeout, 'P10.history-top', `historyFirst=${top.v},recentFirst=${first},in=${top.ms}ms`,
    "at the top, within 3s #term-history starts at the bridge's oldest recent line (seq 1..3000 > the 1000-line recent cap, so not literally 1)");

  await pg.ev(`${TERM}.scrollTop = 1e9`);
  await sleep(500);
  const fit = await pg.ev(fontJs);
  await pg.pinch(x, y, 50, 100);
  const pz = await pg.ev(fontJs);
  result(c, pz >= fit * 1.3 && pz <= 24, 'P10.pinch', `font=${fit}->${pz}px`, 'doubling the 2-finger distance grows the font >= 30%, to <= 24px');

  await pg.ev(`${TERM}.scrollTop = 0`);
  await sleep(400);
  await pg.tap(x, y);
  await sleep(150);
  await pg.tap(x, y);
  await sleep(1200);
  const f2 = await pg.ev(fontJs);
  const g2 = await pg.ev(gapJs);
  result(c, Math.abs(f2 - fit) <= 0.5 && g2 <= 1, 'P10.double-tap', `font=${f2}px(fit=${fit}),gap=${g2}px`, 'two still taps 150ms apart: back to the fitted font (+-0.5px) and the bottom (<= 1px)');

  await sleep(400);
  await pg.pinch(x, y, 50, 100);
  const pz2 = await pg.ev(fontJs);
  await pg.tap(x, y, 15);
  await sleep(150);
  await pg.tap(x, y, 15);
  await sleep(1200);
  const f3 = await pg.ev(fontJs);
  result(c, Math.abs(f3 - pz2) <= 0.5 && Math.abs(f3 - fit) > 0.5, 'P10.moved-tap', `font=${pz2}->${f3}px(fit=${fit})`, 'two taps that moved 15px keep the pinched font');
  await sleep(400);
  await pg.tap(x, y);
  await sleep(150);
  await pg.tap(x, y);

  // ── wc-less: app scroll (SGR wheel forwarding) ──
  await pg.goto(`#/pane/${enc(less)}`);
  await pg.until(`document.getElementById('term-live')?.textContent.includes('wc-B')`, 8000);
  await sleep(1000);
  guard(rec, less); // the gestures below make the page POST to wc-less (each request is guarded too)
  const scroll = `/api/panes/${enc(less)}/scroll`;
  const ta = Date.now();
  await pg.drag(x, y - 120, 240, 12, 30, 200);
  await sleep(700);
  const bodies = pg.posts(ta, scroll).map((q) => q.body);
  const up = bodies.filter((b) => b.direction === 'up').reduce((s, b) => s + b.steps, 0);
  const down = bodies.filter((b) => b.direction !== 'up').length;
  result(c, up >= 15 && down === 0, 'P10.app-swipe', `posts=${bodies.length},upSteps=${up},other=${down}`, "a 240px downward drag POSTs /scroll direction 'up', steps summing >= 15");

  await sleep(1500);
  const tEnd = await pg.drag(x, y - 80, 160, 8, 8);
  await sleep(1500);
  const late = pg.posts(tEnd + 120, scroll).length;
  result(c, late >= 1, 'P10.app-fling', `postsAfterLift=${late}`, 'a fling keeps POSTing /scroll after the finger lifts (>= 1)');

  await sleep(2500);
  await mobile(pg, false); // a PC: at the phone's 3x scale Chrome scales the wheel delta
  const w = await pg.at(TERM);
  const tw = Date.now();
  await pg.S('Input.dispatchMouseEvent', { type: 'mouseWheel', x: w.x, y: w.y, deltaX: 0, deltaY: 90 });
  await sleep(600);
  await mobile(pg, true);
  const wb = pg.posts(tw, scroll).map((q) => q.body);
  result(c, wb.length === 1 && wb[0].direction === 'down' && wb[0].steps === 3, 'P10.app-wheel', `posts=${js(wb)}`, 'a PC wheel deltaY 90 POSTs exactly {down, 3}');

  await sleep(1000);
  const tq = Date.now(); // before the tap: its POST, even its answer, can come before tapEl returns
  await pg.tapEl(`[...document.querySelectorAll('.qkey')].find((b) => b.textContent === '\\u2193')`);
  // the echo's two reads go out 120 and 500 ms after the key's POST /input is answered (terminal.ts echo), not after
  // the tap: under CPU load that answer alone takes a few hundred ms, so the window starts there. It ends 1s after it:
  // the page sees the answer and runs its timers later than CDP saw it, by as long as the renderer waits for a CPU (up
  // to ~60ms on CI's runner), and nothing else reads this pane's screen meanwhile (the 3s refresh reads only while the
  // WS is down, the scrollback only on a local scroll), so a window past the 500ms read counts no other read
  const answered = await waitFn(() => pg.resps.find((r) => r.t >= tq && r.url.includes(`/api/panes/${enc(less)}/input`)), 3000, 20);
  const tAns = answered.v?.t ?? tq;
  await waitFn(() => Date.now() >= tAns + 1100, 2000, 20);
  const reads = pg.reqs.filter((q) => q.method === 'GET' && q.t >= tAns && q.t <= tAns + 1000 && q.url.includes(`/api/panes/${enc(less)}/read`)).length;
  result(c, !answered.timeout && reads >= 2, 'P10.app-quickkey', `answered=${answered.timeout ? 'timeout' : `${tAns - tq}ms`},reads1s=${reads}`,
    "a quick key's POST /input answered within 3s, then >= 2 GET /read within 1s of the answer");
}

/** Stale responses: wc-shell's screen read, held until wc-less is on screen, must not paint wc-less's terminal. */
async function p14(c: Ctx) {
  const { pg } = c;
  const { shell, less } = c.rec.names;
  const read = `/api/panes/${enc(shell)}/read?`;
  await pg.goto('#/agents');
  pg.hold = read;
  let held: any[] = [], tNav = 0, tRel = 0;
  try {
    await pg.ev(`location.hash = ${js(`#/pane/${enc(shell)}`)}`);
    const paused = await waitFn(() => pg.held.length > 0, 3000);
    if (paused.timeout) throw env("wc-shell's /read never sent");
    await pg.ev(`location.hash = ${js(`#/pane/${enc(less)}`)}`);
    tNav = Date.now();
    const onLess = await pg.until(`document.getElementById('term-live')?.textContent.includes('wc-B')`, 5000);
    if (onLess.timeout) throw env('wc-less never showed wc-B');
    // every node or text put into #term-live from here on: a stale paint overwritten between polls still shows
    await pg.ev(`(() => { window.__wcSawA = false; window.__wcMoA = new MutationObserver((recs) => { for (const r of recs) {
      const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (!el?.closest('#term-live')) continue;
      if (r.type === 'characterData' ? r.target.data.includes('wc-A') : [...r.addedNodes].some((n) => n.textContent.includes('wc-A'))) window.__wcSawA = true;
    } }); window.__wcMoA.observe(document.getElementById('screen'), { childList: true, subtree: true, characterData: true }); return 1; })()`);
    tRel = Date.now();
    held = await pg.release();
  } finally {
    await pg.release();
  }
  const ids = held.map((p) => p.networkId);
  const answered = await waitFn(() => ids.every((id) => pg.resps.some((r) => r.id === id)), 2000);
  // 2s from the release: every look shows wc-less's screen and none of wc-shell's
  const seen = new Set<string>();
  for (const t0 = Date.now(); Date.now() - t0 < 2000; await sleep(100)) {
    const live: string = await pg.ev(`document.getElementById('term-live')?.textContent ?? ''`);
    seen.add(`${live.includes('wc-B') ? 'B' : '-'}${live.includes('wc-A') ? 'A' : '-'}`);
  }
  const sawA: boolean = await pg.ev('window.__wcMoA.disconnect(), window.__wcSawA');
  // the held read really carried wc-shell's screen (200, wc-A in it), or the stale path wasn't exercised
  const shellScreen = await Promise.all(ids.map(async (id) => {
    const status = pg.resps.find((r) => r.id === id)?.status;
    const body = await waitFn(async () => (await pg.S('Network.getResponseBody', { requestId: id })).body as string, 2000);
    return { status, wcA: !body.timeout && body.v.includes('wc-A') };
  }));
  const after = answered.timeout ? 'none' : `+${Math.max(...ids.map((id) => pg.resps.find((r) => r.id === id)!.t)) - tRel}ms`;
  const real = shellScreen.length >= 1 && shellScreen.every((x) => x.status === 200 && x.wcA);
  result(c, real && tRel >= tNav && !answered.timeout && !sawA && seen.size === 1 && seen.has('B-'), 'P14',
    `held=${held.length},releasedAfterNav=${tRel >= tNav}(+${tRel - tNav}ms),shellResponse=${after}[${shellScreen.map((x) => `${x.status}:${x.wcA ? 'wc-A' : 'no-wc-A'}`).join('+')}],` +
      `wcAEverPainted=${sawA},liveFor2s=${[...seen].join('+')}`,
    "wc-shell's /read (200, carrying wc-A) held until #/pane/<wc-less> shows wc-B, then released: through it and 2s on, #term-live never gets wc-A and keeps wc-B");
}

async function p12(c: Ctx) {
  const p = c.preview;
  if (!p) { result(c, false, 'P12', `ENV:no-preview.json-for-${c.port}`, 'needs a preview started by `webcheck preview start` (to stop/start it)'); return; }
  const { pg } = c;
  await pg.goto(`#/pane/${enc(c.rec.names.shell)}`);
  await pg.until(`document.getElementById('term-live')?.textContent.length > 0`, 8000);
  await sleep(1000);
  const banner = `document.getElementById('reconnect-banner').classList.contains('visible')`;
  try {
    const stopping = previewCtl(p, 'stop');
    const b = await pg.until(banner, 2000);
    await stopping;
    result(c, !b.timeout, 'P12.banner', `banner=${b.timeout ? 'timeout' : `${b.ms}ms`}`, 'the reconnect banner shows within 2s of stopping the preview');
    const t1 = Date.now();
    await previewCtl(p, 'start');
    const gone = await waitFn(() => pg.ev(`!(${banner})`), 16_000 - (Date.now() - t1));
    const tUp = Date.now();
    const watch = pg.wsSent.filter((f) => f.t >= t1 && /"type":"watch_/.test(f.payload)).length;
    result(c, !gone.timeout && watch >= 1, 'P12.reconnect', `bannerGone=${gone.timeout ? 'timeout' : `${tUp - t1}ms`},watchSent=${watch}`,
      'after start the banner hides within 16s and >= 1 watch_* is sent');
    await sleep(31_000);
    const pings = pg.wsSent.filter((f) => f.t >= t1 && /"type":"ping"/.test(f.payload)).length;
    result(c, pings >= 1, 'P12.ping', `pings31s=${pings}`, '>= 1 ping within 31s of reconnecting');
  } finally {
    await previewCtl(p, 'start'); // never leave the preview down (no-op when running)
  }
}

async function p13(c: Ctx) {
  const { pg } = c;
  await pg.ev(`localStorage.removeItem('herdr_token')`);
  const t = Date.now();
  await pg.S('Page.navigate', { url: `${c.base}/?token=${enc(c.token)}#/agents` });
  const s = await pg.until(`location.search === '' && localStorage.getItem('herdr_token') === ${js(c.token)}`, 1000 - (Date.now() - t), 20);
  result(c, !s.timeout, 'P13.strip', `in=${s.timeout ? 'timeout' : `${Date.now() - t}ms`}`, "within 1s ?token= is gone from the URL and stored in localStorage");

  await pg.load(`${c.base}/?token=wc-invalid-token#/agents`);
  const bad = await pg.until(`(() => { const s = document.querySelector('#screen-login .login-subtitle')?.textContent ?? ''; return /invalid|expired|could not/i.test(s) && s; })()`, 5000);
  result(c, !bad.timeout, 'P13.bad-token', `message=${bad.v || 'none'}`, 'an invalid token shows the token screen with a message');

  await loadApp(c, '#/settings');
  await pg.until(`!!document.getElementById('btn-clear-token')`, 5000);
  const t0 = await pg.tapEl(`document.getElementById('btn-clear-token')`);
  const gone = await pg.until(`localStorage.getItem('herdr_token') === null`, 1000);
  await sleep(5000);
  const conns = pg.wsCreated.filter((t) => t >= t0).length;
  result(c, !gone.timeout && conns === 0, 'P13.signout', `tokenNull=${!gone.timeout},wsOpened5s=${conns}`, 'sign out: token null, then no WebSocket for 5s');
  await loadApp(c);
}

async function p16(c: Ctx) {
  const { pg } = c;
  const prev = await pg.ev(`localStorage.getItem('herdr_notifications')`);
  await pg.ev(`localStorage.setItem('herdr_notifications', 'false')`);
  await pg.goto('#/agents');
  await pg.goto('#/settings');
  await pg.until(`!!document.getElementById('toggle-notif')`, 3000);
  await pg.tapEl(`document.querySelector('.toggle')`);
  const tog = await pg.until(`localStorage.getItem('herdr_notifications') === 'true'`, 1000);
  await pg.ev(prev === null ? `localStorage.removeItem('herdr_notifications')` : `localStorage.setItem('herdr_notifications', ${js(prev)})`);
  result(c, !tog.timeout, 'P16.toggle', `stored=${!tog.timeout}`, "the notification toggle stores 'true'");

  const rows: Array<[string, string]> = await pg.ev(`[...document.querySelectorAll('.settings-row')].map((r) => [r.querySelector('.settings-row-label')?.textContent ?? '', r.querySelector('.settings-row-value')?.textContent ?? ''])`);
  const hv = rows.find(([l]) => l === 'herdr version')?.[1];
  const want = (await api(c, 'GET', '/api/state')).herdr.version;
  result(c, hv === String(want), 'P16.herdr', `shown=${hv},state=${want}`, 'herdr version = /api/state');

  if (c.build.vite) {
    // ' cache X' lands a moment after the render (caches.keys() is async)
    const re = /\(([^)]+)\) cache ([0-9a-f]{8}|-)$/;
    const text = ((await pg.until(`(() => { const t = document.getElementById('app-version')?.textContent.trim() ?? ''; return ${re}.test(t) && t; })()`, 3000)).v ||
      await pg.ev(`document.getElementById('app-version')?.textContent ?? ''`)).trim();
    const m = text.match(re);
    const cache = c.build.swName.slice(-8);
    result(c, !!m && m[1] === c.build.hash && m[2] === cache, 'P16.version', `shown=${text},index=${c.build.hash},sw=${cache}`,
      "#app-version '(BUILD) cache XXXXXXXX': BUILD = index.html's /assets/index-<hash>.js, cache = sw.js's CACHE_VERSION suffix");
  } else {
    const text = rows.find(([l]) => l === 'App version')?.[1] ?? '';
    const appBuild = (await (await fetch(`${c.base}/app.js`)).text()).match(/BUILD\s*=\s*['"]([^'"]+)['"]/)?.[1];
    result(c, text.match(/\(([^)]+)\)/)?.[1] === appBuild, 'P16.version', `legacy,shown=${text},app.js=${appBuild}`, "legacy build: the App version's (BUILD) = app.js's BUILD (no cache part before S0)");
  }
}

async function p17(c: Ctx) {
  const [h, vv] = await c.pg.ev(`[parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height')), visualViewport.height]`);
  result(c, Math.abs(h - vv) <= 1, 'P17', `--app-height=${h},visualViewport=${vv}`, 'at 390x844 --app-height = visualViewport.height (+-1)');
}

/** Reports wc-less's status and waits for /api/state to show it (the agent_status push goes out with it).
 *  idle after a turn shows as done until herdr counts it seen. */
async function reportLess(c: Ctx, state: string): Promise<void> {
  const less = c.rec.names.less;
  const want = state === 'idle' ? ['idle', 'done'] : [state];
  mutate(c.rec, less, ['pane', 'report-agent', '--source', 'webcheck', '--agent', 'claude', '--state', state, less]);
  if ((await waitFn(async () => want.includes((await paneOf(c, less))?.agent?.status), 5000, 100)).timeout) throw env(`wc-less not ${state}`);
}

/** P4-T1: notifications on and permitted, the page hidden: wc-less reported blocked -> one OS notification tagged
 *  with its pane id; opening the pane closes it. (Other agents' notifications may come and go: only this tag counts.) */
async function p4t1(c: Ctx) {
  const { pg } = c;
  const less = c.rec.names.less;
  const tagged = `navigator.serviceWorker.ready.then((r) => r.getNotifications({ tag: ${js(less)} })).then((ns) => ns.length)`;
  // a reused --profile keeps its own setting: put it back however the check ends
  const prev: string | null = await pg.ev(`localStorage.getItem('herdr_notifications')`);
  let other: { targetId: string } | null = null;
  try {
    await pg.ev(`localStorage.setItem('herdr_notifications', 'true')`);
    await pg.goto('#/agents');
    other = await pg.cdp.send('Target.createTarget', { url: 'about:blank' });
    await pg.cdp.send('Target.activateTarget', { targetId: other!.targetId });
    if ((await pg.until('document.hidden', 3000)).timeout) throw env('could not hide the page');
    // The evidence for a miss (it came once in 7 runs, then not in 40): wc-less before the report (already blocked:
    // herdr sends no event), the pushes that reached the page, the page notifications the app fell back to (not in
    // getNotifications), the service worker's state, and the WebSockets opened meanwhile (a reconnect drops a push).
    const before = (await paneOf(c, less))?.agent?.status;
    await pg.ev("(() => { const N = window.__wcN ??= Notification; window.__wcPage = 0; window.Notification = class extends N { constructor(...a) { super(...a); window.__wcPage++; } }; })()");
    const t0 = Date.now();
    await reportLess(c, 'blocked');
    const n = await pg.until(`${tagged}.then((k) => k === 1)`, 10_000, 200);
    const diag = await pg.ev("navigator.serviceWorker.getRegistration().then((r) => `page=${window.__wcPage},sw=${r ? (r.active?.state ?? 'no-active') + (r.installing ? '+installing' : '') + (r.waiting ? '+waiting' : '') : 'none'},hidden=${document.hidden},perm=${Notification.permission},set=${localStorage.getItem('herdr_notifications')}`)");
    const wsNew = pg.wsCreated.filter((t) => t >= t0).length;
    const pushes = pg.wsRecv.filter((f) => f.t >= t0 && f.msg?.type === 'agent_status' && f.msg.paneId === less).map((f) => `${f.msg.from}>${f.msg.to}@${f.t - t0}ms`);
    await pg.cdp.send('Target.activateTarget', { targetId: pg.targetId });
    await pg.until('!document.hidden', 3000);
    await pg.ev(`location.hash = ${js(`#/pane/${enc(less)}`)}`);
    const z = await pg.until(`${tagged}.then((k) => k === 0)`, 2000);
    result(c, !n.timeout && !z.timeout, 'P4-T1', `notif=${ms(n)},cleared=${ms(z)},pushes=${pushes.join('+') || 'none'},before=${before},${diag},wsNew=${wsNew}`,
      'hidden page: wc-less reported blocked -> 1 OS notification tagged with its pane id within 10s; opening the pane clears it within 2s');
  } finally {
    await pg.ev("window.__wcN && (window.Notification = window.__wcN)");
    await pg.ev(prev === null ? `localStorage.removeItem('herdr_notifications')` : `localStorage.setItem('herdr_notifications', ${js(prev)})`);
    await pg.cdp.send('Target.activateTarget', { targetId: pg.targetId });
    if (other) await pg.cdp.send('Target.closeTarget', { targetId: other.targetId }).catch(() => {});
    await reportLess(c, 'idle');
    await sleep(500);
    await pg.goto('#/agents');
  }
}

/** P15: wc-stop opened from #/agents/wc-o1 and stopped (⋮ → Stop agent… → Stop): back to that list, the pane gone. */
async function p15(c: Ctx) {
  const { pg } = c;
  const stop = c.rec.names.stop;
  const list = '#/agents/wc-o1'; // not the default #/agents: the way back is remembered
  await pg.goto(list);
  await pg.goto(`#/pane/${enc(stop)}`);
  const menu = `document.getElementById('btn-agent-menu')`;
  await pg.until(`!!${menu}`, 5000);
  await pg.uncovered(menu, await pg.at(menu)); // its drawer in place, no toast over its header
  guard(c.rec, stop);
  await pg.tapEl(menu);
  // Mantine's menu and modal mount through a transition, a frame or so after the tap
  await pg.until(`!!document.getElementById('am-stop')`, 3000);
  await pg.tapEl(`document.getElementById('am-stop')`);
  await pg.until(`!!document.getElementById('cf-ok')`, 3000);
  const t = await pg.tapEl(`document.getElementById('cf-ok')`);
  const back = await pg.until(`location.hash === ${js(list)}`, 3000);
  const del = pg.reqs.find((q) => q.t >= t - 1000 && q.method === 'DELETE' && q.url.endsWith(`/api/panes/${enc(stop)}`));
  const gone = await waitFn(async () => !(await paneOf(c, stop)), 5000, 200);
  result(c, !back.timeout && !!del && !gone.timeout, 'P15', `back=${ms(back)}(${await pg.hash()}),delete=${!!del},paneGone=${ms(gone)}`,
    `stopping wc-stop returns to ${list} within 3s (DELETE /api/panes/<it>), and /api/state drops the pane within 5s`);
  await pg.goto('#/agents');
}

/** P18: the list (390x400) under state pushes, each a rename of wc-less's tab (wc- kept), so its card changes:
 *  scrolled to 200px the scroller keeps its node and scrollTop, also when wc-probe's change reorders the cards; a finger down (moved 50px) holds every card until
 *  it lifts; a still tap on wc-less's card with a push arriving while the finger is down still opens it. */
async function p18(c: Ctx) {
  const { pg, rec } = c;
  const less = rec.names.less;
  const tab = herdr(['pane', 'get', less]).pane.tab_id;
  const SC = `document.getElementById('screen-agents')`;
  const CARD = `document.querySelector('.agent-card[data-pane-id=${js(less)}]')`;
  let n = 0;
  /** renames wc-less's tab; true once the page got the state frame carrying the new label */
  const push = async (): Promise<boolean> => {
    const label = `wc-less-${++n}`;
    pg.stateMark = js(label);
    pg.stateMarkT = 0;
    mutate(rec, tab, ['tab', 'rename', tab, label]);
    return !(await waitFn(() => pg.stateMarkT > 0, 5000, 5)).timeout;
  };
  await pg.goto('#/agents');
  await pg.S('Emulation.setDeviceMetricsOverride', { width: 390, height: 400, deviceScaleFactor: 3, mobile: true });
  try {
    await pg.until(`!!${SC}?.dataset.ready && !!${CARD}`, 5000);
    // scrolled to 200px: the padding on the list makes room however many agents herdr has (on the scroller itself it
    // would grow the scroller's own box, not its scroll range: a private herdr's 2 cards then scroll 182px at most)
    await pg.ev(`(() => { const s = ${SC}; s.firstElementChild.style.paddingBottom = '1500px'; s.scrollTop = 200; window.__wcSc = s; })()`);
    await sleep(300);
    const top0 = await pg.ev(`${SC}.scrollTop`);
    const p1 = await push();
    await sleep(500);
    const [top1, same] = await pg.ev(`[${SC}.scrollTop, ${SC} === window.__wcSc]`);
    result(c, top0 === 200 && p1 && Math.abs(top1 - top0) <= 1 && same, 'P18.scroll', `push=${p1},scrollTop=${top0}->${top1},sameNode=${same}`,
      'scrolled to 200px, a state push keeps #screen-agents (same node) and its scrollTop (+-1px)');

    // a push that reorders the cards keeps it too: wc-less first and just above the top edge, wc-probe under it
    // becomes the newest change and moves above it. Chrome's scroll anchoring (none in Safari) would scroll the list
    // after the card it anchored on.
    const probe = rec.names.probe;
    const PROBE = `document.querySelector('.agent-card[data-pane-id=${js(probe)}]')`;
    const before = (a: string, b: string) => `!!${a} && !!${b} && !!(${a}.compareDocumentPosition(${b}) & Node.DOCUMENT_POSITION_FOLLOWING)`;
    await reportLess(c, 'working');
    const up = await pg.until(before(CARD, PROBE), 5000);
    const top2 = await pg.ev(`(() => { const s = ${SC};
      s.scrollTop = ${CARD}.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop + 44; return s.scrollTop; })()`);
    await sleep(300);
    mutate(rec, probe, ['pane', 'report-agent', '--source', 'webcheck', '--agent', 'claude', '--state', 'working', probe]);
    const moved = await pg.until(before(PROBE, CARD), 5000);
    await sleep(300);
    const [top3, same3] = await pg.ev(`[${SC}.scrollTop, ${SC} === window.__wcSc]`);
    await reportLess(c, 'idle');
    result(c, !up.timeout && !moved.timeout && Math.abs(top3 - top2) <= 1 && same3, 'P18.reorder', `order=${!up.timeout && !moved.timeout},scrollTop=${top2}->${top3},sameNode=${same3}`,
      "wc-less first, scrolled 44px into its card: wc-probe under it reported working moves above it within 5s, and #screen-agents keeps its node and scrollTop (+-1px)");

    // a finger down and moved 50px: a push changes nothing in the list until it lifts, then what it carried (the new
    // tab label) shows within 100ms, RAIL's response budget, so it reads as part of the lift; a list still held would
    // wait for the next push, minutes away on a quiet system. The app's part is ~2ms (~5ms at 4x CPU throttling); the
    // rest is the renderer waiting for a CPU, up to 51ms on CI's runner, which the 50ms this had sat inside.
    const p = await pg.at(CARD);
    await pg.uncovered(CARD, p);
    await pg.ev(`(() => { const s = ${SC}; window.__wcTE = 0; window.__wcShown = 0; window.__wcLabel = ''; window.__wcMut = []; window.__wcMo?.disconnect();
      window.__wcMo = new MutationObserver((rs) => { const t = performance.now(); for (const r of rs) window.__wcMut.push(t);
        if (!window.__wcShown && window.__wcLabel && ${CARD}?.textContent.includes(window.__wcLabel)) window.__wcShown = t; });
      window.__wcMo.observe(s, { subtree: true, childList: true, characterData: true, attributes: true });
      s.addEventListener('touchend', () => { window.__wcTE = performance.now(); window.__wcDown = window.__wcMut.length; }, { once: true, passive: true }); })()`);
    await pg.touch('touchStart', [[p.x, p.y]]);
    await pg.ev('window.__wcMut = []');
    for (let i = 1; i <= 5; i++) { await sleep(16); await pg.touch('touchMove', [[p.x, p.y - 10 * i]]); }
    const p2 = await push();
    await pg.ev(`window.__wcLabel = ${js(`wc-less-${n}`)}`);
    await sleep(500);
    await pg.touch('touchEnd', []);
    // counted at touchend, and shown only after it: what showed while the finger was down never passes
    const lift = await pg.until(`window.__wcShown >= window.__wcTE && window.__wcTE && { d: Math.round(window.__wcShown - window.__wcTE) }`, 1000);
    const down = await pg.ev('window.__wcDown');
    await pg.ev('window.__wcMo.disconnect()');
    const d = lift.timeout ? null : lift.v.d;
    result(c, p2 && down === 0 && d !== null && d <= 100, 'P18.touch', `push=${p2},mutationsWhileDown=${down},shownAfterLift=${d === null ? 'none' : `${d}ms`}`,
      "with a finger down (moved 50px) a push records 0 mutations in the list; its new label shows on wc-less's card within 100ms of touchend");

    // a still tap on wc-less's card with a push arriving while the finger is down: what the push changed
    // shows only after touchend, and that mustn't swallow the tap's click
    const q = await pg.at(CARD);
    await pg.uncovered(CARD, q);
    await pg.touch('touchStart', [[q.x, q.y]]);
    const tDown = Date.now();
    const p3 = await push();
    await sleep(50); // the page handles the frame (CDP saw it arrive) before the touchend
    const tUp = Date.now();
    await pg.touch('touchEnd', []);
    const nav = await pg.until(`location.hash === ${js(`#/pane/${enc(less)}`)}`, 1000);
    const whileDown = p3 && pg.stateMarkT >= tDown && pg.stateMarkT < tUp;
    result(c, whileDown && !nav.timeout, 'P18.tap', `push=${p3},pushAt=${pg.stateMarkT - tDown}ms,liftAt=${tUp - tDown}ms,nav=${ms(nav)}`,
      "a push arriving while a finger is down on wc-less's card: lifting it (a still tap) opens #/pane/<it> within 1s");
  } finally {
    pg.stateMark = '';
    await pg.ev(`(() => { const l = ${SC}?.firstElementChild; if (l) l.style.paddingBottom = ''; })()`);
    await mobile(pg, true);
    mutate(rec, tab, ['tab', 'rename', tab, 'wc-less']);
    await pg.goto('#/agents');
  }
}

/** M1: an agent's drawer over the list (390x844): a sheet from the bottom, the list's top showing above it, the list the
 *  same node at its scroll under it and back; ✕ closes it, and so does Back, without the history growing. */
async function m1(c: Ctx) {
  const { pg, rec } = c;
  const less = rec.names.less;
  const SC = `document.getElementById('screen-agents')`;
  const CARD = `document.querySelector('.agent-card[data-pane-id=${js(less)}]')`;
  const SHEET = `document.querySelector('.agent-drawer-content')`;
  const pane = js(`#/pane/${enc(less)}`);
  await pg.goto('#/agents');
  await pg.until(`!!${SC}?.dataset.ready && !!${CARD}`, 5000);
  await pg.ev(`(() => { const s = ${SC}; s.firstElementChild.style.paddingBottom = '1500px'; window.__wcSc = s; })()`);
  const cycle = async (close: () => Promise<unknown>) => {
    // scrolled to 60px above the card (or 60px): tapped where it shows (at() would scroll it into view)
    const p = await pg.ev(`(() => { const s = ${SC}, card = ${CARD};
      s.scrollTop = Math.max(60, card.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop - 60);
      const r = card.getBoundingClientRect(), top = Math.max(r.top, s.getBoundingClientRect().top);
      return { x: r.x + r.width / 2, y: (top + r.bottom) / 2 }; })()`);
    await sleep(300);
    await pg.tap(p.x, p.y);
    const open = await pg.until(`location.hash === ${pane} && !!${SHEET}`, 3000);
    await sleep(400); // its slide-in
    const [top0, sheetTop, sheetH] = await pg.ev(`(() => { const r = ${SHEET}.getBoundingClientRect(); return [${SC}.scrollTop, Math.round(r.top), Math.round(r.bottom)]; })()`);
    await close();
    const closed = await pg.until(`location.hash === '#/agents' && !${SHEET}`, 3000);
    const [top1, same, len] = await pg.ev(`[${SC}.scrollTop, ${SC} === window.__wcSc, history.length]`);
    return { open, closed, top0, top1, same, len, sheetTop, sheetH };
  };
  const a = await cycle(() => pg.tapEl(`document.getElementById('btn-drawer-close')`));
  const b = await cycle(() => pg.ev('history.back()')); // the phone's Back
  result(c, !a.open.timeout && !a.closed.timeout && a.sheetTop >= 40 && a.sheetTop <= 60 && a.sheetH === 844 && a.same && Math.abs(a.top1 - a.top0) <= 1,
    'M1.close', `open=${ms(a.open)},sheet=${a.sheetTop}..${a.sheetH},closed=${ms(a.closed)},sameNode=${a.same},scrollTop=${a.top0}->${a.top1}`,
    "scrolled (>= 60px), a tap on wc-less's card opens #/pane/<it> in a sheet from 40-60px to the bottom; ✕ closes it within 3s back to the same #screen-agents at its scrollTop (+-1px)");
  result(c, !b.open.timeout && !b.closed.timeout && b.same && Math.abs(b.top1 - b.top0) <= 1 && b.len === a.len,
    'M1.back', `closed=${ms(b.closed)},sameNode=${b.same},scrollTop=${b.top0}->${b.top1},history=${a.len}->${b.len}`,
    'Back closes it too (the same list, its scrollTop); opening and closing again leaves history.length as it was');
}

/** M3: agents opened one after another (the user's path: a list card, then a notification's navigate, as a sidebar tap
 *  or a [yoicks] notice switches it) keep one drawer: one header, the latest's, in one history entry; one Back closes it. */
async function m3(c: Ctx) {
  const { pg, rec } = c;
  const { less, shell } = rec.names;
  const SHEET = `document.querySelector('.agent-drawer-content')`;
  const HEADS = `document.querySelectorAll('.agent-drawer .agent-drawer-head')`;
  const to = (id: string) => `navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'navigate', url: ${js(`#/pane/${enc(id)}`)} } }))`;
  await pg.goto('#/agents');
  await pg.until(`!!document.querySelector('.agent-card[data-pane-id=${js(less)}]')`, 5000);
  await pg.tapEl(`document.querySelector('.agent-card[data-pane-id=${js(less)}]')`);
  const open = await pg.until(`location.hash === ${js(`#/pane/${enc(less)}`)} && !!${SHEET}`, 3000);
  const len = await pg.ev('history.length');
  for (const id of [shell, less, shell, less]) {
    await pg.ev(to(id));
    await pg.until(`location.hash === ${js(`#/pane/${enc(id)}`)}`, 3000);
    await sleep(300);
  }
  const [heads, title, sheets, len1] = await pg.ev(`[${HEADS}.length, ${HEADS}[0]?.querySelector('.topbar-title')?.textContent ?? '',
    document.querySelectorAll('.agent-drawer-content').length, history.length]`);
  await pg.ev('history.back()');
  const closed = await pg.until(`location.hash === '#/agents' && !${SHEET}`, 3000);
  result(c, !open.timeout && heads === 1 && sheets === 1 && len1 === len && !closed.timeout, 'M3.switch',
    `open=${ms(open)},heads=${heads},sheets=${sheets},title=${JSON.stringify(title)},history=${len}->${len1},closed=${ms(closed)}`,
    "from wc-less's card, 4 switches (wc-shell, wc-less, …) by a notification's navigate leave one drawer with one header and history.length as it was; one Back closes it to #/agents");
}

/** M2: on a PC (1280x844) the drawer comes from the right, min(900px, 65% of the width right of the sidebar) wide, its
 *  dimmed part right of the sidebar; Escape closes the ⋮ menu over it first, then the drawer; a click on the dimmed screen
 *  closes it too. */
async function m2(c: Ctx) {
  const { pg, rec } = c;
  const less = rec.names.less;
  const SHEET = `document.querySelector('.agent-drawer-content')`;
  const MENU = `document.getElementById('btn-agent-menu')`;
  const pane = `#/pane/${enc(less)}`;
  const click = async (x: number, y: number) => {
    for (const type of ['mousePressed', 'mouseReleased']) await pg.S('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const esc = async () => {
    for (const type of ['keyDown', 'keyUp']) await pg.S('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
  };
  await mobile(pg, false);
  try {
    await pg.goto('#/agents');
    await pg.goto(pane);
    const open = await pg.until(`!!${SHEET} && !!${MENU}`, 3000);
    await sleep(400);
    const [left, right, dim, side] = await pg.ev(`(() => { const r = ${SHEET}.getBoundingClientRect();
      return [Math.round(r.left), Math.round(r.right), Math.round(document.querySelector('.agent-drawer-overlay').getBoundingClientRect().left),
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 0]; })()`);
    const want = Math.min(900, (1280 - side) * 0.65);
    result(c, !open.timeout && right === 1280 && Math.abs(1280 - left - want) <= 1 && dim === side, 'M2.wide', `open=${ms(open)},x=${left}..${right},dimFrom=${dim},--sidebar-w=${side}`,
      'from #/agents, #/pane/<wc-less> opens a drawer on the right edge, min(900, 65% of 1280 - --sidebar-w) wide, dimmed from --sidebar-w');
    const m = await pg.at(MENU);
    await click(m.x, m.y);
    const menu = await pg.until(`!!document.querySelector('[data-menu-dropdown]')`, 2000);
    await esc();
    // the menu closes on the key, its dropdown leaves after Mantine's exit transition (150ms; 170-190ms from the key,
    // idle or under load): waited for, not read at a fixed 300ms, which left ~110ms for the renderer's stalls. A menu
    // the Escape missed stays open, so it still fails.
    const gone = await pg.until(`!document.querySelector('[data-menu-dropdown]')`, 2000);
    const stayed = await pg.ev(`location.hash === ${js(pane)} && !!${SHEET}`);
    await esc();
    const closed = await pg.until(`location.hash === '#/agents' && !${SHEET}`, 3000);
    result(c, !menu.timeout && !gone.timeout && stayed && !closed.timeout, 'M2.escape', `menu=${ms(menu)},menuGone=${ms(gone)},drawerStayed=${stayed},closed=${ms(closed)}`,
      "with ⋮'s menu open, Escape closes the menu only (its dropdown gone within 2s); Escape again closes the drawer back to #/agents within 3s");
    await pg.goto(pane);
    await pg.until(`!!${SHEET}`, 3000);
    await sleep(400);
    await click(side + 100, 400);
    const outside = await pg.until(`location.hash === '#/agents' && !${SHEET}`, 3000);
    result(c, !outside.timeout, 'M2.outside', `closed=${ms(outside)}`, 'a click on the dimmed screen left of it (right of the sidebar) closes it back to #/agents within 3s');
  } finally {
    await mobile(pg, true);
  }
}

/** S1: Settings in front of the screen it came from, from the topbar's ⚙ at the screen's top right. Phone (390x844): on
 *  the list (scrolled) it opens over the whole screen; ✕ and Back close it back to the same list node at its scrollTop,
 *  the history as it was. PC (1280, the sidebar beside it): a centered 760px dialog; Escape closes it, and so does a click
 *  outside it. */
async function s1(c: Ctx) {
  const { pg } = c;
  const SC = `document.getElementById('screen-agents')`;
  const SHEET = `document.querySelector('.settings-sheet')`;
  await pg.goto('#/agents');
  await pg.until(`!!${SC}?.dataset.ready`, 5000);
  await pg.ev(`(() => { const s = ${SC}; s.firstElementChild.style.paddingBottom = '1500px'; s.scrollTop = 60; window.__wcSc = s; })()`);
  const corner = (p: { x: number; y: number }, w: number) => p.x >= w - 60 && p.y <= 52; // its center: the topbar's last 44px button
  const gp = await pg.at(`document.getElementById('btn-settings')`);
  const cycle = async (close: () => Promise<unknown>) => {
    await pg.tapEl(`document.getElementById('btn-settings')`);
    const open = await pg.until(`location.hash === '#/settings' && !!${SHEET}`, 3000);
    await sleep(400); // its slide-up
    const [top, bottom, width] = await pg.ev(`(() => { const r = ${SHEET}.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.bottom), Math.round(r.width)]; })()`);
    await close();
    const closed = await pg.until(`location.hash === '#/agents' && !${SHEET}`, 3000);
    const [st, same, len] = await pg.ev(`[${SC}.scrollTop, ${SC} === window.__wcSc, history.length]`);
    return { open, closed, top, bottom, width, st, same, len };
  };
  const a = await cycle(() => pg.tapEl(`document.getElementById('btn-settings-close')`));
  const b = await cycle(() => pg.ev('history.back()'));
  result(c, corner(gp, 390) && !a.open.timeout && a.top === 0 && a.bottom === 844 && a.width === 390 && !a.closed.timeout && a.same && Math.abs(a.st - 60) <= 1,
    'S1.phone', `gear=${Math.round(gp.x)},${Math.round(gp.y)},open=${ms(a.open)},sheet=${a.top}..${a.bottom}x${a.width},closed=${ms(a.closed)},sameNode=${a.same},scrollTop=${a.st}`,
    "the list scrolled 60px: its ⚙ (top right: x>=330, y<=52) opens #/settings over the whole screen (0..844, 390 wide); ✕ closes it within 3s back to the same #screen-agents at 60px");
  result(c, !b.open.timeout && !b.closed.timeout && b.same && Math.abs(b.st - 60) <= 1 && b.len === a.len, 'S1.back', `closed=${ms(b.closed)},sameNode=${b.same},history=${a.len}->${b.len}`,
    'Back closes it too, the list as it was; opening and closing again leaves history.length as it was');
  const click = async (x: number, y: number) => {
    for (const type of ['mousePressed', 'mouseReleased']) await pg.S('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  const esc = async () => { for (const type of ['keyDown', 'keyUp']) await pg.S('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  await mobile(pg, false);
  try {
    await pg.goto('#/agents');
    const gear = `document.querySelector('#topbar #btn-settings')`;
    await pg.until(`!!${gear}`, 3000);
    const g = await pg.at(gear);
    await click(g.x, g.y);
    const open = await pg.until(`location.hash === '#/settings' && !!${SHEET}`, 3000);
    await sleep(400);
    const [left, width] = await pg.ev(`(() => { const r = ${SHEET}.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; })()`);
    await esc();
    const escaped = await pg.until(`location.hash === '#/agents' && !${SHEET}`, 3000);
    await click(g.x, g.y);
    await pg.until(`!!${SHEET}`, 3000);
    await sleep(400);
    await click(100, 800); // outside it (over the sidebar: a modal's backdrop covers it)
    const outside = await pg.until(`location.hash === '#/agents' && !${SHEET}`, 3000);
    result(c, corner(g, 1280) && !open.timeout && width === 760 && Math.abs(left - (1280 - 760) / 2) <= 1 && !escaped.timeout && !outside.timeout, 'S1.wide',
      `gear=${Math.round(g.x)},${Math.round(g.y)},open=${ms(open)},x=${left}+${width},escape=${ms(escaped)},outside=${ms(outside)}`,
      "1280px: the topbar's ⚙ (top right: x>=1220, y<=52) opens a centered 760px dialog; Escape closes it, and so does a click outside it, within 3s each");
  } finally {
    await mobile(pg, true);
  }
}

/** P6: wc-shell's composer (what reaches the shell is a comment line). On a PC Enter sends once and Shift+Enter
 *  inserts a newline; an IME composition survives a state push (a rename of wc-shell's tab, wc- kept): the same
 *  textarea, its value kept, then committed and sent once by Enter. On a phone Enter never sends. */
async function p6(c: Ctx) {
  const { pg, rec } = c;
  const shell = rec.names.shell;
  const tab = herdr(['pane', 'get', shell]).pane.tab_id;
  const TA = `document.getElementById('pane-input')`;
  const DESKTOP = `matchMedia('(hover: hover) and (pointer: fine)').matches`;
  const enter = async (modifiers = 0) => {
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers };
    await pg.S('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...k });
    await pg.S('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
  };
  /** empties the composer, then types text into it */
  const type = async (text: string) => { await pg.ev(`(() => { const t = ${TA}; t.value = ''; t.focus(); return 1; })()`); await pg.S('Input.insertText', { text }); };
  /** the bodies of the POST /input this pane got from t on, after a second */
  const sent = async (t: number) => { await sleep(1000); return pg.posts(t, `/api/panes/${enc(shell)}/input`).map((q) => q.body); };
  try {
    await mobile(pg, false);
    await loadApp(c, `#/pane/${enc(shell)}`); // a new document: a PC's pointer (openPage)
    if ((await pg.until(`!!${TA}`, 5000)).timeout) throw new Error('no #pane-input');
    const desk = await pg.ev(DESKTOP);
    guard(rec, shell);
    await type('# wc-p6-enter');
    let t = Date.now();
    await enter();
    const e1 = await sent(t);
    await type('# wc-p6-shift');
    t = Date.now();
    await enter(8); // Shift
    const s1 = await sent(t);
    const nl: string = await pg.ev(`${TA}.value`);

    await type('# ');
    await pg.S('Input.imeSetComposition', { text: 'にほんご', selectionStart: 4, selectionEnd: 4 });
    const v0: string = await pg.ev(`window.__wcTa = ${TA}, ${TA}.value`);
    const label = `wc-shell-${Date.now() % 100000}`;
    pg.stateMark = js(label);
    pg.stateMarkT = 0;
    mutate(rec, tab, ['tab', 'rename', tab, label]);
    const pushed = !(await waitFn(() => pg.stateMarkT > 0, 5000, 5)).timeout;
    await sleep(300);
    const [same, v1]: [boolean, string] = await pg.ev(`[${TA} === window.__wcTa, ${TA}.value]`);
    await pg.S('Input.insertText', { text: 'にほんご' }); // commits the composition
    const v2: string = await pg.ev(`${TA}.value`);
    t = Date.now();
    await enter();
    const i1 = await sent(t);

    await mobile(pg, true);
    const touch = await pg.ev(DESKTOP);
    await type('# wc-p6-touch');
    t = Date.now();
    await enter();
    const t1 = await sent(t);
    result(c, desk && js(e1) === js([{ text: '# wc-p6-enter', enter: true }]) && s1.length === 0 && nl === '# wc-p6-shift\n' &&
      pushed && same && v0 === '# にほんご' && v1 === v0 && v2 === v0 && js(i1) === js([{ text: '# にほんご', enter: true }]) && !touch && t1.length === 0,
      'P6', `pc=${desk},enter=${js(e1)},shiftEnter=${s1.length}:${js(nl)},ime:push=${pushed},sameNode=${same},value=${js(v0)}->${js(v1)}->${js(v2)},enter=${js(i1)},` +
        `phone=${!touch},enter=${t1.length}`,
      "PC: Enter -> exactly 1 POST /input {text, enter:true}; Shift+Enter -> 0 and a '\\n'; mid-IME a state push keeps the textarea (===) and its value, " +
        'insertText commits, Enter -> exactly 1 POST {text, enter:true}; phone: Enter -> 0 POSTs');
  } finally {
    pg.stateMark = '';
    await mobile(pg, true);
    mutate(rec, tab, ['tab', 'rename', tab, 'wc-shell']);
    await pg.goto('#/agents');
  }
}

/** W1: the PC sidebar. On a PC (1280px): #sidebar left of the topbar and #screen, --sidebar-w its
 *  width; a heading per orchestrator, in /api/state's order, over its account's agents, then Other with
 *  the agents no account has (when there are any); clicking wc-less there opens #/pane/<it> and marks it.
 *  Down to a phone's width the sidebar goes, and #screen stays the same element. */
async function w1(c: Ctx) {
  const { pg } = c;
  const less = c.rec.names.less;
  const row = `document.querySelector('#sidebar [data-sidebar-pane=${js(less)}]')`;
  try {
    await mobile(pg, false);
    await loadApp(c, '#/agents'); // a new document: a PC's pointer
    let groups = '';
    const g = await waitFn(async () => {
      const st = await api(c, 'GET', '/api/state');
      const orch: any[] = st.orchestrators;
      const agents = allPanes(st).filter((p) => p.agent && !orch.some((o) => o.paneId === p.paneId)).map((p) => p.paneId as string);
      const want: Array<[string, string[]]> = orch.map((o) => [o.name, agents.filter((id) => o.agents?.includes(id)).sort()]);
      const other = agents.filter((id) => !orch.some((o) => o.agents?.includes(id))).sort();
      if (other.length) want.push(['', other]);
      const dom = await pg.ev(`[...document.querySelectorAll('#sidebar section.sidebar-group')].map((s) =>
        [s.dataset.home, [...s.querySelectorAll('[data-sidebar-pane]')].map((e) => e.dataset.sidebarPane).sort()])`);
      groups = `${want.length}/${dom.length}`;
      return js(dom) === js(want);
    }, 5000, 300);
    const geo = await pg.ev(`(() => { const x = (id) => Math.round(document.getElementById(id).getBoundingClientRect().x);
      return { w: Math.round(document.getElementById('sidebar').getBoundingClientRect().width), topbar: x('topbar'), screen: x('screen'),
        v: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim() }; })()`);
    const screen = await pg.ev(`window.__wcScreen = document.getElementById('screen'), 1`);
    const p = await pg.at(row);
    for (const type of ['mousePressed', 'mouseReleased']) await pg.S('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    const open = await pg.until(`location.hash === ${js(`#/pane/${enc(less)}`)} && ${row}?.getAttribute('aria-current') === 'page'`, 2000);
    await mobile(pg, true);
    const gone = await pg.until(`!document.getElementById('sidebar') && document.getElementById('screen') === window.__wcScreen`, 2000);
    result(c, !g.timeout && geo.w === 300 && geo.topbar === 300 && geo.screen === 300 && geo.v === '300px' && screen === 1 && !open.timeout && !gone.timeout, 'W1',
      `groups=${groups}:${g.timeout ? 'mismatch' : 'ok'},width=${geo.w},topbarX=${geo.topbar},screenX=${geo.screen},--sidebar-w=${geo.v},open=${ms(open)},phone=${ms(gone)}`,
      "1280px: #sidebar 300px left of #topbar and #screen (--sidebar-w 300px); its groups = /api/state's orchestrators (each its account's agents) + Other; " +
        "clicking wc-less there opens #/pane/<it> marked within 2s; at 390px no #sidebar and the same #screen within 2s");
  } finally {
    await mobile(pg, true);
    await loadApp(c, '#/agents'); // a phone's document again
  }
}

/** P19: wc-shell's quick keys: Esc POSTs exactly {keys:['esc']}, 1 exactly {text:'1'}. */
async function p19(c: Ctx) {
  const { pg, rec } = c;
  const shell = rec.names.shell;
  await pg.goto(`#/pane/${enc(shell)}`);
  if ((await pg.until(`document.querySelectorAll('.qkey').length === 12`, 5000)).timeout) throw new Error('no 12 .qkey');
  guard(rec, shell);
  let ok = true;
  const got: string[] = [];
  for (const [label, want] of [['Esc', { keys: ['esc'] }], ['1', { text: '1' }]] as const) {
    const p = await pg.at(`[...document.querySelectorAll('.qkey')].find((b) => b.textContent === ${js(label)})`);
    const t = Date.now();
    await pg.tap(p.x, p.y);
    await sleep(1000);
    const bodies = pg.posts(t, `/api/panes/${enc(shell)}/input`).map((q) => q.body);
    ok &&= bodies.length === 1 && js(bodies[0]) === js(want);
    got.push(`${label}=${js(bodies)}`);
  }
  result(c, ok, 'P19', got.join(','), "on wc-shell: Esc -> exactly 1 POST /input {keys:['esc']}; 1 -> exactly 1 {text:'1'}");
  await pg.goto('#/agents');
}

// ── the headless orchestrators: wc-h1 on the fake claude (H1-H8), the real wc-h2 (H-T2) ──

const hlView = async (c: Ctx, name: string): Promise<any> => (await api(c, 'GET', '/api/state')).orchestrators.find((o: any) => o.name === name);
const hlStatus = async (c: Ctx, name: string): Promise<string | undefined> => (await hlView(c, name))?.headless?.status;
const hlTranscript = (c: Ctx, name: string): Promise<any> => api(c, 'GET', `/api/panes/${enc(`hl:${name}`)}/transcript`);
const CHAT = `(document.getElementById('chat-log')?.textContent ?? '')`;

/** Where its transcript ends now, for hlItemsSince: the bridge serves only the tail (300 items) whole. */
async function hlMark(c: Ctx, name: string): Promise<{ session?: string; cursor: number }> {
  const t = await hlTranscript(c, name);
  return { session: t.available ? t.sessionId : undefined, cursor: t.cursor ?? 0 };
}

/** Its transcript's items past `mark` (all of the tail when its session changed or had none yet). */
async function hlItemsSince(c: Ctx, name: string, mark: { session?: string; cursor: number }): Promise<any[]> {
  const q = mark.session ? `?session=${enc(mark.session)}&after=${mark.cursor}` : '';
  return (await api(c, 'GET', `/api/panes/${enc(`hl:${name}`)}/transcript${q}`)).items ?? [];
}

const H_HINT = 'preview start --fake-claude DIR/claude (go build -o DIR/claude ./tools/fakeclaude), with $WC_ROOT/.envrc for wc-h2';

/** `name` runs (started when it isn't), recorded so that the run's teardown stops it. */
async function hlUp(c: Ctx, name: string): Promise<void> {
  const o = await hlView(c, name);
  if (!o) throw env(`no ${name} on this preview: ${H_HINT}`);
  c.rec.names[name] = `hl:${name}`;
  save(c.rec);
  if (!o.paneId) await api(c, 'POST', `/api/orchestrators/${name}/start`);
  if ((await waitFn(async () => ['idle', 'done'].includes((await hlStatus(c, name)) ?? ''), 30_000, 200)).timeout) throw env(`${name} not running`);
}

/** Its running Home on screen, its chat loaded (a baseline taken now is the transcript's). */
async function hlHome(c: Ctx, name: string): Promise<void> {
  await hlUp(c, name);
  await c.pg.goto(`#/home/${name}`);
  if ((await c.pg.until(`document.getElementById('chat-log')?.children.length > 0 && !!document.getElementById('pane-input')`, 5000)).timeout) throw env(`${name}'s running Home not shown`);
}

/** Types `text` into the Home's composer and taps Send. */
async function compose(c: Ctx, text: string): Promise<number> {
  await c.pg.ev(`(() => { const t = document.getElementById('pane-input'); t.value = ${js(text)}; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  return c.pg.tapEl(`document.getElementById('btn-send-enter')`);
}

/** H1: its stopped Home's Start runs it. A fresh session first (Clear, then Stop): each run's alerts go out again. */
async function h1(c: Ctx) {
  const { pg } = c;
  await hlUp(c, 'wc-h1');
  await api(c, 'POST', '/api/orchestrators/wc-h1/clear');
  await api(c, 'POST', '/api/orchestrators/wc-h1/stop');
  await pg.goto('#/home/wc-h1');
  const stopped = await pg.until(`!!document.querySelector('#screen-home-stopped #btn-home-start')`, 3000);
  const t0 = await pg.tapEl(`document.getElementById('btn-home-start')`);
  const idle = await waitFn(async () => (await hlStatus(c, 'wc-h1')) === 'idle', 5000, 100);
  const home = await pg.until(`!!document.getElementById('chat-log') && ${CHAT} === 'No messages yet.'`, 3000);
  result(c, !stopped.timeout && !idle.timeout && !home.timeout, 'H1', `stopped=${ms(stopped)},idle=${idle.timeout ? 'timeout' : `${Date.now() - t0}ms`},home=${ms(home)}`,
    "wc-h1's stopped Home: Start -> idle within 5s (/api/state), then its running Home with an empty chat (a fresh session)");
}

/** H6: the version it runs isn't the verified one: a warning line that offers the way back to the TUI. */
async function h6(c: Ctx) {
  const { pg } = c;
  await hlHome(c, 'wc-h1');
  const row = `document.querySelector('.home-warning[data-kind="version"]')`;
  const r = await pg.until(`${row}?.textContent.includes('0.0.0-webcheck') && !!${row}.querySelector('[data-action="tui"]')`, 3000);
  result(c, !r.timeout, 'H6', `warning=${ms(r)}`, "Claude Code 0.0.0-webcheck: a version warning line on wc-h1's Home within 3s, with 'Back to TUI'");
}

/** H2: a message from the Home: working, then done (finishing on another screen), its reply in the chat; seen there, idle. */
async function h2(c: Ctx) {
  const { pg } = c;
  await hlHome(c, 'wc-h1');
  const n0 = await pg.ev(`document.querySelectorAll('#chat-log .chat-assistant').length`);
  await compose(c, 'slow 3');
  const working = await waitFn(async () => (await hlStatus(c, 'wc-h1')) === 'working', 3000, 100);
  await pg.goto('#/agents'); // finishing while another screen is shown
  const done = await waitFn(async () => (await hlStatus(c, 'wc-h1')) === 'done', 10_000, 200);
  await pg.goto('#/home/wc-h1');
  const reply = await pg.until(`document.querySelectorAll('#chat-log .chat-assistant').length > ${n0} && ${CHAT}.includes('echo: slow 3')`, 5000);
  const dot = `document.querySelector('.home-switch-btn[data-orch="wc-h1"] .status-dot')?.dataset.status`;
  const seen = await pg.until(`${dot} === 'idle'`, 3000);
  const api0 = await hlStatus(c, 'wc-h1');
  result(c, !working.timeout && !done.timeout && !reply.timeout && !seen.timeout && api0 === 'done', 'H2',
    `working=${ms(working)},done=${ms(done)},reply=${ms(reply)},dot=${seen.v ? 'idle' : await pg.ev(dot)},api=${api0}`,
    "Send 'slow 3' on wc-h1's Home: working within 3s, done within 10s (on #/agents); back on its Home the reply, and its switcher dot idle (seen) while /api/state still says done");
}

/** H3: its question in the answer panel: a tap answers it (the fake's tool_result has the answer); the old id is 409. */
async function h3(c: Ctx) {
  const { pg } = c;
  await hlHome(c, 'wc-h1');
  const mark = await hlMark(c, 'wc-h1'); // a resumed session may hold an earlier answer: one past here
  await compose(c, 'ask');
  const panel = await pg.until(`[...document.querySelectorAll('#headless-prompt .ask-opt:not(.ask-extra)')].map((b) => b.textContent).join('|') === '1applered|2cherry'`, 5000);
  const id = (await hlView(c, 'wc-h1'))?.headless?.pending?.id;
  await pg.tapEl(`document.querySelectorAll('#headless-prompt .ask-opt:not(.ask-extra)')[1]`);
  const answered = await waitFn(async () => (await hlItemsSince(c, 'wc-h1', mark)).some((i: any) => i.kind === 'tool_result' && i.text.includes('"Which fruit?":"cherry"')), 5000, 200);
  const gone = await pg.until(`!document.getElementById('headless-prompt')`, 3000);
  let stale = 0;
  await api(c, 'POST', '/api/orchestrators/wc-h1/answer', { id: id ?? 'none', answers: { 'Which fruit?': 'apple' } }).catch((e) => { stale = /: 409 /.test(e.message) ? 409 : -1; });
  result(c, !panel.timeout && !answered.timeout && !gone.timeout && stale === 409, 'H3', `panel=${ms(panel)},answer=${ms(answered)},gone=${ms(gone)},oldId=${stale}`,
    "'ask': the panel shows apple/cherry within 5s; tapping cherry puts {\"Which fruit?\":\"cherry\"} in the fake's tool_result within 5s and the panel goes; the old id answers 409");
}

/** H4: ■ while it works ends the turn within 2s. */
async function h4(c: Ctx) {
  const { pg } = c;
  await hlHome(c, 'wc-h1');
  await compose(c, 'slow 30');
  const btn = await pg.until(`!!document.getElementById('btn-home-interrupt')`, 5000);
  const t0 = await pg.tapEl(`document.getElementById('btn-home-interrupt')`);
  const out = await waitFn(async () => (await hlStatus(c, 'wc-h1')) !== 'working', 2000, 50);
  result(c, !btn.timeout && !out.timeout, 'H4', `button=${ms(btn)},left=${out.timeout ? 'timeout' : `${Date.now() - t0}ms`}`, "'slow 30': ■ on the doing-now line; its tap leaves working within 2s (/api/state)");
}

/** H5: messages sent while it works all arrive, in order, each its own user bubble and reply. */
async function h5(c: Ctx) {
  const { pg } = c;
  await hlHome(c, 'wc-h1');
  const tag = `wc-h5-${Date.now() % 100000}`;
  const mark = await hlMark(c, 'wc-h1');
  await compose(c, 'slow 2');
  if ((await waitFn(async () => (await hlStatus(c, 'wc-h1')) === 'working', 3000, 100)).timeout) throw env('wc-h1 not working');
  await compose(c, `${tag}-a`);
  await compose(c, `${tag}-b`);
  const replies = await waitFn(async () => {
    const items = await hlItemsSince(c, 'wc-h1', mark);
    const said = items.filter((i: any) => i.kind === 'user' && i.text.startsWith(tag)).map((i: any) => i.text);
    const echoed = items.filter((i: any) => i.kind === 'assistant' && i.text.startsWith(`echo: ${tag}`)).map((i: any) => i.text);
    return said.join() === `${tag}-a,${tag}-b` && echoed.join() === `echo: ${tag}-a,echo: ${tag}-b`;
  }, 10_000, 300);
  const bubbles = await pg.until(`[...document.querySelectorAll('#chat-log .chat-user')].map((e) => e.textContent.trim()).filter((t) => t.startsWith(${js(tag)})).join() === ${js(`${tag}-a,${tag}-b`)}`, 3000);
  result(c, !replies.timeout && !bubbles.timeout, 'H5', `transcript=${ms(replies)},bubbles=${ms(bubbles)}`,
    "two messages sent during 'slow 2': both user items and both replies, in order, within 10s; two user bubbles in that order on the Home");
}

/** H8: lines it can't read: a stream_broken warning with the way back to the TUI, which opens in place. */
async function h8(c: Ctx) {
  const { pg } = c;
  await hlHome(c, 'wc-h1');
  await compose(c, 'garbage 3');
  const row = `document.querySelector('.home-warning[data-kind="stream_broken"]')`;
  const warn = await pg.until(`!!${row}?.querySelector('[data-action="tui"]')`, 5000);
  let steps = { v: false, timeout: true, ms: 0 };
  if (!warn.timeout) {
    await pg.tapEl(`${row}.querySelector('[data-action="tui"]')`);
    steps = await pg.until(`(document.querySelector('.home-warnings .tui-steps')?.textContent ?? '').includes('"wc-h1"')`, 2000);
  }
  result(c, !warn.timeout && !steps.timeout, 'H8', `warning=${ms(warn)},steps=${ms(steps)}`,
    "'garbage 3': a stream_broken warning line within 5s; its 'Back to TUI' shows the steps naming wc-h1");
}

/** H7: the preview restarts: wc-h1 comes back on the same session, its chat still there. */
async function h7(c: Ctx) {
  const { pg } = c;
  if (!c.preview) throw env('no preview record: H7 restarts the preview');
  await hlHome(c, 'wc-h1');
  const tag = `wc-h7-${Date.now() % 100000}`;
  await compose(c, tag);
  if ((await pg.until(`${CHAT}.includes(${js(`echo: ${tag}`)})`, 5000)).timeout) throw env(`no reply to ${tag}`);
  const before = (await hlTranscript(c, 'wc-h1')).sessionId;
  await previewCtl(c.preview, 'stop');
  await previewCtl(c.preview, 'start');
  const back = await waitFn(async () => ['idle', 'done'].includes((await hlStatus(c, 'wc-h1')) ?? ''), 10_000, 300);
  const after = (await hlTranscript(c, 'wc-h1')).sessionId;
  const chat = await pg.until(`${CHAT}.includes(${js(`echo: ${tag}`)}) && document.getElementById('conn-dot').classList.contains('connected')`, 20_000, 300);
  result(c, !back.timeout && !!before && before === after && !chat.timeout, 'H7', `back=${ms(back)},session=${before === after ? 'same' : `${before}->${after}`},chat=${ms(chat)}`,
    'preview stop + start: wc-h1 running again within 10s on the same session id; the page reconnects and its chat still has the earlier reply within 20s');
}

/** H-T2: the real wc-h2 (haiku, no yoicks tools): a reply, a question answered, ■, a message sent while it works, Clear. */
async function ht2(c: Ctx) {
  const { pg } = c;
  if (!(await hlView(c, 'wc-h2'))) throw env(`no wc-h2 on this preview: ${H_HINT}`);
  // it answers on haiku: its dir's local settings (the bridge writes only settings.json there), read at its start
  const local = path.join(WC_ROOT, 'data', 'herdr-yoicks', 'orchestrators', 'wc-h2', '.claude', 'settings.local.json');
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(local, 'utf8')); } catch { /* none yet */ }
  if (settings.model !== 'haiku') {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, js({ ...settings, model: 'haiku' }));
    if ((await hlView(c, 'wc-h2'))?.paneId) await api(c, 'POST', '/api/orchestrators/wc-h2/stop'); // started before it: again
  }
  await hlHome(c, 'wc-h2');
  const status = (s: string[], wait: number) => waitFn(async () => s.includes((await hlStatus(c, 'wc-h2')) ?? ''), wait, 300);
  const out: string[] = [];
  let ok = true;
  const step = (name: string, pass: boolean, v: string) => { out.push(`${name}=${v}`); ok &&= pass; };

  // a resumed session may have said OK before: one more
  const oks = `[...document.querySelectorAll('#chat-log .chat-assistant')].filter((e) => e.textContent.trim() === 'OK').length`;
  const ok0 = await pg.ev(oks);
  await compose(c, OK_PROMPT);
  const okReply = await pg.until(`${oks} > ${ok0}`, 60_000, 300);
  const okDone = await status(['done', 'idle'], 30_000);
  step('ok', !okDone.timeout && !okReply.timeout, `${ms(okReply)}/${ms(okDone)}`);
  // only haiku from here on (the weekly quota): the session's file says which model answered
  const sid = (await hlTranscript(c, 'wc-h2')).sessionId;
  const root = path.join(pinnedAccount() || path.join(os.homedir(), '.claude'), 'projects');
  const file = fs.readdirSync(root).map((d) => path.join(root, d, `${sid}.jsonl`)).find((f) => fs.existsSync(f));
  // the model of its last assistant line, this OK (other lines name the account's default model too)
  const model = file && fs.readFileSync(file, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((l) => l?.type === 'assistant').at(-1)?.message?.model;
  if (!model?.includes('haiku')) throw env(`wc-h2 answered on ${model ?? 'an unknown model'}, not haiku: stopped here`);

  await compose(c, ASK_PROMPT);
  const panel = await pg.until(`document.querySelectorAll('#headless-prompt .ask-opt:not(.ask-extra)').length === 3`, 60_000, 300);
  if (!panel.timeout) await pg.tapEl(`[...document.querySelectorAll('#headless-prompt .ask-opt:not(.ask-extra)')].find((b) => /cherry/.test(b.textContent))`);
  const asked = await status(['done', 'idle'], 60_000);
  step('ask', !panel.timeout && !asked.timeout && !(await hlView(c, 'wc-h2'))?.headless?.pending, `${ms(panel)}/${ms(asked)}`);

  const LONG = 'Write the numbers from 1 to 300, one per line, and nothing else.';
  const mark = await hlMark(c, 'wc-h2');
  await compose(c, LONG);
  const busy = await status(['working'], 15_000);
  // sent while it works: queued until the turn ends (no tool call to take it in at), which ■ brings
  const mid = `wc-mid-${Date.now() % 100000}: reply with exactly the word MID and nothing else.`;
  await compose(c, mid);
  await sleep(1000);
  const still = (await hlStatus(c, 'wc-h2')) === 'working';
  const t0 = await pg.tapEl(`document.getElementById('btn-home-interrupt')`).catch(() => 0);
  const bubble = await pg.until(`[...document.querySelectorAll('#chat-log .chat-user')].some((e) => e.textContent.includes(${js(mid.slice(0, 14))}))`, 60_000, 300);
  const cut = await waitFn(async () => (await hlItemsSince(c, 'wc-h2', mark)).some((i: any) => i.kind === 'assistant' && i.text.trim() === 'MID'), 60_000, 500);
  step('midTurn', !busy.timeout && still && !!t0 && !bubble.timeout && !cut.timeout, `${ms(busy)}/working=${still}/${ms(bubble)}/${ms(cut)}`);
  await status(['done', 'idle'], 60_000);

  await pg.tapEl(`document.getElementById('btn-home-clear')`);
  await pg.until(`!!document.querySelector('#modal-root #cf-ok')`, 3000); // Mantine's modal mounts through a transition
  await pg.tapEl(`document.querySelector('#modal-root #cf-ok')`);
  const cleared = await pg.until(`${CHAT} === 'No messages yet.'`, 15_000, 300);
  const fresh = (await hlTranscript(c, 'wc-h2')).sessionId;
  step('clear', !cleared.timeout && fresh !== sid, `${ms(cleared)}/${fresh === sid ? 'same-session' : 'new'}`);
  result(c, ok, 'H-T2', out.join(','),
    "wc-h2 (haiku): 'OK' answered; the question answered from the panel; a message sent while it works (still working 1s later), then ■: its user bubble and the reply MID; Clear empties the chat on a new session");
}

// ── Tier 2 items (real Claude in wc-claude; wc-o1/wc-o2 are only started, cleared, stopped) ──

async function sendPrompt(c: Ctx, pane: string, text: string) {
  guard(c.rec, pane);
  await api(c, 'POST', `/api/panes/${enc(pane)}/input`, { text, enter: true, clear: true });
}
const statusFrame = (c: Ctx, pane: string, to: string, t: number, ms: number) =>
  waitFn(() => c.pg.wsRecv.some((f) => f.t >= t && f.msg.type === 'agent_status' && f.msg.paneId === pane && f.msg.to === to), ms, 200);
const ms = (r: { ms: number; timeout: boolean }) => (r.timeout ? 'timeout' : `${r.ms}ms`);

async function p4t2(c: Ctx) {
  const { pg } = c;
  const cl = c.rec.names.claude;
  await pg.ev(`localStorage.setItem('herdr_notifications', 'true')`);
  await pg.goto('#/agents');
  const other = await pg.cdp.send('Target.createTarget', { url: 'about:blank' });
  await pg.cdp.send('Target.activateTarget', { targetId: other.targetId });
  try {
    const hidden = await pg.until('document.hidden', 3000);
    if (hidden.timeout) throw env('could not hide the page');
    const t0 = Date.now();
    await sendPrompt(c, cl, OK_PROMPT);
    const w = await statusFrame(c, cl, 'working', t0, 15_000);
    const d = await statusFrame(c, cl, 'done', t0, 90_000);
    const n = await pg.until(`${notifsJs}.then((t) => t.length === 1 && t[0] === ${js(cl)})`, 10_000, 200);
    await pg.cdp.send('Target.activateTarget', { targetId: pg.targetId });
    await pg.goto(`#/pane/${enc(cl)}`);
    const z = await pg.until(`${notifsJs}.then((t) => t.length === 0)`, 2000);
    result(c, !w.timeout && !d.timeout && !n.timeout && !z.timeout, 'P4-T2', `working=${ms(w)},done=${ms(d)},notif=${ms(n)},cleared=${ms(z)}`,
      'hidden page: wc-claude done -> 1 OS notification tagged with its pane id within 10s; opening the pane clears it within 2s');
  } finally {
    await pg.cdp.send('Target.activateTarget', { targetId: pg.targetId });
    await pg.cdp.send('Target.closeTarget', { targetId: other.targetId }).catch(() => {});
  }
}

async function p17t2(c: Ctx) {
  const cl = c.rec.names.claude;
  if ((await paneOf(c, cl))?.agent?.status !== 'done') {
    const t0 = Date.now();
    await sendPrompt(c, cl, OK_PROMPT);
    if ((await statusFrame(c, cl, 'done', t0, 90_000)).timeout) throw new Error('wc-claude never done');
  }
  await c.pg.goto('#/agents');
  await c.pg.goto(`#/pane/${enc(cl)}`);
  const seq = (await paneOf(c, cl))?.agent?.completionSeq;
  const r = await c.pg.until(`JSON.parse(localStorage.getItem('herdr_seen_done') || '{}')[${js(cl)}] === ${js(seq)}`, 3000);
  result(c, seq != null && !r.timeout, 'P17-T2', `completionSeq=${seq},seen=${ms(r)}`, 'opening a done wc-claude records herdr_seen_done[pane] = its completionSeq');
}

async function p9(c: Ctx) {
  const { pg } = c;
  const cl = c.rec.names.claude;
  const t0 = Date.now();
  await sendPrompt(c, cl, ASK_PROMPT);
  const b = await statusFrame(c, cl, 'blocked', t0, 90_000);
  await pg.goto(`#/pane/${enc(cl)}`);
  const panel = await pg.until(`document.querySelectorAll('#chat-prompt .ask-opt').length >= 3`, 3000);
  // Claude Code appends its own options (type something, chat about this) after the 3 asked for
  const labels: string[] = await pg.ev(`[...document.querySelectorAll('#chat-prompt .ask-opt')].map((b) => (b.querySelector('.ask-opt-label') ?? b).textContent.trim())`);
  const asked = ['apple', 'banana', 'cherry'].every((f, i) => (labels[i] ?? '').toLowerCase().includes(f));
  guard(c.rec, cl);
  const opt = await pg.at(`document.querySelectorAll('#chat-prompt .ask-opt')[1]`);
  const tt = Date.now();
  await pg.tap(opt.x, opt.y);
  await sleep(100);
  await pg.tap(opt.x, opt.y);
  await sleep(1500);
  const posts = pg.posts(tt, `/api/panes/${enc(cl)}/input`).map((q) => q.body);
  const unb = await waitFn(async () => (await paneOf(c, cl))?.agent?.status !== 'blocked', 10_000, 300);
  const sent = posts.map((p) => `{press:${p.press},expect_prompt:${p.expect_prompt ? `${String(p.expect_prompt).length}chars` : 'none'}}`);
  result(c, !b.timeout && !panel.timeout && asked && posts.length === 1 && posts[0].press === '2' && !!posts[0].expect_prompt && !unb.timeout,
    'P9', `blocked=${ms(b)},options=${labels.length}[${labels.join('|')}],posts=${sent.join('+') || 0},unblocked=${ms(unb)}`,
    "panel within 3s, options 1-3 = apple/banana/cherry (Claude adds its own after); option 2 tapped twice in 200ms -> exactly one POST {press:'2', expect_prompt}; unblocked within 10s");
}

/** wc-claude's transcript, for the chat items: a fresh wc-claude has none until a turn, so one goes first (P4-T2's prompt). */
async function ensureTranscript(c: Ctx): Promise<void> {
  const cl = c.rec.names.claude;
  const has = async () => (await api(c, 'GET', `/api/panes/${enc(cl)}/transcript`)).available === true;
  if (await has()) return;
  const t0 = Date.now();
  await sendPrompt(c, cl, OK_PROMPT);
  if ((await statusFrame(c, cl, 'done', t0, 90_000)).timeout) throw new Error('wc-claude never done');
  if ((await waitFn(has, 10_000, 300)).timeout) throw new Error('wc-claude has no transcript after a turn');
}

async function p11(c: Ctx) {
  const { pg } = c;
  const cl = c.rec.names.claude;
  await ensureTranscript(c);
  await pg.goto('#/agents');
  await pg.goto(`#/pane/${enc(cl)}`); // a Claude pane opens on its chat
  const shown = await pg.until(`(() => { const l = document.getElementById('chat-log'); return !!l && l.style.display !== 'none' && l.querySelectorAll('.chat-item').length; })()`, 5000);
  const users0 = await pg.ev(`window.__wcFirst = document.querySelector('#chat-log .chat-item'), document.querySelectorAll('#chat-log .chat-user').length`);
  // a pane's chat is read-only (its composer is the terminal's): the message goes in through the API
  const readOnly = await pg.ev(`document.getElementById('pane-input').closest('.input-bar').style.display === 'none'`);
  await sendPrompt(c, cl, NOTE_PROMPT);
  const user = await pg.until(`document.querySelectorAll('#chat-log .chat-user').length === ${users0 + 1}`, 10_000, 200);
  const same = await pg.ev(`document.querySelector('#chat-log .chat-item') === window.__wcFirst`);
  const det = await pg.until(`document.querySelectorAll('#chat-log details.chat-result').length`, 90_000, 300);
  const [items0, top0] = await pg.ev(`(() => { const d = [...document.querySelectorAll('#chat-log details.chat-result')].pop(); d.open = true; window.__wcDet = d;
    const l = document.getElementById('chat-log'); l.scrollTop = l.scrollHeight - l.clientHeight - 200; return [l.querySelectorAll('.chat-item').length, l.scrollTop]; })()`);
  const app = await pg.until(`document.querySelectorAll('#chat-log .chat-item').length > ${items0}`, 90_000, 200);
  const [open, top1] = await pg.ev(`[window.__wcDet.open && document.contains(window.__wcDet), document.getElementById('chat-log').scrollTop]`);
  // the view toggle is Chat | Term: a tap on each segment, checked by what the drawer shows
  const shows = (id: string) => `document.querySelector('.agent-drawer #${id}')?.style.display !== 'none'`;
  await pg.tapEl(`document.querySelector('#btn-view-toggle [data-mode="terminal"]')`);
  const term = await pg.until(`${shows('terminal-output')} && !(${shows('chat-log')})`, 2000);
  await pg.tapEl(`document.querySelector('#btn-view-toggle [data-mode="chat"]')`);
  const chat = await pg.until(`${shows('chat-log')} && !(${shows('terminal-output')})`, 2000);
  result(c, !shown.timeout && readOnly && !user.timeout && same && !det.timeout && !app.timeout && open && Math.abs(top1 - top0) <= 1 && !term.timeout && !chat.timeout,
    'P11', `chat=${ms(shown)},readOnly=${readOnly},userAdded=${ms(user)},firstNodeKept=${same},result=${ms(det)},append=${ms(app)},detailsOpen=${open},scrollDelta=${top1 - top0},toggle=${!term.timeout && !chat.timeout}`,
    'chat within 5s, no composer in it; a message adds 1 .chat-user, first node kept; an open tool result stays open and scrollTop holds (+-1px) across an append; the view toggle switches to the terminal and back');
}

/** P10-T2: from wc-claude in chat, straight to #/pane/<wc-shell> (no transcript): its server watch is the terminal's,
 *  so with the socket up (no polling) a line wc-shell prints reaches #term-live within 3s. */
async function p10t2(c: Ctx) {
  const { pg, rec } = c;
  const { claude: cl, shell } = rec.names;
  await ensureTranscript(c);
  await pg.goto('#/agents');
  await pg.goto(`#/pane/${enc(cl)}`);
  const chat = await pg.until(`(() => { const l = document.getElementById('chat-log'); return !!l && l.style.display !== 'none'; })()`, 5000);
  if (chat.timeout) throw new Error('wc-claude not shown in chat');
  const t0 = Date.now();
  await pg.ev(`location.hash = ${js(`#/pane/${enc(shell)}`)}`);
  if ((await pg.until(`document.getElementById('term-live')?.textContent.includes('wc-A')`, 5000)).timeout) throw new Error("wc-shell's screen not shown");
  await sleep(1000);
  const watch = pg.wsSent.filter((f) => f.t >= t0 && /"type":"(un)?watch_/.test(f.payload)).map((f) => JSON.parse(f.payload).type);
  const connected = await pg.ev(`document.getElementById('conn-dot').classList.contains('connected')`);
  const mark = `wc-live-${Date.now() % 100000}`;
  mutate(rec, shell, ['pane', 'run', shell, `# ${mark}`]);
  const live = await pg.until(`document.getElementById('term-live').textContent.includes(${js(mark)})`, 3000);
  result(c, connected && !live.timeout, 'P10-T2', `connected=${connected},watchesSent=${watch.join('+') || 'none'},marker=${ms(live)}`,
    "from wc-claude's chat to #/pane/<wc-shell>: a line wc-shell prints shows in #term-live within 3s (the socket up, so no polling)");
  await pg.goto('#/agents');
}

/** Clears an orchestrator from its Home. stayed: #/home/<name> held from the clear request through 8s and
 *  through the wait for the replacement (ready, in the pinned account), however long that took. */
/** Clears an orchestrator through the API, or (viaHome) with its Home's Clear button and the confirm. */
async function clearOrch(c: Ctx, name: string, viaHome = false): Promise<{ fresh: string; stayed: boolean }> {
  const old = c.rec.names[name.slice(3)];
  guard(c.rec, old);
  const hash = `#/home/${name}`;
  const t0 = Date.now();
  let waiting = true;
  const watch = (async () => {
    while (waiting || Date.now() - t0 < 8000) { if ((await c.pg.hash()) !== hash) return false; await sleep(200); }
    return true;
  })().catch(() => false);
  try {
    let fresh: string;
    if (viaHome) {
      const btn = `document.getElementById('btn-home-clear')`;
      const at = await c.pg.at(btn);
      await c.pg.uncovered(btn, at); // toasts (P15-T2's "Renamed") sit right below the topbar, over the status bar
      await c.pg.tap(at.x, at.y);
      if ((await c.pg.until(`!!document.getElementById('cf-ok')`, 3000)).timeout) throw new Error(`${name}: no confirm after the Home's Clear`);
      await c.pg.tapEl(`document.getElementById('cf-ok')`);
      // the page's POST (through guardRequest) answers with the replacement, which the State then names
      const up = await waitFn(async () => {
        const p = (await api(c, 'GET', '/api/state')).orchestrators.find((o: any) => o.name === name)?.paneId;
        return p && p !== old ? p as string : undefined;
      }, 60_000, 300);
      if (up.timeout || !up.v) throw new Error(`${name}: no replacement after the Home's Clear`);
      fresh = up.v;
    } else {
      fresh = (await api(c, 'POST', `/api/agents/${enc(old)}/clear`)).paneId;
    }
    recordPane(c, fresh, name.slice(3));
    // the replacement is a new Claude: it must come up in the pinned account too
    await agentReady(c, fresh, 60_000);
    checkAccount(fresh, name, pinnedAccount());
    waiting = false;
    return { fresh, stayed: await watch };
  } finally { waiting = false; }
}

async function p15t2(c: Ctx) {
  const { pg } = c;
  const cl = c.rec.names.claude;
  await pg.goto(`#/pane/${enc(cl)}`);
  // rename through the UI (⋮ → Rename…): the POST answers ok, a "Renamed" toast shows, herdr has the new name.
  // (The topbar shows the agent kind, not herdr's agent name, on legacy and S0 alike.)
  guard(c.rec, cl);
  await pg.tapEl(`document.getElementById('btn-agent-menu')`);
  await pg.tapEl(`document.getElementById('am-rename')`);
  await pg.ev(`document.getElementById('rn-name').value = 'wc-renamed'`);
  const save = await pg.at(`document.getElementById('rn-save')`);
  const tr = Date.now(); // right before the tap: a fast response still counts
  await pg.tap(save.x, save.y);
  // the toast and herdr's name, polled side by side within the same 3s; the herdr CLI call is synchronous,
  // so its answer counts only if it came back by the deadline
  const deadline = tr + 3000;
  const [toast, named] = await Promise.all([
    pg.until(`[...document.querySelectorAll('.toast')].some((t) => /Renamed/.test(t.textContent))`, deadline - Date.now()),
    waitFn(() => herdr(['agent', 'get', cl]).agent?.name === 'wc-renamed' && Date.now() <= deadline, deadline - Date.now(), 200),
  ]);
  const ok = pg.resps.find((x) => x.t >= tr && x.url.endsWith(`/api/panes/${enc(cl)}/rename`))?.status;
  const r = { timeout: toast.timeout || named.timeout || ok !== 200, ms: Date.now() - tr };
  await pg.goto('#/home/wc-o1');
  // a Home has no ⋮: Settings in its topbar, Clear and Stop on its status bar
  const bar = await pg.until(`!!document.getElementById('btn-home-clear') && !!document.getElementById('btn-home-stop')
    && !!document.getElementById('btn-settings') && !document.getElementById('btn-agent-menu')`, 5000);
  const t0 = Date.now();
  const { fresh, stayed } = await clearOrch(c, 'wc-o1', true);
  const now = (await api(c, 'GET', '/api/state')).orchestrators.find((o: any) => o.name === 'wc-o1')?.paneId;
  const watched = pg.wsSent.some((f) => f.t >= t0 && f.payload.includes(js(fresh)));
  result(c, !r.timeout && !bar.timeout && stayed && now === fresh && watched, 'P15-T2',
    `renamePost=${ok},toast=${ms(toast)},herdrName=${ms(named)},homeButtons=${!bar.timeout},stayedHome8s=${stayed},replaced=${now === fresh},followed=${watched}`,
    "UI rename: POST ok, a 'Renamed' toast and herdr's agent name wc-renamed within 3s; wc-o1's Home has Settings, Clear and Stop and no ⋮; its Clear button keeps #/home/wc-o1 and follows the new pane");
}

async function p8t2(c: Ctx) {
  const { pg } = c;
  const running = async (name: string): Promise<string | undefined> =>
    (await api(c, 'GET', '/api/state')).orchestrators.find((o: any) => o.name === name)?.paneId;
  if (!(await running('wc-o1'))) await startOrch(c, 'wc-o1');
  // wc-o2 starts from its stopped Home's Start button (a retry may find it running: stopped first)
  const old2 = await running('wc-o2');
  if (old2) {
    recordPane(c, old2, 'o2');
    await api(c, 'DELETE', `/api/panes/${enc(old2)}`);
    if ((await waitFn(async () => !(await running('wc-o2')), 10_000, 300)).timeout) throw env('wc-o2 still running');
  }
  // wc-o1's Home: the switcher lists both, wc-o2 dimmed; tapping it opens wc-o2's stopped Home
  await pg.goto('#/home/wc-o1');
  const dim = `document.querySelector('.home-switch-btn[data-stopped][data-orch="wc-o2"]')`;
  const all = (await api(c, 'GET', '/api/state')).orchestrators.length; // wc-o1, wc-o2 and a wc-h
  const sw = await pg.until(`document.querySelectorAll('.home-switch-btn').length === ${all} && !!${dim}`, 5000);
  if (!sw.timeout) {
    const at = await pg.at(dim);
    await pg.uncovered(dim, at);
    await pg.tap(at.x, at.y);
  } else await pg.goto('#/home/wc-o2');
  const stopped = await stoppedHome(c, 'wc-o2', 3000);
  const btn = `document.getElementById('btn-home-start')`;
  const at = await pg.at(btn);
  await pg.uncovered(btn, at);
  // the busy button is recorded in the page as it happens: the push of wc-o2 running replaces the stopped Home
  // before a poll from here would see it
  await pg.ev(`(() => { window.__wcBusy = 0; window.__wcBusyMo?.disconnect(); const t0 = performance.now();
    window.__wcBusyMo = new MutationObserver(() => { const b = ${btn};
      if (!window.__wcBusy && b && b.disabled && b.textContent === 'Starting\\u2026') window.__wcBusy = Math.max(1, Math.round(performance.now() - t0)); });
    window.__wcBusyMo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true }); })()`);
  const tb = Date.now();
  await pg.tap(at.x, at.y);
  const seen = await pg.until('window.__wcBusy', 1000);
  await pg.ev('window.__wcBusyMo.disconnect()');
  const busy = { timeout: seen.timeout || seen.v > 1000, ms: seen.v };
  const up = await waitFn(() => running('wc-o2'), 60_000, 200);
  if (up.timeout) {
    const post = pg.resps.find((x) => x.t >= tb && x.url.endsWith('/api/orchestrators/wc-o2/start'))?.status ?? 'none';
    const toasts = await pg.ev(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
    throw env(`wc-o2 not running 60s after its Start button (busy=${!busy.timeout}, POST ${post}, toasts: ${toasts || 'none'})`);
  }
  recordPane(c, up.v!, 'o2');
  const live = await pg.until(`location.hash === '#/home/wc-o2' && !!document.querySelector('#screen-pane.screen-home') && !document.getElementById('screen-home-stopped')`, 3000);
  await agentReady(c, up.v!, 60_000);
  checkAccount(up.v!, 'wc-o2', pinnedAccount());
  const st = await api(c, 'GET', '/api/state');
  const first = st.orchestrators.filter((o: any) => o.paneId)[0]?.name;
  await pg.ev(`localStorage.removeItem('herdr_home')`);
  await pg.load(`${c.base}/`);
  const home = await pg.until(`location.hash === ${js(`#/home/${enc(first)}`)}`, 3000);
  // clearing wc-o1 with its Home's Clear holds the running Home through the gap (no stopped Home flashes) and follows
  await pg.goto('#/home/wc-o1');
  await pg.ev(`(() => { window.__wcStopped = false; window.__wcStoppedMo?.disconnect();
    window.__wcStoppedMo = new MutationObserver(() => { if (document.getElementById('screen-home-stopped')) window.__wcStopped = true; });
    window.__wcStoppedMo.observe(document.body, { subtree: true, childList: true }); })()`);
  const t0 = Date.now();
  const { fresh, stayed } = await clearOrch(c, 'wc-o1', true);
  const flashed = await pg.ev('(() => { window.__wcStoppedMo.disconnect(); return window.__wcStopped; })()');
  const followed = pg.wsSent.some((f) => f.t >= t0 && f.payload.includes(js(fresh)));
  // stopping wc-o2 with its Home's Stop leaves its Home, stopped (Start), without a toast or a trip to the list
  await pg.goto('#/home/wc-o2');
  await sleep(1000);
  const o2 = c.rec.names.o2;
  guard(c.rec, o2);
  const stopBtn = `document.getElementById('btn-home-stop')`;
  const sat = await pg.at(stopBtn);
  await pg.uncovered(stopBtn, sat);
  await pg.tap(sat.x, sat.y);
  if ((await pg.until(`!!document.getElementById('cf-ok')`, 3000)).timeout) throw new Error('no confirm after the Home\'s Stop');
  const ts = Date.now();
  await pg.tapEl(`document.getElementById('cf-ok')`);
  const after = await stoppedHome(c, 'wc-o2', 10_000);
  const tStopped = Date.now() - ts;
  const noToast = !(await pg.ev(`[...document.querySelectorAll('.toast')].some((t) => /Orchestrator stopped/.test(t.textContent))`));
  result(c, !sw.timeout && stopped.ok && !busy.timeout && !live.timeout && !home.timeout && stayed && !flashed && followed && after.ok && noToast,
    'P8-T2', `switcher=${!sw.timeout},stoppedHome=${stopped.s},startButton=${busy.timeout ? 'not-busy' : `Starting…:${busy.ms}ms`},running=${up.ms}ms,` +
      `liveHome=${ms(live)},home=${ms(home)}(${first}),clearStayed=${stayed},stoppedFlash=${flashed},followed=${followed},stop=${after.s}(${tStopped}ms),noToast=${noToast}`,
    "wc-o1's Home lists wc-o2 dimmed; its tap opens wc-o2's stopped Home (status bar = its account's agents); Start shows 'Starting…' within 1s, " +
      "then the running Home within 3s of it running; / -> the first running Home within 3s; wc-o1's Clear keeps its running Home (no stopped flash) and follows; " +
      "wc-o2's Stop leaves its stopped Home (Start) within 10s, no toast");
}

// ── runner ───────────────────────────────────────────────────────────────────

interface Item { id: string; tier: 1 | 2; manual?: boolean; needs?: string[]; run: (c: Ctx) => Promise<void> }
const ITEMS: Item[] = [
  { id: 'P2', tier: 1, run: p2 }, // first: the profile is fresh and the first load carried ?token=
  { id: 'P8', tier: 1, needs: ['less'], run: p8 }, // early: Chrome caps history.length at 50
  { id: 'P1', tier: 1, run: p1 },
  { id: 'P17', tier: 1, run: p17 },
  { id: 'P16', tier: 1, run: p16 },
  { id: 'P7', tier: 1, needs: ['less'], run: p7 },
  { id: 'P18', tier: 1, needs: ['less', 'probe'], run: p18 },
  { id: 'W1', tier: 1, needs: ['less'], run: w1 },
  { id: 'M1', tier: 1, needs: ['less'], run: m1 },
  { id: 'M2', tier: 1, needs: ['less'], run: m2 },
  { id: 'M3', tier: 1, needs: ['shell', 'less'], run: m3 },
  { id: 'S1', tier: 1, run: s1 },
  { id: 'P3', tier: 1, needs: ['less'], run: p3 },
  { id: 'P4-T1', tier: 1, needs: ['less'], run: p4t1 },
  { id: 'P15', tier: 1, needs: ['stop'], run: p15 },
  { id: 'P10', tier: 1, needs: ['shell', 'less'], run: p10 },
  { id: 'P14', tier: 1, needs: ['shell', 'less'], run: p14 },
  { id: 'P12', tier: 1, needs: ['shell'], run: p12 },
  { id: 'P13', tier: 1, run: p13 },
  { id: 'P6', tier: 1, needs: ['shell'], run: p6 }, // late: its lines reach wc-shell
  { id: 'P19', tier: 1, needs: ['shell'], run: p19 }, // last: it leaves a 1 typed in wc-shell
  // the headless wc-h1 (fake claude), in this order: H1 starts it, H7 restarts the preview
  { id: 'H1', tier: 1, needs: ['hl'], run: h1 },
  { id: 'H6', tier: 1, needs: ['hl'], run: h6 },
  { id: 'H2', tier: 1, needs: ['hl'], run: h2 },
  { id: 'H3', tier: 1, needs: ['hl'], run: h3 },
  { id: 'H4', tier: 1, needs: ['hl'], run: h4 },
  { id: 'H5', tier: 1, needs: ['hl'], run: h5 },
  { id: 'H8', tier: 1, needs: ['hl'], run: h8 },
  { id: 'H7', tier: 1, needs: ['hl'], run: h7 },
  ...['P2.old', 'P2.upgrade', 'P2.downgrade'].map((id): Item => ({ id, tier: 1, manual: true, run: (c) => p2Round(c, id) })),
  { id: 'P4-T2', tier: 2, needs: ['claude'], run: p4t2 },
  { id: 'P17-T2', tier: 2, needs: ['claude'], run: p17t2 },
  { id: 'P11', tier: 2, needs: ['claude'], run: p11 },
  { id: 'P10-T2', tier: 2, needs: ['claude', 'shell'], run: p10t2 },
  { id: 'P9', tier: 2, needs: ['claude'], run: p9 },
  { id: 'P15-T2', tier: 2, needs: ['claude', 'orch'], run: p15t2 },
  { id: 'P8-T2', tier: 2, needs: ['orch'], run: p8t2 },
  { id: 'H-T2', tier: 2, needs: ['hl2'], run: ht2 },
];

async function readBuild(base: string): Promise<Ctx['build']> {
  const index = await (await fetch(`${base}/`)).text();
  const sw = await (await fetch(`${base}/sw.js`)).text();
  // the asset list: STATIC_ASSETS = [...], else the first array of '/…' strings (a generated sw.js may inline it)
  const list = (sw.match(/STATIC_ASSETS\s*=\s*\[([^\]]*)\]/) ?? sw.match(/\[((?:\s*["']\/[^"']*["']\s*,?)+)\]/))?.[1] ?? '';
  return { vite: /src="\/assets\//.test(index), hash: index.match(/\/assets\/index-([\w-]+)\.js/)?.[1] ?? null,
    swName: sw.match(/['"](herdr-yoicks-[^'"]+)['"]/)?.[1] ?? '', assets: [...list.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) };
}

/** lock → clean earlier runs → setup → body → teardown (also on SIGINT/SIGTERM) → unlock. */
async function locked(base: string, body: (c: Ctx) => Promise<void>, needs: Set<string>, gonogo = false): Promise<Ctx> {
  const port = new URL(base).port || '80';
  if (port === PROD_PORT) throw env(`refusing ${base}: port ${PROD_PORT} is production`);
  const tokenFile = path.join(previewDir(port), 'state', 'token');
  if (!fs.existsSync(tokenFile)) throw env(`no token at ${tokenFile} (start the preview with \`preview start\`)`);
  if (!(await fetch(`${base}/healthz`).then((r) => r.ok, () => false))) throw env(`no preview answering at ${base}`);
  const unlock = await lock();
  const pv = readPreview(port);
  if (pv?.herdr !== (PRIV_AT_START ? PRIV_SOCK : undefined)) {
    unlock();
    throw env(`the preview on ${port} runs on ${pv ? (pv.herdr ? 'the private herdr' : 'the desktop herdr') : 'no record'} and this root on the other: start it again (preview start)`);
  }
  teardownAll();
  const dir = path.join(WC_ROOT, 'run', String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const c: Ctx = { base, port, token: fs.readFileSync(tokenFile, 'utf8').trim(), preview: readPreview(port), failures: 0, out: [],
    rec: { dir, base, gonogo: gonogo ? { pid: process.pid, start: procStart(process.pid)! } : undefined,
      workspaces: [], tabs: [], panes: [], reported: [], names: {} }, pg: null!, build: null! };
  save(c.rec);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    c.pg?.proc?.kill('SIGKILL');
    try { teardown(dir); teardownAll(); } finally { unlock(); }
  };
  const onSignal = () => { console.log('interrupted: tearing down'); finish(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    c.build = await readBuild(base);
    await setup(c, needs);
    await body(c);
  } finally {
    finish();
  }
  return c;
}

async function check(o: Record<string, any>): Promise<number> {
  const tiers = new Set(String((o.tier ?? ['1']).join(',')).split(',').map(Number));
  const only = o.only ? new Set(String(o.only).split(',')) : null;
  const items = ITEMS.filter((i) => (only ? only.has(i.id) : tiers.has(i.tier) && !i.manual));
  if (only) for (const id of only) if (!ITEMS.some((i) => i.id === id)) throw new Error(`unknown item ${id}`);
  const needs = new Set(items.flatMap((i) => i.needs ?? []));
  const c = await locked(o.base, async (c) => {
    c.pg = await openPage(c, o.profile);
    await loadApp(c);
    for (const item of items) {
      if (item.needs?.includes('orch')) await startOrchs(c); // a failed start ends the run, as in setup
      for (let attempt = 1; ; attempt++) {
        const mark = c.out.length;
        const fails = c.failures;
        try { await item.run(c); } catch (e) {
          result(c, false, item.id, `${e instanceof EnvError ? 'ENV:' : 'error:'}${(e as Error).message}`, 'item threw');
        }
        if (item.tier === 2 && attempt === 1 && c.failures > fails) {
          console.log(`RETRY ${item.id}: ${c.out.slice(mark).join(' | ')}`);
          c.out.length = mark;
          c.failures = fails;
          continue;
        }
        for (const l of c.out.slice(mark)) console.log(l);
        break;
      }
    }
    if (c.pg.refused.length) {
      result(c, false, 'GUARD', `refused=${c.pg.refused.length}`, 'the page made no request the guard refused');
      console.log(c.out.at(-1));
    }
  }, needs);
  console.log(`${c.failures} failure(s)`);
  return c.failures;
}

/** A process's start time (/proc/<pid>/stat field 22): with the pid, an identity a reused pid can't fake. Linux only. */
function procStart(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; // fields 3.. follow the "(comm)" field
  } catch { return null; }
}

async function gonogo(o: Record<string, any>): Promise<number> {
  if (!procStart(process.pid)) throw env('go/no-go needs Linux /proc (block checks the holder by pid + start time)');
  await locked(o.base, async (c) => {
    const cl = c.rec.names.claude;
    const t0 = Date.now();
    await sendPrompt(c, cl, ASK_PROMPT);
    const b = await waitFn(async () => (await paneOf(c, cl))?.agent?.status === 'blocked', 90_000, 1000);
    if (b.timeout) throw env('wc-claude not blocked by the P9 prompt');
    console.log(`go/no-go ready (${Date.now() - t0}ms): wc-less ${c.rec.names.less}, blocked wc-claude ${cl}.`);
    console.log('B5: `node tools/webcheck.ts block`. Holding until SIGINT/SIGTERM, then tearing down.');
    await new Promise(() => setInterval(() => {}, 1 << 30)); // until a signal: its handler tears down and exits
  }, new Set(['less', 'claude']), true);
  return 0;
}

function block(): number {
  if (!procStart(process.pid)) throw env('block needs Linux /proc (it checks the go/no-go holder by pid + start time)');
  const runs = path.join(WC_ROOT, 'run');
  const rec: Rec | undefined = (fs.existsSync(runs) ? fs.readdirSync(runs) : [])
    .map((d) => { try { return JSON.parse(fs.readFileSync(path.join(runs, d, 'webcheck.json'), 'utf8')); } catch { return null; } })
    // only the run whose setup --gonogo still holds it (same pid AND start time), never a stale record
    .find((r) => typeof r?.gonogo?.pid === 'number' && !!r.gonogo.start && procStart(r.gonogo.pid) === r.gonogo.start);
  if (!rec?.names.less) throw env('no active go/no-go run (start `setup --gonogo` first)');
  if (spawnSync('flock', ['-n', LOCK, 'true']).status === 0) throw env('run without lock');
  mutate(rec, rec.names.less, ['pane', 'report-agent', '--source', 'webcheck', '--agent', 'claude', '--state', 'blocked', rec.names.less]);
  console.log(`wc-less ${rec.names.less} reported blocked`);
  return 0;
}

// ── shots: the PR screenshots (tools/shots-fixture.ts's scenes; see the header) ──────────────────────

const SHOTS_PORT = 8397;

/** In a page: how many pixels of two PNGs (base64) differ, and the diff as a PNG: the after dimmed, magenta within 2 px
 *  of each pixel that differs (seen even when the comment shows it at a third of its size). Chrome decodes them. */
const DIFF_JS = `async (b, a) => {
  const load = async (s) => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode(); return i; };
  const [x, y] = await Promise.all([load(b), load(a)]);
  const w = Math.max(x.width, y.width), h = Math.max(x.height, y.height);
  const canvas = (i, alpha) => { const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.globalAlpha = alpha;
    g.drawImage(i, 0, 0); return { c, g, d: g.getImageData(0, 0, w, h) }; };
  const p = canvas(x, 1).d.data, q = canvas(y, 1).d.data, out = canvas(y, 0.3), o = out.d.data;
  const m = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0, k = 0; i < m.length; i++, k += 4) if (p[k] !== q[k] || p[k + 1] !== q[k + 1] || p[k + 2] !== q[k + 2]) { m[i] = 1; n++; }
  for (let i = 0; i < m.length; i++) if (m[i]) {
    const x0 = i % w, y0 = (i - x0) / w;
    for (let y1 = Math.max(0, y0 - 2); y1 <= Math.min(h - 1, y0 + 2); y1++) for (let x1 = Math.max(0, x0 - 2); x1 <= Math.min(w - 1, x0 + 2); x1++) {
      const k = (y1 * w + x1) * 4; o[k] = 255; o[k + 1] = 0; o[k + 2] = 255;
    }
  }
  out.g.putImageData(out.d, 0, 0);
  return { pixels: n, png: out.c.toDataURL('image/png').slice('data:image/png;base64,'.length) };
}`;

const SIZES = [
  { id: 'phone', metrics: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } },
  { id: 'pc', metrics: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false } },
];

/** A bridge's stand-in over the fixture, loopback only: its reads, a /ws that sends the State once, and the web build
 *  use() last chose (but sw.js: a service worker would only add a step). Writes answer ok and change nothing. One
 *  server for both builds, on SHOTS_PORT in every run: the origin shows on screen (Settings' Bridge URL). */
async function fixtureServer(): Promise<{ url: string; use: (dist: string) => void; close: () => void }> {
  const f = await import('./shots-fixture.ts');
  let root = '';
  let entry = '';
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
  const send = (res: http.ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };
  const json = (res: http.ServerResponse, body: unknown) => send(res, 200, 'application/json', js(body));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname;
    let m: RegExpMatchArray | null;
    if (p === '/api/state') return json(res, f.state);
    if ((m = p.match(/^\/api\/panes\/([^/]+)\/read$/))) {
      const ansi = f.screen(decodeURIComponent(m[1]));
      return json(res, { ansi, text: ansi.replace(/\u001b\[[0-9;]*m/g, ''), appScroll: false });
    }
    if ((m = p.match(/^\/api\/panes\/([^/]+)\/transcript$/))) {
      const items = f.transcripts[decodeURIComponent(m[1])];
      return json(res, !items ? { available: false } : u.searchParams.has('after') ? { available: true, sessionId: 's1', items: [], cursor: 1 }
        : { available: true, sessionId: 's1', items, cursor: 1, reset: true });
    }
    if (p.startsWith('/api/')) return req.method === 'GET' ? send(res, 404, 'application/json', js({ error: { code: 'not_found', message: p } })) : json(res, { ok: true });
    // the entry script under a fixed name: the app shows its file's hash (BUILD), which any code change changes
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
      entry = html.match(/\/assets\/[\w-]+-[\w-]{8}\.js/)?.[0] ?? '';
      return send(res, 200, 'text/html', entry ? html.replace(entry, '/assets/index-shots000.js') : html);
    }
    const file = path.join(root, p === '/assets/index-shots000.js' ? entry : p);
    if (p === '/sw.js' || !file.startsWith(root + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return send(res, 404, 'text/plain', 'not found');
    send(res, 200, types[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
  });
  server.on('upgrade', (req, sock) => { // the handshake, then the State once; what the page sends is read and dropped
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const body = Buffer.from(js({ type: 'state', state: f.state }));
    const n = body.length;
    const head = n < 126 ? [0x81, n] : n < 65536 ? [0x81, 126, n >> 8, n & 255] : [0x81, 127, 0, 0, 0, 0, n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
    sock.write(Buffer.concat([Buffer.from(head), body]));
    sock.on('data', () => {});
    sock.on('error', () => {});
  });
  // a fixed port: the origin is on screen, and the gate compares a screen's bytes across runs (the digest the
  // comment shows against the one the label's run gets), so a port of the run's own would change them
  await new Promise<void>((r, j) => { server.once('error', j); server.listen(SHOTS_PORT, '127.0.0.1', r); })
    .catch((e) => { throw env(`shots: 127.0.0.1:${SHOTS_PORT}: ${e.code ?? e} (another shots run?)`); });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    use: (dist) => { root = path.resolve(dist); },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

async function shots(o: Record<string, any>): Promise<number> {
  if (!o.after || !o.out) throw new Error('shots needs --after DIR and --out DIR (and --before DIR to compare)');
  const { T0, scenes } = await import('./shots-fixture.ts');
  const only = o.only ? new Set(String(o.only).split(',')) : null;
  const picked = scenes.filter((s) => !only || only.has(s.name));
  const partsOf = (scene: typeof scenes[number], size: typeof SIZES[number]) => (scene.parts ?? []).filter((p) => !p.sizes || p.sizes.includes(size.id as 'phone' | 'pc'));
  const names = picked.flatMap((s) => SIZES.flatMap((z) => [...(s.screen === false ? [] : [s.name]), ...partsOf(s, z).map((p) => p.name)].map((n) => `${n}-${z.id}`)));
  const bad = names.find((n, i) => !/^[a-z0-9-]{1,64}$/.test(n) || names.indexOf(n) !== i);
  if (bad) throw new Error(`shots: ${bad} is twice or not [a-z0-9-] (tools/shots-fixture.ts)`);
  // a frozen clock that still moves with the page's own time (timers run), and nothing animated
  const init = `(() => { const T = ${T0 + 30_000}, p0 = performance.now(), R = Date;
    class D extends R { constructor(...a) { super(...(a.length ? a : [T + performance.now() - p0])); } static now() { return T + performance.now() - p0; } }
    globalThis.Date = D;
    document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.head.append(s); }); })()`;
  const out = path.resolve(o.out);
  fs.mkdirSync(out, { recursive: true });
  const sides = [['before', o.before], ['after', o.after]].filter(([, d]) => d) as Array<[string, string]>;
  for (const [, d] of sides) if (!fs.existsSync(path.join(d, 'index.html'))) throw env(`no index.html in ${d} (npx vite build)`);
  const server = await fixtureServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yoicks-shots-'));
  const chrome = startChrome(dir, ['--hide-scrollbars',
    '--blink-settings=primaryPointerType=4,primaryHoverType=2,availablePointerTypes=4,availableHoverTypes=2']);
  const proc = chrome.proc;
  let cdp: Cdp | null = null;
  try {
    cdp = await connectCdp(await chrome.url);
    const c = cdp;
    const shoot = async (scene: typeof scenes[number], size: typeof SIZES[number]) => {
      const { browserContextId } = await c.send('Target.createBrowserContext');
      try {
        const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', browserContextId });
        const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
        const S = (method: string, params: object = {}) => c.send(method, params, sessionId);
        const ev = async (expression: string) => (await S('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
        await S('Page.enable');
        await S('Page.addScriptToEvaluateOnNewDocument', { source: init });
        await S('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
        await S('Emulation.setLocaleOverride', { locale: 'en-US' });
        await S('Emulation.setDeviceMetricsOverride', size.metrics);
        await S('Emulation.setTouchEmulationEnabled', size.metrics.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        await S('Page.navigate', { url: `${server.url}/${scene.token === false ? '' : '?token=shots'}${scene.hash}` });
        const ready = !(await waitFn(() => ev(`(() => { try { return !!(${scene.ready}); } catch { return false; } })()`), 10_000)).timeout;
        await ev(`document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))))
          .then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`);
        await sleep(300);
        const shot: Array<{ name: string; kind: 'screen' | 'part'; png: Buffer; ready: boolean }> = [];
        if (scene.screen !== false) {
          const { data } = await S('Page.captureScreenshot', { format: 'png' });
          shot.push({ name: `${scene.name}-${size.id}`, kind: 'screen', png: Buffer.from(data, 'base64'), ready });
        }
        // each part after the screen: its own box (whole pixels, within the viewport), scrolled into its container's
        // view first; one not found is a 1x1 shot, not ready
        for (const part of partsOf(scene, size)) {
          const box = ready ? await ev(`(async () => { const e = ${part.el}; if (!e) return null;
            e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const b = e.getBoundingClientRect(), x = Math.max(0, Math.floor(b.left)), y = Math.max(0, Math.floor(b.top));
            const w = Math.min(innerWidth, Math.ceil(b.right)) - x, h = Math.min(innerHeight, Math.ceil(b.bottom)) - y;
            return w > 0 && h > 0 ? { x: x + scrollX, y: y + scrollY, width: w, height: h, scale: 1 } : null; })()`) : null;
          const { data } = await S('Page.captureScreenshot', { format: 'png', clip: box ?? { x: 0, y: 0, width: 1, height: 1, scale: 1 } });
          shot.push({ name: `${part.name}-${size.id}`, kind: 'part', png: Buffer.from(data, 'base64'), ready: !!box });
        }
        return shot;
      } finally {
        await c.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      }
    };
    /** An expression's value in a blank page of its own. */
    const inPage = async (expression: string) => {
      const { browserContextId } = await c.send('Target.createBrowserContext');
      try {
        const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', browserContextId });
        const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
        const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (!r.result?.value) throw new Error(`in page: ${r.exceptionDetails?.exception?.description ?? 'no result'}`);
        return r.result.value;
      } finally {
        await c.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
      }
    };
    const diff = async (before: Buffer, after: Buffer): Promise<{ pixels: number; png: Buffer }> => {
      const v = await inPage(`(${DIFF_JS})(${js(before.toString('base64'))}, ${js(after.toString('base64'))})`);
      return { pixels: v.pixels, png: Buffer.from(v.png, 'base64') };
    };
    // the diff's own check, each run: two 8x8 PNGs one level apart at (1,1) give 1 pixel, magenta to (3,3), not (4,4)
    const probe = await inPage(`(async () => {
      const png = (c1) => { const c = document.createElement('canvas'); c.width = c.height = 8; const g = c.getContext('2d');
        g.fillStyle = '#123456'; g.fillRect(0, 0, 8, 8); g.fillStyle = c1; g.fillRect(1, 1, 1, 1); return c.toDataURL('image/png').slice(22); };
      const r = await (${DIFF_JS})(png('#123456'), png('#123457'));
      const i = new Image(); i.src = 'data:image/png;base64,' + r.png; await i.decode();
      const c = document.createElement('canvas'); c.width = c.height = 8; const g = c.getContext('2d'); g.drawImage(i, 0, 0);
      const at = (x, y) => [...g.getImageData(x, y, 1, 1).data.slice(0, 3)].join(',');
      return { pixels: r.pixels, near: at(3, 3), far: at(4, 4) };
    })()`);
    if (probe.pixels !== 1 || probe.near !== '255,0,255' || probe.far === '255,0,255') throw new Error(`the diff is broken: ${js(probe)}`);
    const manifest: Array<{ name: string; kind: 'screen' | 'part'; changed: boolean | null; notReady: string[]; pixels: number | null }> = [];
    for (const scene of picked) for (const size of SIZES) {
      // one page load per side gives the scene's screen and its parts; both sides shoot the same names (one fixture)
      const shots = new Map<string, { kind: 'screen' | 'part'; got: Record<string, Buffer>; notReady: string[] }>();
      for (const [side, d] of sides) {
        server.use(d);
        for (const r of await shoot(scene, size)) {
          const s = shots.get(r.name) ?? { kind: r.kind, got: {}, notReady: [] };
          shots.set(r.name, s);
          fs.writeFileSync(path.join(out, `${r.name}.${side}.png`), r.png);
          s.got[side] = r.png;
          if (!r.ready) s.notReady.push(side);
        }
      }
      for (const [name, { kind, got, notReady }] of shots) {
        const changed = got.before ? !got.before.equals(got.after) : null;
        let pixels: number | null = null;
        if (changed) {
          const d = await diff(got.before, got.after);
          fs.writeFileSync(path.join(out, `${name}.diff.png`), d.png);
          pixels = d.pixels;
        }
        manifest.push({ name, kind, changed, notReady, pixels });
        console.log(`${changed === null ? 'shot   ' : changed ? 'CHANGED' : 'same   '} ${name}${changed ? ` (${pixels} px)` : ''}${notReady.length ? ` (not ready: ${notReady.join(', ')})` : ''}`);
      }
    }
    fs.writeFileSync(path.join(out, 'manifest.json'), js({ shots: manifest }, null, 1));
    console.log(`${manifest.filter((s) => s.changed).length} of ${manifest.length} changed; ${out}`);
    return 0;
  } finally {
    cdp?.close();
    proc.kill('SIGKILL');
    server.close();
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const { values: o, positionals: [cmd, sub] } = parseArgs({ allowPositionals: true, options: {
    base: { type: 'string' }, tier: { type: 'string', multiple: true }, only: { type: 'string' }, profile: { type: 'string' },
    gonogo: { type: 'boolean' }, bin: { type: 'string' }, port: { type: 'string' }, 'web-dir': { type: 'string' }, 'fake-claude': { type: 'string' },
    before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' } } });
  if (cmd === 'shots') return shots(o);
  if (cmd === 'herdr') return herdrCmd(sub);
  if (cmd === 'preview') return previewCmd(sub, o);
  if (cmd === 'teardown') { const unlock = await lock(); try { teardownAll(); } finally { unlock(); } return 0; }
  if (cmd === 'block') return block();
  if (!o.base) throw new Error('--base is required');
  if (cmd === 'check') return check(o);
  if (cmd === 'setup' && o.gonogo) return gonogo(o);
  throw new Error('usage: see the header of tools/webcheck.ts');
}

process.stdout.on('error', () => {}); // a closed stdout must not kill the run before its teardown
main().then((n) => process.exit(n), (e) => {
  console.log(e instanceof EnvError ? `ENV: ${e.message}` : `error: ${e.stack ?? e}`);
  process.exit(1);
});
