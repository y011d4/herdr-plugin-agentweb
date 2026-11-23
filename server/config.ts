import { readFileSync } from 'node:fs';
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

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const expandDir = (dir: string, home: string): string => dir.trim().replace(/^~(?=\/|$)/, home).replace(/\/+$/, '');

/**
 * config `orchestrators: [{ name, label?, dir }]`, in order. Malformed entries and
 * repeated names are dropped; with none left, the legacy single `orchestrator_dir`
 * (or its default dir) is the one orchestrator, so an old config keeps working.
 */
export function parseOrchestrators(raw: unknown, legacyDir: unknown, home = homedir()): OrchestratorDef[] {
  const out: OrchestratorDef[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const { name, label, dir } = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>;
    // name goes into the app's #/home/<name> route: keep it a plain slug
    if (!nonEmpty(name) || !/^[A-Za-z0-9_-]+$/.test(name) || !nonEmpty(dir)) continue;
    if (out.some((o) => o.name === name)) continue;
    out.push({ name, label: nonEmpty(label) ? label.trim() : name, dir: expandDir(dir, home) });
  }
  if (out.length > 0) return out;
  const dir = nonEmpty(legacyDir) ? legacyDir : join(home, '.local', 'share', 'herdr-agentweb', 'dispatcher');
  return [{ name: 'default', label: '', dir: expandDir(dir, home) }];
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
