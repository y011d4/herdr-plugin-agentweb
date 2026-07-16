# herdr-plugin-agentweb

herdr plugin: a Node.js bridge server that translates the herdr unix-socket API
into HTTP/WebSocket, plus a mobile-first PWA it serves. Lets a phone monitor
and control every coding agent running in herdr. herdr itself is never
modified — everything goes through its public socket API.

## Architecture

```
phone (PWA: web/src/*.ts → built to web/*.js)
  │ REST /api/* + WS /ws (bearer token)
bridge (server/*.ts → built to dist/server/*.js, binds 127.0.0.1:8390)
  │ ndjson over $HERDR_SOCKET_PATH
herdr server
```

- `server/herdr-client.ts` — socket RPC + persistent event subscription + reconnect
- `server/state.ts` — pure snapshot/event → normalized State (unit-tested; keep it I/O-free)
- `server/transcript-normalize.ts` — pure JSONL line → chat TimelineItem[] (unit-tested; I/O-free)
- `server/transcript.ts` — resolve + tail a claude pane's transcript file (I/O)
- `server/http.ts` — REST routes, WS (state pushes, per-client pane + transcript watch), static files
- `server/auth.ts` / `notify.ts` / `config.ts` — token, agent-status fanout + optional ntfy, config
- `bin/agentwebctl.ts` — plugin entrypoints: run | start | stop | status | qr
- `web/src/app.ts` — SPA (hash routing), `ansi.ts` — pure ANSI→HTML,
  `transcript.ts` — pure TimelineItem→HTML chat renderer, `sw.ts` — service worker
- `herdr-plugin.toml` — actions/panes call `dist/bin/agentwebctl.js`; `[[build]]` runs on
  `herdr plugin install` but NOT on `herdr plugin link`

The REST/WS/State JSON contract is documented in README "API surface". Server
and web are separate tsc projects that only share this contract — change both
sides together.

## Build / test / deploy loop

```bash
npm install && npm run build   # tsc ×3 (server+bin → dist/, web/src → web/, sw)
npm test                       # node --test server/test/ — runs .ts natively (dev needs Node >= 23.6)
node server/main.ts            # foreground dev run against the live herdr
```

Deploying a change to the running bridge:

```bash
npm run build
herdr plugin action invoke y011d4.agentweb.stop
herdr plugin action invoke y011d4.agentweb.start
curl -s http://127.0.0.1:8390/healthz   # expect {"ok":true,"herdrConnected":true}
```

Re-run `herdr plugin link <repo>` only when `herdr-plugin.toml` changed — herdr
caches the linked manifest.

**Service worker cache**: bump `CACHE_VERSION` in `web/src/sw.ts` on every
change to any web asset. Cached assets refresh only when sw.js itself changes;
without the bump phones keep serving the old app. Headless-browser checks have
the same problem — always use a fresh `--user-data-dir` profile.

## Verified herdr socket API behavior (hard-won; don't rediscover)

Verified live against herdr 0.7.3 / protocol 16:

- **One connection = one request.** The server closes the socket after each
  response. Only `events.subscribe` keeps a connection open.
- **Event names arrive in mixed forms**: lifecycle events in underscore form
  (`pane_created`, `workspace_focused`), typed subscription events in dot form
  (`pane.agent_status_changed`). Normalize before dispatch.
- `pane.agent_status_changed` subscriptions are **per pane_id** — the pane set
  changing requires a snapshot re-fetch and a fresh subscribe connection.
- `session.snapshot` result is nested under `result.snapshot`.
- **`pane.send_input` wraps text in bracketed paste** when the app enables it,
  and apps discard control sequences inside a paste. Raw bytes (e.g. SGR mouse
  wheel) must go through `pane.send_text`.
- **Selecting a numbered menu option (e.g. AskUserQuestion) is one atomic
  keystroke: the option's digit sent as a raw byte via `pane.send_text`.** Pressing
  the digit selects AND submits the option — no Enter, no cursor movement (verified
  live: sending `"3"` to an AskUserQuestion answered "cherry" outright). It MUST go
  as a raw keystroke: a digit in `send_input` `text` is bracketed-paste-wrapped and
  ignored by the menu, and a digit in `send_input` `keys` is dropped (herdr's `keys`
  are named keys only). Because the digit is atomic, the bridge's answer path sends
  just the digit — no follow-up read/Enter/arrow that could land on a later prompt,
  and the `❯` position is irrelevant (selection is by number). The startup trust
  prompt is a different widget (Enter/Esc only, no digits), but it never surfaces as
  a `blocked` pane, so the chat answer UI never needs to drive it.
- herdr emits focus events ~10/s during desktop activity. Never let them
  trigger WS pushes; apply them to the model silently.
- Invalid enum values in request params make herdr **drop the connection
  without a response** (surfaces as opaque "connection closed"). The bridge
  validates enums in REST routes and returns a clear 400 instead.
