# Compatibility and troubleshooting

## Compatibility {#compatibility}


| | Status |
| --- | --- |
| Linux amd64 | Supported, used daily |
| Linux arm64 | Supported: CI runs the tests (including a bridge against a fake herdr) on arm64; not yet run against a real herdr |
| macOS arm64 / amd64 | Experimental: both are built; CI runs the unit tests on arm64 only. Not yet run against a real herdr; see [Known limitations](#known-limitations) |
| herdr | 0.9.5 (socket protocol 22) verified. With another protocol the bridge logs a warning in `bridge.log`, and `status` shows it |
| Claude Code | 2.1.322 verified: the orchestrator permission rules and the chat view's transcript format |

Windows isn't supported (herdr doesn't run there). The binaries are statically linked
(`CGO_ENABLED=0`), so any Linux distribution works, glibc or musl.

## Known limitations {#known-limitations}


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

## Troubleshooting {#troubleshooting}


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
