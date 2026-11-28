# What yoicks does vs. what you configure

Each behavior of yoicks is decided in one of five places. When something happens that you didn't
expect, this page says where it was decided, and so where to change it, or that you can't.

| Source | What it is | Who edits it |
|---|---|---|
| **Built in** | the `yoicks` binary, and the orchestrator rules bundled with it ([`orchestrator/rules.md`](https://github.com/y011d4/herdr-yoicks/blob/main/orchestrator/rules.md)) | nobody: it changes with a yoicks update |
| **`config.json`** | the plugin's [configuration](./config) | you |
| **An orchestrator's files** | its directory: `rules.md` (from yoicks) and `local.md` (yours) | yoicks rewrites some of them, you own the rest ([below](#files)) |
| **Claude Code settings** | `.claude/settings.json` and `.claude/settings.local.json`, the account's own settings | yoicks writes one file per orchestrator; the rest are yours |
| **Outside yoicks** | herdr, git, direnv, `gh`, systemd, GitHub, your network transport | you, with those tools |

## The files {#files}

| File | Where (default) | Written by | Edit it? |
|---|---|---|---|
| `config.json` | `~/.config/herdr/plugins/config/y011d4.yoicks/` (`herdr plugin config-dir y011d4.yoicks` prints it) | you | yes; restart the bridge after editing |
| `CLAUDE.md` | `~/.local/share/herdr-yoicks/orchestrators/<name>/` | yoicks, at each bridge start and each start of that orchestrator | no: edits are lost |
| `rules.md` | the same | yoicks: the bundled rules, only the parts for its mode (and for the PR watch when that is on) | no: edits are lost |
| `.claude/settings.json` | the same | yoicks | no: edits are lost |
| `local.md` | the same | yoicks creates it once (a comment only), then it is yours | yes: never overwritten |
| `.claude/settings.local.json` | the same | you (yoicks never writes it) | yes |
| `token`, `bridge.log`, `bridge.pid` and `bridge-run.pid`, `headless/<name>.json` and `.mcp.json`, `todos/<name>.json`, `agent-purposes.json`, `pane-profiles.json` | `~/.local/state/herdr/plugins/y011d4.yoicks/` | the bridge | no (deleting `token` rotates it: [Security model](./security)) |
| `canary.json` | the same | `scripts/claude-canary.sh` | no |
| `yoicks-claude-canary.service` and `.timer` | `~/.config/systemd/user/` | `sh scripts/claude-canary.sh install` | you enable them, or not |

`~/.local/share` is `$XDG_DATA_HOME` when that is set, `~/.local/state` is `$XDG_STATE_HOME`, and
inside herdr's plugin commands the state dir is `$HERDR_PLUGIN_STATE_DIR`.

## Homes and orchestrators {#orchestrators}

| Behavior | Decided by | Where |
|---|---|---|
| Which Homes exist, their names, labels and order | `config.json` | `orchestrators[].name`, `.label` (none: one named `default`) |
| The Claude account each runs under | `config.json` | `orchestrators[].env.CLAUDE_CONFIG_DIR`; without it, the default account (a TUI one: what a direnv `.envrc` over its directory sets, if any) |
| In a herdr pane or headless | `config.json` | `orchestrators[].mode`: `"headless"`, or absent for a pane |
| The program an orchestrator runs | built in | always plain `claude`, whatever `launch_profiles` says |
| How it hands out work, follows workers, reports and cleans up | built in | `rules.md` (from the bundled rules) |
| Which repositories it takes on, the language it answers in, when it may deploy… | you | `local.md` |
| What a TUI orchestrator may run | yoicks writes it | `.claude/settings.json`: `dontAsk`; `yoicks overview`, `yoicks agent …` and `yoicks worktree remove …` are the only commands it may run, editing is denied, and Claude Code's read-only tools still work inside its directory. Your own additions go in `.claude/settings.local.json` |
| What a headless orchestrator may run | built in | the bridge's command line: AskUserQuestion and its yoicks tools, no shell. Its directory's settings can't add any; the bridge reads them only to refuse API billing |
| Seeing and driving only its own account's agents | built in | can't be turned off ([What it can reach](../guide/orchestrators#what-it-can-reach)) |

## Workers {#workers}

| Behavior | Decided by | Where |
|---|---|---|
| The commands an orchestrator drives workers with | built in | [the `yoicks` commands](./cli) (TUI); the same as tools, plus `todo` (headless) |
| Which programs a worker can be started with | `config.json` | `launch_profiles`, merged over the built-in `claude`, `codex` and `opencode` |
| Which profile to use when (a cheaper one for lookups, say) | you | `local.md` |
| Where a new worktree goes | built in | next to its repository, `<repo>-wt-<branch>` |
| A worker's Claude account | built in | the orchestrator's; refused where the directory's direnv comes to another account (a directory without `CLAUDE_CONFIG_DIR` counts as the default account), and for a new worktree also where direnv can't tell |
| A new worktree's account | outside yoicks | an `.envrc` above the repository (herdr can't give a worktree an environment) |
| A worker's own permissions and prompts | Claude Code settings | its account's and its repository's settings, as for any Claude Code session; yoicks writes none. You answer its prompts in its pane |
| The purpose line under a worker's name | the orchestrator | headless `agent_start`'s `purpose`, which the bundled rules ask for |

## Waking the orchestrator {#wakes}

A **headless** orchestrator is woken by the bridge, with messages whose text is built in:

- `[yoicks] <worker>: <from> → <to>` when a worker it prompted finishes or stops for an answer.
  Several within 3 seconds come as one message. A turn the worker takes up on its own (a
  background task, you in its pane) wakes it once that end has held for 10 seconds.
- `[yoicks] <worker>: ready, task not sent` once a worker that was stopped at a question when it
  started is ready for its task.
- `[yoicks] to-do done by the user: <text> (<worker>, <url>)` when you tick an item off its to-do
  list (only while it runs).
- `[yoicks] PR merged: <url> (<worker>); its to-do item is removed`, `PR closed without merging: …`
  and `PR <url> can't be read …`, with the PR watch.
- `[yoicks] restarted while you were working; check overview.` after a restart in the middle of a
  turn.

What it does when woken comes from `rules.md`, and from your `local.md`.

A **TUI** orchestrator gets no such messages: the bundled rules tell it to run
`yoicks agent prompt <name> "<task>" --wait` in the background, and that command ending wakes it.

## The to-do list {#todos}

Headless orchestrators only.

- **Built in:** the `todo` tool, the list under **Needs you** on the Home, keeping it across Stop,
  Clear and restarts (`todos/<name>.json`), one reminder when an item comes due, and waking the
  orchestrator when you tick an item off (a stopped one isn't told).
- **The bundled rules** say what goes on it: what only you can do, such as a PR to merge, a login or
  a decision you owe; never a blocked worker or its own question, which the Home shows anyway.
- **Your `local.md`** can add to that.
- **You** tick items off on the Home.

## The PR watch {#pr-watch}

- **On or off:** `config.json`'s `pr_watch` (headless entries only). Off by default: then nothing goes
  to GitHub.
- **Built in:** looking up the github.com PR links on the to-do lists once a minute, removing a merged
  or closed PR's item, and the wake messages above.
- **Outside yoicks:** `gh`, on the bridge's PATH and logged in; the PR states are read with its login.
- **After a merge:** the bundled rules have the worker deploy only if your `local.md` allows a
  deploy in that repository (with the checks it names); otherwise the orchestrator just tells you
  it is merged. Either way it then cleans up the worker. A deploy after a merge is always your rule,
  never yoicks's.

## Closing finished panes {#auto-close}

Built in, with no key to turn it off. Once a worker's agent exits and its shell is back in the
foreground, the bridge closes the tab `yoicks agent start` (or the `agent_start` tool) opened for it
(that tab's shell carries `YOICKS_WORKER=1`). It never closes a pane you opened or an
orchestrator's. A worker started in a new worktree isn't closed this way either (herdr gives a new
worktree no environment, so its shell has no mark), nor is the last pane of a linked worktree's
workspace: `yoicks worktree remove` closes those with the worktree.

## Headless Homes {#headless}

| Behavior | Decided by | Where |
|---|---|---|
| Running headless | `config.json` | `orchestrators[].mode: "headless"` |
| Subscription only (refusing API-key billing), restarting after a crash, stopping with the bridge | built in | [Headless orchestrators](../guide/headless) |
| Its model | you, on its Home | the pick is kept in the state dir and passed at each start |
| Compact, Clear, Stop | you, on its Home | its **⋮** |
| The usage line (`5h · 7d · ctx`) and the orange hint from 70% of the context | built in | from Claude Code's own stream; nothing to configure |

## Notifications {#notifications}

| Where | What | Decided by |
|---|---|---|
| The phone's OS notifications | an agent's or a headless Home's blocked or done, a headless Home's warnings and due to-dos, a failed Claude Code check, while the app is in the background | Settings → **Enable notifications**, on each device, and the browser's permission |
| [ntfy](https://ntfy.sh) | the same | `config.json`'s `notify_url` (unset: nothing is sent) |
| The PC (herdr's notification) | a headless Home's blocked or done, its warnings and due to-dos, a failed Claude Code check | built in; none for agents in panes |
| The app's toasts | the results of what you did | built in |

## Checking Claude Code {#canary}

- **Built in:** the live test and `scripts/claude-canary.sh`, in the checkout. With a headless
  entry, the bridge shows the last result, warns while it failed, and alerts once per failed check.
- **Outside yoicks:** running it: an hourly systemd user timer that `claude-canary.sh install`
  writes and you enable (the script itself checks only for a new Claude Code version or after 24
  hours; it needs `go` and the checkout).
- **Turning it off:** `"canary": false` in `config.json` (the script reads it, not the bridge), or
  disable the timer. See [Checking Claude Code](../guide/headless#checking-claude-code).

## Reaching the bridge {#network}

| Behavior | Decided by | Where |
|---|---|---|
| Bind address and port | `config.json` | `host`, `port` (`HERDR_YOICKS_HOST` and `HERDR_YOICKS_PORT` win) |
| The URL in the connect QR | `config.json` | `public_url`; unset, Tailscale is detected |
| The transport (`tailscale serve`, a reverse proxy, a tunnel) | outside yoicks | [Exposing the bridge to your phone](../guide/phone) |
| The bearer token, loopback by default, no requests out unless asked | built in | [Security model](./security) |

## Developing yoicks {#developing}

Only for work on yoicks's own repository; none of it affects a plugin you installed.

| Behavior | Decided by | Where |
|---|---|---|
| CI | the repository | `.github/workflows/ci.yml` |
| The e2e checks | the repository | `tools/e2e.ts`; CI runs Tier 1 on every PR and every push to main |
| PR screenshots | the repository | `screenshots.yml` shoots main's and the PR's screens, `screenshots-publish.yml` compares them and sets the `screenshots` status |
| Approving changed screenshots | the maintainer | ticking the box in the bot's comment on the PR; nothing else approves |
| Which checks a merge into main needs | outside yoicks | GitHub's branch protection, a repository setting (here: `web`, `bridge`, `e2e` and `screenshots`) |
| Deploying to the running bridge | the repository | `sh scripts/redeploy.sh main`, which waits for CI's run of that commit (through `gh`) ([Development](../development)) |
| Running that deploy without a prompt in Claude Code | Claude Code settings | the repository's `.claude/settings.json` allows exactly `sh scripts/redeploy.sh main`; a rollback still asks |
| An orchestrator deploying after a merge | you | its `local.md` ([PR watch](#pr-watch)) |
| Git hooks | outside yoicks | the repository ships none; whatever is in your clone's `.git/hooks` is your own |
| Releases | the repository | `scripts/release.sh` ([Releasing](../development#releasing)) |
