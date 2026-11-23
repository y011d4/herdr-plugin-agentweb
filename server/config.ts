import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config, OrchestratorDef } from './types.ts';
import { parseLaunchProfiles } from './agent-lifecycle.ts';

function loadFileConfig(): Record<string, unknown> {
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!configDir) return {};
  try {
    const raw = readFileSync(join(configDir, 'config.json'), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveStateDir(): string {
  return (
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(homedir(), '.local', 'state', 'herdr-agentweb')
  );
}

function resolveSocketPath(): string {
  return (
    process.env.HERDR_SOCKET_PATH ||
    join(homedir(), '.config', 'herdr', 'herdr.sock')
  );
}

/** Where the plugin keeps its data, the managed orchestrators' dirs among it. */
export function dataDir(home = homedir()): string {
  return join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'herdr-agentweb');
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const expandHome = (v: string, home: string): string => v.trim().replace(/^~(?=\/|$)/, home);
const expandDir = (dir: string, home: string): string => expandHome(dir, home).replace(/\/+$/, '');

/**
 * config `orchestrators: [{ name, label?, env? }]`, in order. Each is managed by the
 * plugin in <data>/orchestrators/<name> and started with its `env` (string values; a
 * leading ~ is expanded, so `"CLAUDE_CONFIG_DIR": "~/.config/claude/work"` works).
 * Malformed entries and repeated names are dropped. With none left, the older setup
 * stays as it was: the single `orchestrator_dir`, else the old default dir
 * (<data>/dispatcher) when it exists — both unmanaged, as the user's own dir — else
 * one managed orchestrator named `default`.
 */
export function parseOrchestrators(
  raw: unknown,
  legacyDir: unknown,
  home = homedir(),
  data = dataDir(home),
  exists: (p: string) => boolean = existsSync,
): OrchestratorDef[] {
  const out: OrchestratorDef[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const { name, label, env } = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    // name is a dir name and goes into the app's #/home/<name> route: keep it a plain slug
    if (!nonEmpty(name) || !/^[A-Za-z0-9_-]+$/.test(name) || out.some((o) => o.name === name)) continue;
    const vars: Record<string, string> = {};
    if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
      for (const [k, v] of Object.entries(env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string') vars[k] = expandHome(v, home);
    }
    out.push({ name, label: nonEmpty(label) ? label.trim() : name, dir: join(data, 'orchestrators', name), env: vars, managed: true });
  }
  if (out.length > 0) return out;
  const legacy = nonEmpty(legacyDir) ? expandDir(legacyDir, home) : join(data, 'dispatcher');
  if (nonEmpty(legacyDir) || exists(legacy)) return [{ name: 'default', label: '', dir: legacy, env: {}, managed: false }];
  return [{ name: 'default', label: '', dir: join(data, 'orchestrators', 'default'), env: {}, managed: true }];
}

export function loadConfig(): Config {
  const file = loadFileConfig();

  const host =
    process.env.HERDR_AGENTWEB_HOST ||
    (typeof file.host === 'string' ? file.host : null) ||
    '127.0.0.1';

  const port =
    process.env.HERDR_AGENTWEB_PORT
      ? parseInt(process.env.HERDR_AGENTWEB_PORT, 10)
      : (typeof file.port === 'number' ? file.port : 8390);

  const notifyUrl = typeof file.notify_url === 'string' ? file.notify_url : null;

  const publicUrl =
    typeof file.public_url === 'string' && file.public_url.trim() !== ''
      ? file.public_url.trim().replace(/\/+$/, '')
      : null;

  return {
    host,
    port,
    notifyUrl,
    publicUrl,
    stateDir: resolveStateDir(),
    socketPath: resolveSocketPath(),
    launchProfiles: parseLaunchProfiles(file.launch_profiles),
    orchestrators: parseOrchestrators(file.orchestrators, file.orchestrator_dir),
  };
}
