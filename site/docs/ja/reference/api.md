# API (スクリプト用)


- `GET /api/state` — 正規化したワークスペース / タブ / ペイン / エージェントのツリーと、`orchestrators`
  (`[{ name, label, paneId, agents, mode, headless, todos }]`、config の順) を返します。`paneId` はそのディレクトリで動いているエージェントで、
  無ければ `null` です。`agents` はその Claude アカウントのエージェントのペイン (自分自身を含みます) で、わからなければ `null` です。
  `mode` は `"tui"` か、ブリッジ自身が `claude -p` として動かすもの (config の
  `"mode": "headless"`) なら `"headless"` です。`"headless"` のものは、動いている間 `paneId` が `"hl:<name>"` になり、
  `headless` が `{ status: stopped|idle|working|blocked|done|error, completionSeq, pending: { id, questions } | null,
  usage: { fiveHour, sevenDay, fable: { utilization (0–1), resetsAt (ms) } | null, contextPct | null, at } | null,
  warnings: [{ kind, message, since, actions: (interrupt|clear|tui)[] }], model, activeModel, models: [{ value, displayName, description, resolvedModel }],
  compact: { state: running|done|failed, from, to, error } | null }` になります。
  tui のものでは `null` です。`compact` は最後の compact (Home からのもの、入力した `/compact`、上限の近くで Claude Code が自分で行うもの) で、
  次のターンが終わるまで残ります。`from` と `to` は前後のコンテキストのウィンドウに対する割合 (%) で、わからない間は `null` です。
  `error` は失敗した理由で、失敗していなければ `""` です。`models` は Claude Code の `/model` の一覧から `default` を除いたものです (`default` のモデルは、ほかのどの項目にも
  無ければ、その id のまま残ります)。このブリッジの子プロセスが返すまでは `[]` です。`model` はここで選んだモデルで、選んでいなければ `""` です。`activeModel` は実際に使われているモデル (Claude Code の id) で、
  わかるまでは `""` です。何も選んでいなければ、再開したセッションは最後に動いたときのモデルのままです。`todos` はその Home にあるユーザーの
  やることリストです (`[{ id, text, agent, url, due, createdAt }]`、古い順、`null` にはなりません。その
  orchestrator が、ユーザーがやることとして書き留めたものです。`agent` はワーカーの herdr での名前、`url` は http(s) のリンク、`due` は ms で、どれも
  指定が無ければ `null` です)。
  ほかに `orchestratorPaneId` (最初に動いている tui のもののペイン、無ければ `null`)、`claudeCheck` (最後の Claude Code の確認。
  `{ at (ms), version, ok, failed: [items] }`、一度も実行されていなければ `null`)、`purposes` (`{ <paneId>: <one line> }`、
  `null` にはなりません。各ワーカーの目的で、ヘッドレスの orchestrator の `agent_start` か `agent_prompt` が渡したものです。
  アプリはエージェントの名前の下に表示し、エージェントがいなくなると消えます) も返します。各エージェントの `completionSeq` は herdr の
  `completion_seq` (その idle/done のステータスがどの完了のものか。取得するまでは `null`)、
  `stateChangeSeq` は herdr の `state_change_seq` (herdr でのステータス変化の順序で、アプリはこの順に並べます。
  取得するまでは `null`)、`herdrName` は herdr でのそのエージェントの名前 (`agent.start` で付けた名前で、
  `yoicks agent` とヘッドレスの orchestrator の `[yoicks]` 通知もこの名前で呼びます。取得するまでは `null`) です
- `GET /api/panes/:paneId/read?source=visible|recent&lines=N&format=text|ansi` — `visible` は
  ペインの現在の画面です。herdr 自身の `visible` はデスクトップの表示に従い、その表示は上にスクロールしていることがあるため、
  ブリッジは一番下の画面を読みます (テキストは herdr の `detection`、ANSI は表示領域 1 つ分の高さの
  `recent`)
- `POST /api/panes/:paneId/input` `{"text": "ls", "enter": true}` または `{"keys": ["ctrl+c"]}`
  — `"clear": true` を加えると、テキストが入る前にペインの入力欄を消します (Ctrl+U を繰り返します)。
  こうすると、ここで書いたメッセージは、ペインに直接打ち込まれていた下書きの後ろにつながらず、
  それだけで送信されます
