# Install

## Requirements {#requirements}


- [herdr](https://herdr.dev) >= 0.9.5 (see [Compatibility](../reference/troubleshooting#compatibility))
- Linux on amd64 or arm64. macOS (Apple silicon and Intel) is experimental.
- Nothing else to install: the plugin is one prebuilt binary, which the install downloads
  and checks with the usual `sh`, `curl` or `wget`, and `sha256sum` or `shasum`. No Node.js,
  no Go.
- A way to reach the bridge from your phone — a reverse proxy, a tunnel, or a VPN
  (see [Exposing the bridge to your phone](./phone)).
  Tailscale is one easy option, not a requirement.
- Optional commands, used when present:
  - `git` >= 2.31 — branch names on the cards, worktrees
  - `qrencode` — the connect QR code (without it, the connect pane prints the URL)
  - `tailscale` — the connect URL is detected when the bridge is behind `tailscale serve`
  - `direnv` — per-directory Claude accounts for [orchestrators](./orchestrators)
  - `gh` — `worktree remove` recognizes squash-merged branches

## Setup {#setup}


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
checkout instead, see [Development](../development).

## Updating {#updating}


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

## Rolling back {#rolling-back}


To go back to an earlier release, stop the bridge, reinstall that version, start again:

```bash
herdr plugin action invoke y011d4.yoicks.stop   # wait until it has finished
herdr plugin uninstall y011d4.yoicks            # keeps the token, config and orchestrator dirs
herdr plugin install y011d4/herdr-yoicks --ref v<earlier version>
herdr plugin action invoke y011d4.yoicks.start
```

Then Clear the running orchestrators, as after an update.

A linked checkout (see [Development](../development)) rolls back with
`sh scripts/redeploy.sh <commit>` instead.

## Uninstalling {#uninstalling}


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
