import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken, extractToken } from './auth.ts';
import { toClientState } from './state.ts';
import { buildAgentStatusMessage } from './notify.ts';
import type { HerdrClient, NormalizedState, StatusChange, Config } from './types.ts';

const BODY_LIMIT = 64 * 1024; // 64 KB
const PANE_WATCH_INTERVAL_MS = 800; // server-side poll rate for watched panes

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ── pane routes: id segment is any non-slash text (pane ids contain ':') ──
const PANE_RE = /^\/api\/panes\/([^/]+)\/(\w+)$/;
const AGENT_RE = /^\/api\/agents\/([^/]+)\/(\w+)$/;

interface HerdrError extends Error {
  herdrCode?: string;
  status?: number;
}

function mapHerdrError(err: HerdrError): number {
  const code = err.herdrCode;
  if (code === 'not_found') return 404;
  // herdr returns a clean error (not a connection drop) for an unsupported key
  // name in pane.send_input; surface it as a client error, not a 502.
  if (code === 'invalid_params' || code === 'invalid_request' || code === 'invalid_key') return 400;
  return 502;
}

function jsonError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message } }));
}

function jsonOk(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// decodeURIComponent throws a URIError on malformed percent-encoding; return
// null so callers can answer with a clean 400 instead of an unhandled rejection.
function decodePathSegment(seg: string): string | null {
  try { return decodeURIComponent(seg); } catch { return null; }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    const fail = (err: HerdrError) => {
      if (!settled) { settled = true; reject(err); }
    };
    req.on('data', (chunk: Buffer) => {
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
      let parsed: unknown;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        parsed = text ? JSON.parse(text) : {};
      } catch {
        fail(Object.assign(new Error('invalid JSON body'), { status: 400 }));
        return;
      }
      // Reject non-object JSON (null, arrays, primitives) so route handlers can
      // safely read/spread body fields without throwing outside this guard.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fail(Object.assign(new Error('invalid JSON body'), { status: 400 }));
        return;
      }
      settled = true;
      resolve(parsed as Record<string, unknown>);
    });
    req.on('error', fail);
  });
}

function serveStatic(webRoot: string, urlPath: string, res: ServerResponse): void {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const abs = resolve(join(webRoot, rel));
  // path traversal guard
  if (!abs.startsWith(webRoot + '/') && abs !== webRoot) {
    jsonError(res, 403, 'forbidden', 'forbidden');
    return;
  }
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    jsonError(res, 404, 'not_found', 'not found');
    return;
  }
  if (!st.isFile()) {
    // directories (and other non-files) would make createReadStream emit an
    // unhandled EISDIR and crash the process — treat them as not found
    jsonError(res, 404, 'not_found', 'not found');
    return;
  }
  const mime = MIME[extname(abs)] || 'application/octet-stream';
  const stream = createReadStream(abs);
  stream.on('error', () => { res.destroy(); }); // e.g. file removed after stat
  res.writeHead(200, { 'Content-Type': mime });
  stream.pipe(res);
}

export interface HttpServerResult {
  server: ReturnType<typeof createServer>;
  broadcastState: (state: NormalizedState) => void;
  broadcastAgentStatus: (change: StatusChange, state: NormalizedState) => void;
}

