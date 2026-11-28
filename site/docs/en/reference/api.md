# API (for scripting)


- `GET /api/state` — normalized workspaces/tabs/panes/agents tree, plus `orchestrators`
  (`[{ name, label, paneId, agents, mode, headless, todos }]` in config order; `paneId` is the agent running in its dir, or
  `null`; `agents` the agent panes of its Claude account, itself included, or `null` when unknown;
  `mode` is `"tui"`, or `"headless"` for one the bridge runs itself as `claude -p` (config
  `"mode": "headless"`), whose `paneId` is `"hl:<name>"` while it runs and whose
  `headless` is `{ status: stopped|idle|working|blocked|done|error, completionSeq, pending: { id, questions } | null,
  usage: { fiveHour, sevenDay, fable: { utilization (0–1), resetsAt (ms) } | null, contextPct | null, at } | null,
  warnings: [{ kind, message, since, actions: (interrupt|clear|tui)[] }], model, activeModel, models: [{ value, displayName, description, resolvedModel }] }`,
  `null` for a tui one; `models` is Claude Code's `/model` list without its `default` (whose model, if nothing else
  offers it, stays as its id), `[]` until a child of this bridge has given it; `model` the one chosen here, `""` for none; `activeModel` the model in effect, Claude Code's id, `""`
  until known: with none chosen, a resumed session keeps the model it last ran on), `todos` the user's
  to-do list on its Home (`[{ id, text, agent, url, due, createdAt }]`, oldest first, never `null`: what its
  orchestrator wrote down for the user to do; `agent` a worker's herdr name, `url` an http(s) link, `due` ms, each
  `null` when not given)
  and `orchestratorPaneId` (the first running tui one's, or `null`), and `claudeCheck`, the last Claude Code check
  (`{ at (ms), version, ok, failed: [items] }`, `null` when none has run), and `purposes` (`{ <paneId>: <one line> }`,
  never `null`: what each worker is for, as a headless orchestrator's `agent_start` or `agent_prompt` gave it; the
  app shows it under the agent's name, and it goes once the agent is gone). Each agent's `completionSeq` is herdr's
  `completion_seq` (which completion its idle/done status is; `null` until fetched), and its
  `stateChangeSeq` is herdr's `state_change_seq` (herdr's order of status changes, which the app
  lists by; `null` until fetched), and its `herdrName` herdr's name for it (`agent.start`'s, as
  `yoicks agent` and a headless orchestrator's `[yoicks]` notices name it; `null` until fetched)
- `GET /api/panes/:paneId/read?source=visible|recent&lines=N&format=text|ansi` — `visible` is the
  pane's live screen: the bridge reads the bottom screen (herdr's `detection` for text, `recent`
  one viewport tall for ANSI), since herdr's own `visible` follows the desktop's view, which may be
  scrolled up
- `POST /api/panes/:paneId/input` `{"text": "ls", "enter": true}` or `{"keys": ["ctrl+c"]}`
  — add `"clear": true` to wipe the pane's composer (repeated Ctrl+U) before the
  text lands, so a message composed here submits alone instead of being appended
  to a draft already typed straight into the pane
- `POST /api/panes/:paneId/focus`
- `POST /api/panes/:paneId/scroll` `{"direction": "up", "steps": 3}` — SGR wheel events for full-screen apps
- `POST /api/agents` `{"profile": "claude", "cwd": "/path", "name": "review", "task": "…", "workspace": "w7"}`
  — start a new agent from a named [launch profile](./config) (fixed argv allowlist; a caller
  never supplies a raw command). Only `profile` is required; returns `{"paneId", "name", "agent"}`
  (plus `"taskDelivered"` when `task` was given — the response then waits, up to 30s, for the agent to
  become ready for it). The agent opens in a new tab (labelled with its name) at `cwd`; pass
  `"workspace"` to put that tab in a specific workspace (else the active one). `name` is fitted to
  herdr's agent-name rule (lowercased, a-z/0-9/`-`/`_`, max 32). Pass a `"worktree": {"repo", "branch", "base"}` object
  instead of `cwd` to **create a worktree and launch the agent in its root pane atomically** — the worktree is
  rolled back if the agent fails to start. The new pane appears in `/api/state` a moment later.
  New worktrees go **next to their repo**, as `<repo>-wt-<branch>` (a blank branch gets a generated
  `worktree/…` name), not into herdr's worktrees dir, so whatever covers the repo from a parent dir — a
  direnv `.envrc` per org dir that picks the Claude account, say — covers the checkout too.
