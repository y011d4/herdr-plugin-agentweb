# herdr-plugin-mobile

Monitor and control every coding agent running in [herdr](https://herdr.dev) from your
phone. A herdr plugin that runs a small local bridge server (Node.js) and serves a
mobile-first PWA:

- Dashboard of all agents across all workspaces with live status
  (idle / working / **blocked** / done), blocked agents sorted to the top
- Pane view with colored terminal output, text input, and quick keys
  (Enter, Esc, Ctrl+C, arrows, y/n, …)
- Live updates over WebSocket; notifications when an agent becomes blocked or done
- No accounts, no cloud, no third-party services. Everything stays on your machine
  and (recommended) inside your Tailscale tailnet.

```
Android (Chrome / installed PWA)
   │  HTTPS via `tailscale serve` (tailnet-only)
   ▼
bridge server (this plugin, binds 127.0.0.1:8390)
   │  ndjson over the herdr unix socket
   ▼
herdr server
```

## Requirements

- herdr >= 0.7.0 (Linux/macOS)
- Node.js >= 20
- Tailscale on both the machine and the phone (recommended access path)

## Setup

```bash
git clone https://github.com/y011d4/herdr-plugin-mobile
cd herdr-plugin-mobile
npm install                      # only dependency: ws
herdr plugin link "$(pwd)"
```

Start the bridge (any of these):

```bash
herdr plugin action invoke y011d4.mobile.start   # detached daemon
herdr plugin pane open --plugin y011d4.mobile --entrypoint server  # visible in a pane
```

Then connect the phone by scanning a QR code (requires the `qrencode` system
package; falls back to printing the URL):

```bash
herdr plugin pane open --plugin y011d4.mobile --entrypoint connect
```

The overlay pane shows a QR of the best reachable URL — the `tailscale serve`
HTTPS address when active, otherwise the Tailscale IP — with the access token
included. `start`/`status` print the URL without the token; the token lives in
the state dir (`token` file, printed path in the action output).

### Expose to your phone (Tailscale, recommended)

The bridge binds to `127.0.0.1` only. Publish it inside your tailnet with
automatic HTTPS:

```bash
tailscale serve --bg 8390
```

Then open `https://<machine>.<tailnet>.ts.net/?token=<token>` on the phone and use
Chrome's "Add to Home screen". HTTPS gives the PWA a secure context, which enables
the service worker and Web Notifications. Traffic never leaves the WireGuard
tunnel; nothing is exposed to the public internet (don't use `tailscale funnel`).

To stop publishing: `tailscale serve reset` (or check with `tailscale serve status`).

### Keybinding (optional)

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "y011d4.mobile.status"
description = "mobile bridge status"
```

## Configuration

Optional `config.json` in the plugin config dir
(`herdr plugin config-dir y011d4.mobile`):

```json
{
  "host": "127.0.0.1",
  "port": 8390,
  "notify_url": null
}
```

- `host` — bind address. Keep `127.0.0.1` and use `tailscale serve`. Setting this
  to your Tailscale IP serves plain HTTP directly on the tailnet (works, but the
  PWA runs without a secure context: no service worker, no system notifications).
- `port` — bridge port (default 8390).
- `notify_url` — optional [ntfy](https://ntfy.sh) topic URL for background push
  notifications, e.g. `https://ntfy.example.internal/herdr` for a **self-hosted**
  ntfy instance. When unset (default) the bridge performs no outbound requests at
  all. If you want pushes while the app is closed: self-host ntfy, bind it to
  your tailnet, point the ntfy Android app at the same topic.

Environment overrides: `HERDR_MOBILE_HOST`, `HERDR_MOBILE_PORT`.

## Security model

- The bridge talks to herdr through the local unix socket (file mode 0600), the
  same access any process of your user already has.
- Every `/api` and `/ws` request requires a bearer token, generated on first start
  and stored with mode 0600 in the plugin state dir. Unauthenticated requests get
  401. `GET /healthz` is the only open endpoint and returns no session data.
- Default bind is loopback-only; remote reachability is delegated to Tailscale
  (`tailscale serve` is tailnet-only and terminates TLS with a valid certificate).
- No telemetry, no external requests (unless you opt into `notify_url`).
- Anyone with the token can read agent output and type into your panes — treat the
  URL like an SSH key. Rotate by deleting `token` in the state dir and restarting.
  Tokens are 32 hex chars (128-bit); tokens created by older versions were 64 and
  stay valid until rotated.

## API surface (for scripting)

- `GET /api/state` — normalized workspaces/tabs/panes/agents tree
- `GET /api/panes/:paneId/read?source=visible|recent&lines=N&format=text|ansi`
- `POST /api/panes/:paneId/input` `{"text": "ls", "enter": true}` or `{"keys": ["ctrl+c"]}`
- `POST /api/panes/:paneId/focus`
- `POST /api/agents/:target/send` `{"text": "continue"}`
- `WS /ws?token=…` — `{"type":"state"}` snapshots and `{"type":"agent_status"}` transitions

## Development

Source is TypeScript under `server/`, `bin/`, and `web/src/`. The built JS
distribution lives in `dist/` (server and bin) and `web/` (PWA assets).

```bash
npm install && npm run build   # install deps and compile TS → JS
npm test                       # unit tests (node --test, runs .ts natively, needs Node >= 23.6)
node server/main.ts            # run against your live herdr in the foreground (dev, Node >= 23.6)
```

`herdr plugin link` does **not** run build commands; run `npm install && npm run build`
manually after cloning or linking. `herdr plugin install` does run the manifest
build commands automatically.

Runtime of the built `dist/` requires Node >= 20. Running TS sources directly
(dev mode) requires Node >= 23.6 for native type stripping.

Logs for the detached daemon go to `<state dir>/bridge.log`
(`herdr plugin config-dir y011d4.mobile` prints the config dir; state dir is its
sibling, or `$HERDR_PLUGIN_STATE_DIR` inside plugin commands).
