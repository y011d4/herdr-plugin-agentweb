# herdr-plugin-agentweb

**English** | [日本語](./README.ja.md)

Monitor and control every coding agent running in [herdr](https://herdr.dev) from your
phone. A herdr plugin that runs a small local bridge server (Node.js) and serves a
mobile-first PWA:

- Dashboard of all agents across all workspaces with live status
  (idle / working / **blocked** / done), blocked agents sorted to the top;
  a done agent you open on the phone reads as idle there (herdr's own state is left as is);
  each card shows its git branch, and a linked worktree's agents appear inside their
  main checkout, chipped as a worktree
- Start, rename, clear, and stop agents from the phone: **+** on the dashboard launches an
  agent from a named launch profile — in an existing workspace/worktree you pick, or in a
  **fresh worktree** it creates for you — and each pane's **⋮** menu renames, clears
  (fresh session), or stops it
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

- herdr >= 0.8.0 (Linux/macOS)
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
  "notify_url": null,
  "orchestrators": [
    { "name": "default", "label": "", "env": {} }
  ],
  "launch_profiles": {
    "claude": { "argv": ["claude"], "label": "Claude Code" },
    "codex": { "argv": ["codex"], "label": "Codex" },
    "opencode": { "argv": ["opencode"], "label": "opencode" }
  }
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
- `launch_profiles` — named agent launch profiles for `POST /api/agents`. Each entry is
  `{ "argv": [...], "label": "…" }`; `argv[0]` is an agent kind herdr knows (`claude`, `codex`,
  `opencode`, …; herdr picks the executable for it) and the rest are fixed flags (the whole
  point of the allowlist is that a phone/script picks a *profile name*, never a raw command). Your
  entries merge over the built-in defaults shown above (same name overrides its `argv`; a new name is
  added; a malformed entry is ignored). Use it to add variants, e.g.
  `"claude-yolo": { "argv": ["claude", "--dangerously-skip-permissions"], "label": "Claude (yolo)" }`.
- `orchestrators` — your **orchestrators**: Claude Code agents you talk to, which hand the work to
  other agents and report back. Each entry is `{ "name", "label", "env" }`: `label` is its title on
  the phone, `env` the environment it starts with — typically `CLAUDE_CONFIG_DIR` to pick its Claude
  account (`"~/.config/claude/work"`; a leading `~` is expanded), so you can keep, say, a work and a
  personal orchestrator apart. The plugin sets up each one's directory itself (see
  [Orchestrators](#orchestrators)) and starts it from the phone (**Start** buttons atop the agents
  list) or with `agentwebctl.js orchestrator start <name>`. Opening the app lands on an
  orchestrator's **Home**: its chat with only the dialogue (tool calls hidden), a status bar of its
  Claude account's agents (those that need you, and counts of the rest), and a "doing now" line while
  it works. Orchestrators aren't listed among the agents. Opened from a Home, the agents list shows
  only that account's agents (`#/agents/<name>`, Back returns to the Home); the full list's
  **← Home** opens the Home used last. With several running, Home shows a switcher (`label`s, with their
  status) and reopens the one used last (`#/home/<name>`); with none, the app opens on the list.
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

### Orchestrators

For each entry of `orchestrators`, the plugin keeps a directory,
`~/.local/share/herdr-agentweb/orchestrators/<name>/` (under `$XDG_DATA_HOME` when set), writing
it when the bridge starts and again each time it starts that orchestrator:

- `CLAUDE.md` — names the orchestrator and imports the two files below.
- `rules.md` — the rules bundled with the plugin ([`orchestrator/rules.md`](orchestrator/rules.md)):
  how to start workers, follow them, report, and clean up after them.
- `.claude/settings.json` — its permissions (below).
- `local.md` — **yours**: this orchestrator's own rules (which repositories it takes on, the
  language to answer in, a cheaper launch profile for lookups…). Created empty once and never
  overwritten. For your own permissions, use `.claude/settings.local.json`.

It starts in a new herdr workspace at that directory, with its `env`. The plugin then checks that
it came up under the Claude account that `env` sets, and stops it otherwise. No per-directory
tool such as direnv is needed. **Clear** (in the agent menu) restarts it with the same account.

An orchestrator drives its workers only through `agentwebctl.js`, which touches nothing outside
its own Claude account. The account is an agent process's `CLAUDE_CONFIG_DIR` (default
`~/.claude`). Anything whose account differs, or can't be told, is hidden or refused:

- `overview` — a read-only text summary of the other agents of this account (location, launch dir,
  status, last request, last reply, current tool call).
- `agent get|read|prompt|wait <target> [flags]` — `herdr agent …` on that agent, refused for
  another account's. Output and flags are herdr's.
- `agent start <name> --cwd <dir> [--profile <launch profile>] [--worktree <branch> [--base <ref>]]` —
  starts a `launch_profiles` agent with the orchestrator's account, in a new tab of the workspace
  already at `dir` (else a new workspace). It is refused where a direnv `.envrc` sets another
  account. With `--worktree`, it starts in a new worktree of the repo there, created next to the
  repo (`<repo>-wt-<branch>`). herdr can't hand a worktree an environment, so the worktree's account
  must come from the directory: an `.envrc` above the repo (one per org dir, say) covers it. The
  started agent's account is checked; a mismatch stops it again. A new worktree is then kept,
  since the agent may already have written to it.
- `worktree remove <checkout path>` — removes a finished worker's linked worktree and its branch,
  only when no agent is left in it, it has no uncommitted or untracked files, and the branch is
  merged (an ancestor of `origin/HEAD`, or the head of a merged PR per `gh`, for squash merges).

