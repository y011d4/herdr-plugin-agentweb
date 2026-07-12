import { loadConfig } from './config.js';
import { initAuth } from './auth.js';
import { createHerdrClient } from './herdr-client.js';
import { createHttpServer } from './http.js';
import { sendNtfyNotification } from './notify.js';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(join(__dirname, '..', 'web'));

const config = loadConfig();
const token = initAuth(config.stateDir);

let currentState = null;
let httpServer = null;
let broadcastState = null;
let broadcastAgentStatus = null;

const herdrClient = createHerdrClient({
  socketPath: config.socketPath,

  onState(state) {
    currentState = state;
    broadcastState?.(state);
  },

  onAgentStatus(change, state) {
    currentState = state;
    broadcastAgentStatus?.(change, state);
    sendNtfyNotification(change, state, config.notifyUrl).catch(() => {});
  },

  onConnectionChange(isConnected) {
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

function shutdown() {
  console.log('[herdr-mobile] shutting down');
  herdrClient.destroy();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  console.error('[herdr-mobile] unhandled rejection:', reason);
});
