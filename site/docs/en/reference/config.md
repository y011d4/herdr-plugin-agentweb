# Configuration


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
  [Exposing the bridge to your phone](../guide/phone)). Binding
  to a LAN/VPN IP serves plain HTTP directly (works, but the PWA then runs without a
  secure context: no service worker, no system notifications).
- `port` — bridge port (default 8390).
- `public_url` — **the main switch for remote access**: the base URL your phone uses
  to reach the bridge, e.g. `"https://herdr.example.com"` (reverse proxy or Cloudflare
  Tunnel), an ngrok URL, or `"https://gram.your-tailnet.ts.net"` (Tailscale). The
  connect QR pane builds its link from this. When unset, the pane falls back to
  auto-detecting Tailscale (serve HTTPS address, else tailnet IP), then to
  `http://127.0.0.1:<port>` — so set it for any transport other than Tailscale. See
  [Exposing the bridge to your phone](../guide/phone).
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
  [Orchestrators](../guide/orchestrators)) and starts it from the phone (**Start** on its Home, which opens even while it
  is stopped) or with `<plugin dir>/bin/yoicks orchestrator start <name>`. Opening the app lands on an
  orchestrator's **Home**: its chat with only the dialogue (tool calls hidden), a status bar of its
  Claude account's agents (those that need you, and counts of the rest), and a "doing now" line while
  it works. Orchestrators aren't listed among the agents. A tap on the counts lists those agents, blocked first,
  then working, done and idle (a tap on one opens it); its **Open the list** opens the agents list with
  only that account's agents (`#/agents/<name>`, Back returns to the Home); the full list's
  **← Home** opens the Home used last. With two or more configured, a phone's top bar is a switcher between the
  Homes (`label`s, with their status and what waits on you there; it scrolls sideways when they don't fit), over the
  Home's status bar. On a PC a rail at the left lists the Homes instead, each with what waits on you there (a count)
  and its agents' counts (working, done, idle); a click opens the Home, and **All agents** at its bottom the full
  list. A Home's top bar is its own: its name and status, then what a phone has at its status bar's right (a headless
  one's usage and model, `>_` and **⋮**). From 1280px wide a panel at the Home's right lists what needs you there (its
  question, its blocked agents, its to-do list) and its other agents, with **Open the list**; narrower, its status bar
  keeps Needs you and the counts. The app reopens the Home used last (`#/home/<name>`); with none, it opens on the list.
- `notify_url` — optional [ntfy](https://ntfy.sh) topic URL for background push
  notifications, e.g. `https://ntfy.example.internal/herdr` for a **self-hosted**
  ntfy instance. When unset (default) the bridge performs no outbound requests at
  all. If you want pushes while the app is closed: self-host ntfy, bind it to
  your tailnet, point the ntfy Android app at the same topic.
- `canary` — `false` turns off `scripts/claude-canary.sh`, the periodic check of Claude Code for
  headless orchestrators (see [Checking Claude Code](../guide/headless#checking-claude-code)).
- `pr_watch` — `true` lets headless orchestrators notice merged PRs by themselves. Once a minute the
  bridge asks your `gh` (its login, as on the PC) for the state of the github.com PR links on their
  to-do lists, all in one GraphQL call. A merged or closed PR's item is removed and its orchestrator
  is told (`[yoicks] PR merged: <url>`), so it can go on (a deploy its local rules allow, cleaning up
  the worker). Needs `gh` on the bridge's PATH and logged in (`gh auth status`); when it fails, each
  Home with a PR on its list is alerted once per error. Off by default: then nothing goes to GitHub.

For which behaviors are built in and which come from this file, an orchestrator's files or tools
outside yoicks, see [What yoicks does vs. what you configure](./built-in-vs-configured).

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
