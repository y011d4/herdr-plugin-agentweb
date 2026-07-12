import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function loadFileConfig() {
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!configDir) return {};
  try {
    const raw = readFileSync(join(configDir, 'config.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function resolveStateDir() {
  return (
    process.env.HERDR_PLUGIN_STATE_DIR ||
    join(homedir(), '.local', 'state', 'herdr-mobile')
  );
}

function resolveSocketPath() {
  return (
    process.env.HERDR_SOCKET_PATH ||
    join(homedir(), '.config', 'herdr', 'herdr.sock')
  );
}

export function loadConfig() {
  const file = loadFileConfig();

  const host =
    process.env.HERDR_MOBILE_HOST ||
    file.host ||
    '127.0.0.1';

  const port =
    process.env.HERDR_MOBILE_PORT
      ? parseInt(process.env.HERDR_MOBILE_PORT, 10)
      : (file.port ?? 8390);

  const notifyUrl = file.notify_url || null;

  return {
    host,
    port,
    notifyUrl,
    stateDir: resolveStateDir(),
    socketPath: resolveSocketPath(),
  };
}
