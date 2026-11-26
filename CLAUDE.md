# herdr-yoicks

herdr plugin: a bridge server (one Go binary, `yoicks`) that translates the herdr
unix-socket API into HTTP/WebSocket, plus a mobile-first PWA it serves. Lets a phone monitor
and control every coding agent running in herdr. herdr itself is never
modified — everything goes through its public socket API.

## Architecture

```
phone (PWA: web/src/*.ts → built by Vite to web/dist)
  │ REST /api/* + WS /ws (bearer token)
bridge (Go: cmd/yoicks + internal/bridge, web/dist embedded; binds 127.0.0.1:8390)
  │ ndjson over $HERDR_SOCKET_PATH
herdr server
```

All in `internal/bridge/` (one package):

- `herdr_client.go` — socket RPC + persistent event subscription + reconnect (one actor goroutine)
- `state.go` — pure snapshot/event → normalized State (unit-tested; keep it I/O-free)
- `worktree_resolve.go` — git context herdr omits (esp. the branch), resolved
  from a workspace's cwd via `git rev-parse` (I/O + TTL cache; runs in herdr_client
  after createState so state.go stays pure)
- `transcript_normalize.go` — pure JSONL line → chat TimelineItem[] (unit-tested; I/O-free)
- `transcript.go` — resolve + tail a claude pane's transcript file (I/O)
- `http.go` — REST routes, static files (embedded web UI); `ws.go` — WS (state pushes,
  per-client pane + transcript watch); `serve.go` — the bridge process
- `agent_lifecycle.go` — pure start/stop/rename/clear/create-worktree orchestration over an
  injected herdr `rpc` (unit-tested, I/O-free like worktree-resolve's injectable git). Uses herdr's own
  `tab.create`/`pane.split`/`agent.start`/`agent.prompt`/`pane.close`/`agent.rename`/`agent.get`/`worktree.create`;
  agents launch only from a
  fixed `launch_profiles` allowlist (never a caller-supplied command). http.go wires the routes
  (`POST /api/agents`, `DELETE /api/panes/:id`, `POST /api/panes/:id/rename`, `POST /api/agents/:target/clear`,
  `POST /api/worktrees`). The New agent UI's "Create a new worktree" toggle creates a worktree, then starts
  the agent in its checkout. Every new worktree (phone, API, `yoicks agent start --worktree`) goes
  next to its repo as `<repo>-wt-<branch>` (`placeWorktreeNextToRepo` in worktree_resolve.go), so a
  parent-dir `.envrc` (e.g. the Claude account per org dir) covers it; herdr's own default dir wouldn't.
- `auth.go` / `notify.go` / `config.go` — token, agent-status fanout + optional ntfy, config
  (config also parses `launch_profiles`, merged over built-in defaults)
- `cli.go` (`cmd/yoicks` is its main) — plugin entrypoints: serve (the bridge) | run |
  start | stop | status | qr, plus the
  orchestrator's commands: `overview` (read-only text summary of the other agents; pure part in
  `overview.go`), `agent get|read|prompt|wait|start` and `worktree remove` (plus
  `orchestrator start <name>` for people; an orchestrator's allowlist doesn't include it). `agent
  start` gives the new tab the caller's account as env (`accountEnv`), so workers need no direnv;
  it refuses only where direnv positively reports another account. All of them are
  confined to the caller's Claude account (`account.go`: an account = the agent process's
  `CLAUDE_CONFIG_DIR`/projects, read from /proc of the pane's foreground process group leader; the
  caller's = its nearest `claude` ancestor's; a dir's = `direnv exec` with our own account/direnv
  vars stripped; unknown = refused). get/read/prompt/wait shell out to the herdr CLI on the resolved
  pane id after the check. Talks to the herdr socket + transcripts directly, never the token.
  The commands' bodies take the account (and the rpc) as arguments — `overviewText`,
  `ownAgentPane`, `startOwnAgent`, `removeOwnWorktree` — so a caller inside the bridge can use them;
  the CLI passes `ownAccount()` and prints.
  herdr's `agent.start` RPC answers before the agent's process exists (the shell is still in the
  foreground), so `agent start` waits for `agent.get` to report the detected agent before
  checking the started agent's account.
