import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { WebSocketServer } from 'ws';
import { verifyToken, extractToken } from './auth.js';
import { toClientState } from './state.js';
import { buildAgentStatusMessage } from './notify.js';

const BODY_LIMIT = 64 * 1024; // 64 KB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── pane id pattern: one or more word chars, colon, one or more word chars ──
const PANE_RE = /^\/api\/panes\/([^/]+)\/(\w+)$/;
const AGENT_RE = /^\/api\/agents\/([^/]+)\/(\w+)$/;

function mapHerdrError(err) {
  const code = err.herdrCode;
  if (code === 'not_found') return 404;
  if (code === 'invalid_params' || code === 'invalid_request') return 400;
  return 502;
}

function jsonError(res, status, code, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function jsonOk(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const chunks = [];
    const fail = (err) => {
      if (!settled) { settled = true; reject(err); }
    };
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) {
        fail(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        settled = true;
        resolve(text ? JSON.parse(text) : {});
      } catch {
        fail(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', fail);
  });
}

function serveStatic(webRoot, urlPath, res) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = resolve(join(webRoot, rel));
  // path traversal guard
  if (!abs.startsWith(webRoot + '/') && abs !== webRoot) {
    jsonError(res, 403, 'forbidden', 'forbidden');
    return;
  }
  try {
    statSync(abs);
  } catch {
    jsonError(res, 404, 'not_found', 'not found');
    return;
  }
  const mime = MIME[extname(abs)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  createReadStream(abs).pipe(res);
}

export function createHttpServer({ webRoot, herdrClient, getState, config }) {
  const wsClients = new Set();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = req.method;

    // ── healthz (no auth) ──────────────────────────────────────────────────
    if (pathname === '/healthz') {
      jsonOk(res, { ok: true, herdrConnected: herdrClient.isConnected() });
      return;
    }

    // ── static files (no auth) ─────────────────────────────────────────────
    if (!pathname.startsWith('/api') && !pathname.startsWith('/ws')) {
      serveStatic(webRoot, pathname, res);
      return;
    }

    // ── auth check for /api ────────────────────────────────────────────────
    if (pathname.startsWith('/api')) {
      const token = extractToken(req);
      if (!verifyToken(token)) {
        jsonError(res, 401, 'unauthorized', 'missing or invalid token');
        return;
      }
    }

    // ── REST routes ────────────────────────────────────────────────────────

    if (pathname === '/api/state' && method === 'GET') {
      const state = getState();
      if (!state) {
        jsonError(res, 502, 'unavailable', 'herdr not connected');
        return;
      }
      jsonOk(res, toClientState(state));
      return;
    }

    const paneMatch = PANE_RE.exec(pathname);
    if (paneMatch) {
      const paneId = decodeURIComponent(paneMatch[1]);
      const action = paneMatch[2];

      if (action === 'read' && method === 'GET') {
        const source = url.searchParams.get('source') || 'visible';
        const lines = url.searchParams.get('lines') ? parseInt(url.searchParams.get('lines'), 10) : undefined;
        const format = url.searchParams.get('format') || 'text';
        const stripAnsi = url.searchParams.get('strip_ansi') === 'true';
        try {
          const params = { pane_id: paneId, source, format };
          if (lines != null) params.lines = lines;
          if (stripAnsi) params.strip_ansi = true;
          const result = await herdrClient.rpc('pane.read', params);
          // Unwrap herdr's {type, read: {text, ...}} envelope to contract shape {text?} or {ansi?}.
          // herdr always puts the content in read.text; format=ansi means that text contains ANSI escapes.
          const inner = result.read ?? result;
          const out = format === 'ansi'
            ? { ansi: inner.text ?? null }
            : { text: inner.text ?? null };
          jsonOk(res, out);
        } catch (err) {
          jsonError(res, mapHerdrError(err), err.herdrCode || 'error', err.message);
        }
        return;
      }

      if (action === 'input' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (err) {
          jsonError(res, err.status || 400, 'bad_request', err.message);
          return;
        }
        const keys = [...(body.keys || [])];
        if (body.enter) keys.push('enter');
        const params = { pane_id: paneId };
        if (body.text != null) params.text = body.text;
        if (keys.length > 0) params.keys = keys;
        try {
          await herdrClient.rpc('pane.send_input', params);
          jsonOk(res, { ok: true });
        } catch (err) {
          jsonError(res, mapHerdrError(err), err.herdrCode || 'error', err.message);
        }
        return;
      }

      if (action === 'focus' && method === 'POST') {
        try {
          await herdrClient.rpc('pane.focus', { pane_id: paneId });
          jsonOk(res, { ok: true });
        } catch (err) {
          jsonError(res, mapHerdrError(err), err.herdrCode || 'error', err.message);
        }
        return;
      }

      jsonError(res, 404, 'not_found', 'unknown pane endpoint');
      return;
    }

    const agentMatch = AGENT_RE.exec(pathname);
    if (agentMatch) {
      const target = decodeURIComponent(agentMatch[1]);
      const action = agentMatch[2];

      if (action === 'send' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (err) {
          jsonError(res, err.status || 400, 'bad_request', err.message);
          return;
        }
        try {
          await herdrClient.rpc('agent.send', { target, text: body.text || '' });
          jsonOk(res, { ok: true });
        } catch (err) {
          jsonError(res, mapHerdrError(err), err.herdrCode || 'error', err.message);
        }
        return;
      }

      jsonError(res, 404, 'not_found', 'unknown agent endpoint');
      return;
    }

    jsonError(res, 404, 'not_found', 'not found');
  });

  // ── WebSocket server ───────────────────────────────────────────────────────

  // the only expected inbound WS message is a small ping — cap payloads
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const token = extractToken(req);
    if (!verifyToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wsClients.add(ws);
      const state = getState();
      if (state) {
        ws.send(JSON.stringify({ type: 'state', state: toClientState(state) }));
      }

      ws.on('message', data => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      });

      ws.on('close', () => wsClients.delete(ws));
      ws.on('error', () => wsClients.delete(ws));
    });
  });

  // ── broadcast helpers (called by main.js) ─────────────────────────────────

  let lastStateMsg = null;

  function broadcastState(state) {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify({ type: 'state', state: toClientState(state) });
    // focus churn in the TUI produces frequent no-op state updates; skip resends
    if (msg === lastStateMsg) return;
    lastStateMsg = msg;
    for (const ws of wsClients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  function broadcastAgentStatus(change, state) {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify(buildAgentStatusMessage(change, state));
    for (const ws of wsClients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  return { server, broadcastState, broadcastAgentStatus };
}