- `POST /api/panes/:paneId/focus` — herdr の `pane.focus`: PC の herdr がそのペインのワークスペース、タブ、ペインに
  切り替わります (Web の **Open in herdr**。PC のブラウザでのみペインの ⋮ にあります)
- `POST /api/panes/:paneId/scroll` `{"direction": "up", "steps": 3}` — フルスクリーンアプリ向けの SGR ホイールイベント
- `POST /api/agents` `{"profile": "claude", "cwd": "/path", "name": "review", "task": "…", "workspace": "w7"}`
  — 名前付きの[起動プロファイル](./config)から新しいエージェントを起動します (argv を固定した許可リストです。
  呼び出し側が生のコマンドを渡すことはありません)。必須は `profile` だけで、`{"paneId", "name", "agent"}` を返します
  (`task` を渡したときは `"taskDelivered"` も付きます。このとき応答は、エージェントがタスクを受け取れる状態になるまで最大 30s
  待ちます)。エージェントは `cwd` で新しいタブ (その名前のラベル付き) に開きます。
  `"workspace"` を渡すと、そのタブを指定のワークスペースに置きます (渡さなければアクティブなワークスペース)。`name` は
  herdr のエージェント名の規則に合わせて直します (小文字にし、a-z/0-9/`-`/`_`、最大 32 文字)。`cwd` の代わりに `"worktree": {"repo", "branch", "base"}` オブジェクトを渡すと、
  **worktree を作り、そのルートペインでエージェントを起動するまでをアトミックに行います**。エージェントの起動に失敗すると、
  worktree は元に戻します。新しいペインは少し遅れて `/api/state` に現れます。
  新しい worktree は、herdr の worktree のディレクトリではなく、**リポジトリの隣**に `<repo>-wt-<branch>` として作ります (ブランチが空なら
  `worktree/…` の名前を生成します)。そのため、親ディレクトリからリポジトリに効いているもの (たとえば、org のディレクトリごとに
  Claude アカウントを選ぶ direnv の `.envrc`) が、そのチェックアウトにも効きます。
- `POST /api/orchestrators/:name/start` — config にある orchestrator を新しいワークスペースで起動し、`{"paneId", "name"}` を返します
  (ディレクトリと `env` は config から取ります。リクエストは名前を指定するだけです)。
  すでに動いていれば 409 を返します。ヘッドレスのものは代わりにブリッジの子プロセスとして起動し (セッションを再開します)、
  その前に Claude のサブスクリプションのままであることを確かめます (そうでなければ 409)。返すのは `{"paneId": "hl:<name>", "name"}` です。
- `POST /api/orchestrators/:name/send` `{"text": "…"}`、`…/interrupt`、`…/clear`、`…/stop` — ヘッドレスの
  orchestrator 用です。send はメッセージを送り (作業中でも送れます)、interrupt はそのターンを中断します。どちらも、
  動いていなければ 409 を返します。clear は、動いていてもいなくても、新しいセッションで起動します (start と同じく
  `{"paneId", "name"}` を返します)。stop は止めます。すでに止まっていても成功します。質問が
  保留中の間 (まだ保留中になっていない、届く途中の質問でも)、send はその質問を `"question": "<その id>"` で指す必要があります (web UI の Chat about this)。指さない send は書き込まずに断ります (409 `question_pending`。web UI はそのメッセージを下書きとして残します)。質問を指した send は、回答ではなく、その質問についてのメッセージです。メッセージを書き込んだあと、`answer` の `chat` と同じように質問を断ります。send に `"answers"` (パネルでそれまでに選んだもの) があれば、それも添えます。send には
  `"images": [{"mediaType": "image/jpeg", "data": "<base64>"}]` を付けられます (最後までデコードできる JPEG、PNG、GIF で、
  最大 4 枚、1 辺 2000 px まで、合計 1 MiB まで。このとき `text` は空でもかまいません)。画像はテキストの前に画像
  ブロックとして書き込みます。条件に合わなければ 400 を返します。web UI の + と貼り付けは、画像を JPEG に縮小・再圧縮して
  添付します。ヘッドレスの orchestrator には herdr のペインがありません。`/api/panes/hl:<name>/…` と
  `/api/agents/hl:<name>/…` は、`GET /api/panes/hl:<name>/transcript` を除いて 404 になります。