export function createHttpServer({ webRoot, herdrClient, getState, config: _config }: {
  webRoot: string;
  herdrClient: HerdrClient;
  getState: () => NormalizedState | null;
  config: Config;
}): HttpServerResult {
  const wsClients = new Set<WebSocket>();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
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
      const paneId = decodePathSegment(paneMatch[1]);
      if (paneId === null) {
        jsonError(res, 400, 'invalid_params', 'malformed pane id');
        return;
      }
      const action = paneMatch[2];

      if (action === 'read' && method === 'GET') {
        const source = url.searchParams.get('source') || 'visible';
        const linesParam = url.searchParams.get('lines');
        const lines = linesParam ? parseInt(linesParam, 10) : undefined;
        const format = url.searchParams.get('format') || 'text';
        const stripAnsi = url.searchParams.get('strip_ansi') === 'true';
        // validate enums here: herdr drops the connection without a response
        // on an invalid request variant, which surfaces as an opaque
        // "connection closed" — return a clear 400 instead
        if (!['visible', 'recent', 'recent_unwrapped', 'detection'].includes(source)) {
          jsonError(res, 400, 'invalid_params', `invalid source: ${source}`);
          return;
        }
        if (!['text', 'ansi'].includes(format)) {
          jsonError(res, 400, 'invalid_params', `invalid format: ${format}`);
          return;
        }
        if (lines !== undefined && (!Number.isInteger(lines) || lines < 0)) {
          jsonError(res, 400, 'invalid_params', `invalid lines: ${linesParam}`);
          return;
        }
        try {
          const params: Record<string, unknown> = { pane_id: paneId, source, format };
          if (lines != null) params.lines = lines;
          if (stripAnsi) params.strip_ansi = true;
          const result = await herdrClient.rpc('pane.read', params) as Record<string, unknown>;
          // Unwrap herdr's {type, read: {text, ...}} envelope to contract shape {text?} or {ansi?}.
          // herdr always puts the content in read.text; format=ansi means that text contains ANSI escapes.
          const inner = (result.read ?? result) as Record<string, unknown>;
          const out = format === 'ansi'
            ? { ansi: inner.text ?? null }
            : { text: inner.text ?? null };
          jsonOk(res, out);
        } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, mapHerdrError(herdrErr), herdrErr.herdrCode || 'error', herdrErr.message);
        }
        return;
      }

      if (action === 'input' && method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await readBody(req); } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, herdrErr.status || 400, 'bad_request', herdrErr.message);
          return;
        }
        if (body.keys !== undefined &&
            !(Array.isArray(body.keys) && body.keys.every((k) => typeof k === 'string'))) {
          jsonError(res, 400, 'invalid_params', 'keys must be an array of strings');
          return;
        }
        if (body.text != null && typeof body.text !== 'string') {
          jsonError(res, 400, 'invalid_params', 'text must be a string');
          return;
        }
        const keys = [...((body.keys as string[] | undefined) ?? [])];
        if (body.enter) keys.push('enter');
        const params: Record<string, unknown> = { pane_id: paneId };
        if (body.text != null) params.text = body.text;
        if (keys.length > 0) params.keys = keys;
        try {
          await herdrClient.rpc('pane.send_input', params);
          jsonOk(res, { ok: true });
        } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, mapHerdrError(herdrErr), herdrErr.herdrCode || 'error', herdrErr.message);
        }
        return;
      }

      if (action === 'focus' && method === 'POST') {
        try {
          await herdrClient.rpc('pane.focus', { pane_id: paneId });
          jsonOk(res, { ok: true });
        } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, mapHerdrError(herdrErr), herdrErr.herdrCode || 'error', herdrErr.message);
        }
        return;
      }

      // Scroll a full-screen app's own view (claude etc.) by sending real SGR
      // mouse wheel events. These must go through pane.send_text as raw bytes:
      // pane.send_input wraps text in bracketed paste when the app enables it,
      // and the app then discards the control sequences.
      if (action === 'scroll' && method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await readBody(req); } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, herdrErr.status || 400, 'bad_request', herdrErr.message);
          return;
        }
        const direction = body.direction;
        if (direction !== 'up' && direction !== 'down') {
          jsonError(res, 400, 'invalid_params', `invalid direction: ${String(direction)}`);
          return;
        }
        const steps = Math.max(1, Math.min(30, Math.floor(typeof body.steps === 'number' ? body.steps : 1)));
        const seq = (direction === 'up' ? '\u001b[<64;10;5M' : '\u001b[<65;10;5M').repeat(steps);
        try {
          await herdrClient.rpc('pane.send_text', { pane_id: paneId, text: seq });
          jsonOk(res, { ok: true });
        } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, mapHerdrError(herdrErr), herdrErr.herdrCode || 'error', herdrErr.message);
        }
        return;
      }

      jsonError(res, 404, 'not_found', 'unknown pane endpoint');
      return;
    }

    const agentMatch = AGENT_RE.exec(pathname);
    if (agentMatch) {
      const target = decodePathSegment(agentMatch[1]);
      if (target === null) {
        jsonError(res, 400, 'invalid_params', 'malformed agent id');
        return;
      }
      const action = agentMatch[2];

      if (action === 'send' && method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await readBody(req); } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, herdrErr.status || 400, 'bad_request', herdrErr.message);
          return;
        }
        if (body.text != null && typeof body.text !== 'string') {
          jsonError(res, 400, 'invalid_params', 'text must be a string');
          return;
        }
        try {
          await herdrClient.rpc('agent.send', { target, text: body.text || '' });
          jsonOk(res, { ok: true });
        } catch (err) {
          const herdrErr = err as HerdrError;
          jsonError(res, mapHerdrError(herdrErr), herdrErr.herdrCode || 'error', herdrErr.message);
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

  server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
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

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wsClients.add(ws);
      const state = getState();
      if (state) {
        ws.send(JSON.stringify({ type: 'state', state: toClientState(state) }));
      }

      // Pane watch: while a client views a pane, poll it server-side over the
      // cheap unix socket and push output only when it actually changed. This
      // gives near-real-time keypress echo without client-side fast polling.
      let watchedPaneId: string | null = null;
      let watchTimer: ReturnType<typeof setInterval> | null = null;
      let lastOutput: string | null = null;
      let readInFlight = false;

      const stopWatch = (): void => {
        if (watchTimer) clearInterval(watchTimer);
        watchTimer = null;
        watchedPaneId = null;
        lastOutput = null;
      };

      const pollWatchedPane = async (): Promise<void> => {
        if (!watchedPaneId || readInFlight || ws.readyState !== WebSocket.OPEN) return;
        readInFlight = true;
        const paneId = watchedPaneId;
        try {
          const result = (await herdrClient.rpc('pane.read', {
            pane_id: paneId,
            source: 'visible',
            lines: 200,
            format: 'ansi',
          })) as { read?: { text?: string } };
          const ansi = result.read?.text ?? '';
          if (paneId === watchedPaneId && ansi !== lastOutput && ws.readyState === WebSocket.OPEN) {
            lastOutput = ansi;
            ws.send(JSON.stringify({ type: 'pane_output', paneId, ansi }));
          }
        } catch {
          // Transient herdr/read errors must not kill the watch — the client only
          // falls back to HTTP polling when the socket drops, so stopping on a
          // brief outage would freeze the view for the session. But a pane that
          // has vanished from the snapshot is gone for good: stop polling it and
          // tell the client to leave, rather than failing every 800ms forever.
          if (paneId === watchedPaneId) {
            const state = getState();
            if (state && !state._paneById.has(paneId)) {
              stopWatch();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'pane_gone', paneId }));
              }
            }
          }
        } finally {
          readInFlight = false;
        }
      };

      ws.on('message', (data: Buffer) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(data.toString()) as Record<string, unknown>; } catch { return; }
        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg?.type === 'watch_pane' && typeof msg.paneId === 'string') {
          stopWatch();
          watchedPaneId = msg.paneId;
          watchTimer = setInterval(() => { void pollWatchedPane(); }, PANE_WATCH_INTERVAL_MS);
          void pollWatchedPane();
        } else if (msg?.type === 'unwatch_pane') {
          stopWatch();
        }
      });

      ws.on('close', () => { stopWatch(); wsClients.delete(ws); });
      ws.on('error', () => { stopWatch(); wsClients.delete(ws); });
    });
  });

  // ── broadcast helpers (called by main.ts) ─────────────────────────────────

  let lastStateMsg: string | null = null;

  function broadcastState(state: NormalizedState): void {
    const msg = JSON.stringify({ type: 'state', state: toClientState(state) });
    // focus churn in the TUI produces frequent no-op state updates; skip resends.
    // The dedupe baseline is updated even with no clients connected, so a client
    // that connects during a lull isn't left stale when state later returns to a
    // previously-broadcast value (its initial snapshot came straight from getState).
    if (msg === lastStateMsg) return;
    lastStateMsg = msg;
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  function broadcastAgentStatus(change: StatusChange, state: NormalizedState): void {
    if (wsClients.size === 0) return;
    const msg = JSON.stringify(buildAgentStatusMessage(change, state));
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  return { server, broadcastState, broadcastAgentStatus };
}
