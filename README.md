# herdr-plugin-agentweb

**English** | [日本語](./README.ja.md)

Monitor and control every coding agent running in [herdr](https://herdr.dev) from your
phone. A herdr plugin that runs a small local bridge server (Node.js) and serves a
mobile-first PWA:

- Dashboard of all agents across all workspaces with live status
  (idle / working / **blocked** / done), blocked agents sorted to the top
- Pane view: colored terminal output fitted to the phone width, pinch zoom,
  scrollback by swiping down, multiline input, and quick keys
  (Enter, ⌫, Esc, Ctrl+C, arrows, y/n, …)
- Live updates over WebSocket (sub-second); notifications when an agent
  becomes blocked or done — tap to jump to the pane, swipe right to dismiss
- No accounts, no cloud, no third-party services. Everything stays on your machine;
  remote access is your choice of transport — a reverse proxy, a tunnel, or a VPN.

```
Android (Chrome / installed PWA)
   │  HTTPS via a reverse proxy, tunnel, or VPN (see "Exposing the bridge")
   ▼
bridge server (this plugin, binds 127.0.0.1:8390)
   │  ndjson over the herdr unix socket
   ▼
herdr server
```

## Requirements

- herdr >= 0.7.0 (Linux/macOS)
- Node.js >= 20
- A way to reach the bridge from your phone — a reverse proxy, a tunnel, or a VPN
  (see [Exposing the bridge to your phone](#exposing-the-bridge-to-your-phone)).
  Tailscale is one easy option, not a requirement.

## Setup

Install straight from GitHub — herdr fetches the repo and runs the build for you:

```bash
herdr plugin install y011d4/herdr-plugin-agentweb
# or pin a version:  herdr plugin install y011d4/herdr-plugin-agentweb --ref v0.1.0
```

No clone, no manual build: `herdr plugin install` runs the manifest `[[build]]` steps
(`npm ci`, then `npm run build`), so it needs Node.js and `npm` on `PATH`. To hack on
the plugin from a local checkout instead, see [Development](#development).

Start the bridge (any of these):

```bash
herdr plugin action invoke y011d4.agentweb.start   # detached daemon
herdr plugin pane open --plugin y011d4.agentweb --entrypoint server  # visible in a pane
```

Then connect the phone by scanning a QR code (requires the `qrencode` system
package; falls back to printing the URL):

```bash
herdr plugin pane open --plugin y011d4.agentweb --entrypoint connect
```

The overlay pane shows a QR of your connect URL with the access token included:
your configured `public_url` when set, otherwise an auto-detected Tailscale
address, otherwise `http://127.0.0.1:<port>`. See
[Exposing the bridge to your phone](#exposing-the-bridge-to-your-phone) to pick a
transport and set `public_url`. `start`/`status` print the URL without the token;
the token lives in the state dir (`token` file, printed path in the action output).

### Managing the bridge

The plugin exposes three workspace actions and two panes:

| Entrypoint | Kind | What it does |
| --- | --- | --- |
| `y011d4.agentweb.start` | action | Start the bridge as a detached daemon |
| `y011d4.agentweb.stop` | action | Stop the running bridge |
| `y011d4.agentweb.status` | action | Report whether it's running and print the URL (no token) |
| `server` | pane | Run the bridge in a visible pane (foreground; the tokenized URL is shown here) |
| `connect` | pane | Show the connect QR / URL as an overlay |

Invoke an action with `herdr plugin action invoke <id>`; open a pane with
`herdr plugin pane open --plugin y011d4.agentweb --entrypoint <id>`. The detached
daemon and the foreground `server` pane are mutually exclusive — start one or the
other, not both.

### Exposing the bridge to your phone

The bridge binds to `127.0.0.1` only, so something has to carry traffic from your
phone to that loopback port. Pick **one** of the transports below and set
`public_url` (see [Configuration](#configuration)) to the address your phone will
use. The bridge doesn't care which one you use — it just serves the PWA and the API
on loopback.

Prefer a transport that gives you **HTTPS with a valid certificate**: that makes the
page a *secure context*, which is what enables the service worker, "Add to Home
screen", and Web Notifications. Plain HTTP still works for viewing, but those PWA
features stay off.

**Reverse proxy + your own domain** (Caddy / nginx / Traefik) — terminate TLS with a
real certificate and forward to the bridge. Caddy needs one line and provisions the
certificate for you:

```
# Caddyfile — DNS for herdr.example.com must resolve to this host
herdr.example.com {
    reverse_proxy 127.0.0.1:8390
}
```

Set `"public_url": "https://herdr.example.com"`. (On nginx, pass the WebSocket
`Upgrade`/`Connection` headers through so `/ws` works.)

**Cloudflare Tunnel** — no open ports, no public IP, valid HTTPS:

```bash
cloudflared tunnel --url http://127.0.0.1:8390   # prints an https://…trycloudflare.com URL
```

Set `public_url` to that URL, or bind a named tunnel to your own domain for a stable
address.

**Quick tunnel** (ngrok, localtunnel, …) — fastest to try, but the URL changes each
run:

```bash
ngrok http 8390                                  # prints an https URL with a valid cert
```

Because the address is ephemeral, either update `public_url` each run, or skip the QR
pane and just open `<printed-url>/?token=<token>` on the phone.

**VPN** (Tailscale, WireGuard, ZeroTier, …) — put the phone and the machine on the
same private network. Tailscale can also terminate HTTPS for you, so it needs no
separate reverse proxy:

```bash
tailscale serve --bg 8390                        # tailnet-only HTTPS, valid cert
```

Then open `https://<machine>.<tailnet>.ts.net/?token=<token>` (stop with `tailscale
serve reset`; don't use `tailscale funnel`). With a plain VPN IP instead — e.g.
`"public_url": "http://100.x.y.z:8390"` — it works over HTTP but without a secure
context, so the PWA features above stay off; front it with a reverse proxy if you
want them.

Whichever you pick, open `<public_url>/?token=<token>` on the phone (the connect QR
pane builds exactly this link) and use Chrome's "Add to Home screen".

## Pane view gestures

- **Pinch** zooms the terminal font (4–24px); **double-tap** returns to
  fit-to-width at the bottom. One finger pans.
- **Swipe down** scrolls into the pane's history — older output sits above the
  current screen, so dragging down reveals it (swipe up returns toward the
  latest output). For panes with terminal scrollback this is instant and local
  (the last 1000 lines are preloaded).
- Full-screen apps that keep no scrollback (e.g. Claude Code with
  `"tui": "fullscreen"`) scroll **their own** view instead: swipes are
  forwarded to the app as mouse-wheel events, with fling momentum. Expect a
  short delay per step — the app repaints remotely.
- While you read history, live updates pause; returning to the bottom (or
  double-tapping) resumes them.

Tip: Claude Code's `"tui": "fullscreen"` setting is what prevents scrollback
from accumulating. Remove it (default renderer) and restarted sessions build
terminal scrollback, giving you the smooth local scrolling path everywhere.

### Keybinding (optional)

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "y011d4.agentweb.status"
description = "agent web bridge status"
```

## Configuration

Configuration is entirely optional — the bridge runs with working defaults. To
change anything, create a `config.json` in the plugin config dir. Print that dir
with:

```bash
herdr plugin config-dir y011d4.agentweb
```

Every key is optional; include only the ones you want to override. The full shape,
with defaults, is:

```json
{
  "host": "127.0.0.1",
  "port": 8390,
  "public_url": null,
  "notify_url": null
}
```

- `host` — bind address. Keep `127.0.0.1` and put a transport in front of it (see
  [Exposing the bridge to your phone](#exposing-the-bridge-to-your-phone)). Binding
  to a LAN/VPN IP serves plain HTTP directly (works, but the PWA then runs without a
  secure context: no service worker, no system notifications).
- `port` — bridge port (default 8390).
- `public_url` — **the main switch for remote access**: the base URL your phone uses
  to reach the bridge, e.g. `"https://herdr.example.com"` (reverse proxy or Cloudflare
  Tunnel), an ngrok URL, or `"https://gram.your-tailnet.ts.net"` (Tailscale). The
  connect QR pane builds its link from this. When unset, the pane falls back to
  auto-detecting Tailscale (serve HTTPS address, else tailnet IP), then to
  `http://127.0.0.1:<port>` — so set it for any transport other than Tailscale. See
  [Exposing the bridge to your phone](#exposing-the-bridge-to-your-phone).
- `notify_url` — optional [ntfy](https://ntfy.sh) topic URL for background push
  notifications, e.g. `https://ntfy.example.internal/herdr` for a **self-hosted**
  ntfy instance. When unset (default) the bridge performs no outbound requests at
  all. If you want pushes while the app is closed: self-host ntfy, bind it to
  your tailnet, point the ntfy Android app at the same topic.

**Applying changes:** the config is read once at startup, so restart the bridge
after editing — `herdr plugin action invoke y011d4.agentweb.stop`, then `…start`.

**Environment overrides:** `HERDR_AGENTWEB_HOST` and `HERDR_AGENTWEB_PORT` take
precedence over `config.json` for `host`/`port` (`public_url` and `notify_url` are
config-file only). Effective precedence is env var → `config.json` → built-in
default.

> When you run the server directly for development (`node server/main.ts`),
> `config.json` is only read if `HERDR_PLUGIN_CONFIG_DIR` points at the config dir.
> herdr sets that automatically for plugin actions and panes, so it "just works"
> when launched through herdr.

## Security model

- The bridge talks to herdr through the local unix socket (file mode 0600), the
  same access any process of your user already has.
- Every `/api` and `/ws` request requires a bearer token, generated on first start
  and stored with mode 0600 in the plugin state dir. Unauthenticated requests get
  401. `GET /healthz` is the only open endpoint and returns no session data.
- Default bind is loopback-only; remote reachability is delegated to whatever
  transport you put in front (reverse proxy, tunnel, or VPN — see
  [Exposing the bridge to your phone](#exposing-the-bridge-to-your-phone)). A VPN
  such as `tailscale serve` keeps the bridge inside a private network, adding a
  network-layer boundary on top of the token.
- Exposing it through a **public** domain (reverse proxy / Cloudflare Tunnel) makes
  the bridge reachable from the internet at the network layer, so the bearer token is
  then your only line of defense. The token is 128-bit (not brute-forceable), but
  treat the connect URL as a secret: it also rides in the query string, so it can
  land in reverse-proxy access logs. A VPN transport avoids that exposure.
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
- `POST /api/panes/:paneId/scroll` `{"direction": "up", "steps": 3}` — SGR wheel events for full-screen apps
- `GET /api/panes/:paneId/transcript` — Claude Code chat view: the pane's JSONL
  session transcript as normalized `items` (`user`/`assistant`/`thinking`/
  `tool_use`/`tool_result`) plus `sessionId` and a byte `cursor`. Returns
  `{"available": false}` when the pane isn't a claude session or its transcript
  isn't on this host. Add `?session=<id>&after=<cursor>` to fetch only items past
  the cursor for that session (incremental polling).
- `POST /api/agents/:target/send` `{"text": "continue"}`
- `WS /ws?token=…` — `{"type":"state"}` snapshots and `{"type":"agent_status"}`
  transitions. `{"type":"watch_transcript","paneId":…}` starts a live tail that
  pushes `{"type":"transcript_items",…}` (`reset` rebuilds, else appends);
  `{"type":"unwatch_transcript"}` stops it (mirrors `watch_pane`/`pane_output`).

## Development

For local development, clone and **link** a working tree instead of installing from
GitHub — `herdr plugin link` points herdr at your checkout so your edits take effect:

```bash
git clone https://github.com/y011d4/herdr-plugin-agentweb
cd herdr-plugin-agentweb
npm install && npm run build     # only dependency: ws
herdr plugin link "$(pwd)"
```

Source is TypeScript under `server/`, `bin/`, and `web/src/`. The built JS
distribution lives in `dist/` (server and bin) and `web/` (PWA assets).

```bash
npm run build                  # recompile TS → JS after changes
npm test                       # unit tests (node --test, runs .ts natively, needs Node >= 23.6)
node server/main.ts            # run against your live herdr in the foreground (dev, Node >= 23.6)
```

`herdr plugin link` does **not** run build commands — rebuild with `npm run build`
after edits (and re-run `herdr plugin link` only when `herdr-plugin.toml` changed).
`herdr plugin install` runs the manifest build commands automatically.

Runtime of the built `dist/` requires Node >= 20. Running TS sources directly
(dev mode) requires Node >= 23.6 for native type stripping.

Logs for the detached daemon go to `<state dir>/bridge.log`
(`herdr plugin config-dir y011d4.agentweb` prints the config dir; state dir is its
sibling, or `$HERDR_PLUGIN_STATE_DIR` inside plugin commands).