- `POST /api/orchestrators/:name/model` `{"model": "<value>"}` — ヘッドレスの orchestrator のモデルを
  `headless.models` のどれかに設定します (それ以外は 400)。動いているものはその場で切り替わります (Claude Code の `set_model` で、次の
  ターンから)。ターンの実行中は 409、Claude Code が 10 s 以内に答えなければ 504 を返します (答えた時点で保存されます)。止まっているものは、
  次にそのモデルで起動します。設定は再起動と Clear をまたいで保たれます (起動のたびに `--model` を渡します)。
- `POST /api/orchestrators/:name/compact` `{"focus"?: "<要約に残してほしいこと>"}` — ヘッドレスの orchestrator の会話を
  その場で compact します (Claude Code の `/compact`。focus は 1 行にまとめ、2000 バイトまで)。セッションは要約から続き、
  `headless.compact` がその経過を示します。ターンの合間だけです。ターンの実行中や質問を待っている間は 409 `busy`、止まっているときは
  409 `not_running` を返します。完了としては数えません。
- `POST /api/orchestrators/:name/answer` `{"id": "…", "answers": {"<question>": "<label>"}}` または
  `{"id": "…", "deny": "<message>"}` または `{"id": "…", "chat": true, "answers"?: {…}}` — ヘッドレスの
  orchestrator の保留中の質問 (`headless.pending`、その AskUserQuestion) に答えます (または断ります)。multiSelect のラベルは
  `", "` でつなぎます。自由なテキストも使えます (Claude Code の "Type something.")。`chat` は Claude Code の "Chat about
  this" で、Claude Code の文言で質問を断ります。その文言には、質問とそれまでに出した回答が並びます。その id が
  保留中のものでなければ 409 を返します。
- `DELETE /api/orchestrators/:name/todos/:id` — その Home のやることリストの項目を済みにします。その項目が無ければ
  (すでに済みにした、またはその orchestrator が完了にした) 404 になります。
- `DELETE /api/panes/:paneId` — ペインを閉じてエージェントを止めます
- `POST /api/panes/:paneId/rename` `{"name": "worker-2"}` — ペインで動いているエージェントの名前を変えます
- `POST /api/agents/:target/clear` — 代わりの新しいエージェントを (同じプロファイルと cwd で) 起動し、
  古いペインを閉じます。ペイン id が変わるので、クライアントは新しいペインを追い直します
- `GET /api/panes/:paneId/transcript` — Claude Code のチャット表示用です。ペインの JSONL の
  セッション transcript を、正規化した `items` (`user`/`assistant`/`thinking`/
  `tool_use`/`tool_result`。画像のある `user` の項目は `images` を data: URL として持ちます) と、`sessionId`、バイト単位の `cursor` で返します。
  ペインが claude のセッションでないか、その transcript がこのホストに無ければ
  `{"available": false}` を返します。`?session=<id>&after=<cursor>` を付けると、そのセッションの
  cursor より後の項目だけを取得します (差分のポーリング用)。
- `POST /api/agents/:target/send` `{"text": "continue"}` — 入力を受け付けられる状態のエージェントにプロンプトを送ります (herdr の
  `agent.prompt`。`text` は空にできません)
- `WS /ws?token=…` — `{"type":"state"}` のスナップショットと `{"type":"agent_status"}`
  の遷移、それにヘッドレスの orchestrator の新しい警告を伝える `{"type":"orchestrator_alert","name","kind","message"}` を送ります
  (セッションと種類ごとに 1 回。`notify_url` があれば ntfy にも送ります。`name` が `""` で
  `kind` が `"canary"` のものは Claude Code の確認の失敗で、1 回だけです。`kind` が `"todo"` のものは期限が来たやることリストの項目で、各項目
  1 回ずつ、その本文を `message` に入れ、Home ごとに 1 つの通知にまとめます。`kind` が `"github"` のものは `pr_watch` の gh の失敗で、エラーごとに
  1 回、リストに PR がある Home それぞれに送ります)。
  ヘッドレスの orchestrator の working → done と → blocked は、`paneId: "hl:<name>"`
  と、そのラベルを `workspaceLabel` に入れた `agent_status` として届きます。`{"type":"watch_transcript","paneId":…}` は transcript の
  ライブの追跡を始め、`{"type":"transcript_items",…}` を送ります (`reset` なら作り直し、そうでなければ追加します)。
  `{"type":"unwatch_transcript"}` で止まります (`watch_pane`/`pane_output` と同じ形です)。