- `recent` reads cap at 1000 lines regardless of the requested count.

## The two scrolling mechanisms (phone pane view)

1. **Panes with terminal scrollback** — the view is one continuous buffer:
   `#term-history` (recent-source prefix, refreshed ≤ every 10s) above
   `#term-live` (current screen, WS-pushed). Scrolling is local and smooth.
2. **Zero-scrollback panes** (full-screen apps; e.g. Claude Code with
   `"tui": "fullscreen"`) — nothing exists to scroll locally. Swipes are
   forwarded as SGR wheel events through `POST /api/panes/:id/scroll`
   (batched steps, fling momentum); the app scrolls its own view and the
   updated screen comes back via watch pushes. Heuristic: empty history
   prefix + pane has an agent (`appScrollPane`). Arrow keys are NOT a
   substitute — they trigger composer history in Claude Code.

## The chat view (Claude Code transcript rendering)

A claude pane can be shown as a structured chat timeline instead of the raw
terminal. It does NOT scrape the terminal — it tails Claude Code's own JSONL
session transcript on disk. Terminal view stays the universal fallback for every
agent; chat is an additive, feature-detected layer (`available`), so
vendor-neutrality is preserved.

- **Exact pane→transcript mapping (don't use newest-mtime).** herdr's raw pane
  carries `agent_session = { source:"herdr:claude", value:"<uuid>" }` (seen via
  `session.snapshot` / `pane.get`). That `value` IS the transcript filename:
  `~/.claude/projects/<slug>/<value>.jsonl`, slug = `cwd.replace(/[/._]/g,'-')`.
  A pane's launch cwd can differ from its current `foreground_cwd`, so resolve by
  the slug first, then fall back to globbing `~/.claude/projects/*/<value>.jsonl`.
- **Graceful degradation is expected.** Some claude sessions' transcripts aren't
  on this host (remote/containerized, alternate `CLAUDE_CONFIG_DIR`) → the endpoint
  returns `available:false` and the client keeps the terminal. Never guess a
  wrong session by mtime.
- Reads are confined to `~/.claude/projects` (sessionId regex + path containment);
  the client only sends a paneId — sessionId/cwd come from herdr. The `session`
  query param is an equality gate only, never used to build a path.
- The tailer reads new bytes from a byte cursor that always sits on a newline
  boundary (safe for multi-byte UTF-8); a trailing partial line is left for the
  next read. WS `watch_transcript` re-resolves the session id each tick so a
  mid-session reset (`/clear` → new session file) triggers a `reset` rebuild.

## Touch/DOM rules in app.ts (regression-prone)

- **Never replace terminal DOM during an active touch** — the browser cancels
  the in-progress scroll gesture. Renders defer via `pendingAnsi` while
  `terminalTouchActive` or scrolled above the bottom, and flush on touchend /
  return-to-bottom.
- Async fetches capture `paneViewGen` + pane id and bail if the user navigated
  away; stale responses must not poison the next pane's view.
- Double-tap detection requires two *stationary* taps (movement > 10px within
  a touch disqualifies it) — fast swipe flicks must not trigger it.
- WS pushes are deduped server-side against the last serialized state;
  `sinceUnixMs` carries over across re-snapshots so rebuilds don't defeat it.

## Security invariants

- Every `/api` and `/ws` request requires the bearer token
  (`timingSafeEqual`); `/healthz` is the only open endpoint.
- The tokenized connect URL is printed only by `server/main.js` startup (run
  pane + 0600 bridge.log) and the `qr` entrypoint. **Never print the token in
  action stdout** — herdr captures action output into its plugin logs.
- Bind stays loopback-only by default; remote access is Tailscale's job
  (`tailscale serve`). No outbound requests unless `notify_url` is set.
- Static file serving keeps the resolve+prefix path-traversal guard.

## Testing

- Unit tests: `server/test/*.test.ts` (state normalization/event routing/
  immutability, auth, ndjson, notify shapes). The routing-table test asserts
  every subscribed lifecycle event is either rebuild-triggering or applied —
  keep it in sync with `buildSubscriptions`.
- Live verification is expected before claiming completion: healthz, an
  `/api/state` sanity check, and (for input paths) a scratch-tab round trip
  (`herdr tab create` → POST input → read back → close the tab).
- Gesture work: verify with headless Chrome CDP touch emulation
  (`Input.dispatchTouchEvent`, mobile metrics, fresh profile). "The screen
  changed" is not proof by itself on a busy pane — assert on content moving
  to *older* lines and on the composer staying clean.

## Conventions

- Lowercase conventional commits, no emojis, no AI co-author lines.
- TS sources use explicit `.ts` relative-import extensions
  (`rewriteRelativeImportExtensions` emits `.js`). No raw control bytes in
  source — write ESC as the literal six characters `\u001b` in string escapes.
- Only production dependency is `ws`; don't add more without a strong reason
  (QR uses the system `qrencode`, falling back to a plain URL).
