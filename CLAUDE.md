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
  (`POST /api/agents`, `DELETE /api/panes/:id`, `POST /api/panes/:id/rename`, `POST /api/agents/:target/clear`).
  The web UI starts no agents (orchestrators do); `POST /api/agents` stays for scripts and webcheck's
  Tier 2 setup. Every new worktree (API, `yoicks agent start --worktree`) goes
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
  it refuses only where direnv positively reports another account. It also marks that tab's shell
  `YOICKS_WORKER=1`: once a marked pane's agent exits and its shell is back in the foreground, the
  bridge closes it (`worker_exit.go`, from `broadcastState`; never an unmarked pane, nor the only pane
  of a linked worktree's workspace, which `worktree remove` closes with the worktree). All of them are
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
  so they mount afresh; `#/pane/<id>` opens the pane in `ui/AgentDrawer.tsx`, Mantine's Drawer, over the
  screen it was opened from, `view.paneBackRoute`, which stays as it is: a list live and at its scroll,
  a Home with its view suspended, resumed as it was on close (`suspendPaneView`/`resumePaneView`: no new view, no
  flicker); a sheet from the bottom on a phone, from the right at 1024px and up; a Claude pane opens on its chat,
  its terminal only when chosen for it, remembered per pane for the app's life (pane-view's `chosenView`);
  `#/settings` likewise opens Settings in `ui/SettingsSheet.tsx`, Mantine's Modal, centered at 1024px and
  up, the whole screen on a phone, a Home under it running on; one overlay at a time, `isOverlay`),
  `nav.ts` (`openAgent`/`go`: overlay → overlay replaces the history entry, so Settings from a drawer
  takes its place; `closeOverlay` (`closeAgent`): back to the entry under it when it was opened on it,
  `view.paneOverBase`, else a replace; ✕, the dimmed screen, Escape with no other layer over it and the
  phone's Back close it), the topbar (each screen fills its three slots), the connection dot and the
  reconnect banner, the SW's `navigate` message, visibilitychange's global part (the watch, the
  open pane's OS notifications, seen done), `visualViewport` → `--app-height` and the startup (token,
  WS, first `/api/state`, a 401 → the token screen). Under it: `api.ts` (token, REST; a 401 →
  callback), `store.ts` (State, WS link, `view`, seen done, kept tasks; subscribe/emit), `drafts.ts` (the
  composer's unsent text per Home name or pane id, in localStorage until sent; a connected State
  drops those of panes and orchestrators it no longer has), `ws.ts`
  (socket, ping, backoff, state polling, watches) and `notify.ts` (the toast store: short-lived
  results of the user's actions, and the OS notifications; a status push or an alert never
  toasts). The screens are in `web/src/ui/`: Settings, Token, the agents list `Dashboard.tsx`,
  `Pane.tsx` and `PromptPanel.tsx`, and on a PC the sidebar `Sidebar.tsx` beside them; `Status.tsx` is an agent's
  status as they show it (`StatusBadge`, `StatusDot`); `Toasts.tsx` draws into `#toast-container` (each toast
  Mantine's Notification; only the toasts take taps, the box too while the stack overflows) and `Modals.tsx`
  (Confirm, Rename and the image preview, all on Mantine's Modal) is portalled into `#modal-root`;
  a pane's ⋮ is a Mantine Menu (`Pane.tsx`'s `AgentMenu`, in its drawer's header, its dropdown in `#modal-root`
  too, over the drawer). An opened
  pane's body is `pane-view.ts` (`createPaneView` → setMode/onState/echo/destroy, one per opened
  pane or Home: the chat log, the transcript probe, its own WS messages and agent_status, the 3s
  refresh, the pane's visibilitychange, the prompt poll and closing the drawer after an answer) over `terminal.ts` (`createTerminal`:
  the continuous buffer, fit/pinch, wheel forwarding and fling). These two are the imperative
  engines, and an engine owns only its own DOM subtree: `#pane-view`'s children, an empty
  container React draws and never renders into. `ui/Pane.tsx` draws Home's topbar and
  bits, the composer (an uncontrolled textarea) and the quick keys around `#pane-view`, and
  `ui/PromptPanel.tsx` the answer panel pane-view reports (`opts.prompt`: taps, in-flight guard, cooldown, 409). A headless
  orchestrator's Home (`hl:<name>`) is the same screen: `findPane`/`markPaneSeen` (`store.ts`) make it
  a pane from its `OrchestratorView` (never in `appState.workspaces`: "No workspaces
  found" goes by those), `api.ts`'s `orchestratorPost` sends its composer, Clear, Stop, ■ and answers to
  `/api/orchestrators/:name/*`, `watch.ts` watches only its transcript, pane-view has no terminal for
  it (the chat, empty until its session's first line) and `PromptPanel.tsx`'s `HeadlessPrompt` answers
  `headless.pending`; its usage and warnings (■, Clear, the steps back to the TUI) sit on the status
  bar. `orchestrator_alert` raises an OS notification while hidden (`notifyOrchestratorAlert`);
  Settings shows the last Claude Code check and the TUI steps; the `[yoicks] …` lines at either end of a user turn render as dim lines (`splitNotices`), the rest as its bubble; an `agent_start`, `agent_prompt` (`sent to <name>: <the task's first line, cut short>`, or `not sent to <name>: <why>`) or `worktree_remove` result shows as such a line (`conversationItems`), and a worker's name in one is a button that opens its drawer (`ui/ChatLog.tsx`'s `Notice`; the State's `agent.herdrName`, from `agent.list`, `nav.ts`'s `openAgentNamed`). Its composer
  takes images (+ or paste; `image.ts` scales them to JPEG, the bridge's `imageBlocks` checks them); a tap on one, attached or sent, opens it full screen (`previewImage`: its own history entry, so Back closes it). `ansi.ts` — pure ANSI→HTML,
  `transcript.ts` — pure: the chat's markdown as escaped HTML and what a Home's chat keeps, drawn by
  `ui/ChatLog.tsx` (the items as React components on Mantine's: bubbles and cards are Paper, the prose
  Typography, a thinking block, a tool result and the answer panel's terminal a native `<details>` (`Disclosure`);
  in a React root of its own on pane-view's `#chat-log`, under its own MantineProvider,
  synchronously, so the engine keeps measuring and scrolling it), `sw.ts` — service worker (built
  into `sw.js` by `vite.config.ts`'s `sw()`). `web/index.html` is Vite's input, `web/public/`
  (manifest, icons: `scripts/icons.mjs` draws them from one mark, by hand, outputs committed) is copied as is, and `web/dist` (`//go:embed all:web/dist*`) is the output: one
  JS and one CSS file under `assets/`, named by content hash (no code splitting: an open PWA would
  ask for a deleted chunk after a deploy). The bridge serves `assets/*` as `immutable`,
  `index.html` and `sw.js` as `no-cache`, and a text file as the best of its brotli and gzip
  copies the client accepts (`vite.config.ts`'s `precompress()` writes them next to it, after
  `sw()`; each encoding its own ETag); `embed_test.go` checks the build, the copies and the size
  budgets (a cold open as sent, brotli; the JS raw). The pattern also matches the committed
  `web/dist-placeholder.txt`, so the Go code builds, vets and tests without a web build (CI's
  bridge jobs have no Node): such a binary has no UI and `Serve` refuses to start (so a start,
  and a redeploy, fails), `embed_test.go` skips (CI's web job runs it with `YOICKS_REQUIRE_WEB=1`)
  and `scripts/release.sh` checks for `web/dist/index.html`
- **Styles: Mantine's components, Tailwind for layout, little hand-written CSS.** `web/app.css` (index.html's one
  stylesheet) sets the cascade layers, lowest first: `theme` (Tailwind's variables), `base`
  (`reset.css`: the element resets, which over Mantine would strip its buttons), `mantine`
  (`@mantine/core/styles.layer.css`, all of it), `app` (`style.css`, over Mantine's baseline body
  rules), `utilities` (Tailwind, scanning `web/src` only; no preflight, as Mantine advises).
  `main.tsx` puts the app under `MantineProvider` with `theme.ts`, dark only (`forceColorScheme`;
  index.html has `data-mantine-color-scheme="dark"` for the first paint). The theme is the app's
  look: style.css's colors as Mantine's `dark` palette and the primary `accent`, 15px text. The
  root stays 16px (style.css sets 15px on the body), so rem is unscaled. Both have the same five
  breakpoints (xs 36em, sm 40em, md 48em, lg 64em = the PC layout's 1024px, xl 80em), in `theme.ts`
  and app.css's `@theme`; `web/test/theme.test.ts` checks them and the colors against the CSS.
  Mantine's portals go into `#modal-root` (the theme's Portal default). Tests render under
  `render.ts`'s `mantine()` (`env="test"`: no transitions, a portal stays in place).
  What is drawn is Mantine's components (Button, ActionIcon, CloseButton, the inputs, Card, Badge, Text,
  Group/Stack, Modal, Menu, NavLink, SegmentedControl, Notification…); where a thing sits (flex, gaps,
  overflow, a width's breakpoints) is Tailwind classes; colors are Mantine props with the theme's names
  (`dark.N`, `accent`, the statuses `idle`/`working`/`blocked`/`done`/`unknown`) or `var(--color-*)` in a
  class. `style.css` keeps the tokens, index.html's first paint (the topbar, the banner, `.loading-spinner`,
  which `terminal.ts` uses too), the engines' DOM (the terminal; the chat's `#chat-log` box, and `.chat-md`,
  which tunes Mantine's Typography for the chat's prose), the toasts' box, the drawer's and the PC grid's
  layout, and the Settings sheet's. The theme makes a button given no size, and an input at its default size (sm; every
  Mantine input has one), 44px tall (`--touch-min`), an input's text 16px (below that iOS zooms in on focus;
  the composer keeps 14px); `theme.test.ts` checks it. What is clicked shows the pointer: a Mantine control by
  the theme's `cursorType`, a `summary` or `[role=button]` by reset.css, a disabled one `not-allowed` (style.css). Mantine's style props (`px`, `c`, `bg`…) are inline
  styles, so they beat any class, a Tailwind `lg:` one too: a value that changes with the width goes in
  classes only. A class (Tailwind's layer, or `app`) beats Mantine's own CSS. Ids stay; the class names the
  tests and webcheck select on stay on their elements as hooks without CSS (`agent-card`, `home-chip`,
  `qkey`, `toast`, `ask-opt`…); a new hook is a `data-*` attribute. Mantine's focus trap focuses in a
  `setTimeout`: `autoFocus` where the focus must be there as it mounts. Tailwind never finds a class written
  right before `${…}` in a template string (`self-end${x}`): leave a space. With no preflight, `border-dashed`
  dashes every side at the browser's default width: dash one edge with `[--tw-border-style:dashed]`
- **Orchestrator homes**: config `orchestrators: [{name,label,env}]`, each in its own dir:
  `orchestrator.go` writes `<data>/orchestrators/<name>/` (data = `$XDG_DATA_HOME` or
  `~/.local/share`, + `herdr-yoicks`: `dataDir`) at bridge start and before each start: CLAUDE.md
  (imports rules.md, then the user's local.md, which is created once and never overwritten),
  rules.md (the bundled `orchestrator/rules.md` with the real yoicks command filled in) and
  `.claude/settings.json` (dontAsk allowlist). It starts (phone Start button →
  `POST /api/orchestrators/:name/start`, or `yoicks orchestrator start <name>`) in a new
  workspace whose shell gets the entry's `env` (herdr `workspace.create`/`tab.create`/`pane.split`
  take `env`; `worktree.create` does not), and the started agent's account is checked against it.
  Clear relaunches with the old agent's account (`accountEnv` → `clearAgent`'s `envFor`). Without
  `orchestrators`, there is one named `default`.
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
  between the configured orchestrators (2+; stopped ones dimmed; each with its "needs you" count, `ui/Todos.tsx`'s `needsYou`:
  its account's blocked agents, its question, its to-do items due now; the PC sidebar's Home headings have it too), a
  status bar of one row (wrapping only where it must): "Needs you · n" (that count, orange; `To-do · n`, dim, while only items
  due later wait; none at all otherwise: `NeedsButton`), the counts of its account's agents (`homeSummary`; no orchestrators),
  and at the right a headless one's usage and model, Clear and Stop. Needs you opens a Mantine Popover (Escape, a tap outside
  and leaving the screen close it; as wide as a phone allows, no taller than the room below it): the blocked agents' chips, its
  question's line, and its to-do list (`ui/Todos.tsx` over the pure `todos.ts`: ✓ = `DELETE …/todos/:id`, an item due ahead under
  Later until its time, a link shown by its host, a worker's name opening its drawer; a stopped Home has them too), dialogue-only chat
  (`conversationItems` hides tools/injected turns, but for questions and worker starts), a "doing now" line (`latestActivity`) and a
  composer (the terminal + quick keys stay one `>_` tap away — the only way to send Esc/Ctrl+C, and
  the fallback when there's no transcript). Orchestrators get no card in any agents list (`agentCards`
  in `ui/Dashboard.tsx` feeds both the list and `homeSummary`); the full list's ← Home opens `defaultHome()`.
  Home's counts (its status bar's: an outlined pill with a ›) open `#/agents/<name>`: only the panes in its state `agents` (its Claude
  account's, via `paneAccount`, cached per agent pane and re-checked every 60s by `paneAccountCache`;
  `null` = unknown → every agent),
  with `← <its Home>` (`Back to …`; at every width) to that Home; a pane opened from there opens over that list. Any route to
  its pane (`#/pane/<id>`: notification clicks, stale links) is replaced by its Home. herdr's
  `pane.agent_detected` (fires on detect *and* release) is rebuild-triggering, so agent presence and
  `launchCwd` stay current across exit/`cd`/relaunch in one shell. Its behavior (delegating via `yoicks agent …`, waking on background
  `agent prompt --wait`) lives in that dir's `CLAUDE.md`, not in this repo.
