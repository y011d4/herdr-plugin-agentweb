#!/usr/bin/env node
/**
 * tools/webcheck.ts: the headless-Chrome checks of the web UI (the gate before every deploy).
 * Dependency-free; run as `node tools/webcheck.ts …` (Node >= 22.18 type stripping).
 *
 *   node tools/webcheck.ts preview start --bin bin/yoicks [--port 8395] [--web-dir DIR]
 *   node tools/webcheck.ts preview stop [--port 8395]
 *   node tools/webcheck.ts check --base http://127.0.0.1:8395 [--tier 1|2|1,2] [--only P10,P12] [--profile DIR]
 *   node tools/webcheck.ts setup --gonogo --base URL   # go/no-go: wc-less + a blocked wc-claude, held until SIGINT/SIGTERM
 *   node tools/webcheck.ts block                       # go/no-go B5: report that wc-less as blocked
 *   node tools/webcheck.ts teardown                    # clean every unfinished run
 *
 * A preview is a throwaway bridge (state/config under $WC_ROOT/preview-<port>, `env -u HERDR_BIN_PATH`)
 * over the REAL herdr, which production also shows. check/setup/teardown take $WC_ROOT/lock
 * (WC_ROOT = $WEBCHECK_ROOT or ~/.local/state/herdr-yoicks-webcheck) through a separate
 * `flock -n -o` holder process, so the lock lasts from setup to teardown and never reaches the
 * preview bridge or Chrome. Every mutation goes through guard(): only ids this run recorded in
 * $RUN/webcheck.json whose live tab or workspace label starts with wc-. Each check prints
 * `PASS|FAIL <id> <measured> <condition>`; the exit code is the number of failures.
 * Tier 2 (real Claude) needs $WC_ROOT/.envrc pinning CLAUDE_CONFIG_DIR (direnv allow'ed).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const WC_ROOT = process.env.WEBCHECK_ROOT || path.join(os.homedir(), '.local/state/herdr-yoicks-webcheck');
const LOCK = path.join(WC_ROOT, 'lock');
const WORK = path.join(WC_ROOT, 'work');
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
  const c = rec?.chrome;
  try { if (c && fs.readFileSync(`/proc/${c.pid}/cmdline`, 'utf8').includes(c.dir)) process.kill(c.pid, 'SIGKILL'); } catch { /* gone */ }
  // a just-killed Chrome's helpers may still write to its profile: retry, and never stop the closing for it
  const rm = (p: string) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { console.log(`WARN ${(e as Error).message}`); } };
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
  return () => p.stdin!.end();
}

// ── preview bridge ───────────────────────────────────────────────────────────

interface Preview { bin: string; port: string; webDir?: string }
const previewDir = (port: string) => path.join(WC_ROOT, `preview-${port}`);

function previewEnv(p: Preview): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  delete e.HERDR_BIN_PATH;
  delete e.YOICKS_WEB_DIR;
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

const orchConfig = (account: string | null) => js({ orchestrators: ['wc-o1', 'wc-o2'].map((name) =>
  ({ name, label: name.toUpperCase(), ...(account ? { env: { CLAUDE_CONFIG_DIR: account } } : {}) })) });