- `POST /api/orchestrators/:name/start` — start a configured orchestrator (its directory and `env`
  come from the config; the request names it only) in a new workspace and return `{"paneId", "name"}`.
  409 when it already runs. A headless one starts as the bridge's child instead (resuming its session),
  after checking it stays on the Claude subscription (409 otherwise), and returns `{"paneId": "hl:<name>", "name"}`.
- `POST /api/orchestrators/:name/send` `{"text": "…"}`, `…/interrupt`, `…/clear` and `…/stop` — for a
  headless orchestrator: send a message (also while it works) and interrupt its turn, both 409 when it
  isn't running; clear starts it in a fresh session (returning `{"paneId", "name"}` like start), running
  or not; stop ends it, and succeeds when it is already stopped. A send naming the pending question
  (`"question": "<its id>"`) is about it, not an answer: it is written, then the question is refused as `answer`'s `chat` refuses it, with the
  send's `"answers"` (the panel's so far), if any. The web UI names it only for a message begun with the question on screen, at least 1 s
  before the send. Without it (or naming a question no longer pending), the question stays: Claude Code holds the message until it is
  answered. A send may
  carry `"images": [{"mediaType": "image/jpeg", "data": "<base64>"}]` (JPEG, PNG or GIF that decode
  whole, at most 4, 2000 px a side and 1 MiB in all; `text` may then be empty), written as image
  blocks before the text; 400 otherwise. The web UI's + and paste
  attach them, scaled and recompressed to JPEG. A headless orchestrator has no herdr pane: `/api/panes/hl:<name>/…` and
  `/api/agents/hl:<name>/…` answer 404, except `GET /api/panes/hl:<name>/transcript`.
- `POST /api/orchestrators/:name/model` `{"model": "<value>"}` — set a headless orchestrator's model to one of
  `headless.models` (400 for another): a running one switches in place (Claude Code's `set_model`, from its next
  turn), 409 while a turn runs, 504 when Claude Code hasn't answered within 10 s (kept once it does); a stopped one
  starts on it. Kept across restarts and Clear (`--model` at each start).
- `POST /api/orchestrators/:name/answer` `{"id": "…", "answers": {"<question>": "<label>"}}` or
  `{"id": "…", "deny": "<message>"}` or `{"id": "…", "chat": true, "answers"?: {…}}` — answer (or refuse) the
  headless orchestrator's pending question (`headless.pending`, its AskUserQuestion): a multiSelect's labels
  joined by `", "`, free text allowed (Claude Code's "Type something."); `chat` is Claude Code's "Chat about
  this": refused with its words, which list the questions and the answers given so far; 409 when that id
  isn't the one pending.
- `DELETE /api/orchestrators/:name/todos/:id` — tick an item of that Home's to-do list off; 404 when
  there is no such item (already ticked off, or done by its orchestrator).
- `DELETE /api/panes/:paneId` — stop an agent by closing its pane
- `POST /api/panes/:paneId/rename` `{"name": "worker-2"}` — rename the agent running in the pane
- `POST /api/agents/:target/clear` — start a fresh replacement agent (same profile + cwd) and close
  the old pane; the pane id changes, so the client re-follows the new pane
- `GET /api/panes/:paneId/transcript` — Claude Code chat view: the pane's JSONL
  session transcript as normalized `items` (`user`/`assistant`/`thinking`/
  `tool_use`/`tool_result`; a `user` item with images has `images`, as data: URLs) plus `sessionId` and a byte `cursor`. Returns
  `{"available": false}` when the pane isn't a claude session or its transcript
  isn't on this host. Add `?session=<id>&after=<cursor>` to fetch only items past
  the cursor for that session (incremental polling).
- `POST /api/agents/:target/send` `{"text": "continue"}` — submit a prompt to a ready agent (herdr
  `agent.prompt`; `text` must be non-empty)
- `WS /ws?token=…` — `{"type":"state"}` snapshots and `{"type":"agent_status"}`
  transitions, and `{"type":"orchestrator_alert","name","kind","message"}` for a headless
  orchestrator's new warning (once per session and kind; also to ntfy when `notify_url` is set; `name` `""`
  with `kind` `"canary"`: a failed Claude Code check, once; `kind` `"todo"`: to-do items come due, each
  once, their text as `message`, one alert per Home; `kind` `"github"`: `pr_watch`'s gh failing, once per
  error, to each Home with a PR on its list). A
  headless orchestrator's working → done and → blocked come as `agent_status` with `paneId: "hl:<name>"`
  and its label as `workspaceLabel`. `{"type":"watch_transcript","paneId":…}` starts a live tail that
  pushes `{"type":"transcript_items",…}` (`reset` rebuilds, else appends);
  `{"type":"unwatch_transcript"}` stops it (mirrors `watch_pane`/`pane_output`).
