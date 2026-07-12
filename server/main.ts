import { loadConfig } from './config.ts';
import { initAuth } from './auth.ts';
import { createHerdrClient } from './herdr-client.ts';
import { createHttpServer } from './http.ts';
import { sendNtfyNotification } from './notify.ts';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedState, StatusChange } from './types.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(join(__dirname, '..', 'web'));

const config = loadConfig();
const token = initAuth(config.stateDir);

let currentState: NormalizedState | null = null;
let httpServer: ReturnType<typeof import('node:http').createServer> | null = null;
let broadcastState: ((state: NormalizedState) => void) | null = null;
let broadcastAgentStatus: ((change: StatusChange, state: NormalizedState) => void) | null = null;

const herdrClient = createHerdrClient({
  socketPath: config.socketPath,

  onState(state: NormalizedState) {
    currentState = state;
    broadcastState?.(state);
  },

  onAgentStatus(change: StatusChange, state: NormalizedState) {
    currentState = state;
    broadcastAgentStatus?.(change, state);
    sendNtfyNotification(change, state, config.notifyUrl).catch(() => {});
  },

  onConnectionChange(isConnected: boolean) {
    console.log(`[herdr] ${isConnected ? 'connected' : 'disconnected'}`);
  },
});

const http = createHttpServer({
  webRoot: WEB_ROOT,
  herdrClient,
  getState: () => currentState,
  config,
});

httpServer = http.server;
broadcastState = http.broadcastState;
broadcastAgentStatus = http.broadcastAgentStatus;

httpServer.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`herdr-mobile listening on ${base}`);
  console.log(`connect: ${base}?token=${token}`);
});

herdrClient.start();

function shutdown(): void {
  console.log('[herdr-mobile] shutting down');
  herdrClient.destroy();
  httpServer!.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  console.error('[herdr-mobile] unhandled rejection:', reason);
});