async function previewCmd(sub: string, o: Record<string, any>): Promise<number> {
  const port = String(o.port ?? '8395');
  if (port === PROD_PORT) throw env(`refusing port ${PROD_PORT} (production)`);
  if (sub !== 'stop' && (sub !== 'start' || !o.bin)) throw new Error('usage: preview start --bin PATH [--port N] [--web-dir DIR] | preview stop [--port N]');
  const unlock = await lock(); // never under a run; the holder process keeps the lock from the bridge
  try {
    const old = readPreview(port);
    if (old) await previewCtl(old, 'stop').catch((e) => console.log(`WARN ${e.message}`));
    if (sub === 'stop') { console.log(`preview ${port} stopped`); return 0; }
    const p: Preview = { bin: path.resolve(o.bin), port, webDir: o['web-dir'] && path.resolve(o['web-dir']) };
    // the orchestrators start with Tier 2's account (the bridge checks the started agent against it)
    const account = fs.existsSync(path.join(WC_ROOT, '.envrc')) ? pinnedAccount() : null;
    fs.rmSync(previewDir(port), { recursive: true, force: true });
    for (const d of ['state', 'config']) fs.mkdirSync(path.join(previewDir(port), d), { recursive: true });
    fs.writeFileSync(path.join(previewDir(port), 'config', 'config.json'), orchConfig(account));
    fs.writeFileSync(path.join(previewDir(port), 'preview.json'), js(p));
    await previewCtl(p, 'start');
    console.log(`preview ${port} up: http://127.0.0.1:${port} (token ${path.join(previewDir(port), 'state', 'token')}, account ${account === null ? 'none: Tier 1 only' : accountName(account)})`);
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
  reqs: Req[] = []; resps: Array<{ t: number; url: string; status: number; type: string; sw: boolean }> = [];
  wsSent: Frame[] = []; wsRecv: Frame[] = []; wsCreated: number[] = []; swFails = 0; refused: string[] = [];
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
  /** Center of the element `el` (a JS expression) after scrolling it into view. */
  async at(el: string): Promise<{ x: number; y: number }> {
    const r = await this.ev(`(() => { const e = ${el}; if (!e) return null; e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!r) throw new Error(`no element: ${el}`);
    await sleep(250);
    return r;
  }
  async tapEl(el: string) { const p = await this.at(el); await this.tap(p.x, p.y); return Date.now(); }
  posts = (t: number, suffix: string) => this.reqs.filter((q) => q.t >= t && q.method === 'POST' && q.url.endsWith(suffix));
  /** The page's own API mutations go through the same guard: a UI bug must not reach a real agent. */
  async guardRequest(p: any) {
    const u = new URL(p.request.url);
    try {
      const id = u.pathname.match(/^\/api\/(?:panes|agents)\/([^/]+)/)?.[1];
      if (p.request.method !== 'GET' && !/^\/api\/orchestrators\/wc-o[12]\/start$/.test(u.pathname)) {
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

async function openPage(c: Ctx, profile?: string): Promise<Page> {
  const pg = new Page(c);
  const dir = profile ? path.resolve(profile) : path.join(c.rec.dir, 'chrome');
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, 'DevToolsActivePort'), { force: true });
  // headless Linux swallows touchmoves within ~30px of the touchstart; 3 makes it ~8px, a phone's 8dp
  pg.proc = spawn('google-chrome-stable', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--touch-slop-distance=3', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  // a spawn failure ('error') rejects into the run's normal teardown instead of crashing past it
  const failed = new Promise<never>((_, rej) => pg.proc.on('error', (e) => rej(env(`chrome: ${e.message}`))));
  failed.catch(() => {});
  if (pg.proc.pid) { c.rec.chrome = { pid: pg.proc.pid, dir }; save(c.rec); }
  const port = await Promise.race([waitFn(() => fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0], 15_000), failed]);
  if (port.timeout) throw env('chrome did not start');
  const ver = await (await fetch(`http://127.0.0.1:${port.v}/json/version`)).json();
  pg.cdp = await connectCdp(ver.webSocketDebuggerUrl);
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
      pg.resps.push({ t, url: p.response.url, status: p.response.status, type: p.type, sw: !!p.response.fromServiceWorker });
    } else if (m.method === 'Network.webSocketCreated') pg.wsCreated.push(t);
    else if (m.method === 'Network.webSocketFrameSent') pg.wsSent.push({ t, payload: p.response.payloadData });
    else if (m.method === 'Network.webSocketFrameReceived') {
      const payload: string = p.response.payloadData;
      if (/^\{"type":"state"/.test(payload)) return; // big and frequent; nothing checks them
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
  if (needs.has('claude') || needs.has('orch')) {
    account = pinnedAccount();
    // preview start gives the orchestrators that account as env; a preview from before the .envrc has none
    let cfg = '';
    try { cfg = fs.readFileSync(path.join(previewDir(c.port), 'config', 'config.json'), 'utf8'); } catch { /* not ours */ }
    if (cfg !== orchConfig(account)) throw env(`the preview's orchestrators are not pinned to ${accountName(account)} (restart it with preview start)`);
  }
  if (!needs.size) return;
  fs.mkdirSync(WORK, { recursive: true });
  const w = herdr(['workspace', 'create', '--cwd', WORK, '--label', 'wc-webcheck', '--no-focus']);
  const ws = w.workspace.workspace_id;
  record(c.rec, { workspace: ws, tab: w.tab.tab_id, pane: w.root_pane.pane_id });
  const shell = needs.has('shell') ? await newTab(c, ws, 'wc-shell') : '';
  const less = needs.has('less') ? await newTab(c, ws, 'wc-less') : '';
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
  for (const p of [shell, less].filter(Boolean)) {
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
  if (needs.has('orch')) for (const name of ['wc-o1', 'wc-o2']) await startOrch(c, name);
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
  const icons = ((await m.json()).icons ?? []).map((i: any) => i.src);
  const got = await Promise.all(icons.map(async (s: string) => { const r = await fetch(new URL(s, `${c.base}/`)); return `${r.status}:${r.headers.get('content-type')}`; }));
  const dom = await c.pg.ev(`[document.querySelectorAll('link[rel=manifest]').length, document.querySelectorAll('meta[name=apple-mobile-web-app-capable]').length]`);
  result(c, m.status === 200 && ct.startsWith('application/manifest+json') && got.length === 2 && got.every((g) => g === '200:image/png') && dom.join() === '1,1',
    'P1', `manifest=${m.status}:${ct},icons=${got.join('+')},link/meta=${dom.join('/')}`,
    'manifest 200 application/manifest+json; 2 icons 200 image/png; 1 link[rel=manifest], 1 apple-mobile-web-app-capable');
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

async function p2Round(c: Ctx, id: string) {
  const want = id === 'P2.upgrade' ? 'vite' : 'legacy';
  if ((want === 'vite') !== c.build.vite) {
    result(c, false, id, `ENV:${c.build.vite ? 'vite' : 'legacy'}-build-served`, `${id} needs the ${want} build served (see the S0 old-SW round trip)`);
    return;
  }
  const re = want === 'vite' ? /^herdr-yoicks-[0-9a-f]{8}$/ : /^herdr-yoicks-v\d+$/;
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
  const appBuild = (await (await fetch(`${c.base}/app.js`)).text()).match(/BUILD\s*=\s*['"]([^'"]+)['"]/)?.[1];
  result(c, !st.timeout && ks.length === 1 && ks[0] === c.build.swName && re.test(ks[0]) && !n404.length && (id !== 'P2.downgrade' || build === appBuild),
    id, `sw=${st.v},caches=${ks.join('+')},404=${n404.join('+') || 0}${id === 'P2.downgrade' ? `,build=${build}(app.js ${appBuild})` : ''}`,
    `only sw.js's cache (${re}) after ${id === 'P2.old' ? 'install' : '2 reloads'}; no 404${id === 'P2.downgrade' ? '; Settings shows the old BUILD' : ''}`);
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
  result(c, ok && btns === 2 && !nav.timeout, 'P7', `cards(dom/state):${counts.join(',')},topbarButtons=${btns},tap=${nav.timeout ? 'timeout' : `${nav.ms}ms`}`,
    '.agent-card count = /api/state (#/agents, #/agents/wc-o1); 2 topbar buttons; tapping wc-less opens #/pane/<it> within 2s');
}

/** Without a running orchestrator, a fresh open (/) and #/home land on #/agents by location.replace. */
async function p8(c: Ctx) {
  const { pg } = c;
  const running = (await api(c, 'GET', '/api/state')).orchestrators.filter((o: any) => o.paneId).map((o: any) => o.name);
  if (running.length) {
    result(c, true, 'P8', `n/a(running:${running.join('+')})`, 'needs no orchestrator running (/api/state)');
    return;
  }
  /** #/agents within 3s, then its .agent-card count = /api/state's (within 5s, as P7) */
  const landed = async (): Promise<{ ok: boolean; s: string }> => {
    const r = await pg.until(`location.hash === '#/agents' && !!document.querySelector('#screen-agents[data-ready]')`, 3000);
    let last = '';
    const n = await waitFn(async () => {
      const dom = await pg.ev(`document.querySelectorAll('.agent-card').length`);
      const want = expectedCards(await api(c, 'GET', '/api/state'));
      last = `${dom}/${want}`;
      return dom === want;
    }, 5000, 300);
    return { ok: !r.timeout && !n.timeout, s: `${ms(r)}:cards=${last}` };
  };
  // a fresh document's history.length already counts its own entry: a replace keeps it, a push adds one
  const { identifier } = await pg.S('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__wcHist0 = history.length' });
  try { await pg.load(`${c.base}/`); } finally { await pg.S('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
  const root = await landed();
  const [h1, h0] = await pg.ev(`[history.length, window.__wcHist0]`);
  // in the app: the hash assignment adds one entry, the redirect none
  const g0 = await pg.ev('history.length');
  await pg.ev(`location.hash = '#/home'`);
  const home = await landed();
  const g1 = await pg.ev('history.length');
  result(c, root.ok && h1 === h0 && home.ok && g1 === g0 + 1, 'P8',
    `/=${root.s},history=${h0}->${h1};#/home=${home.s},history=${g0}->${g1}`,
    'no orchestrator running: / and #/home are replaced by #/agents within 3s (history.length +0, +1 for the #/home assignment itself); .agent-card count = /api/state');
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
  const tq = await pg.tapEl(`[...document.querySelectorAll('.qkey')].find((b) => b.textContent === '\\u2193')`);
  await sleep(700);
  const reads = pg.reqs.filter((q) => q.method === 'GET' && q.t >= tq && q.t <= tq + 600 && q.url.includes(`/api/panes/${enc(less)}/read`)).length;
  result(c, reads >= 2, 'P10.app-quickkey', `reads600ms=${reads}`, 'a quick key is followed by >= 2 GET /read within 600ms');
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

async function p11(c: Ctx) {
  const { pg } = c;
  const cl = c.rec.names.claude;
  await pg.ev(`localStorage.removeItem('herdr_pane_view')`);
  await pg.goto('#/agents');
  await pg.goto(`#/pane/${enc(cl)}`);
  const shown = await pg.until(`(() => { const l = document.getElementById('chat-log'); return !!l && l.style.display !== 'none' && l.querySelectorAll('.chat-item').length; })()`, 5000);
  const users0 = await pg.ev(`window.__wcFirst = document.querySelector('#chat-log .chat-item'), document.querySelectorAll('#chat-log .chat-user').length`);
  guard(c.rec, cl);
  await pg.tapEl(`document.getElementById('pane-input')`);
  await pg.S('Input.insertText', { text: NOTE_PROMPT });
  await pg.tapEl(`document.getElementById('btn-send-enter')`);
  const user = await pg.until(`document.querySelectorAll('#chat-log .chat-user').length === ${users0 + 1}`, 10_000, 200);
  const same = await pg.ev(`document.querySelector('#chat-log .chat-item') === window.__wcFirst`);
  const det = await pg.until(`document.querySelectorAll('#chat-log details.chat-result').length`, 90_000, 300);
  const [items0, top0] = await pg.ev(`(() => { const d = [...document.querySelectorAll('#chat-log details.chat-result')].pop(); d.open = true; window.__wcDet = d;
    const l = document.getElementById('chat-log'); l.scrollTop = l.scrollHeight - l.clientHeight - 200; return [l.querySelectorAll('.chat-item').length, l.scrollTop]; })()`);
  const app = await pg.until(`document.querySelectorAll('#chat-log .chat-item').length > ${items0}`, 90_000, 200);
  const [open, top1] = await pg.ev(`[window.__wcDet.open && document.contains(window.__wcDet), document.getElementById('chat-log').scrollTop]`);
  await pg.tapEl(`document.getElementById('btn-view-toggle')`);
  const term = await pg.until(`localStorage.getItem('herdr_pane_view') === 'terminal'`, 2000);
  await pg.tapEl(`document.getElementById('btn-view-toggle')`);
  const chat = await pg.until(`localStorage.getItem('herdr_pane_view') === 'chat'`, 2000);
  result(c, !shown.timeout && !user.timeout && same && !det.timeout && !app.timeout && open && Math.abs(top1 - top0) <= 1 && !term.timeout && !chat.timeout,
    'P11', `chat=${ms(shown)},userAdded=${ms(user)},firstNodeKept=${same},result=${ms(det)},append=${ms(app)},detailsOpen=${open},scrollDelta=${top1 - top0},toggleSaved=${!term.timeout && !chat.timeout}`,
    'chat within 5s; send adds 1 .chat-user, first node kept; an open tool result stays open and scrollTop holds (+-1px) across an append; the view toggle is saved');
}

/** Clears an orchestrator from its Home. stayed: #/home/<name> held from the clear request through 8s and
 *  through the wait for the replacement (ready, in the pinned account), however long that took. */
async function clearOrch(c: Ctx, name: string): Promise<{ fresh: string; stayed: boolean }> {
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
    const out = await api(c, 'POST', `/api/agents/${enc(old)}/clear`);
    recordPane(c, out.paneId, name.slice(3));
    // the replacement is a new Claude: it must come up in the pinned account too
    await agentReady(c, out.paneId, 60_000);
    checkAccount(out.paneId, name, pinnedAccount());
    waiting = false;
    return { fresh: out.paneId, stayed: await watch };
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
  const t0 = Date.now();
  const { fresh, stayed } = await clearOrch(c, 'wc-o1');
  const now = (await api(c, 'GET', '/api/state')).orchestrators.find((o: any) => o.name === 'wc-o1')?.paneId;
  const watched = pg.wsSent.some((f) => f.t >= t0 && f.payload.includes(js(fresh)));
  result(c, !r.timeout && stayed && now === fresh && watched, 'P15-T2',
    `renamePost=${ok},toast=${ms(toast)},herdrName=${ms(named)},stayedHome8s=${stayed},replaced=${now === fresh},followed=${watched}`,
    "UI rename: POST ok, a 'Renamed' toast and herdr's agent name wc-renamed within 3s; clearing wc-o1 keeps #/home/wc-o1 and follows the new pane");
}

async function p8t2(c: Ctx) {
  const { pg } = c;
  for (const name of ['wc-o1', 'wc-o2']) { // a retry finds wc-o2 stopped
    if (!(await api(c, 'GET', '/api/state')).orchestrators.find((o: any) => o.name === name)?.paneId) await startOrch(c, name);
  }
  const st = await api(c, 'GET', '/api/state');
  const first = st.orchestrators.filter((o: any) => o.paneId)[0]?.name;
  await pg.ev(`localStorage.removeItem('herdr_home')`);
  await pg.load(`${c.base}/`);
  const home = await pg.until(`location.hash === ${js(`#/home/${enc(first)}`)}`, 3000);
  const sw = await pg.until(`document.querySelectorAll('.home-switch-btn').length === 2`, 3000);
  await pg.goto('#/home/wc-o1');
  const t0 = Date.now();
  const { fresh, stayed } = await clearOrch(c, 'wc-o1');
  const followed = pg.wsSent.some((f) => f.t >= t0 && f.payload.includes(js(fresh)));
  await pg.goto('#/home/wc-o2');
  await sleep(1000);
  const o2 = c.rec.names.o2;
  guard(c.rec, o2);
  const ts = Date.now();
  await api(c, 'DELETE', `/api/panes/${enc(o2)}`);
  const toast = await pg.until(`[...document.querySelectorAll('.toast')].some((t) => /Orchestrator stopped/.test(t.textContent))`, 12_000, 100);
  const tToast = Date.now() - ts;
  const list = await pg.until(`location.hash === '#/agents'`, 2000);
  result(c, !home.timeout && !sw.timeout && stayed && followed && !toast.timeout && Math.abs(tToast - 8000) <= 1000 && !list.timeout,
    'P8-T2', `home=${ms(home)}(${first}),switcher=${!sw.timeout},clearStayed=${stayed},followed=${followed},stopToast=${tToast}ms,toList=${!list.timeout}`,
    '/ -> the first running Home within 3s with 2 switcher buttons; clear wc-o1 holds its Home 8s then follows; stop wc-o2 -> toast at 8+-1s and #/agents');
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
  { id: 'P3', tier: 1, needs: ['less'], run: p3 },
  { id: 'P10', tier: 1, needs: ['shell', 'less'], run: p10 },
  { id: 'P12', tier: 1, needs: ['shell'], run: p12 },
  { id: 'P13', tier: 1, run: p13 },
  ...['P2.old', 'P2.upgrade', 'P2.downgrade'].map((id): Item => ({ id, tier: 1, manual: true, run: (c) => p2Round(c, id) })),
  { id: 'P4-T2', tier: 2, needs: ['claude'], run: p4t2 },
  { id: 'P17-T2', tier: 2, needs: ['claude'], run: p17t2 },
  { id: 'P11', tier: 2, needs: ['claude'], run: p11 },
  { id: 'P9', tier: 2, needs: ['claude'], run: p9 },
  { id: 'P15-T2', tier: 2, needs: ['claude', 'orch'], run: p15t2 },
  { id: 'P8-T2', tier: 2, needs: ['orch'], run: p8t2 },
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

async function main(): Promise<number> {
  const { values: o, positionals: [cmd, sub] } = parseArgs({ allowPositionals: true, options: {
    base: { type: 'string' }, tier: { type: 'string', multiple: true }, only: { type: 'string' }, profile: { type: 'string' },
    gonogo: { type: 'boolean' }, bin: { type: 'string' }, port: { type: 'string' }, 'web-dir': { type: 'string' } } });
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