The `.claude/settings.json` the plugin writes keeps the orchestrator to those commands:
`"defaultMode": "dontAsk"` (anything not allowed is refused without asking), allow only those
commands, deny the herdr CLI and other accounts' transcripts, and keep read-only commands (which
`dontAsk` still runs) inside its own directory. Workers themselves are ordinary agents under your
own permission prompts; this boundary is about what each orchestrator, and so each account, sees.

**Older setups.** Without `orchestrators`, nothing changes. The single `"orchestrator_dir": "<dir>"`,
or else the old default `~/.local/share/herdr-agentweb/dispatcher` if it exists, is still the one
orchestrator, named `default`. It runs your own `CLAUDE.md` from that directory, which the plugin
never writes to. To move to managed orchestrators:

1. Add `orchestrators` to the config and restart the bridge. The plugin creates their directories.
2. Put anything from your old `CLAUDE.md` that is still yours into each `local.md`. The bundled
   rules replace the parts about driving herdr.
3. Start them (phone or `agentwebctl.js orchestrator start <name>`) and answer the folder-trust
   question once. Then end the old orchestrator and delete its directory.

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

- `GET /api/state` — normalized workspaces/tabs/panes/agents tree, plus `orchestrators`
  (`[{ name, label, paneId, agents }]` in config order; `paneId` is the agent running in its dir, or
  `null`; `agents` the agent panes of its Claude account, itself included, or `null` when unknown)
  and `orchestratorPaneId` (the first running one's, or `null`). Each agent's `completionSeq` is herdr's
  `completion_seq` (which completion its idle/done status is; `null` until fetched), and its
  `stateChangeSeq` is herdr's `state_change_seq` (herdr's order of status changes, which the app
  lists by; `null` until fetched)
- `GET /api/panes/:paneId/read?source=visible|recent&lines=N&format=text|ansi`
- `POST /api/panes/:paneId/input` `{"text": "ls", "enter": true}` or `{"keys": ["ctrl+c"]}`
  — add `"clear": true` to wipe the pane's composer (repeated Ctrl+U) before the
  text lands, so a message composed here submits alone instead of being appended
  to a draft already typed straight into the pane
- `POST /api/panes/:paneId/focus`
- `POST /api/panes/:paneId/scroll` `{"direction": "up", "steps": 3}` — SGR wheel events for full-screen apps
- `GET /api/profiles` — the configured launch profiles as `{"profiles": [{"name", "label"}]}`
  (names + labels only, never the argv), for the new-agent picker
- `POST /api/agents` `{"profile": "claude", "cwd": "/path", "name": "review", "task": "…", "workspace": "w7"}`
  — start a new agent from a named [launch profile](#configuration) (fixed argv allowlist; a caller
  never supplies a raw command). Only `profile` is required; returns `{"paneId", "name", "agent"}`
  (plus `"taskDelivered"` when `task` was given — the response then waits, up to 30s, for the agent to
  become ready for it). The agent opens in a new tab (labelled with its name) at `cwd`; pass
  `"workspace"` to put that tab in a specific workspace (else the active one). `name` is fitted to
  herdr's agent-name rule (lowercased, a-z/0-9/`-`/`_`, max 32). Pass a `"worktree": {"repo", "branch", "base"}` object
  instead of `cwd` to **create a worktree and launch the agent in its root pane atomically** — the worktree is
  rolled back if the agent fails to start. The new pane appears in `/api/state` a moment later.
  New worktrees go **next to their repo**, as `<repo>-wt-<branch>` (a blank branch gets a generated
  `worktree/…` name), not into herdr's worktrees dir, so whatever covers the repo from a parent dir — a
  direnv `.envrc` per org dir that picks the Claude account, say — covers the checkout too.
- `POST /api/orchestrators/:name/start` — start a configured orchestrator (its directory and `env`
  come from the config; the request names it only) in a new workspace and return `{"paneId", "name"}`.
  409 when it already runs.
- `POST /api/worktrees` `{"cwd": "/repo", "branch": "feat/x", "base": "origin/main"}` — create a git
  worktree next to the repo, as above (herdr `worktree.create`; `cwd` is any path in the source repo,
  `branch`/`base` optional) and return `{"workspaceId", "checkoutPath", "branch", "paneId"}`. Standalone (create a worktree
  without an agent); the New agent form's "＋ New worktree…" option instead uses the atomic
  `worktree` spec on `POST /api/agents` above.
- `DELETE /api/panes/:paneId` — stop an agent by closing its pane
- `POST /api/panes/:paneId/rename` `{"name": "worker-2"}` — rename the agent running in the pane
- `POST /api/agents/:target/clear` — start a fresh replacement agent (same profile + cwd) and close
  the old pane; the pane id changes, so the client re-follows the new pane
- `GET /api/panes/:paneId/transcript` — Claude Code chat view: the pane's JSONL
  session transcript as normalized `items` (`user`/`assistant`/`thinking`/
  `tool_use`/`tool_result`) plus `sessionId` and a byte `cursor`. Returns
  `{"available": false}` when the pane isn't a claude session or its transcript
  isn't on this host. Add `?session=<id>&after=<cursor>` to fetch only items past
  the cursor for that session (incremental polling).
- `POST /api/agents/:target/send` `{"text": "continue"}` — submit a prompt to a ready agent (herdr
  `agent.prompt`; `text` must be non-empty)
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
