# The `yoicks` commands

An orchestrator drives its workers with these commands (the plugin's `bin/yoicks`), and none of them
touches anything outside the caller's Claude account (see
[Orchestrators](../guide/orchestrators#what-it-can-reach)):

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
- `orchestrator start <name>` — starts a configured orchestrator, as **Start** on its Home does. It is
  for you, not for orchestrators: their allowlist doesn't include it.
