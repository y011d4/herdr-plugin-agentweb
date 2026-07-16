import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken, extractToken } from './auth.ts';
import { toClientState } from './state.ts';
import { buildAgentStatusMessage } from './notify.ts';
import { resolveTranscriptPath, readTranscriptFrom, readTranscriptTail } from './transcript.ts';
import type { HerdrClient, NormalizedState, StatusChange, Config } from './types.ts';

const BODY_LIMIT = 64 * 1024; // 64 KB
const PANE_WATCH_INTERVAL_MS = 800; // server-side poll rate for watched panes
const TRANSCRIPT_WATCH_INTERVAL_MS = 1000; // poll rate for a watched chat transcript
const TRANSCRIPT_RESOLVE_INTERVAL_MS = 5000; // re-resolve session id (pane.get + dir scan) at most this often
const TRANSCRIPT_INITIAL_ITEMS = 300; // last-N items sent on initial chat load

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
  const headers: Record<string, string> = { 'Content-Type': mime };
  // Always revalidate the service worker and the HTML shell so a new build is
  // detected without a manual cache clear (the SW versions the other assets and
  // re-caches them on activate). Without this a stale sw.js can pin an old bundle
  // across reloads, especially in an installed PWA.
  const base = abs.slice(abs.lastIndexOf('/') + 1);
  if (base === 'sw.js' || extname(abs) === '.html') {
    headers['Cache-Control'] = 'no-cache';
  }
  const stream = createReadStream(abs);
  stream.on('error', () => { res.destroy(); }); // e.g. file removed after stat
  res.writeHead(200, headers);
  stream.pipe(res);
}

interface RawPaneInfo {
  agent?: string;
  scroll?: { max_offset_from_bottom?: number; viewport_rows?: number };
}

// pane.get also returns the claude session identity and cwd, used to locate the
// pane's transcript on disk for the chat view.
interface RawPaneFull extends RawPaneInfo {
  agent_session?: { value?: string; source?: string };
  cwd?: string;
  foreground_cwd?: string;
}

// Locate a pane's Claude Code transcript: fetch its session id + cwd from herdr,
// then resolve the on-disk JSONL. Returns nulls when the pane isn't a claude
// session or its transcript isn't on this host (→ chat view unavailable).
async function resolvePaneTranscript(
  herdrClient: HerdrClient,
  paneId: string,
): Promise<{ sessionId: string | null; file: string | null }> {
  try {
    const info = (await herdrClient.rpc('pane.get', { pane_id: paneId })) as { pane?: RawPaneFull };
    const sess = info.pane?.agent_session;
    const sessionId = sess?.source?.startsWith('herdr:claude') && typeof sess.value === 'string' ? sess.value : null;
    const cwd = info.pane?.foreground_cwd || info.pane?.cwd || null;
    return { sessionId, file: sessionId ? resolveTranscriptPath(sessionId, cwd) : null };
  } catch {
    return { sessionId: null, file: null };
  }
}