- **Headless orchestrators** (built through S5; the pilot and the switch, S6, in `.omc/plans/headless-orchestrator/`): an entry
  with `"mode": "headless"` runs as the bridge's own child,
  `claude -p` over stream-json, instead of an agent in a pane. `headless.go`: one `headlessRunner` per
  such entry (start with the billing checks and the orphan scan; send, also mid-turn; interrupt as a
  `control_request`, no answer in 2 s → kill + `--resume`; stop = interrupt, close stdin, 1.5 s, SIGTERM
  the group, 0.5 s, SIGKILL; clear = a fresh session; a crash restarts with `--resume` after 2/10/30 s
  (a session without a transcript, i.e. no message yet, can't be resumed: it begins again under its id; one in
  another project dir of its account counts, as Claude Code resumes it from there),
  more than 3 in 10 min = `error`; the bridge's shutdown stops them in parallel within `yoicks stop`'s
  5 s, Pdeathsig as the backstop). `headless_state.go` is pure: a stdout line → status, completionSeq,
  usage, warnings (unknown events, unreadable lines, the init check). Its state's `paneId` is
  `hl:<name>` while the child runs; the pane/agent routes and `watch_pane` refuse `hl:` (404 /
  nothing read), only the transcript route serves it (`resolvePaneTranscript`'s head). Saved in
  `<state>/headless/<name>.json` (`{sessionId, wanted, watches, completionSeq, model}`: the count goes on across restarts, a phone's seen-done is keyed on it). Its
  model: each child gets an `initialize` control request at its start, whose answer lists Claude Code's `/model`
  choices (state `headless.models`; the answer also has the account's email: only `models` is read); `POST …/model`
  switches a running child in place with `set_model` (refused mid-turn; Claude Code applies it from the next turn),
  and each start passes the saved choice as `--model` (the list's `default` entry is left out: the Home offers the
  models themselves, the default's as its id when no other entry offers it). Without one, `--resume` keeps the model the session last ran on (2.1.322), not the settings' default, so the model in effect (`headless.activeModel`) comes from Claude Code: a
  `get_settings` request at each start (`applied.model`), `set_model`'s answer and each turn's init. `<state>/headless/<name>.mcp.json` (only the
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
  `worktree_remove`), confined to the account its child runs under (`agent_start`, and `agent_prompt` re-tasking a worker,
  also take a `purpose`: one line in the user's language, `purpose.go`, by pane id in `<state>/agent-purposes.json`, sent as
  state `purposes`, dropped once its pane has no agent, after it was seen with one or a minute on; the CLI has none, as it can't reach the
  bridge), and `todo`, its Home's to-do list for the user
  (`todo.go`: one list per orchestrator in `<state>/todos/<name>.json`, kept across Stop, Clear and restarts; an item
  `{id, text, agent, url (http(s) only), due, createdAt}`, sent as state `orchestrators[].todos`; the user ticks one off with
  `DELETE /api/orchestrators/:name/todos/:id`; the items come due are reminded once from the bridge's minute tick, in one
  `orchestrator_alert` of kind `todo` per Home (the phone tags notifications by Home), ntfy and `notification.show`; blocked workers and the Home's question are not
  items: the web shows those from the State; with config `pr_watch`, `prwatch.go` looks up the github.com PR links on
  those lists each minute, all in one `gh api graphql` call (the user's gh and login, the URLs as variables), removes a merged
  or closed PR's item and wakes its Home with `[yoicks] PR merged: <url> (<worker>); its to-do item is removed`, an unreadable
  PR's once a run, a gh failure alerted once per error, kind `github`, to each Home with a PR); `approve` is the child's
  `--permission-prompt-tool`: AskUserQuestion becomes state `headless.pending` (answered by
  `POST …/answer`: the panel's "Type something." is a question's own answer, its "Chat about this" (`{chat}`) refuses it with Claude Code's words; a `/send` meanwhile is written, then refuses it the same way), held open with progress, anything
  else is denied unasked. `agent_prompt` watches the worker (one goroutine, herdr's waits on a
  closable no-deadline connection, `HerdrClient.Wait`) and wakes the orchestrator with `[yoicks]
  <worker>: <from> → <to>` (names and status only, 3 s coalesced); a watch outlives the worker's
  end (until its pane goes, its worktree is removed, a newer prompt, Stop or Clear), so a turn it
  takes up on its own (a background task's event, the user in its pane; not a `done → idle`, a look)
  wakes it too, once that end has held 10 s (`resumeQuiet`: a flap wakes once); the watches are saved and
  re-armed after a restart. rules.md has `<!-- tui -->`/`<!-- headless -->` sections (`rulesFor`
  keeps the mode's, and the `<!-- pr-watch -->` parts inside headless only with `pr_watch`,
  `OrchestratorDef.PRWatch`; the TUI output is pinned by `orchestrator_golden_test.go`). `tools/fakeclaude`
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
go test ./...                 # bridge + CLI (CI: go test -race ./...); no web build needed
go build -o bin/yoicks ./cmd/yoicks   # after build:web: without it, the bridge refuses to start
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
that checkout, with the PC at hand. The gate is CI, not a local webcheck: each push to main runs
all of ci.yml, webcheck's Tier 1 included, so the run of main's head checks the merged PRs together,
and `redeploy.sh main` deploys only a commit whose run passed:

```bash
sh scripts/redeploy.sh main      # fetch, CI's run of origin/main, fast-forward, rebuild, stop/start, /healthz
sh scripts/redeploy.sh <commit>  # rolling back: the same, to <commit> (detached), without CI
```

Before stopping anything, `main` waits for CI's run of the very commit it deploys (`gh run watch`)
instead of deploying past it: the run takes about 3 minutes, and a bad deploy is a restart the phone
feels and a rollback by hand. No run yet, a failed one, or a cancelled one (main moved on, so CI
dropped it) refuses: run it again later. The other checks are the deployer's: once main's run has
finished (`gh run list --workflow ci.yml --branch main --limit 1`; still going: wait first, or this
check is minutes old at the stop), check that no Home is working or waiting on a question
(`/api/state`; redeploy.sh only warns), run it with nothing in between, and report the `BUILD` and
`CACHE` it prints, and any Home it interrupted anyway.

It also refuses (before stopping anything) outside the linked checkout, on a dirty tree, when local
main can't fast-forward, and when `herdr-plugin.toml` would change: herdr caches the linked
manifest, so that switch is by hand (it prints the steps: stop, switch, build, `herdr plugin link`,
start). Any failure after the stop puts the old binary back and starts it. It prints the `BUILD`
and `CACHE` that Settings → App version should show on the phone. A commit from before the script
(before the Vite build) has no copy: `t=$(mktemp) && git show main:scripts/redeploy.sh > "$t" && sh
"$t" main`. `.claude/settings.json` allows exactly `sh scripts/redeploy.sh main` (auto mode too, once
the folder is trusted); a rollback still asks, since a wildcard would let any commit, an unmerged
one included, reach production. The binary path doesn't change, so the orchestrators' allowlists still match; Clear the TUI ones
when `orchestrator/rules.md` differs between the versions. A headless one needs nothing: the restart resumes
it, and a resumed session reads the CLAUDE.md and rules.md of its start (checked live on Claude Code 2.1.322).

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
  `agent_not_ready` answer is waited out. An agent already at a dialog (a permission, the folder-trust
  question of a new dir) refuses a prompt with `agent_blocked` before any input is sent (herdr 0.9.5's
  `agent prompt --help`, met in the pilot): the headless orchestrator's tools then say "task not sent"
  and wake it once the agent is idle, as for `agent_not_ready` at startup.
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
  shared `--git-common-dir`, matching herdr's own repoKey. In the UI each card (and sidebar
  row) shows the agent's herdr name (`herdrName`, else its tab name), under it its purpose
  (state `purposes`, when given: two lines at most, all of it on hover), then one dim line,
  its location and git branch; the drawer title is the name and location, the purpose a small
  line under them. The dashboard is one flat list of every agent, most
  recent status change first, so each card names its own location (`cardLocation`); a linked
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
- **What the model says between tool calls can be a `thinking` block** (narration: the
  explanation before a question, say). Only its `signature` tells it from thinking: base64
  protobuf whose string at field 2 → 1 → 8 is `"narration"` (`"thinking"` otherwise; Claude Code
  2.1.322's classifier, seen in a real session 11-27). `normalizeLine` makes it an assistant
  item (`narration`), so the Home shows it; as thinking it was hidden.
- The tailer reads new bytes from a byte cursor that always sits on a newline
  boundary (safe for multi-byte UTF-8); a trailing partial line is left for the
  next read. WS `watch_transcript` re-resolves the session id each tick so a
  mid-session reset (`/clear` → new session file) triggers a `reset` rebuild.

## Touch/DOM rules in the web UI (regression-prone)

Per component and engine. innerHTML (and `dangerouslySetInnerHTML`) takes only escaped HTML:
`ansiToHtml`'s and `renderMarkdown`'s / `inlineMarkdown`'s output.

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
  view. Within a pane, reads also drop a response a newer read or WS push superseded. A drawer
  opened over a Home suspends the Home's view (no timers, messages or reads; resumed on close) and leaves its DOM: the pane ids (`#pane-view`,
  `#chat-log`, `#terminal-output`, `#screen-pane`…) then exist twice, so select inside `.agent-drawer`.
- **`ui/Pane.tsx`: the composer is uncontrolled.** The textarea (Mantine's Textarea, without `autosize`, which
  would fight the value the code sets: `autoGrow` sizes it) has no `value` prop, so a state
  push never resets what is being typed, an IME composition included. Enter sends only on a PC
  (Shift+Enter: a newline), never the Enter that confirms an IME conversion (`isComposing`, or
  keyCode 229), and once per held key (`composer-keys.ts`); on a touch device only Send sends.
- **`ui/App.tsx`: `#topbar`, `#reconnect-banner` and `#screen` stay the same elements** for the
  app's life (webcheck observes `#screen`); a route render swaps what is inside them only.
- `terminal.ts`: double-tap detection requires two *stationary* taps (movement > 10px within
  a touch disqualifies it) — fast swipe flicks must not trigger it.
- WS pushes are deduped server-side against the last serialized state;
  `sinceUnixMs` carries over across re-snapshots so rebuilds don't defeat it.
- **Wide screens (a PC)**: the PC layout is `web/style.css`'s last block, `@media (min-width:
  1024px)` (the `lg` breakpoint); none of it applies below 1024px (every phone, landscape too), so the phone layout stays
  as it is. It keeps the scroll containers full width and makes the readable column with their padding
  (`--wide-gutter`; the bars and the composer around the chat take it as a `lg:px-(--wide-gutter)` class).
  At that width (`WIDE_QUERY`, `theme.ts`; theme.test checks it against style.css and `lg`) the shell
  also draws the sidebar (`ui/Sidebar.tsx`) on every screen but the token one: each orchestrator's
  Home a heading over its account's agents (`homeGroups`), then Other (Settings stays the topbar's ⚙, at
  the screen's top right, as on a phone). It comes first in `#app`, in a
  slot of its own, so `#topbar`/`#reconnect-banner`/`#screen` stay the same elements as it comes and
  goes; while it is there `#app` is a two-column grid (`#app:has(> #sidebar)`) and `--sidebar-w` is its
  width, for an overlay that should leave it usable. Like the list it holds still while a finger is
  down (`useHeldState`), and it opens an agent the list's way (`nav.ts`'s `openAgent`: its drawer, over
  the screen on show; the dimmed part starts at `--sidebar-w`, so the sidebar stays usable under it).

## Security invariants

- Every `/api` and `/ws` request requires the bearer token
  (`timingSafeEqual`); `/healthz` is the only open endpoint.
- The tokenized connect URL is printed only by the bridge's startup (`yoicks serve`/`run`: run
  pane + 0600 bridge.log) and the `qr` entrypoint. **Never print the token in
  action stdout** — herdr captures action output into its plugin logs.
- Bind stays loopback-only by default; remote access is Tailscale's job
  (`tailscale serve`). No outbound requests unless `notify_url` or `pr_watch` is set (`pr_watch`:
  the user's `gh`, once a minute, asks GitHub's GraphQL API for the state of the github.com PR
  links on the headless Homes' to-do lists, nothing else; the credentials stay gh's).
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
  via `OnPrompt`, `StallAfter`) and records `notification.show`; never a real Claude. Their time
  is a `fakeherdr.FakeClock`, the runner's (`clock`: its restarts, coalesced wake-ups, delivery
  window, silence and question checks) and the World's waits alike: a test moves it on (`pass`,
  `Advance`) where real time would pass, and never sleeps for a timer; fakeclaude's `hang` and
  `hold` go on at a SIGUSR1 (`release`). The WS watches' polls (`server.clock`) and the herdr
  client's reconnects, debounces and agent.list retry (`HerdrClient.clock`) take one the same way, and a test waits
  for the PC notifications in flight with `server.bg`. Only real-process deadlines (`stopChild`'s
  signals, write deadlines) and herdr's socket deadline (`TestHerdrWaitHasNoDeadline`) stay on
  the real clock, and so does `record-wire`'s bridge, a process of its own: comparing, it waits
  for the requests each operation was recorded with, not a fixed settle, and the two WS watches
  run beside the rest on bridges of their own. The TS-recorded client scenarios run the client on a
  FakeClock kept at the real time's pace (`runScenario`), which a scenario may jump over a long
  wait (`Client.Jump`: ack-timeout's 10 s). fakeclaude is built once per test binary (`fakeClaudeEnv`).
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
- **webcheck** (`tools/webcheck.ts`: headless Chrome over CDP, no dependencies): CI's `webcheck` job
  runs Tier 1 on every PR and every push to main, over a private herdr (the release binary of
  `HERDR_VERSION`, pinned by SHA-256 in ci.yml), and main's run is the gate before a deploy (above).
  By hand it is optional, for debugging a UI flow or writing a check: the same, in a root of your own
  (its own lock: no other worker's run to wait for) and nowhere production shows:
  ```bash
  export WEBCHECK_ROOT=$(mktemp -d /tmp/wc-XXXX)  # short: the private herdr's socket lives under it
  go build -o "$FC/claude" ./tools/fakeclaude   # FC: any dir; the H items' wc-h1 runs it
  node tools/webcheck.ts herdr start            # a private headless herdr for this root
  node tools/webcheck.ts preview start --bin bin/yoicks --port 8396 --fake-claude "$FC/claude"  # a port of your own
  node tools/webcheck.ts check --base http://127.0.0.1:8396 --tier 1  # lock, setup, checks, teardown
  node tools/webcheck.ts preview stop --port 8396 && node tools/webcheck.ts herdr stop
  ```
  The private herdr (`herdr server` under `$WC_ROOT/herdr` as its HOME and XDG dirs: none of the
  desktop herdr's config, so not its plugins, which would start a second yoicks) takes every herdr call
  of that root and its previews while `$WC_ROOT/herdr` exists; stopped, they fail rather than reach the
  desktop's. A preview and a run stay on the herdr they began on: `herdr start|stop` refuse while the root
  has a preview or an unfinished run, a run refuses a preview of the other herdr, and the default root
  (every worker's) gets none. Without `herdr start` (Tier 2, which needs the desktop's HOME and direnv),
  the preview is a throwaway bridge over the real herdr.
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
  - The headless Home: Tier 1's H1–H8 drive `wc-h1` on the fake claude (`--fake-claude`, needed for
    them); Tier 2's H-T2 the real `wc-h2`, which a preview *without* `--fake-claude` (and with the
    `.envrc`) has, answering on haiku (its dir's `settings.local.json`; H-T2 stops if the transcript
    says another model). Both with `YOICKS_HEADLESS_NO_TOOLS=1`; a run stops the ones it started.
  - Safety: over the real herdr (no `herdr start`), the preview controls it, and production (so the
    phone, notifications included) sees the scratch agents: say so before such a run. It mutates only what the run created
    and recorded whose live tab or workspace label starts with `wc-` (one guard, which the page's
    own API requests pass too), and refuses port 8390. Runs and `preview start`/`stop` take turns
    on `$WC_ROOT/lock`, held by a separate `flock` process the bridge and Chrome never inherit.
    Teardown also runs on Ctrl+C; what it can't close stays recorded, and the next run retries it.
    `WC_ROOT` = `$WEBCHECK_ROOT` or `~/.local/state/herdr-yoicks-webcheck`.
  - A new check first passes on the current UI (the main before a screen's port), so it isn't
    written to fit the new code.
- **PR screenshots** (`.github/workflows/screenshots.yml`): on a PR touching the web UI, CI shoots main's
  web build and the PR's (`node tools/webcheck.ts shots`) and posts the screens whose pixels changed,
  before | after, in one comment it updates (images in `refs/screenshots/pr-<n>`, outside the branches).
  No herdr, no bridge: a stand-in serves `tools/shots-fixture.ts` (made-up data, typed as the web's
  `State`, so `npm run check:contract` fails when it goes stale; the shots are public, so never real
  data in it). A new screen is a line in its `scenes`. The same build shoots the same bytes: a browser
  context per shot, a frozen clock, UTC, no animations, one origin for both builds, the entry script
  under a fixed name (the app shows its hash). By hand, for a quick look before pushing:
  ```bash
  git worktree add "$T/before" main && (cd "$T/before" && npm ci --ignore-scripts && npx vite build)
  npx vite build && node tools/webcheck.ts shots --before "$T/before/web/dist" --after web/dist --out "$T/shots"
  ```

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
  dependencies are development-only: React and Mantine are bundled into the web UI; the rest
  (TypeScript, Vite, Tailwind, Vitest, happy-dom) is for its build and tests.
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
- **`custom_status` and `agent_message` were removed** (the bridge read them from panes and status
  events into an agent's `customStatus`/`message`, which a card showed as a dim line): herdr 0.9.5's
  schema has neither (protocol 22 has `state_labels`), so they were always empty. If herdr starts
  filling them (or `state_labels` turns out to carry such a line), they can come back: the fields on
  `RawPane`/`AgentInfo` and `applyEvent`, `herdr_schema_test.go`'s field lists, the contract, the card.
- **Not verified before the switch** (watch in production): memory, threads and fds over days;
  recovery after the machine sleeps; the CLI account checks' allow side and `worktree remove`
  through a real orchestrator; `blocked` on the folder-trust prompt. Never run against a real
  herdr: linux/arm64 and macOS. Supporting macOS's account features needs `sysctl`
  (`kern.procargs2`, via `golang.org/x/sys/unix`) in place of `/proc`.
- **Headless on macOS**: no `/proc`, so no orphan scan (a child an earlier bridge left isn't found),
  no refusal of a TUI start (phone or `yoicks orchestrator start`) beside a running headless child,
  and no Pdeathsig (only the shutdown ends a child). The same `sysctl` would fix the first two.