- `web/src/main.tsx` (index.html's entry) starts `ui/App.tsx`, the SPA shell, and draws it into
  `#app` over index.html's static first paint (the same topbar, banner and `#screen`): hash routing
  (`routes.ts`, pure `resolveRoute`; each route render gives the screen and its topbar a new key,
  so they mount afresh), the topbar (each screen fills its three slots), the connection dot and the
  reconnect banner, the SW's `navigate` message, visibilitychange's global part (the watch, the
  open pane's OS notifications, seen done), `visualViewport` → `--app-height` and the startup (token,
  WS, first `/api/state`, a 401 → the token screen). Under it: `api.ts` (token, REST; a 401 →
  callback), `store.ts` (State, WS link, `view`, seen done, kept tasks; subscribe/emit), `ws.ts`
  (socket, ping, backoff, state polling, watches) and `notify.ts` (the toast store and the OS
  notifications). The screens are in `web/src/ui/`: Settings, Token, the agents list `Dashboard.tsx`,
  `Pane.tsx` and `PromptPanel.tsx`; `Toasts.tsx` draws into `#toast-container` and `Modals.tsx`
  (Confirm, agent actions, Rename, New agent) is portalled into `#modal-root`. An opened
  pane's body is `pane-view.ts` (`createPaneView` → setMode/onState/echo/destroy, one per opened
  pane or Home: the chat log, the transcript probe, its own WS messages and agent_status, the 3s
  refresh, the pane's visibilitychange, the prompt poll and going Back after an answer) over `terminal.ts` (`createTerminal`:
  the continuous buffer, fit/pinch, wheel forwarding and fling). These two are the imperative
  engines, and an engine owns only its own DOM subtree: `#pane-view`'s children, an empty
  container React draws and never renders into. `ui/Pane.tsx` draws the topbar, Home's
  bits, the composer (an uncontrolled textarea) and the quick keys around `#pane-view`, and
  `ui/PromptPanel.tsx` the answer panel pane-view reports (`opts.prompt`: taps, in-flight guard, cooldown, 409). `ansi.ts` — pure ANSI→HTML,
  `transcript.ts` — pure TimelineItem→HTML chat renderer, `sw.ts` — service worker (built
  into `sw.js` by `vite.config.ts`'s `sw()`). `web/index.html` is Vite's input, `web/public/`
  (manifest, icons) is copied as is, and `web/dist` (`//go:embed all:web/dist`) is the output: one
  JS and one CSS file under `assets/`, named by content hash (no code splitting: an open PWA would
  ask for a deleted chunk after a deploy). The bridge serves `assets/*` as `immutable`,
  `index.html` and `sw.js` as `no-cache`; `embed_test.go` checks the build and its size budget
- **Orchestrator homes**: config `orchestrators: [{name,label,env}]` — each is *managed*:
  `orchestrator.go` writes `<data>/orchestrators/<name>/` (data = `$XDG_DATA_HOME` or
  `~/.local/share`, + `herdr-yoicks`; `herdr-agentweb`, the dir from before the rename, while it
  exists, so the orchestrators' cwds and with them Claude Code's memory/transcripts/folder trust
  never move: `dataDir`) at bridge start and before each start: CLAUDE.md
  (imports rules.md, then the user's local.md, which is created once and never overwritten),
  rules.md (the bundled `orchestrator/rules.md` with the real yoicks command filled in) and
  `.claude/settings.json` (dontAsk allowlist). It starts (phone Start button →
  `POST /api/orchestrators/:name/start`, or `yoicks orchestrator start <name>`) in a new
  workspace whose shell gets the entry's `env` (herdr `workspace.create`/`tab.create`/`pane.split`
  take `env`; `worktree.create` does not), and the started agent's account is checked against it.
  Clear relaunches with the old agent's account (`accountEnv` → `clearAgent`'s `envFor`). Without
  `orchestrators`, the legacy single `orchestrator_dir`, else the old default dir
  `<data>/dispatcher` when it exists, is one *unmanaged* orchestrator named `default` (the plugin
  never writes there); with neither, a managed `default`.
  The agent running in each dir is that orchestrator, identified by the pane shell's cwd
  (`launchCwd`, not the mutable foreground cwd; nested dirs: the deepest wins), since herdr's
  snapshot has no agent names (`findOrchestrators`, sent as state `orchestrators[]`, plus
  `orchestratorPaneId` = the first running one for older clients). Typically one per Claude account. Status events carry no cwd, so an
  agent appearing in an existing pane triggers a re-snapshot (a `cd` before launch must count).
  A fresh app open (empty hash) lands on a **Home** (`#/home/<name>`; bare `#/home` = the one used
  last on this phone, running or not, else the first running, else the first configured). A stopped
  orchestrator's Home (`StoppedHome`, no pane) shows its account's agents and **Start** (the only
  Start: the list has none); its account is `expectedAccount(def)` (the same rule `startOrchestrator`
  checks against), found once in the background at bridge start. A running one's is the pane view in
  `homeMode` (Stop leaves the Home stopped; a Clear holds it ≤8s for the replacement) — a switcher
  between the configured orchestrators (2+; stopped ones dimmed), a
  status bar of its account's agents (blocked chips + counts, `homeSummary`; no orchestrators), dialogue-only chat
  (`conversationItems` hides tools/injected turns), a "doing now" line (`latestActivity`) and a
  composer (the terminal + quick keys stay one `>_` tap away — the only way to send Esc/Ctrl+C, and
  the fallback when there's no transcript). Orchestrators get no card in any agents list (`agentCards`
  in `ui/Dashboard.tsx` feeds both the list and `homeSummary`); the full list's ← Home opens `defaultHome()`.
  Home's Agents / All agents open `#/agents/<name>`: only the panes in its state `agents` (its Claude
  account's, via `paneAccount`, cached per agent pane and re-checked every 60s by `paneAccountCache`;
  `null` = unknown → every agent),
  with Back to the Home; a pane opened from there goes Back to that list. Any route to
  its pane (`#/pane/<id>`: notification clicks, stale links) is replaced by its Home. herdr's
  `pane.agent_detected` (fires on detect *and* release) is rebuild-triggering, so agent presence and
  `launchCwd` stay current across exit/`cd`/relaunch in one shell. Its behavior (delegating via `yoicks agent …`, waking on background
  `agent prompt --wait`) lives in that dir's `CLAUDE.md`, not in this repo.