// Whether a pane should receive forwarded SGR wheel events: it must run an
// agent, have no terminal scrollback (a full-screen alt-screen app keeps none),
// and actually paint most of the viewport. A normal pane whose output merely
// fits the screen has few filled rows and must keep local scrolling, so wheel
// bytes aren't injected as unexpected mouse sequences.
function computeAppScroll(pane: RawPaneInfo | undefined, ansi: string): boolean {
  if (!pane?.agent) return false;
  const maxOffset = pane.scroll?.max_offset_from_bottom;
  const viewportRows = pane.scroll?.viewport_rows;
  if (maxOffset !== 0 || typeof viewportRows !== 'number' || viewportRows <= 0) return false;
  const nonEmpty = ansi.split('\n').filter((l) => l.trim() !== '').length;
  return nonEmpty >= viewportRows * 0.6;
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
          const text = (inner.text ?? null) as string | null;
          const out: Record<string, unknown> = format === 'ansi' ? { ansi: text } : { text };
          // For the live screen, attach the same server-side app-scroll decision
          // the WS watch pushes, so the HTTP fallback (used while the socket is
          // down) keeps wheel forwarding correct instead of stuck at false.
          if (source === 'visible') {
            try {
              const info = (await herdrClient.rpc('pane.get', { pane_id: paneId })) as { pane?: RawPaneInfo };
              out.appScroll = computeAppScroll(info.pane, text ?? '');
            } catch { /* best-effort; omit appScroll if pane.get fails */ }
          }
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
        if (body.enter !== undefined && typeof body.enter !== 'boolean') {
          jsonError(res, 400, 'invalid_params', 'enter must be a boolean');
          return;
        }
        const keys = [...((body.keys as string[] | undefined) ?? [])];
        if (body.enter === true) keys.push('enter'); // strict: a string like "false" must not submit
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

      // Structured chat view: the pane's Claude Code JSONL transcript as
      // TimelineItems. `?session=<id>&after=<cursor>` fetches only items past a
      // byte cursor for the same session (HTTP-fallback polling); otherwise the
      // recent tail is returned with reset=true. available=false → not a claude
      // pane, or its transcript isn't on this host (client keeps the terminal).
      if (action === 'transcript' && method === 'GET') {
        const { sessionId, file } = await resolvePaneTranscript(herdrClient, paneId);
        if (!sessionId || !file) {
          jsonOk(res, { available: false });
          return;
        }
        const sessionParam = url.searchParams.get('session');
        const afterParam = url.searchParams.get('after');
        const after = afterParam !== null ? parseInt(afterParam, 10) : NaN;
        if (sessionParam === sessionId && Number.isInteger(after) && after >= 0) {
          // reset=true when `after` is too far behind (readTranscriptFrom bounds
          // the read and returns a rebuilt tail); the client replaces, not appends.
          const { items, cursor, reset } = readTranscriptFrom(file, after, TRANSCRIPT_INITIAL_ITEMS);
          jsonOk(res, { available: true, sessionId, items, cursor, reset });
        } else {
          const { items, cursor, truncated } = readTranscriptTail(file, TRANSCRIPT_INITIAL_ITEMS);
          jsonOk(res, { available: true, sessionId, items, cursor, reset: true, truncated });
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
      let lastAppScroll: boolean | null = null;
      let readInFlight = false;

      const stopWatch = (): void => {
        if (watchTimer) clearInterval(watchTimer);
        watchTimer = null;
        watchedPaneId = null;
        lastOutput = null;
        lastAppScroll = null;
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
          // Fresh scroll metadata (pane.get, a cheap single-pane query) drives the
          // app-scroll decision. Fetch it in its own try so a metadata blip can't
          // drop the output we already read — keep the last appScroll (or false)
          // and still push the content, since the client stops polling while the
          // socket is connected.
          let appScroll = lastAppScroll ?? false;
          try {
            const info = (await herdrClient.rpc('pane.get', { pane_id: paneId })) as { pane?: RawPaneInfo };
            appScroll = computeAppScroll(info.pane, ansi);
          } catch { /* keep previous appScroll; pane.read already succeeded */ }
          if (paneId === watchedPaneId && (ansi !== lastOutput || appScroll !== lastAppScroll)
              && ws.readyState === WebSocket.OPEN) {
            lastOutput = ansi;
            lastAppScroll = appScroll;
            ws.send(JSON.stringify({ type: 'pane_output', paneId, ansi, appScroll }));
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

      // Transcript watch: while a client views a claude pane in chat mode, tail
      // its JSONL transcript and push new TimelineItems. Independent of the pane
      // watch above (the client runs one or the other per view mode). The session
      // id is re-resolved (a pane.get RPC + projects-dir scan) only every
      // TRANSCRIPT_RESOLVE_INTERVAL_MS to catch a mid-session reset (/clear → new
      // session file); the resolved file is tailed cheaply on every tick.
      let watchedTranscriptPaneId: string | null = null;
      let transcriptTimer: ReturnType<typeof setInterval> | null = null;
      let transcriptSessionId: string | null = null; // '' = last resolved unavailable
      let transcriptFile: string | null = null;
      let transcriptCursor = 0;
      let transcriptResolveAt = 0; // last session-id resolution (Date.now())
      let transcriptPollInFlight = false;

      const stopTranscriptWatch = (): void => {
        if (transcriptTimer) clearInterval(transcriptTimer);
        transcriptTimer = null;
        watchedTranscriptPaneId = null;
        transcriptSessionId = null;
        transcriptFile = null;
        transcriptCursor = 0;
        transcriptResolveAt = 0;
      };

      const pollTranscript = async (): Promise<void> => {
        if (!watchedTranscriptPaneId || transcriptPollInFlight || ws.readyState !== WebSocket.OPEN) return;
        transcriptPollInFlight = true;
        const paneId = watchedTranscriptPaneId;
        try {
          // Throttled re-resolution: catches a session switch without a per-tick
          // herdr RPC + directory scan (transcriptResolveAt starts 0 → first tick
          // always resolves).
          if (Date.now() - transcriptResolveAt >= TRANSCRIPT_RESOLVE_INTERVAL_MS) {
            transcriptResolveAt = Date.now();
            const { sessionId, file } = await resolvePaneTranscript(herdrClient, paneId);
            if (paneId !== watchedTranscriptPaneId || ws.readyState !== WebSocket.OPEN) return;
            if (!sessionId || !file) {
              // Not a claude pane, or transcript not on this host — tell the
              // client once so it falls back to the terminal, then keep it flagged.
              if (transcriptSessionId !== '') {
                transcriptSessionId = '';
                transcriptFile = null;
                ws.send(JSON.stringify({ type: 'transcript_items', paneId, available: false, reset: true, items: [], cursor: 0 }));
              }
              return;
            }
            if (sessionId !== transcriptSessionId || file !== transcriptFile) {
              // First resolve for this session (or a mid-session switch): send the tail.
              transcriptSessionId = sessionId;
              transcriptFile = file;
              const { items, cursor } = readTranscriptTail(file, TRANSCRIPT_INITIAL_ITEMS);
              transcriptCursor = cursor;
              ws.send(JSON.stringify({ type: 'transcript_items', paneId, available: true, sessionId, items, cursor, reset: true }));
              return;
            }
          }
          // Cheap incremental tail of the already-resolved file every tick.
          if (transcriptFile && transcriptSessionId) {
            const { items, cursor, reset } = readTranscriptFrom(transcriptFile, transcriptCursor, TRANSCRIPT_INITIAL_ITEMS);
            transcriptCursor = cursor;
            if (reset || items.length > 0) {
              ws.send(JSON.stringify({ type: 'transcript_items', paneId, available: true, sessionId: transcriptSessionId, items, cursor, reset }));
            }
          }
        } catch {
          // transient herdr/file errors — keep watching, retry next tick
        } finally {
          transcriptPollInFlight = false;
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
        } else if (msg?.type === 'watch_transcript' && typeof msg.paneId === 'string') {
          stopTranscriptWatch();
          watchedTranscriptPaneId = msg.paneId;
          transcriptTimer = setInterval(() => { void pollTranscript(); }, TRANSCRIPT_WATCH_INTERVAL_MS);
          void pollTranscript();
        } else if (msg?.type === 'unwatch_transcript') {
          stopTranscriptWatch();
        }
      });

      ws.on('close', () => { stopWatch(); stopTranscriptWatch(); wsClients.delete(ws); });
      ws.on('error', () => { stopWatch(); stopTranscriptWatch(); wsClients.delete(ws); });
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
