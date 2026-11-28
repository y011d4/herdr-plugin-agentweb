# Headless orchestrators

`"mode": "headless"` on an entry runs that orchestrator as the bridge's own `claude -p`
instead of an agent in a herdr pane (your Claude subscription only: the bridge refuses API-key
billing). Its Home is then the chat alone: messages go out also while it works, ■ on the
"doing now" line interrupts it, its questions get an answer panel, and its status bar (on a PC its top bar) shows its
usage (`5h · 7d · fable · ctx`; fable only while it runs on Fable; a tap on it lists when each limit resets: the time left and the clock time; the limits stay across a bridge restart and a Clear until each resets), the model it runs on (a pick from
Claude Code's `/model` list switches it between turns, or for its next start) and what went wrong, each with what to do.
**Compact** in its **⋮** (with Clear and Stop; between turns; an optional focus says what the summary should keep) runs Claude Code's `/compact` in
place: the session goes on from the summary, and the "doing now" line says `compacting…`, then `compacted: ctx 64% → 12%`.
From 70% of the context in use, the ctx turns orange and a small orange dot marks the ⋮: a suggestion only (Claude Code compacts by itself near the
limit). The chat marks where a compaction cut the conversation (`[yoicks] compacted`). It
also keeps a to-do list for you (its `todo` tool), under "Needs you" on its Home: what only you can do, such
as a PR to merge, a login or a decision you still owe it, each reminded once when it comes due; a tap on one opens its menu: **Mark done** ticks it off and tells the Home, which takes up what follows (a stopped Home isn't told), **Snooze…** puts it off to later (in 1 hour, in 3 hours, this evening at 18:00, tomorrow at 09:00, or a day and time of your own): it waits under Later, out of the Needs you count, until then, and comes back with a reminder (the Home isn't told), **Ask the orchestrator** quotes it (with its id) in the composer, to ask the orchestrator about it, and **Dismiss** drops it undone: the Home is told it isn't needed, so it takes no next step from it and doesn't add it again unless you ask (a PR's item dismissed is no merge, and that PR isn't watched any more). A phone's switcher button
for each Home (and its row in the PC's left rail) counts what waits on you there. On a PC from 1280px wide the Home's panel, beside its chat, lists it in place of the
Home's Needs you (its blocked agents, its question, its to-do list), then its other agents. It has no herdr pane: on the PC,
open the same Home in a browser. To be told while the app is closed, set `notify_url` (ntfy). To go
back to the TUI: remove `"mode": "headless"`, restart the bridge, and tap **Start** on its Home (a
fresh session); its Home's ⋮ (**Back to the TUI…**) and its warnings show the same steps.

## Checking Claude Code {#checking-claude-code}


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
