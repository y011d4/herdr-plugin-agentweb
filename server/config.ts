import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from './types.ts';

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
    join(homedir(), '.local', 'state', 'herdr-mobile')
  );
}

function resolveSocketPath(): string {
  return (
    process.env.HERDR_SOCKET_PATH ||
    join(homedir(), '.config', 'herdr', 'herdr.sock')
  );
}

export function loadConfig(): Config {
  const file = loadFileConfig();

  const host =
    process.env.HERDR_MOBILE_HOST ||
    (typeof file.host === 'string' ? file.host : null) ||
    '127.0.0.1';

  const port =
    process.env.HERDR_MOBILE_PORT
      ? parseInt(process.env.HERDR_MOBILE_PORT, 10)
      : (typeof file.port === 'number' ? file.port : 8390);

  const notifyUrl = typeof file.notify_url === 'string' ? file.notify_url : null;

  return {
    host,
    port,
    notifyUrl,
    stateDir: resolveStateDir(),
    socketPath: resolveSocketPath(),
  };
}
