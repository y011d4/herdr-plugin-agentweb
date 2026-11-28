# Orchestrators

Orchestrators are Claude Code agents you talk to, which hand the work to other agents and report
back. You list them under `orchestrators` in the [configuration](../reference/config), and
opening the app lands on one's **Home**.

## Its directory {#its-directory}


For each entry of `orchestrators`, the plugin keeps a directory,
`~/.local/share/herdr-yoicks/orchestrators/<name>/` (under `$XDG_DATA_HOME` when set), writing
it when the bridge starts and again each time it starts that orchestrator:

- `CLAUDE.md` — names the orchestrator and imports the two files below.
- `rules.md` — the rules bundled with the plugin ([`orchestrator/rules.md`](https://github.com/y011d4/herdr-yoicks/blob/main/orchestrator/rules.md)):
  how to start workers, follow them, report, and clean up after them.
- `.claude/settings.json` — its permissions (below).
- `local.md` — **yours**: this orchestrator's own rules (which repositories it takes on, the
  language to answer in, a cheaper launch profile for lookups…). Created empty once and never
  overwritten. For your own permissions, use `.claude/settings.local.json`.

It starts in a new herdr workspace at that directory, with its `env`. The plugin then checks that
it came up under the Claude account that `env` sets, and stops it otherwise. No per-directory
tool such as direnv is needed. **Clear** (in the agent menu) restarts it with the same account.

## What it can reach {#what-it-can-reach}

An orchestrator drives its workers only through `yoicks`, which touches nothing outside
its own Claude account. The account is an agent process's `CLAUDE_CONFIG_DIR` (default
`~/.claude`). Anything whose account differs, or can't be told, is hidden or refused. The commands
are listed in [The `yoicks` commands](../reference/cli).

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

## Headless {#headless}

An orchestrator can also run without a pane, as the bridge's own `claude -p`: see
[Headless orchestrators](./headless).
