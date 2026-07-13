# herdr-plugin-mobile

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
- `server/http.ts` — REST routes, WS (state pushes, per-client pane watch), static files
- `server/auth.ts` / `notify.ts` / `config.ts` — token, agent-status fanout + optional ntfy, config
- `bin/mobilectl.ts` — plugin entrypoints: run | start | stop | status | qr
- `web/src/app.ts` — SPA (hash routing), `ansi.ts` — pure ANSI→HTML, `sw.ts` — service worker
- `herdr-plugin.toml` — actions/panes call `dist/bin/mobilectl.js`; `[[build]]` runs on
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
herdr plugin action invoke y011d4.mobile.stop
herdr plugin action invoke y011d4.mobile.start
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
