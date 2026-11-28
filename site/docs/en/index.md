# What is yoicks

*Yoicks* is the huntsman's cry that sends the pack on.

yoicks is a [herdr](https://herdr.dev) plugin for running many coding agents at once through one of them. You
hand the work to an **orchestrator**, a Claude Code agent you talk to on its **Home**, and it does the rest in
parallel:

- **It starts the workers.** One per task (`yoicks agent start`), each in a new herdr tab and, for a repository,
  in its own git worktree next to the repo (`<repo>-wt-<branch>`). When a worker exits, the bridge closes the tab
  it opened; a worker in a worktree keeps its tab until its branch is merged and `yoicks worktree remove` takes
  the worktree, the tab and the branch away.
- **It follows them.** A worker that finishes or stops for an answer wakes the orchestrator, which reads the
  result and gives the next task, or tells you what the worker is waiting for (you answer in that worker's pane).
- **It brings you only what needs you.** The Home's **Needs you** lists its account's blocked agents and its own
  question. A [headless](./guide/headless) orchestrator also keeps a to-do list of what only you can do (a PR to
  merge, a login, a decision), each reminded once when it comes due.
- **It goes on after a merge.** With `pr_watch` ([configuration](./reference/config)), a headless orchestrator
  learns that a PR on its to-do list was merged, deploys if its own rules allow a deploy there, and cleans up the
  worker.
- **It stays in its account.** An orchestrator sees and drives only the agents of its own Claude account, so a
  work Home and a personal one stay apart ([Orchestrators](./guide/orchestrators)).

## In your hand {#in-your-hand}

The plugin runs a small local bridge server (a Go binary) that serves a mobile-first PWA, so all of it is on your
phone or a PC's browser:

- Dashboard of all agents across all workspaces with live status
  (idle / working / **blocked** / done), blocked agents sorted to the top;
  a done agent you open on the phone reads as idle there (herdr's own state is left as is);
  each card shows its git branch, and a linked worktree's agents appear inside their
  main checkout, chipped as a worktree
- Rename, clear, and stop agents from the phone: each pane's **⋮** menu renames, clears
  (fresh session), or stops it (an orchestrator's Home has **Clear** and **Stop** buttons
  instead). Agents are started by the orchestrators, not by hand. **⚙** at the top right
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