- **Headless orchestrators** (being built: plan in `.omc/plans/headless-orchestrator/`): a managed entry
  with `"mode": "headless"` (an unmanaged one stays tui, logged) runs as the bridge's own child,
  `claude -p` over stream-json, instead of an agent in a pane. `headless.go`: one `headlessRunner` per
  such entry (start with the billing checks and the orphan scan; send, also mid-turn; interrupt as a
  `control_request`, no answer in 2 s → kill + `--resume`; stop = interrupt, close stdin, 1.5 s, SIGTERM
  the group, 0.5 s, SIGKILL; clear = a fresh session; a crash restarts with `--resume` after 2/10/30 s,
  more than 3 in 10 min = `error`; the bridge's shutdown stops them in parallel within `yoicks stop`'s
  5 s, Pdeathsig as the backstop). `headless_state.go` is pure: a stdout line → status, completionSeq,
  usage, warnings (unknown events, unreadable lines, the init check). Its state's `paneId` is
  `hl:<name>` while the child runs; the pane/agent routes and `watch_pane` refuse `hl:` (404 /
  nothing read), only the transcript route serves it (`resolvePaneTranscript`'s head). Saved in
  `<state>/headless/<name>.json` (`{sessionId, wanted, rulesHash, watches}`); `<state>/headless/<name>.mcp.json` (only the
  bridge writes it, `--mcp-config` in the argv) is the marker that tells its own orphan from a user's
  `claude --resume`. Warnings also go out once per session and kind as WS `orchestrator_alert`, ntfy
  and herdr's `notification.show`; its working→done and →blocked go out as an agent's do, as
  `StatusChange{PaneID: "hl:<name>"}` (WS `agent_status`, ntfy) and `notification.show` (never for
  `wc-` names). `mcp.go`: the child's MCP server (go-sdk, streamable HTTP on its own `127.0.0.1:0`
  listener; a bearer per child in its mcp.json, new at each start, revoked by Stop and Clear, so a
  call from an old child reaches nothing; an admitted call binds to its child's epoch, new at each
  start, Stop and Clear, and a watch or question it registers once that child is replaced is
  refused; the workers' generation, which a restart keeps, is separate). Its tools
  are the CLI's orchestrator commands as functions (`overview`, `agent_get`, `agent_read`, `agent_prompt`, `agent_start`,
  `worktree_remove`), confined to the account its child runs under; `approve` is the child's
  `--permission-prompt-tool`: AskUserQuestion becomes state `headless.pending` (answered by
  `POST …/answer`; a `/send` meanwhile denies it with its text), held open with progress, anything
  else is denied unasked. `agent_prompt` watches the worker (one goroutine, herdr's waits on a
  closable no-deadline connection, `HerdrClient.Wait`) and wakes the orchestrator with `[yoicks]
  <worker>: <from> → <to>` (names and status only, 3 s coalesced); the watches are saved and
  re-armed after a restart. rules.md has `<!-- tui -->`/`<!-- headless -->` sections (`rulesFor`
  keeps the mode's; the TUI output is pinned by `orchestrator_golden_test.go`). `tools/fakeclaude`
  (built as `claude`; `YOICKS_CLAUDE_BIN` points the bridge at it) stands in for Claude Code in
  tests and checks, MCP calls included. Without a headless entry none of it runs: no child, no MCP
  listener, no `[headless` log line.
- `herdr-plugin.toml` — actions/panes call `./bin/yoicks`. `[[build]]` (`scripts/plugin-build.sh release`) runs on
  `herdr plugin install`/`update` only — never for a linked plugin (not on link, relink, update,
  enable or a herdr restart; checked on 0.9.5): it downloads the GitHub release binary of the
  manifest's `version` and checks it against the committed `release/checksums.txt` (no line or a
  mismatch fails; never a fallback to a source build). Without `release`, as run by hand in a
  linked checkout, `plugin-build.sh` builds that checkout from source (so the linked main is
  always main's latest, whatever release exists). `scripts/release.sh <version>` builds the 4 release binaries
  (linux/darwin × amd64/arm64, pinned toolchain, stripped, `-X …/internal/bridge.Version`) and writes the
  checksums + manifest version; README "Releasing" has the rest

The REST/WS/State JSON contract is documented in README "API surface". The Go bridge
and the TypeScript web share only this contract — change both sides together
(`internal/bridge/contract_test.go` writes `testdata/contract/` and
`web/test/contract.gen.ts`; `npm run check:contract` type-checks it against the web's types).

## Build / test / deploy loop

```bash
npm ci && npm run build:web   # tsc type checks (web, sw), then vite build → web/dist (embedded)
npm test                      # web tests (Vitest; Node per package.json engines)
go test ./...                 # bridge + CLI (CI: go test -race ./...); needs web/dist
go build -o bin/yoicks ./cmd/yoicks
HERDR_PLUGIN_STATE_DIR=$(mktemp -d) HERDR_YOICKS_PORT=8392 ./bin/yoicks run   # dev run
```

The web UI from source (Vite on :5174, hot reload, no service worker: it registers only in a
build; React's StrictMode runs each effect twice there, so an opened pane reads twice), against a
dev bridge:

```bash
STATE=$(mktemp -d)   # the bridge's state (token, bridge.log) and data (orchestrator dirs)
HERDR_PLUGIN_STATE_DIR=$STATE XDG_DATA_HOME=$STATE HERDR_YOICKS_PORT=8392 ./bin/yoicks start   # stop: the same, with stop
echo "http://localhost:5174/?token=$(cat "$STATE/token")"   # the URL to open
YOICKS_DEV_BRIDGE=http://127.0.0.1:8392 npm run dev          # /api and /ws proxied to that bridge
```

To check the built app, SW included, without rebuilding the binary: `npx vite build --watch`
and run the bridge with `YOICKS_WEB_DIR=web/dist`.

Deploying to the running bridge (the binary of the checkout herdr links, normally main's), in
that checkout, with the PC at hand:

```bash
sh scripts/redeploy.sh main      # fetch, fast-forward main, rebuild, stop/start, wait for /healthz
sh scripts/redeploy.sh <commit>  # rolling back: the same, to <commit> (detached)
```

It refuses (before stopping anything) outside the linked checkout, on a dirty tree, when local
main can't fast-forward, and when `herdr-plugin.toml` would change: herdr caches the linked
manifest, so that switch is by hand (it prints the steps: stop, switch, build, `herdr plugin link`,
start). Any failure after the stop puts the old binary back and starts it. It prints the `BUILD`
and `CACHE` that Settings → App version should show on the phone. A commit from before the script
(before the Vite build) has no copy: `t=$(mktemp) && git show main:scripts/redeploy.sh > "$t" && sh
"$t" main`. The binary path doesn't change, so the orchestrators' allowlists still match; Clear them
when `orchestrator/rules.md` differs between the versions. (The last Node bridge is `423f49d`;
going back there takes `npm ci && npm run build`, re-linking, and Clearing the orchestrators.) A
commit from before the rename to yoicks is the plugin `y011d4.agentweb` with `bin/agentwebctl`:
going back across it means the README "Renamed from agentweb" steps in reverse (stop, re-link,
its own config/state dirs, Clear); the data dir is the same `herdr-agentweb` on both sides.

**Service worker cache**: the build generates `CACHE_VERSION` (`herdr-yoicks-` + 8 hex of a hash
over every built file's name and content) and the SW's asset list: never bump or edit them by
hand. Any change to a served file renames the cache, so phones pick the new build up; Settings →
App version shows `<version> (<BUILD = the JS hash>) cache <8 hex>`. Headless-browser checks keep
a registered SW across runs — always use a fresh `--user-data-dir` profile.

## Verified herdr socket API behavior (hard-won; don't rediscover)

Verified live against herdr 0.7.3 / protocol 16:

- **One connection = one request.** The server closes the socket after each
  response. Only `events.subscribe` keeps a connection open.
- **Event names arrive in mixed forms**: lifecycle events in underscore form
  (`pane_created`, `workspace_focused`), typed subscription events in dot form
  (`pane.agent_status_changed`). Normalize before dispatch.
- `pane.agent_status_changed` subscriptions are **per pane_id** — the pane set
  changing requires a snapshot re-fetch and a fresh subscribe connection.
- `session.snapshot` result is nested under `result.snapshot`.
- **`pane.send_input` wraps text in bracketed paste** when the app enables it,
  and apps discard control sequences inside a paste. Raw bytes (e.g. SGR mouse
  wheel) must go through `pane.send_text`. A composed message submits reliably as
  a single `send_input` carrying both `text` and `keys:["enter"]` (verified live
  against Claude Code: single-line, multi-line, and large pastes all submit) — the
  enter is a real keypress, not swallowed by the paste.
- **Clearing a Claude Code composer before sending (so a yoicks message can't
  merge with a draft the user typed straight into the pane, which yoicks can't
  read).** Send raw `Ctrl+U` (0x15) via `pane.send_text`: it kills to the start of
  the current line, so a multi-line draft needs it repeated — the bridge sends
  ~30, which walks up any realistic draft and is a no-op once empty (verified
  live). It's the safe choice: `Ctrl+C` *would* clear the whole composer in one
  keystroke but a second press exits Claude Code and it interrupts a running
  agent; `Esc` does not clear at all. Known edge: `Ctrl+U` leaves the after-cursor
  tail if the cursor sits mid-line in a multi-line draft (unusual — a just-typed
  draft has the cursor at the end).
- **Selecting a numbered menu option (e.g. AskUserQuestion) is one atomic
  keystroke: the option's digit sent as a raw byte via `pane.send_text`.** Pressing
  the digit selects AND submits the option — no Enter, no cursor movement (verified
  live: sending `"3"` to an AskUserQuestion answered "cherry" outright). It MUST go
  as a raw keystroke: a digit in `send_input` `text` is bracketed-paste-wrapped and
  ignored by the menu, and a digit in `send_input` `keys` is dropped (herdr's `keys`
  are named keys only). Because the digit is atomic, the bridge's answer path sends
  just the digit — no follow-up read/Enter/arrow that could land on a later prompt,
  and the `❯` position is irrelevant (selection is by number). The startup trust
  prompt is a different widget (Enter/Esc only, no digits). On herdr 0.9.5 it *does*
  surface as a `blocked` pane (seen live: a claude started in an untrusted dir reports
  `agent_status: blocked`), so a new agent's first task is withheld until it's answered.
- **Starting agents changed in herdr 0.8** (verified live on 0.9.5 / protocol 22).
  `agent.start` no longer creates a pane or takes `argv`/`cwd`/`workspace_id`: it is
  `{ name, kind, pane_id, args? }` and launches into an existing **idle shell pane**, so
  open one first (`tab.create` → `root_pane`, `pane.split` → `pane`, or
  `worktree.create`'s `root_pane`). A just-opened pane answers `agent_pane_busy`
  until its shell is up — retry briefly (herdr's CLI does too). `name` must match
  `^[a-z][a-z0-9_-]{0,31}$` (also for `agent.rename`). `agent.send` is gone; use
  `agent.prompt { target, text }`, which answers `agent_not_ready` until `agent.get`
  shows `interactive_ready: true`.
- **herdr's waits** (S0 row 15, 0.9.5): `agent.prompt { target, text, wait: { until } }` is
  **edge** — it answers (`agent_prompted`) once the turn the prompt started ends in an `until`
  status, or `agent_prompt_stalled` when no working/blocked came within 5 s (delivered, not taken
  up yet). `agent.wait { target, until }` is **level** (`agent_info` at once when the status already
  matches, exactly: `done` doesn't match `until: [idle]`). Neither has a deadline of its own, so
  they go on a no-deadline connection (`HerdrClient.Wait`), and `until` always lists both idle
  and done. `interactive_ready` is often null on a running agent: a prompt is tried, and only an
  `agent_not_ready` answer is waited out.
- herdr emits focus events ~10/s during desktop activity. Never let them
  trigger WS pushes; apply them to the model silently.
- **`done` vs `idle` is the server's per-pane `seen` flag, and only focus sets it**
  (checked in herdr 0.9.5 source): `pane.focus` / `agent.focus` / tab or workspace
  switches mark the active tab seen; reads don't; no API sets `seen` alone. Focus
  would switch the PC's screen, so the PWA keeps its own "seen done" record
  (`markSeen`/`shownStatus` in `web/src/dashboard-group.ts`, localStorage) and leaves
  herdr's state alone. herdr's TUI clients likewise track viewed completions per client.
  The record is keyed on herdr's `completion_seq` (which completion it is), which is
  **only in `agent.list`/`agent.get`** — not in snapshots or `pane.agent_status_changed` —
  so the bridge fetches `agent.list` after each snapshot and each status change
  (`applyCompletionSeqs` → `completionSeq`, plus `state_change_seq` → `stateChangeSeq`, a
  server-wide counter that orders status changes; verified live on 0.9.5). Not `sinceUnixMs`:
  that resets on a bridge restart.
  Don't fake it with `pane.report_agent`: that hijacks the agent's hook lifecycle authority.
- Invalid enum values in request params make herdr **drop the connection
  without a response** (surfaces as opaque "connection closed"). The bridge
  validates enums in REST routes and returns a clear 400 instead.
- `recent` reads cap at 1000 lines regardless of the requested count.
- **`visible` is the desktop's viewport, not the live screen** (herdr 0.9.5 source + live): scrolled
  up in herdr (`pane.get` `scroll.offset_from_bottom > 0`), it keeps returning that old text while a
  prompt waits at the bottom — the phone then found no menu at all. `recent` (and `detection`,
  text only) stay at the bottom, so every screen read (`screenRead` in http.go) is `detection`
  for text and `recent` with `lines = viewport_rows` for ANSI, scrolled or not: a branch on the
  scroll state would race a scroll between `pane.get` and the read. Never a `recent` *text* read
  of the screen: asking more rows than an idle alt-screen agent's screen has (it can shrink after
  `pane.get`) makes herdr scroll the app to capture history; ANSI reads never do.
- **A workspace's `worktree` object is only sometimes present.** herdr attaches
  `worktree = { repo_key, repo_name, repo_root, checkout_path, is_linked_worktree }`
  to workspaces it opened via its worktree flow — including linked worktrees — but
  plain checkouts often arrive with no `worktree` field, and it **never carries the
  branch** (verified live: `worktree` has repo_key/paths/is_linked_worktree only). So
  `internal/bridge/worktree_resolve.go` resolves git with `git rev-parse` to fill in the branch.
  For a herdr-tagged worktree it resolves the **stable `checkout_path`** (not the pane's
  mutable `foreground_cwd`, which an agent `cd` can move) and layers only the branch onto
  herdr's authoritative identity — so a wandering pane can't repoint or clear the repo; an
  untagged checkout has no herdr identity, so it derives its full worktree info from the
  pane cwd (and clears when that stops resolving). `repo_key` uses git's
  shared `--git-common-dir`, matching herdr's own repoKey. In the UI each card shows its
  tab name and (dim, beside it) its git branch. The dashboard is one flat list of every
  agent, most recent status change first, so each card names its own workspace; a linked
  worktree's card adds a `worktree` chip. The order is herdr's `stateChangeSeq` (a change
  not fetched yet counts as newest), then `sinceUnixMs`: that one lives only in bridge memory,
  so a bridge restart resets every card to "just now" — ordering by it alone sank agents
  working since before the restart. A cwd git can't resolve just renders plain (graceful degradation).

## The two scrolling mechanisms (phone pane view)

1. **Panes with terminal scrollback** — the view is one continuous buffer:
   `#term-history` (recent-source prefix, refreshed ≤ every 10s) above
   `#term-live` (current screen, WS-pushed). Scrolling is local and smooth.
2. **Zero-scrollback panes** (full-screen apps; e.g. Claude Code with
   `"tui": "fullscreen"`) — nothing exists to scroll locally. Swipes are
   forwarded as SGR wheel events through `POST /api/panes/:id/scroll`
   (batched steps, fling momentum); the app scrolls its own view and the
   updated screen comes back via watch pushes. Heuristic: empty history
   prefix + pane has an agent (`appScrollPane`). Arrow keys are NOT a
   substitute — they trigger composer history in Claude Code.

## The chat view (Claude Code transcript rendering)

A claude pane can be shown as a structured chat timeline instead of the raw
terminal. It does NOT scrape the terminal — it tails Claude Code's own JSONL
session transcript on disk. Terminal view stays the universal fallback for every
agent; chat is an additive, feature-detected layer (`available`), so
vendor-neutrality is preserved.

- **Exact pane→transcript mapping (don't use newest-mtime).** herdr's raw pane
  carries `agent_session = { source:"herdr:claude", value:"<uuid>" }` (seen via
  `session.snapshot` / `pane.get`). That `value` IS the transcript filename:
  `~/.claude/projects/<slug>/<value>.jsonl`, slug = `cwd.replace(/[/._]/g,'-')`.
  A pane's launch cwd can differ from its current `foreground_cwd`, so resolve by
  the slug first, then fall back to globbing `~/.claude/projects/*/<value>.jsonl`.
- **Graceful degradation is expected.** Some claude sessions' transcripts aren't
  on this host (remote/containerized, alternate `CLAUDE_CONFIG_DIR`) → the endpoint
  returns `available:false` and the client keeps the terminal. Never guess a
  wrong session by mtime.
- Reads are confined to `~/.claude/projects` (sessionId regex + path containment);
  the client only sends a paneId — sessionId/cwd come from herdr. The `session`
  query param is an equality gate only, never used to build a path.
- **A message sent while the agent is working may never become a `user` line.**
  Claude Code queues it (`queue-operation` enqueue). If it is taken in mid-turn at a
  tool boundary (`remove`, `reason: "absorbed_mid_turn"`), the only record is
  `{type:"attachment", attachment:{type:"queued_command", origin:{kind:"human"}, prompt}}`
  (`prompt`: string or content blocks); if it waits for the turn to end (`dequeue`) it
  becomes a normal `user` line. `normalizeLine` maps the human `queued_command` to a
  user item; `task-notification` / `peer` queued commands stay hidden (verified live).
- The tailer reads new bytes from a byte cursor that always sits on a newline
  boundary (safe for multi-byte UTF-8); a trailing partial line is left for the
  next read. WS `watch_transcript` re-resolves the session id each tick so a
  mid-session reset (`/clear` → new session file) triggers a `reset` rebuild.

## Touch/DOM rules in the web UI (regression-prone)

Per component and engine. innerHTML (and `dangerouslySetInnerHTML`) takes only escaped HTML:
`ansiToHtml`'s and `renderItem(s)`'s output.

- **`terminal.ts`: never replace terminal DOM during an active touch** — the browser cancels
  the in-progress scroll gesture. Renders defer via `pendingAnsi` while
  `terminalTouchActive` or scrolled above the bottom, and flush on touchend /
  return-to-bottom.
- **`ui/Dashboard.tsx`: the agents list has the same hazard.** `#screen-agents` is the scroll
  container; state pushes (agent_status_changed etc.) arrive constantly, so it must stay the
  **same element** while the list is shown, with the cards keyed by pane id (`data-ready` marks
  the real container; the loading spinner lacks it). Recreating `#screen-agents` snaps
  `scrollTop` to 0 (the "scroll jumps to top" bug) and cancels an in-progress drag. Like the
  terminal, the list holds still while a finger is down and shows the latest State on the
  macrotask after touchend (`setTimeout(0)`, so a still tap's click lands first).
- **`pane-view.ts` / `terminal.ts`: one instance per opened pane.** Each opened pane gets its own
  `createPaneView` / `createTerminal`, and the shell destroys it on leaving (`ui/App.tsx`'s
  `handleRoute` → `closePaneView`): `destroy()` stops its timers and listeners, and
  every async continuation checks `destroyed`, so a stale response can't poison the next pane's
  view. Within a pane, reads also drop a response a newer read or WS push superseded.
- **`ui/Pane.tsx`: the composer is uncontrolled.** The textarea has no `value` prop, so a state
  push never resets what is being typed, an IME composition included. Enter sends only on a PC
  (Shift+Enter: a newline), never the Enter that confirms an IME conversion (`isComposing`, or
  keyCode 229), and once per held key (`composer-keys.ts`); on a touch device only Send sends.
- **`ui/App.tsx`: `#topbar`, `#reconnect-banner` and `#screen` stay the same elements** for the
  app's life (webcheck observes `#screen`); a route render swaps what is inside them only.
- `terminal.ts`: double-tap detection requires two *stationary* taps (movement > 10px within
  a touch disqualifies it) — fast swipe flicks must not trigger it.
- WS pushes are deduped server-side against the last serialized state;
  `sinceUnixMs` carries over across re-snapshots so rebuilds don't defeat it.

## Security invariants

- Every `/api` and `/ws` request requires the bearer token
  (`timingSafeEqual`); `/healthz` is the only open endpoint.
- The tokenized connect URL is printed only by the bridge's startup (`yoicks serve`/`run`: run
  pane + 0600 bridge.log) and the `qr` entrypoint. **Never print the token in
  action stdout** — herdr captures action output into its plugin logs.
- Bind stays loopback-only by default; remote access is Tailscale's job
  (`tailscale serve`). No outbound requests unless `notify_url` is set.
- Static file serving keeps the resolve+prefix path-traversal guard.
- A headless orchestrator stays on the Claude subscription (fail closed): its child's env is an
  allowlist (HOME PATH USER LOGNAME SHELL LANG LC_* TZ TMPDIR, TERM=dumb, then the entry's env; never
  `HERDR_*`, which would make herdr's hooks report it as a pane, nor a billing variable), and its argv
  never has `--bare` or `--dangerously-skip-permissions`. An entry env with `ANTHROPIC_*`,
  `CLAUDE_CODE_USE_*` or `AWS_BEARER_TOKEN_BEDROCK` is refused, and so is one with `HOME` or
  `XDG_CONFIG_HOME` (the checks, the account and the chat read the bridge's home); before each start `claude auth status
  --json` must say `authMethod: claude.ai` with a subscription (only those two fields are read or
  logged: the output has the account's email), and no settings file it reads (the account's, the
  dir's `settings.json`/`settings.local.json`, the managed one) may set such an env or `apiKeyHelper`
  (auth status misses those); the child's first init must say `apiKeySource: none` and exactly its
  tools, with the yoicks MCP server connected, else it is stopped. The orphan scan kills only a
  claude carrying the bridge's marker (its group only when it leads one); any other claude on that
  session is left alone (409).
- The headless MCP listener is loopback-only (`127.0.0.1:0`, never the configured bind), opened only
  with a headless entry. Each request needs its orchestrator's bearer (compared with
  `subtle.ConstantTimeCompare`; anything else is a 401), written only into its 0600 mcp.json; go-sdk
  also refuses a non-localhost Host. Its tools reach only that orchestrator's Claude account, as the
  CLI's do; no shell, and every other permission is denied without asking.
- Starting agents is gated to the `launch_profiles` allowlist: `POST /api/agents` takes a profile
  *name* → fixed argv, never a caller-supplied command/argv. (`cwd` is passed through and is not a
  new privilege — the bearer token already grants full pane input ≈ a shell — but choosing the
  *program* is gated behind named profiles.)

## Testing

- Unit tests: `internal/bridge/*_test.go` (state normalization/event routing/
  immutability, auth, ndjson, notify shapes, HTTP/WS, CLI) and `web/test/*.test.ts`. The
  routing-table test (`state_test.go`) asserts every subscribed lifecycle event is either
  rebuild-triggering or applied — keep it in sync with `buildSubscriptions`.
- Against recordings (`testdata/README.md`): the herdr client replays `testdata/scenarios`, and
  the bridge + CLI are driven through `testdata/wire` (`tools/fakeherdr`, a fake herdr socket).
  Both were first recorded from the TypeScript bridge the Go one was ported from; `record-wire`
  re-records the wire ones from the current build (only for an intended change; review the diff).
- Headless orchestrators (`headless_test.go`, `mcp_test.go`) run on `tools/fakeclaude` (stream-json,
  scripts by message text, MCP calls through go-sdk's client as Claude Code makes them) and
  fakeherdr's World, which answers the agent calls (`agent.get/read/prompt/wait`, a worker's script
  via `OnPrompt`, `StallAfter`) and records `notification.show`; never a real Claude.
- **The real Claude** only in `headless_live_test.go` (`//go:build claudelive`; CI only vets it):
  `go test -tags claudelive -count=1 -run TestClaudeLive -v ./internal/bridge` runs `claude` itself
  through the runner (haiku via the test-only `extraArgs`, the personal account, throwaway dirs,
  fakeherdr), about six turns, and prints `PASS|FAIL <item> <detail>` for plan §8's items plus
  `mcp_failure` (the bearer revoked mid-session: Claude Code 2.1.322 says `MCP server "yoicks"
  rejected the Authorization header in its config …`); `CLAUDE_LIVE_OUT` gets `{version, ok,
  failed}`. It removes only its own `~/.claude/projects/<slug>/`. Run it when Claude Code changes
  (it uses the weekly quota), then raise `verifiedClaudeVersion`. `scripts/claude-canary.sh` (its
  test: `scripts/claude_canary_test.go`, fake `claude` and `go`) runs it from the linked checkout
  for a new version or after 24 h and writes `<state>/canary.json` (`{at, version, ok, failed}`);
  `install` writes the hourly user timer, which the user enables; config `"canary": false` stops it.
  With a headless entry the bridge reads the file at its start and each minute (`checkClaude`):
  state `claudeCheck`, a `canary` warning on the headless ones while it failed, the version warning
  tells it, and a failed check alerts once (`orchestrator_alert` with no name, ntfy,
  `notification.show`).
- The `mcp_call` warning doesn't read Claude Code's error text: the MCP middleware notes the
  `_meta["claudecode/toolUseId"]` of each `tools/call` (`served`), the stream model reports each yoicks
  tool's result, and an `is_error` one for an id never served failed before reaching the bridge.
  fakeclaude names its calls the same way (`mcpfail` fails one without calling).
- Live verification is expected before claiming completion: healthz, an
  `/api/state` sanity check, and (for input paths) a scratch-tab round trip
  (`herdr tab create` → POST input → read back → close the tab).
- Gesture work: verify with headless Chrome CDP touch emulation
  (`Input.dispatchTouchEvent`, mobile metrics, fresh profile). "The screen
  changed" is not proof by itself on a busy pane — assert on content moving
  to *older* lines and on the composer staying clean.
- **webcheck** (`tools/webcheck.ts`: headless Chrome over CDP, no dependencies) is the gate before
  deploying a web change: all of Tier 1 passes.
  ```bash
  node tools/webcheck.ts preview start --bin bin/yoicks --port 8395  # throwaway bridge over the real herdr
  node tools/webcheck.ts check --base http://127.0.0.1:8395 --tier 1  # lock, setup, checks, teardown
  node tools/webcheck.ts preview stop --port 8395
  ```
  Each check prints `PASS|FAIL <id> <measured> <condition>`; the exit code is the failure count.
  `--only P10,P12` picks checks; `--profile DIR` reuses a Chrome profile, for the old-SW round trip
  (`P2.old` → `P2.upgrade` → `P2.downgrade`, the old build served with `preview start --web-dir`).
  The file's header lists the rest (`setup --gonogo`, `block`, `teardown`).
  - Tier 1 is deterministic, shell panes only: `wc-shell` (`seq`) and `wc-less` (`less --mouse`,
    `report-agent`ed as claude, so it takes the app-scroll path). Tier 2 (`--tier 2`) drives a
    real Claude (`wc-claude`, orchestrators `wc-o1`/`wc-o2`) and refuses to run until
    `$WC_ROOT/.envrc` sets the account's `CLAUDE_CONFIG_DIR` (`direnv allow`ed). `preview start`
    then gives the orchestrators that account as `env` (start the preview after the `.envrc`), and
    a Claude it starts in another account stops the run (`ENV: … account mismatch`). The default
    account is `unset CLAUDE_CONFIG_DIR`, not `~/.claude`: set, Claude Code reads a stale
    `~/.claude/.claude.json` instead of `~/.claude.json`.
  - Safety: the preview controls the real herdr, and production (so the phone, notifications
    included) sees the scratch agents: say so before a run. It mutates only what the run created
    and recorded whose live tab or workspace label starts with `wc-` (one guard, which the page's
    own API requests pass too), and refuses port 8390. Runs and `preview start`/`stop` take turns
    on `$WC_ROOT/lock`, held by a separate `flock` process the bridge and Chrome never inherit.
    Teardown also runs on Ctrl+C; what it can't close stays recorded, and the next run retries it.
    `WC_ROOT` = `$WEBCHECK_ROOT` or `~/.local/state/herdr-yoicks-webcheck`.
  - A new check first passes on the current UI (the main before a screen's port), so it isn't
    written to fit the new code.

## Conventions

- Lowercase conventional commits, no emojis, no AI co-author lines.
- TS sources use explicit `.ts` relative-import extensions (`node` runs `tools/vectors/*.ts`
  on them directly; Vite bundles them). No raw control bytes in
  source — write ESC as the literal six characters `\u001b` in string escapes.
- Dependencies: the binary's are `github.com/coder/websocket` and, the one exception made,
  `github.com/modelcontextprotocol/go-sdk` (v1.8.0: the stripped binary +2 MB, 8 indirect modules; S0 measured
  them) for the headless orchestrator's MCP server: Claude Code's MCP client changes (`server/discover`,
  protocol versions), and the official SDK follows it where a hand-written server would have to. Don't
  add more without a strong reason (QR uses the system `qrencode`, falling back to a plain URL). Node and the npm
  dependencies are development-only: React is bundled into the web UI; the rest (TypeScript,
  Vite, Vitest, happy-dom) is for its build and tests.
- herdr's API schema (`herdr api schema --json`, protocol 22 = herdr 0.9.5) is saved in
  `testdata/herdr-schema/`; `internal/bridge/herdr_schema_test.go` checks every method,
  parameter, decoded field and event field the bridge uses against it. A new herdr field or
  event the bridge reads goes into that test too.

## Follow-ups (left open by the Go migration)

- **herdr-client edge cases** (kept from the TypeScript client it was ported from):
  1. Overlapping snapshots are applied in arrival order, so an older one answering last can
     overwrite a newer state (a rename, say). Fix: number the requests; for an older answer,
     only drain the event buffer.
  2. A snapshot in flight when the subscription drops can publish `connected: true` after the
     drop, which stays while reconnecting fails. Fix: remember `coverageEpoch` at the request
     and keep `Connected` false if it changed.
  3. A worktree filled in from the cwd (herdr sent none) is treated as herdr's on the next fill:
     if that dir stops being a git checkout, the old worktree and branch show until the next
     snapshot. Fix: remember which worktrees were filled in and let git's answer replace them.
- **`custom_status` and `agent_message`**, read from panes and status events, aren't in herdr
  0.9.5's schema (protocol 22 has `state_labels`), so they are always empty
  (`notInProtocol22` in `herdr_schema_test.go`).
- **Not verified before the switch** (watch in production): memory, threads and fds over days;
  recovery after the machine sleeps; the CLI account checks' allow side and `worktree remove`
  through a real orchestrator; `blocked` on the folder-trust prompt. Never run against a real
  herdr: linux/arm64 and macOS. Supporting macOS's account features needs `sysctl`
  (`kern.procargs2`, via `golang.org/x/sys/unix`) in place of `/proc`.
- **Headless on macOS**: no `/proc`, so no orphan scan (a child an earlier bridge left isn't found),
  no refusal of a TUI start (phone or `yoicks orchestrator start`) beside a running headless child,
  and no Pdeathsig (only the shutdown ends a child). The same `sysctl` would fix the first two.
