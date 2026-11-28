<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/icons/lockup.svg">
    <img src="site/docs/public/lockup-light.svg" alt="yoicks" width="300">
  </picture>
</p>

# herdr-yoicks

**English** | [日本語](./README.ja.md)

*Yoicks* is the huntsman's cry that sends the pack on.

Monitor and control every coding agent running in [herdr](https://herdr.dev) from your
phone. A herdr plugin that runs a small local bridge server (a Go binary) and serves a
mobile-first PWA:

- Dashboard of all agents across all workspaces with live status
  (idle / working / **blocked** / done), blocked agents sorted to the top;
  a done agent you open on the phone reads as idle there (herdr's own state is left as is);
  each card shows its git branch, and a linked worktree's agents appear inside their
  main checkout, chipped as a worktree
- Rename, clear, and stop agents from the phone: each pane's **⋮** menu renames, clears
  (fresh session), or stops it (an orchestrator's Home has **Clear** and **Stop**, and a headless
  one's **Compact**, in the **⋮** on its status bar). Agents are started by the orchestrators, not by hand. **⚙** at the top right
  opens the settings
- Pane view: colored terminal output fitted to the phone width, pinch zoom,
  scrollback by swiping down, multiline input, and quick keys
  (Enter, ⌫, Esc, Ctrl+C, arrows, y/n, …). On a PC's browser, Enter sends and
  Shift+Enter inserts a newline; on a phone, Enter inserts a newline and Send sends
- Live updates over WebSocket (sub-second); OS notifications (Settings) when an
  agent becomes blocked or done while the app is in the background — tap to jump
  to the pane
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

- [herdr](https://herdr.dev) >= 0.9.5 (see [Compatibility](#compatibility))
- Linux on amd64 or arm64. macOS (Apple silicon and Intel) is experimental.
- Nothing else to install: the plugin is one prebuilt binary, which the install downloads
  and checks with the usual `sh`, `curl` or `wget`, and `sha256sum` or `shasum`. No Node.js,
  no Go.
- A way to reach the bridge from your phone — a reverse proxy, a tunnel, or a VPN
  (see [Exposing the bridge to your phone](#exposing-the-bridge-to-your-phone)).
  Tailscale is one easy option, not a requirement.
- Optional commands, used when present:
  - `git` >= 2.31 — branch names on the cards, worktrees
  - `qrencode` — the connect QR code (without it, the connect pane prints the URL)
  - `tailscale` — the connect URL is detected when the bridge is behind `tailscale serve`
  - `direnv` — per-directory Claude accounts for [orchestrators](#orchestrators)
  - `gh` — `worktree remove` recognizes squash-merged branches

## Setup

Install a release straight from GitHub:

```bash
herdr plugin install y011d4/herdr-yoicks --ref v0.1.0
```

No clone, no build: `herdr plugin install` runs the manifest `[[build]]` step,
`scripts/plugin-build.sh release`, which downloads that version's binary for your OS and CPU from the
[GitHub releases](https://github.com/y011d4/herdr-yoicks/releases) and checks it
against the SHA-256 in `release/checksums.txt`, committed in the repo at that tag. A binary that
doesn't match is not installed. (Without `--ref`, herdr installs the default branch, which
downloads the release its `herdr-plugin.toml` names.) To hack on the plugin from a local
checkout instead, see [Development](#development).

### Updating

Stop the bridge, update, start it again — in that order: the update moves the plugin to a new
directory, and the new `stop` may not find a bridge the old binary started:

```bash
herdr plugin action invoke y011d4.yoicks.stop   # wait until it has finished
herdr plugin update                               # or: herdr plugin install … --ref v<new>
herdr plugin action invoke y011d4.yoicks.start
```

Then restart each running orchestrator (**Clear** on its Home). The bridge rewrites their rules and
allowlists with the new `yoicks` path when it starts, and a running orchestrator still calls the old one.
A headless one needs nothing: the bridge's restart resumes it, and the resumed session reads the new rules.

### Rolling back

To go back to an earlier release, stop the bridge, reinstall that version, start again:

```bash
herdr plugin action invoke y011d4.yoicks.stop   # wait until it has finished
herdr plugin uninstall y011d4.yoicks            # keeps the token, config and orchestrator dirs
herdr plugin install y011d4/herdr-yoicks --ref v<earlier version>
herdr plugin action invoke y011d4.yoicks.start
```

Then Clear the running orchestrators, as after an update.

A linked checkout (see [Development](#development)) rolls back with `sh scripts/redeploy.sh
<commit>` instead.

### Uninstalling

```bash
herdr plugin action invoke y011d4.yoicks.stop
herdr plugin config-dir y011d4.yoicks            # note the config dir before uninstalling
herdr plugin uninstall y011d4.yoicks
```

`herdr plugin uninstall` leaves files behind. Delete what you no longer want:

- the installed checkout: `~/.config/herdr/plugins/github-installations/y011d4.yoicks-*`
  (older herdr: `~/.config/herdr/plugins/github/y011d4.yoicks-*`)
- the state dir, `~/.local/state/herdr/plugins/y011d4.yoicks` (under `$XDG_STATE_HOME` when
  set): the access token, `bridge.log`, `pane-profiles.json`
- the config dir printed above (`config.json`)
- `~/.local/share/herdr-yoicks` (under `$XDG_DATA_HOME` when set): the orchestrator directories,
  including your own `local.md` files

### Starting

Start the bridge (any of these):

```bash
herdr plugin action invoke y011d4.yoicks.start   # detached daemon
herdr plugin pane open --plugin y011d4.yoicks --entrypoint server  # visible in a pane
```

Then connect the phone by scanning a QR code (requires the `qrencode` system
package; falls back to printing the URL):

```bash
herdr plugin pane open --plugin y011d4.yoicks --entrypoint connect
```

The overlay pane shows a QR of your connect URL with the access token included:
your configured `public_url` when set, otherwise an auto-detected Tailscale
address, otherwise `http://127.0.0.1:<port>`. See
[Exposing the bridge to your phone](#exposing-the-bridge-to-your-phone) to pick a
transport and set `public_url`. This pane is the only place that shows the token:
`start`/`status`, the `server` pane and `bridge.log` show the URL without it. The
token lives in the state dir (`token` file, printed path in the action output).

### Managing the bridge

The plugin exposes three workspace actions and two panes:

| Entrypoint | Kind | What it does |
| --- | --- | --- |
| `y011d4.yoicks.start` | action | Start the bridge as a detached daemon |
| `y011d4.yoicks.stop` | action | Stop the running bridge |
| `y011d4.yoicks.status` | action | Report whether it's running, the URL (no token), the versions of the plugin and herdr, and which optional commands it finds |
| `server` | pane | Run the bridge in a visible pane (foreground; the URL is shown here, without the token) |
| `connect` | pane | Show the connect QR / URL as an overlay |

Invoke an action with `herdr plugin action invoke <id>`; open a pane with
`herdr plugin pane open --plugin y011d4.yoicks --entrypoint <id>`. The detached
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
serve reset`; don't use `tailscale funnel`). With a plain VPN IP instead, the bridge must listen on it: set
`"host": "100.x.y.z"` as well as `"public_url": "http://100.x.y.z:8390"` (the default `127.0.0.1` isn't
reachable from the phone). It works over HTTP but without a secure context, so the PWA features above stay
off; front it with a reverse proxy if you want them.

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
- In a chat (a Claude pane's or a Home's), scrolling up from the newest message shows a
  **↓** at its bottom right, with a dot once new messages arrive; tapping it scrolls back to the
  newest message, and the chat follows new ones again.
- On a Home, a long press on a message (on a PC a right click, or the ↩ in its top-right corner) offers **Reply**: the
  composer shows a line of that message (✕ cancels it), and what you send starts with it as a quote, so
  the orchestrator knows what you answer. A reply shows that line on top of its bubble; tapping it
  scrolls to the message. The same menu has **Copy**, the only item on a dim `[yoicks]` line.
- A Home's chat shows when each message was sent (your local time; the day too when it isn't today). The
  time is the one Claude Code recorded in its transcript, so a reload or a restart keeps it.

Tip: Claude Code's `"tui": "fullscreen"` setting is what prevents scrollback
from accumulating. Remove it (default renderer) and restarted sessions build
terminal scrollback, giving you the smooth local scrolling path everywhere.

### Keybinding (optional)

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "y011d4.yoicks.status"
description = "yoicks bridge status"
```

## Configuration

Configuration is entirely optional — the bridge runs with working defaults. To
change anything, create a `config.json` in the plugin config dir. Print that dir
with:

```bash
herdr plugin config-dir y011d4.yoicks
```

Every key is optional; include only the ones you want to override. The full shape,
with defaults, is:

```json
{
  "host": "127.0.0.1",
  "port": 8390,
  "public_url": null,
  "notify_url": null,
  "pr_watch": false,
  "orchestrators": [
    { "name": "default", "label": "", "env": {} }
  ],
  "launch_profiles": {
    "claude": { "argv": ["claude"] },
    "codex": { "argv": ["codex"] },
    "opencode": { "argv": ["opencode"] }
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
- `launch_profiles` — named agent launch profiles, for an orchestrator's `agent start --profile`,
  Clear and `POST /api/agents`. Each entry is `{ "argv": [...] }`; `argv[0]` is an agent kind herdr knows (`claude`, `codex`,
  `opencode`, …; herdr picks the executable for it) and the rest are fixed flags (the whole
  point of the allowlist is that a caller picks a *profile name*, never a raw command). Your
  entries merge over the built-in defaults shown above (same name overrides its `argv`; a new name is
  added; a malformed entry is ignored). Use it to add variants, e.g.
  `"claude-yolo": { "argv": ["claude", "--dangerously-skip-permissions"] }`.
- `orchestrators` — your **orchestrators**: Claude Code agents you talk to, which hand the work to
  other agents and report back. Each entry is `{ "name", "label", "env" }`: `label` is its title on
  the phone, `env` the environment it starts with — typically `CLAUDE_CONFIG_DIR` to pick its Claude
  account (`"~/.config/claude/work"`; a leading `~` is expanded), so you can keep, say, a work and a
  personal orchestrator apart. The plugin sets up each one's directory itself (see
  [Orchestrators](#orchestrators)) and starts it from the phone (**Start** on its Home, which opens even while it
  is stopped) or with `<plugin dir>/bin/yoicks orchestrator start <name>`. Opening the app lands on an
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
- `canary` — `false` turns off `scripts/claude-canary.sh`, the periodic check of Claude Code for
  headless orchestrators (see [Checking Claude Code](#checking-claude-code-for-headless-mode)).
- `pr_watch` — `true` lets headless orchestrators notice merged PRs by themselves. Once a minute the
  bridge asks your `gh` (its login, as on the PC) for the state of the github.com PR links on their
  to-do lists, all in one GraphQL call. A merged or closed PR's item is removed and its orchestrator
  is told (`[yoicks] PR merged: <url>`), so it can go on (a deploy its local rules allow, cleaning up
  the worker). Needs `gh` on the bridge's PATH and logged in (`gh auth status`); when it fails, each
  Home with a PR on its list is alerted once per error. Off by default: then nothing goes to GitHub.

**Applying changes:** the config is read once at startup, so restart the bridge
after editing — `herdr plugin action invoke y011d4.yoicks.stop`, then `…start`.

**Environment overrides:** `HERDR_YOICKS_HOST` and `HERDR_YOICKS_PORT` take
precedence over `config.json` for `host`/`port` (`public_url` and `notify_url` are
config-file only). Effective precedence is env var → `config.json` → built-in
default.

> When you run the bridge directly for development (`./bin/yoicks run`),
> `config.json` is only read if `HERDR_PLUGIN_CONFIG_DIR` points at the config dir
> (`HERDR_PLUGIN_CONFIG_DIR="$(herdr plugin config-dir y011d4.yoicks)" ./bin/yoicks run`).
> herdr sets that automatically for plugin actions and panes, so it "just works"
> when launched through herdr.

### Orchestrators

For each entry of `orchestrators`, the plugin keeps a directory,
`~/.local/share/herdr-yoicks/orchestrators/<name>/` (under `$XDG_DATA_HOME` when set), writing
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

An orchestrator drives its workers only through `yoicks`, which touches nothing outside
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
  since the agent may already have written to it. Once the agent exits (`/exit`, or on its own),
  the bridge closes the tab it opened for it (marked `YOICKS_WORKER=1` in that tab's shell), so
  finished workers leave no idle shells behind; a worktree's tab goes with `worktree remove`.
- `worktree remove <checkout path>` — removes a finished worker's linked worktree and its branch,
  only when no agent is left in it, it has no uncommitted or untracked files, and the branch is
  merged (an ancestor of `origin/HEAD`, or the head of a merged PR per `gh`, for squash merges).
  A worktree left on a detached HEAD (a worker that checked out what it deployed) is removed
  when that commit is in `origin/HEAD`, and the branch its dir is named after
  (`<repo>-wt-<branch>`, and its reflog shows it started on) only when that branch is merged too;
  otherwise the branch is kept, and the answer says so. A shell left in the worktree doesn't
  hold it: herdr closes its workspace.

The `.claude/settings.json` the plugin writes keeps the orchestrator to those commands:
`"defaultMode": "dontAsk"` (anything not allowed is refused without asking), allow only those
commands, and deny the herdr CLI and other accounts' transcripts. `dontAsk` still runs read-only
commands, but already refuses the usual readers (`cat`, `ls`, `grep`, `git -C`…) on paths outside
the orchestrator's directory; as of Claude Code 2.1.322 it lets `tree`, `du`, `fd`/`fdfind` and
`lsof` through, so those are denied too. Existence checks (`test -e`, `realpath`) still answer.
(Claude Code's `blockReadsOutsideWorkingDirectories` is not used: it would also refuse
`yoicks` itself, whose path and `--cwd`/worktree paths lie outside the directory, and no
allow rule lifts it.) Workers themselves are ordinary agents under your own permission prompts;
this boundary is about what each orchestrator, and so each account, sees.

**Headless.** `"mode": "headless"` on an entry runs that orchestrator as the bridge's own `claude -p`
instead of an agent in a herdr pane (your Claude subscription only: the bridge refuses API-key
billing). Its Home is then the chat alone: messages go out also while it works, ■ on the
"doing now" line interrupts it, its questions get an answer panel, and the status bar shows its
usage (`5h · 7d · fable · ctx`; fable only while it runs on Fable; a tap on it lists when each limit resets: the time left and the clock time; the limits stay across a bridge restart and a Clear until each resets), the model it runs on (a pick from
Claude Code's `/model` list switches it between turns, or for its next start) and what went wrong, each with what to do.
**Compact** in its status bar's **⋮** (with Clear and Stop; between turns; an optional focus says what the summary should keep) runs Claude Code's `/compact` in
place: the session goes on from the summary, and the "doing now" line says `compacting…`, then `compacted: ctx 64% → 12%`.
From 70% of the context in use, the ctx turns orange and a small orange dot marks the ⋮: a suggestion only (Claude Code compacts by itself near the
limit). The chat marks where a compaction cut the conversation (`[yoicks] compacted`). It
also keeps a to-do list for you (its `todo` tool), under "Needs you" on its Home: what only you can do, such
as a PR to merge, a login or a decision you still owe it, each reminded once when it comes due; ✓ ticks one off and tells the Home, which takes up what follows
(a stopped Home isn't told), and **Ask** quotes one (with its id) in the composer, to ask the orchestrator about it. Each Home's switcher button
(and its heading in the PC sidebar) counts what waits on you there. On a PC the sidebar lists it under that heading
(its blocked agents, its question, its to-do list); the agents themselves are folded into one row, **All agents**, which a click unfolds. It has no herdr pane: on the PC,
open the same Home in a browser. To be told while the app is closed, set `notify_url` (ntfy). To go
back to the TUI: remove `"mode": "headless"`, restart the bridge, and tap **Start** on its Home (a
fresh session); the Home's warnings and Settings show the same steps.

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
- No telemetry, no external requests (unless you opt into `notify_url`, or `pr_watch`: then your
  `gh` asks GitHub for the state of the PRs on the headless orchestrators' to-do lists, nothing more).
- Anyone with the token can read agent output and type into your panes — treat the
  URL like an SSH key. Rotate by deleting `token` in the state dir and restarting.
  Tokens are 32 hex chars (128-bit); tokens created by older versions were 64 and
  stay valid until rotated.

## Compatibility

| | Status |
| --- | --- |
| Linux amd64 | Supported, used daily |
| Linux arm64 | Supported: CI runs the tests (including a bridge against a fake herdr) on arm64; not yet run against a real herdr |
| macOS arm64 / amd64 | Experimental: both are built; CI runs the unit tests on arm64 only. Not yet run against a real herdr; see [Known limitations](#known-limitations) |
| herdr | 0.9.5 (socket protocol 22) verified. With another protocol the bridge logs a warning in `bridge.log`, and `status` shows it |
| Claude Code | 2.1.322 verified: the orchestrator permission rules and the chat view's transcript format |

Windows isn't supported (herdr doesn't run there). The binaries are statically linked
(`CGO_ENABLED=0`), so any Linux distribution works, glibc or musl.

## Known limitations

- **macOS: no Claude-account checks.** An agent's Claude account is read from Linux's `/proc`.
  On macOS, the commands that need a pane's account (`overview`, `agent …`, `worktree remove`)
  refuse, an orchestrator's Home lists every agent rather than its account's, **Clear**
  relaunches without checking the account, and the CLI takes its own `CLAUDE_CONFIG_DIR` as the
  caller's account.
- **Claude Code installed with npm** runs as `node`, so `yoicks` doesn't recognize it as the
  calling orchestrator's Claude process and falls back to its own `CLAUDE_CONFIG_DIR`. Use
  Claude Code's native installer for orchestrators.
- **Chat view transcripts** are found under `~/.claude/projects` and
  `~/.config/claude/<name>/projects`. On Linux, an agent with any other `CLAUDE_CONFIG_DIR` is
  found through its process environment; on macOS it isn't, and its pane keeps the terminal view.

## Troubleshooting

- `curl -s http://127.0.0.1:8390/healthz` should answer `{"ok":true,"herdrConnected":true}`. No
  answer: the bridge isn't running (start it, then read `bridge.log`). `"herdrConnected":false`:
  it can't reach herdr's socket (`$HERDR_SOCKET_PATH`, by default `~/.config/herdr/herdr.sock`).
- `herdr plugin action invoke y011d4.yoicks.status` reports the plugin's and herdr's versions,
  herdr's protocol (with a warning when it isn't a verified one) and the optional commands found
  on the PATH herdr gives plugins. Read the output with
  `herdr plugin log list --plugin y011d4.yoicks` (its `stdout`).
- The detached bridge logs to `bridge.log` in the state dir
  (`~/.local/state/herdr/plugins/y011d4.yoicks`): the version it runs, the herdr it connected
  to, and errors. It never has the token (`start` also redacts it from lines an older bridge
  wrote), but it names your paths and agents, so keep it private.
- The phone still shows the old app after an update: close and reopen it (the service worker
  fetches the new version in the background).
- The connect pane prints a URL but no QR code: install `qrencode`.

## API surface (for scripting)

- `GET /api/state` — normalized workspaces/tabs/panes/agents tree, plus `orchestrators`
  (`[{ name, label, paneId, agents, mode, headless, todos }]` in config order; `paneId` is the agent running in its dir, or
  `null`; `agents` the agent panes of its Claude account, itself included, or `null` when unknown;
  `mode` is `"tui"`, or `"headless"` for one the bridge runs itself as `claude -p` (config
  `"mode": "headless"`), whose `paneId` is `"hl:<name>"` while it runs and whose
  `headless` is `{ status: stopped|idle|working|blocked|done|error, completionSeq, pending: { id, questions } | null,
  usage: { fiveHour, sevenDay, fable: { utilization (0–1), resetsAt (ms) } | null, contextPct | null, at } | null,
  warnings: [{ kind, message, since, actions: (interrupt|clear|tui)[] }], model, activeModel, models: [{ value, displayName, description, resolvedModel }],
  compact: { state: running|done|failed, from, to, error } | null }`,
  `null` for a tui one; `compact` is its last compaction (the Home's, a typed `/compact`, or Claude Code's own near the
  limit) until the next turn ends: `from` and `to` the context before and after, percent of the window (`null` while
  unknown), `error` why it failed (`""` when it didn't); `models` is Claude Code's `/model` list without its `default` (whose model, if nothing else
  offers it, stays as its id), `[]` until a child of this bridge has given it; `model` the one chosen here, `""` for none; `activeModel` the model in effect, Claude Code's id, `""`
  until known: with none chosen, a resumed session keeps the model it last ran on), `todos` the user's
  to-do list on its Home (`[{ id, text, agent, url, due, createdAt }]`, oldest first, never `null`: what its
  orchestrator wrote down for the user to do; `agent` a worker's herdr name, `url` an http(s) link, `due` ms, each
  `null` when not given)
  and `orchestratorPaneId` (the first running tui one's, or `null`), and `claudeCheck`, the last Claude Code check
  (`{ at (ms), version, ok, failed: [items] }`, `null` when none has run), and `purposes` (`{ <paneId>: <one line> }`,
  never `null`: what each worker is for, as a headless orchestrator's `agent_start` or `agent_prompt` gave it; the
  app shows it over the agent's name, and it goes once the agent is gone). Each agent's `completionSeq` is herdr's
  `completion_seq` (which completion its idle/done status is; `null` until fetched), and its
  `stateChangeSeq` is herdr's `state_change_seq` (herdr's order of status changes, which the app
  lists by; `null` until fetched), and its `herdrName` herdr's name for it (`agent.start`'s, as
  `yoicks agent` and a headless orchestrator's `[yoicks]` notices name it; `null` until fetched)
- `GET /api/panes/:paneId/read?source=visible|recent&lines=N&format=text|ansi` — `visible` is the
  pane's live screen: the bridge reads the bottom screen (herdr's `detection` for text, `recent`
  one viewport tall for ANSI), since herdr's own `visible` follows the desktop's view, which may be
  scrolled up
- `POST /api/panes/:paneId/input` `{"text": "ls", "enter": true}` or `{"keys": ["ctrl+c"]}`
  — add `"clear": true` to wipe the pane's composer (repeated Ctrl+U) before the
  text lands, so a message composed here submits alone instead of being appended
  to a draft already typed straight into the pane
- `POST /api/panes/:paneId/focus`
- `POST /api/panes/:paneId/scroll` `{"direction": "up", "steps": 3}` — SGR wheel events for full-screen apps
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
  409 when it already runs. A headless one starts as the bridge's child instead (resuming its session),
  after checking it stays on the Claude subscription (409 otherwise), and returns `{"paneId": "hl:<name>", "name"}`.
- `POST /api/orchestrators/:name/send` `{"text": "…"}`, `…/interrupt`, `…/clear` and `…/stop` — for a
  headless orchestrator: send a message (also while it works) and interrupt its turn, both 409 when it
  isn't running; clear starts it in a fresh session (returning `{"paneId", "name"}` like start), running
  or not; stop ends it, and succeeds when it is already stopped. A message sent while a question is
  pending is about it, not an answer: it is written, then the question is refused as `answer`'s `chat` refuses it, with the send's `"answers"` (the panel's so far), if any. A send may
  carry `"images": [{"mediaType": "image/jpeg", "data": "<base64>"}]` (JPEG, PNG or GIF that decode
  whole, at most 4, 2000 px a side and 1 MiB in all; `text` may then be empty), written as image
  blocks before the text; 400 otherwise. The web UI's + and paste
  attach them, scaled and recompressed to JPEG. A headless orchestrator has no herdr pane: `/api/panes/hl:<name>/…` and
  `/api/agents/hl:<name>/…` answer 404, except `GET /api/panes/hl:<name>/transcript`.
- `POST /api/orchestrators/:name/model` `{"model": "<value>"}` — set a headless orchestrator's model to one of
  `headless.models` (400 for another): a running one switches in place (Claude Code's `set_model`, from its next
  turn), 409 while a turn runs, 504 when Claude Code hasn't answered within 10 s (kept once it does); a stopped one
  starts on it. Kept across restarts and Clear (`--model` at each start).
- `POST /api/orchestrators/:name/compact` `{"focus"?: "<what the summary should keep>"}` — compact a headless
  orchestrator's conversation in place (Claude Code's `/compact`, the focus on one line, at most 2000 bytes): the session goes
  on from the summary; `headless.compact` follows it. Between turns only: 409 `busy` while a turn runs or a question waits,
  409 `not_running` when stopped. It counts no completion.
- `POST /api/orchestrators/:name/answer` `{"id": "…", "answers": {"<question>": "<label>"}}` or
  `{"id": "…", "deny": "<message>"}` or `{"id": "…", "chat": true, "answers"?: {…}}` — answer (or refuse) the
  headless orchestrator's pending question (`headless.pending`, its AskUserQuestion): a multiSelect's labels
  joined by `", "`, free text allowed (Claude Code's "Type something."); `chat` is Claude Code's "Chat about
  this": refused with its words, which list the questions and the answers given so far; 409 when that id
  isn't the one pending.
- `DELETE /api/orchestrators/:name/todos/:id` — tick an item of that Home's to-do list off; a running
  headless Home is woken with `[yoicks] to-do done by the user: <text> (<agent>, <url>)` (several within
  3 s in one message; a stopped one is never told); 404 when there is no such item (already ticked off,
  or done by its orchestrator).
- `DELETE /api/panes/:paneId` — stop an agent by closing its pane
- `POST /api/panes/:paneId/rename` `{"name": "worker-2"}` — rename the agent running in the pane
- `POST /api/agents/:target/clear` — start a fresh replacement agent (same profile + cwd) and close
  the old pane; the pane id changes, so the client re-follows the new pane
- `GET /api/panes/:paneId/transcript` — Claude Code chat view: the pane's JSONL
  session transcript as normalized `items` (`user`/`assistant`/`thinking`/
  `tool_use`/`tool_result`; a `user` item with images has `images`, as data: URLs) plus `sessionId` and a byte `cursor`. Returns
  `{"available": false}` when the pane isn't a claude session or its transcript
  isn't on this host. Add `?session=<id>&after=<cursor>` to fetch only items past
  the cursor for that session (incremental polling).
- `POST /api/agents/:target/send` `{"text": "continue"}` — submit a prompt to a ready agent (herdr
  `agent.prompt`; `text` must be non-empty)
- `WS /ws?token=…` — `{"type":"state"}` snapshots and `{"type":"agent_status"}`
  transitions, and `{"type":"orchestrator_alert","name","kind","message"}` for a headless
  orchestrator's new warning (once per session and kind; also to ntfy when `notify_url` is set; `name` `""`
  with `kind` `"canary"`: a failed Claude Code check, once; `kind` `"todo"`: to-do items come due, each
  once, their text as `message`, one alert per Home; `kind` `"github"`: `pr_watch`'s gh failing, once per
  error, to each Home with a PR on its list). A
  headless orchestrator's working → done and → blocked come as `agent_status` with `paneId: "hl:<name>"`
  and its label as `workspaceLabel`. `{"type":"watch_transcript","paneId":…}` starts a live tail that
  pushes `{"type":"transcript_items",…}` (`reset` rebuilds, else appends);
  `{"type":"unwatch_transcript"}` stops it (mirrors `watch_pane`/`pane_output`).

## Development

For local development, clone and **link** a working tree instead of installing from
GitHub — `herdr plugin link` points herdr at your checkout so your edits take effect:

Building from source needs Go (the version in `go.mod`) and Node.js 26.x with `npm`
(`engines` in `package.json`, which CI uses too; the web UI's Vite build and Vitest tests).

```bash
git clone https://github.com/y011d4/herdr-yoicks
cd herdr-yoicks
sh scripts/plugin-build.sh          # web UI, then bin/yoicks (Go), from this checkout
herdr plugin link "$(pwd)"
```

The bridge and CLI are Go (`cmd/yoicks`, `internal/bridge`). The PWA is TypeScript and React
under `web/src/` (`main.tsx` starts the shell, `ui/App.tsx`), built by Vite to `web/dist` and
embedded in the binary.

```bash
sh scripts/plugin-build.sh          # rebuild after changes, web ones too (the binary embeds the web UI)
go test ./...                       # Go tests
npm test                            # web UI tests (Vitest)
./bin/yoicks run                    # run against your live herdr in the foreground (config: see Configuration)
YOICKS_DEV_BRIDGE=http://127.0.0.1:8390 npm run dev   # the web UI from source on :5174 (hot reload),
                                    # /api and /ws proxied to a running bridge; open ?token=<its token>
```

herdr never runs build commands for a linked plugin (not on `herdr plugin link`, nor on
`herdr plugin update`, which skips linked plugins) — rebuild with `sh scripts/plugin-build.sh`
after edits (and re-run `herdr plugin link` only when `herdr-plugin.toml` changed). It always
builds the checkout as it is; `sh scripts/plugin-build.sh release` instead downloads the release
binary of the version in `herdr-plugin.toml`, as an install does.

To deploy a linked checkout's new commits to its running bridge, or to roll it back, run this in
that checkout:

```bash
sh scripts/redeploy.sh main         # fast-forward main to origin/main, rebuild, restart
sh scripts/redeploy.sh <commit>     # the same for an earlier commit (detached)
```

It waits for the stop and start actions and for `/healthz`, and prints the `BUILD` and `CACHE`
that Settings → App version should then show. It refuses before stopping anything on a dirty
tree, when `herdr-plugin.toml` would change (herdr caches a linked manifest: it prints the
steps by hand, `herdr plugin link` included), or, for `main`, until the CI run (GitHub Actions,
through `gh`) of the commit it deploys has passed: it waits for one still going. After any later
failure it starts the old binary again.

Logs for the detached daemon go to `<state dir>/bridge.log`
(`~/.local/state/herdr/plugins/y011d4.yoicks`, or `$HERDR_PLUGIN_STATE_DIR` inside plugin
commands).

### Checking Claude Code for headless mode

A headless orchestrator relies on parts of Claude Code's `claude -p` stream that aren't
documented: the init's keys, the interrupt, the permission tool, the transcript, the usage
events. The live test checks them against the real `claude`, with haiku, a throwaway directory,
your default account (no `CLAUDE_CONFIG_DIR`) and a fake herdr: one session and one resume, about
six short turns. It prints a `PASS`/`FAIL` line per item and afterwards removes its own
`~/.claude/projects/` entry. It is never built into the binary (the `claudelive` tag); CI only vets
it.

```bash
go test -tags claudelive -count=1 -run TestClaudeLive -v ./internal/bridge
```

`scripts/claude-canary.sh` runs it periodically from the linked checkout and writes the result to
`<state dir>/canary.json`. A bridge with a headless orchestrator reads that file every minute. The
state carries it as `claudeCheck`, a failed check is a warning on each headless orchestrator, the
"not verified" version warning tells the last check's result, and each failed check notifies once
(ntfy, the PC, the app). The script runs the test only when Claude Code's version differs from the last check's
or that check is 24 hours old (`--force` runs it now). An hourly systemd user timer runs it:

```bash
sh scripts/claude-canary.sh install   # writes ~/.config/systemd/user/yoicks-claude-canary.{service,timer}
systemctl --user daemon-reload && systemctl --user enable --now yoicks-claude-canary.timer
```

The script never enables the timer itself. Each check costs one short haiku session (tens of
thousands of tokens, mostly cache), about once a day and once per Claude Code update: small, but
part of your weekly quota. When that quota runs low, stop it with `"canary": false` in
`config.json` or `systemctl --user disable --now yoicks-claude-canary.timer`.

### Releasing

Maintainers, from a clean checkout of the commit to release:

```bash
scripts/release.sh 0.2.0    # builds dist/release/* in a temporary worktree with the pinned Go
                            # toolchain; writes release/checksums.txt and the manifest version
git add herdr-plugin.toml release/checksums.txt && git commit -m "release v0.2.0" && git tag v0.2.0
git push origin main v0.2.0
gh release create v0.2.0 dist/release/* --title v0.2.0 --notes "…"
```

The binaries are uploaded as built, uncompressed: their checksums are the ones committed with the
tag, which `scripts/plugin-build.sh` checks on install. Name the verified herdr and Claude Code
versions in the release notes.

## License

[MIT](LICENSE)
