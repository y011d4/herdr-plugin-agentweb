# bridge と agentwebctl を Go に移す計画

- 状態: **承認済み**（2026-11-24。Architect と Critic の合意済み、2 回目で Critic が APPROVE）。P0 完了、K1 通過（docs/go-migration/p0-report.md。残りの見積もりの見直しもそちら）
- 作成: 2026-11-24、ブランチ `go-migration-plan`。改訂 3（2 回目の細かい指摘まで反映。§12）
- 対象: `server/*.ts`（bridge、空行を除き約 4,100 行）と `bin/agentwebctl.ts`（CLI、547 行）。`web/` は TypeScript のまま残す。

## 0. 要約

| 段階 | 内容 | 本番 | 作業日 |
|---|---|---|---|
| P0 | 準備と確認（偽の herdr、TS 版での通信とシナリオの記録、herdr-client の設計の試作） | Node | 3〜5 |
| P1 | ソケット、HTTP、WS を使わない部分とそのテスト（約 230 件）を移す | Node | 6〜8 |
| P2 | 残りの I/O 層（herdr 接続、HTTP、WS、git、/proc、direnv）を移す | Node | 9〜13 |
| P3 | CLI（agentwebctl の全サブコマンド）を移す | Node | 3〜4 |
| P4 | 別ポートで並走（読むだけ 3 日）→ 試用（使い捨てのタブと携帯で書き込みも 4 日）。実機確認 | Node | 3〜4（と暦日 7 日） |
| P5 | 切り替え | **Go** | 2 |
| P6 | 配布（リリース、インストール手順、他人向けの文書、LICENSE） | Go | 4〜6 |

- 合計 30〜42 作業日と、並走・試用の暦日 7 日。
- **凍結（TS のサーバーと CLI に手を入れない期間）は P0 の手順 4 から P5 の手順 3 まで。** 作業日で 21〜29 日と P4 の暦日 7 日。週 5 日の作業で 5〜7 週間（P4 が K4 の上限の 14 日まで延びると 8 週間ほど）。質問のときにお伝えした 4〜6 週間より少し長い。長すぎる場合は K5（§9.3）で一時停止できる。
- 大きなリスク:
  1. herdr-client の再接続とイベントのバッファ処理（今はテストがない）を移し損ね、通知を取りこぼすか二重に出す。
  2. JSON の形のずれ（null と空配列の取り違え、判別共用体の崩れ）で web が壊れる。
  3. 切り替えや戻しのときに、orchestrator の許可パスがずれる、または古い bridge が残ってポートを握ったままになる。

## 1. 決まっていること・前提

| 項目 | 内容 | 出どころ |
|---|---|---|
| Go に移す範囲 | bridge サーバーと CLI。web UI は TS のまま、ビルドした静的ファイルを `go:embed` で埋め込む | 依頼 |
| Bun | 使わない（配布サイズ 109 MB 対 Go 7〜10 MB） | 依頼・比較レポート |
| macOS | 試せる Mac がない。darwin 版はビルドして配るが「試験的」と書く。/proc に頼る機能は macOS では今と同じく拒否する | 利用者の回答 |
| 移行中の変更 | 凍結中は TS のサーバーと CLI に手を入れない（セキュリティ修正だけは TS と Go の両方に入れる）。web UI は API の形を変えない限り直してよい | 利用者の回答 |
| ライセンス | MIT。0cv/herdr-mobile-relay（AGPL-3.0）は考え方の参考にとどめ、コードは写さない | 利用者の回答 |
| WS ライブラリ | `github.com/coder/websocket` v1.8.15（推移的な依存なし。試作で deflate を確認済み） | 比較レポート |
| Go | 1.27 系。`go.mod` の `toolchain` 行に加え、リリースのビルドでは `GOTOOLCHAIN` を固定する | §8.3 |
| 先例 | 同じ機械に入っている rmarganti.herdr-pluck が、`command = ["./bin/herdr-pluck", …]` と `[[build]] = ["./scripts/install-binary.sh"]`（リリースから取得、なければ自分でビルド）で Rust のバイナリを配っている。相対パスの起動はこれで動いている | `~/.config/herdr/plugins/github/rmarganti.herdr-pluck-*/` |

## 2. 方針（RALPLAN-DR）

### 原則

1. **切り替えまで本番の設定に触らない。** 動いている Node の bridge、その state、config、orchestrator のディレクトリは、P5 まで Node 版だけが書く。Go 版を動かすときは、manifest から起動する場合を除いて、必ず一時的な `HERDR_PLUGIN_CONFIG_DIR`、`HERDR_PLUGIN_STATE_DIR`、`XDG_DATA_HOME` を指定する（指定しないと `herdr plugin config-dir` から本物の config を読んでしまう。`bin/agentwebctl.ts:49`）。P4a（読むだけの並走）では Go 版は herdr に何も書き込まない。P4b（試用）からは、携帯から Go 版を普段どおり使うので本物の agent にも書き込む。それまでに、送るリクエストが TS 版と同じであることを通信の記録で確かめておく。
2. **同じ挙動であることを証拠で示す。** herdr に送るリクエスト（操作ごと）、web に返す JSON、テスト名の対応表の 3 つを TS 版と比べる。TS 版の不具合を移植で直す場合は、「違いの記録」（`docs/go-migration/divergences.md`）に理由と一緒に書いたものだけを、説明のついた違いとして認める。
3. **戻せるようにする。** 切り替えは 1 コミットにまとめ、「今の bridge を止める → revert → リンクし直す → 起動する」で戻せるようにする。これが使えるのは、P5 の手順 6 で TS のコードを消すまでである。
4. **依存を増やさない。** 切り替えの時点で、実行時の依存は coder/websocket だけにする。
5. **判定できないときは拒否する。** アカウントの判定など、今の「わからなければ断る」性質を、どの OS でも保つ。

### 判断の軸（上位 3 つ）

1. 挙動の退行を起こさないこと（herdr の細かい挙動、セキュリティの不変条件、通知の取りこぼし）
2. 配れること（Node なし、単一バイナリ、ほかの人の環境で動くこと）
3. 移行中のコスト（凍結の長さ、道具の多さ）

### 移行方式の比較

| 案 | 内容 | 良い点 | 悪い点 |
|---|---|---|---|
| A. 一括で書き直す | Go 版を全部書いてから一度に切り替える | 構造が単純 | 切り替えまで本物の herdr で試せない |
| A'. 一括で書き直し、切り替えてから様子を見る | P3 の後すぐに切り替え、Node は戻す先として残す | 並走の道具が要らず、凍結が数日短い | 通知の取りこぼし（R1）や JSON のずれ（R2）を、携帯が Go 版に頼り始めてから見つけることになる |
| B. 機能ごとに置き換える（前段に Go を置き、未移植の経路を Node に転送） | 移した経路から順に Go が受け持つ | 少しずつ本番に出せる | herdr の状態を Go と Node の両方が持つ。WS が二つに割れ、トークンも二か所で扱う。転送のコードは最後に捨てる。4,600 行の規模には重すぎる |
| C. 層ごとに移し、並走と試用で比べてから一度に切り替える（**採用**） | 下の層から順に Go に移してテストで固める。本番は Node のまま、Go 版を別ポートで読むだけで並走させてから、使い捨てのタブで試用し、manifest を切り替える | 本番は常に動いている。切り替えの前に本物の herdr で比べられる。並走は config を分けるだけで済む | 凍結が長い。比べるための小さな道具が要る |
| D. CLI を先に、サーバーを後に切り替える | CLI だけ先に Go にする | 切り替えの単位が小さい | CLI はサーバーと同じモジュールを使うので先に移せる部分がほとんどない。orchestrator の許可パスを 2 回変えることになる |

**C を選ぶ理由:** 並走は config を分けるだけで済む（§4 P4）ので、A' との差は 3 日の読むだけの並走と小さな比較の道具だけである。その代わりに、R1 と R2 を携帯が頼る前に見つけられる。B は道具のほうが高くつき、D は分けても得るものがない。

**危険な部分を先に試す:** 層の順で進むと、一番危ない herdr-client が P2 まで残る。そこで P0 で herdr-client の設計（§3.7 L6）を試作し、TS 版で記録したシナリオに合うかを確かめてから P1 に入る（K1）。

## 3. 今のコードで環境に依存している箇所

### 3.1 OS の機能

| # | 何に依存しているか | 場所 | macOS で今どうなるか | Go での扱い |
|---|---|---|---|---|
| E1 | `/proc/<pid>/stat`・`cmdline` で claude の祖先プロセスを探す | `server/account.ts:43,59`（`ownAccount`） | 読めないので、自分の `CLAUDE_CONFIG_DIR` を呼び出し元のアカウントとみなす（コマンドラインで別アカウントを名乗れないようにする仕掛けが効かない） | `proc_linux.go` に移す。darwin は今と同じ扱いにして README に書く |
| E2 | `/proc/<pid>/environ` を `grep` で読み、`CLAUDE_CONFIG_DIR` と `HOME` だけ取り出す（1 秒、64 KB で打ち切る） | `server/transcript.ts:60`（`projectsRootForPid`）。`paneAccount`、transcript の場所探し、overview が使う | null を返す。ペインのアカウントが不明になり、拒否される | Linux は `grep` に渡す今の方式を残す（ほかの環境変数を bridge のメモリに入れないという今の約束を守るため）。打ち切りの値も同じ。darwin は null のまま |
| E3 | `process.platform === 'linux'` で clear のアカウント確認を切り替える | `server/http.ts:716` | 確認をとばして clear する | `runtime.GOOS` で同じ分岐にする |
| E4 | シグナル（SIGTERM、SIGINT）、`kill(pid, 0)`、親から切り離した子の起動 | `bin/agentwebctl.ts:91,125,144-215,304-322`、`server/main.ts:85` | 動く | `syscall`（Unix のみ）。`Setsid` で切り離す |
| E5 | ファイルの権限 0600・0700（token、bridge.log、pane-profiles.json、state ディレクトリ） | `server/auth.ts`、`server/pane-profile-store.ts`、`bin/agentwebctl.ts:151` | 動く | そのまま移す |
| E6 | Unix ドメインソケット（herdr） | `server/herdr-client.ts`、`bin/agentwebctl.ts:330` | 動く | `net.Dial("unix", …)` |
| E7 | Node の HTTP サーバーの既定のタイムアウト（ヘッダーの受信など） | `server/http.ts` | 動く | Go の既定はタイムアウトなし。`ReadHeaderTimeout` を設定する。WS は対象外 |

### 3.2 外部コマンド

| # | コマンド | 場所 | 必須か | Go での扱い |
|---|---|---|---|---|
| X1 | `git` | `server/worktree-resolve.ts:108`（2 秒）、`:226`（5 秒）、`:231`（`rev-parse --path-format=absolute` は git 2.31 以上が必要）、`bin/agentwebctl.ts:529-547`（symbolic-ref、fetch、merge-base、`branch -D`。60 秒） | ブランチ表示と worktree 機能に必要。なければ表示が減るだけ | `os/exec` で同じ引数、同じタイムアウト、同じ `LC_ALL=C`。README に「git 2.31 以上」と書く |
| X2 | `gh` | `bin/agentwebctl.ts:536`（squash merge 済みの PR を調べる） | 任意 | そのまま |
| X3 | `direnv`（と `sh`） | `server/account.ts:145`（`dirAccount`。15 秒、64 KB） | アカウントをディレクトリごとに分けるときだけ必要 | そのまま。なければ null（拒否） |
| X4 | `tailscale` | `bin/agentwebctl.ts:231,238` | 任意 | そのまま |
| X5 | `qrencode` | `bin/agentwebctl.ts:287` | 任意（なければ URL だけ出す） | 切り替えまではそのまま（P3 で出力を比べるため）。バイナリ内で QR を作るか（`rsc.io/qr`）は P6 で決める |
| X6 | `herdr`（CLI） | `bin/agentwebctl.ts:49`（`plugin config-dir`）、`:121`（`notification show`、`HERDR_BIN_PATH` を使う）、`:431`（`agent get/read/prompt/wait` をそのまま渡す。こちらは PATH の `herdr`） | 必須 | 切り替えまでは今と同じにする。「`HERDR_BIN_PATH` があればそれ、なければ PATH」に揃えるのは違いの記録に書いて P6 で行う |
| X7 | `ps` | `bin/agentwebctl.ts:72-79`（pidfile の PID が本当に bridge か調べる） | なければ PID を信じる | Go 版は「1 語目の basename が `agentwebctl` で、2 語目が `serve` か `run`」のときだけ bridge とみなす。引数は、Linux では `/proc/<pid>/cmdline`（NUL 区切りなので、インストール先のパスに空白があっても崩れない）から、darwin では `ps -p <pid> -o args=` の末尾が `agentwebctl serve` か `agentwebctl run` かで見る（実行ファイルのパスだけで見ると、orchestrator が裏で動かす `agentwebctl agent wait` も当てはまり、再利用された PID に SIGTERM を送りうる。またインストール先が変わっても見つけられる）。P5 の手順 6 までは main.js と main.ts も認める |
| X8 | `grep` | E2 と同じ | Linux で必須 | E2 と同じ |

### 3.3 環境変数

| 変数 | 場所 | 用途 |
|---|---|---|
| `HERDR_SOCKET_PATH` | `server/config.ts:27`、`bin/agentwebctl.ts:331` | herdr のソケット（既定 `~/.config/herdr/herdr.sock`） |
| `HERDR_PLUGIN_STATE_DIR` | `server/config.ts:20`、`bin/agentwebctl.ts:40` | token、pidfile、bridge.log、pane-profiles.json |
| `HERDR_PLUGIN_CONFIG_DIR` | `server/config.ts:8`、`bin/agentwebctl.ts:47` | config.json。CLI はなければ `herdr plugin config-dir` に聞く |
| `XDG_DATA_HOME` | `server/config.ts:34` | orchestrator のディレクトリ |
| `HERDR_AGENTWEB_HOST`、`HERDR_AGENTWEB_PORT` | `server/config.ts:81,86`、`bin/agentwebctl.ts:104-105,258` | 待ち受けの上書き |
| `HERDR_BIN_PATH` | `bin/agentwebctl.ts:119` | herdr の通知 |
| `HERDR_PANE_ID` | `bin/agentwebctl.ts:372` | overview で自分を除く |
| `HERDR_PLUGIN_ENTRYPOINT_ID` | `bin/agentwebctl.ts:297` | qr のペインで Enter を待つ |
| `HOME`、`CLAUDE_CONFIG_DIR` | `server/account.ts:20,27,67` | アカウントの判定 |
| `HTTP_PROXY` など | （Node の fetch は読まない） | Go の HTTP クライアントは読む。ntfy に効く。違いの記録に書き、Go の挙動を受け入れる |

### 3.4 herdr のバージョンに依存するもの

- manifest の `min_herdr_version = "0.8.0"`。実機で確かめたのは herdr 0.9.5（protocol 22）。
- 0.8 で `agent.start` の形が変わった（ペインを作らず、`pane_id` に起動する）。`agent.send` はなくなった。
- `completion_seq` と `state_change_seq` は `agent.list` / `agent.get` にしかない（0.9.5）。
- 不正な enum を送ると herdr は応答せずに接続を切る。
- イベント名が `pane_created` と `pane.agent_status_changed` のように混在する。`session.snapshot` の結果は `result.snapshot` の下にある。`recent` の読み出しは 1000 行まで。
- エラーコード（`agent_pane_busy`、`agent_not_ready`、`dirty_worktree_requires_force`）と、agent 名の制約 `^[a-z][a-z0-9_-]{0,31}$`。
- `workspace.create`、`tab.create`、`pane.split` は `env` を受け取るが、`worktree.create` は受け取らない。
- 今のコードは snapshot の `version`・`protocol` を State に写すだけで、何も判定していない（`server/state.ts:179`）。
- 使っている RPC は `events.subscribe` を含めて 19 種類: `agent.get/list/prompt/rename/start`、`pane.close/focus/get/process_info/read/send_input/send_text/split`、`session.snapshot`、`tab.create`、`workspace.create`、`worktree.create/remove`、`events.subscribe`。購読するイベントは `server/herdr-client.ts:164-193` の 21 種類。

### 3.5 パスの決め打ちと配置

| # | 内容 | 場所 | Go での扱い |
|---|---|---|---|
| P-1 | `package.json` を探して上にたどり、プラグインのルートを決める | `server/orchestrator.ts:24`、`bin/agentwebctl.ts:23` | 不要になる。rules.md と web は embed、自分の場所は `os.Executable()` と `filepath.EvalSymlinks` |
| P-2 | `AGENTWEBCTL = node <root>/dist/bin/agentwebctl.js` を orchestrator の `rules.md` と `.claude/settings.json` の許可リストに書く | `server/orchestrator.ts:35,49` | Go の実行ファイルの絶対パスにする（`shellWord` はそのまま）。今の 3 つの管理ディレクトリ（kenri、personal、pfn）には `node /home/y011d4/ghq/github.com/y011d4/herdr-plugin-mobile/dist/bin/agentwebctl.js` が書かれていて、bridge の起動時に書き直される。GitHub からのインストールでは、インストール先（herdr 0.9.5 では `~/.config/herdr/plugins/github-installations/<id>-<hash>/<世代>/checkout/`）が更新のたびに変わる（P0 で確認）。bridge の起動のたびに書き直す今の仕組みで追いつくが、動いている orchestrator は再起動するまで古いパスのままなので、README の更新の手順に orchestrator の再起動を入れる |
| P-3 | 古い非管理ディレクトリ `~/.local/share/herdr-agentweb/dispatcher` の `CLAUDE.md:37` と `.claude/settings.json:15` に、同じ node のパスが手で書かれている | 利用者のファイル | プラグインは書き換えない（今の約束）。P5 で利用者が直すか、使っていなければ消す |
| P-4 | web のルートを `__dirname/../web` か `../../web` から探す | `server/main.ts:12-19` | embed にする。web は凍結していないのでファイルが増えうる。そのため名前を並べず、拡張子のパターン（`web/*.js` など）で指定する。古いビルドの残りは、リリースを一時的な worktree でビルドすることで防ぐ（§8.3）。開発用に `AGENTWEB_WEB_DIR` を指定するとディスクから配る |
| P-5 | `dist/server/main.js` がなければ `server/main.ts` を使う | `bin/agentwebctl.ts:35` | 不要になる。`agentwebctl serve` がサーバー本体 |
| P-6 | manifest のコマンドが `node dist/bin/agentwebctl.js …`、`[[build]]` が `npm ci` と `npm run build` | `herdr-plugin.toml` | herdr-pluck と同じ `["./bin/agentwebctl", …]` にする。`[[build]]` は §8 |
| P-7 | 既定のパス: state `~/.local/state/herdr-agentweb`、socket `~/.config/herdr/herdr.sock`、data `$XDG_DATA_HOME` または `~/.local/share/herdr-agentweb`、ポート 8390、`127.0.0.1` | `server/config.ts`、`bin/agentwebctl.ts:41,331` | macOS での herdr の socket の場所は確かめられないので、README で `HERDR_SOCKET_PATH` を案内する。state は直す（P0 で発見）: herdr から起動すると `HERDR_PLUGIN_STATE_DIR` は `~/.local/state/herdr/plugins/<id>` で、herdr の外から CLI を動かしたときの既定 `~/.local/state/herdr-agentweb` と食い違う（この機械には両方に token がある）。Go 版は herdr の外でも herdr と同じ場所を既定にし（herdr の決め方は P1 で確かめる）、違いの記録に書く |
| P-8 | Claude の transcript の場所: `~/.claude/projects` と `~/.config/claude/<name>/projects` | `server/transcript.ts:22-40` | そのまま。後者はこの利用者の複数アカウントの置き方に合わせたもので、ほかの人には `CLAUDE_CONFIG_DIR` が任意の場所にある。Linux では E2 が補うが、macOS では補えない。README に書く |
| P-9 | 利用者が書く `local.md` の `~/ghq/...` | 利用者のファイル | 利用者の文章なので触らない |

### 3.6 Claude Code のバージョンに依存するもの

| # | 内容 | 場所 |
|---|---|---|
| C1 | orchestrator の deny 一覧（`tree`、`du`、`fd`、`lsof` など）と `dontAsk`、`disableAgentView`。Claude Code 2.1.322 で測った | `server/orchestrator.ts:44-58`（測った版の注記は 54 行目） |
| C2 | transcript のパス（cwd の `/._` を `-` にした slug）、JSONL の行の形（`queued_command`、`queue-operation` など）、`agent_session.source = "herdr:claude"` | `server/transcript*.ts` |
| C3 | claude のプロセスを `comm` か `cmdline` の basename が `claude` であることで見分ける。npm で入れた claude は `node` として動くので見つからず、E1 の仕掛けが効かない | `server/account.ts:40-45` |
| C4 | 入力欄の挙動: Ctrl+U を 30 回で下書きを消す、数字キー 1 つでメニューを選ぶ、bracketed paste の中の制御文字は捨てられる | `server/http.ts:27-28` ほか |

C1 から C4 は Go に移しても変わらない（Go 版は同じバイトを送るだけ）。ただし、ほかの人に配ると Claude Code のバージョンがばらつくので、§7.2 で「確かめたバージョン」を README とリリースノートに書く。

### 3.7 Go に移すと変わる言語・実行環境の違い

| # | 違い | 影響する場所 | 対策 |
|---|---|---|---|
| L1 | Go の `mime.TypeByExtension` はホストの `/etc/mime.types` を読むので、ホストによって結果が変わる | 静的ファイル（`server/http.ts:30` に明示の表がある） | 今の表をそのまま Go に持ってくる。`http.FileServer` の自動判定には任せない |
| L2 | `encoding/json` は `< > &` をエスケープする。nil スライスは `null`。map のキーは並べ替えられる（JS は挿入順）。判別共用体（`TimelineItem` の `kind`、WS メッセージの `type`）は Go の型にそのまま書けない | State、WS のメッセージ、WS の重複送信の抑止（直前の JSON と比べる） | `SetEscapeHTML(false)`。配列は空スライスで初期化する。ただし null に意味がある配列（`orchestrators[].agents`: null は「アカウント不明なので全 agent を出す」。`server/state.ts:401`）は nil のまま `null` にする。共用体は種類ごとに struct を分けるか、`MarshalJSON` で出し分ける。§6 の契約テストで確かめる |
| L3 | Go の正規表現（RE2）は先読みを使えない | `server/config.ts:38`（`/^~(?=\/|$)/`） | 文字列の処理で書き直す。テストはそのまま移す |
| L4 | JS の文字列は UTF-16、Go は UTF-8 のバイト。`slice` や `length` の結果が違う | overview の切り詰め、`prompt-identity`、`transcript-normalize` | 日本語と絵文字を含むテスト入力を足す |
| L5 | `localeCompare` での並べ替え | `server/http.ts:348`（profiles の一覧） | ASCII の名前では差が出ない。違いの記録に書く |
| L6 | JS は単一スレッドで、コールバックの順番が決まっている。Go の HTTP ハンドラは並行に動く | herdr-client の状態、`startedProfiles`、`wsClients`、`paneAccountCache`、WS の送信 | 下の「herdr-client と WS の設計」のとおり。テストは `-race` で回す |
| L7 | ntfy のヘッダーの非 ASCII を `?` に置き換える（Node の undici の制約への対処） | `server/notify.ts:58` | Go では制約がないが、通知の文面を変えないため同じ処理を残す |
| L8 | coder/websocket は既定で Origin を確かめ、Host と違えば 403 を返す。`ws` は何も確かめない（`server/http.ts:763`） | `/ws` | 今と同じく確かめない（`AcceptOptions.InsecureSkipVerify: true`。名前に反して TLS とは関係なく、Origin の照合だけを省く設定）。WS もトークンが必須で、ほかのサイトのページはトークンを知らないため。確かめると、Host を書き換えるリバースプロキシ（README の `public_url` の使い方）の後ろで WS がつながらなくなる。違いの記録ではなく、意図した同一の挙動としてコメントに書く |
| L9 | TS 版はソケットから届いた塊ごとに UTF-8 に戻している（`server/herdr-client.ts:80,232`）ので、塊の境目で分かれた多バイト文字が壊れる（CLI は `setEncoding` で避けている。`bin/agentwebctl.ts:336`） | herdr からの応答とイベント | Go 版は `bufio` で行ごとに読むので起きない。TS の不具合を直す違いとして記録する |

**herdr-client と WS の設計（L6 の詳細）**

- herdr-client は、状態（`currentState`、イベントのバッファ、`snapshotDepth`、`preBufferStatus`、`replayedPanes`、購読の対象、`coverageEpoch`）を持つ goroutine を 1 本にする（以下「actor」）。ほかの goroutine はチャネルで頼み、actor は結果を待たない。
- actor は I/O で止まらない。RPC（snapshot、`agent.list`）は別の goroutine で行い、結果を actor に送り返す。購読の接続の読み出しも別の goroutine で、1 行ずつ actor に送る。タイマー（作り直しの 250 ms、配信の 250 ms、`agent.list` の 50 ms、worktree の 30 秒）も actor に届く。
- snapshot の重なりを扱う。名前の変更から呼ばれる `refresh()`（`server/http.ts:661`）と、ack の後の照合（`server/herdr-client.ts:253`）が重なると、深さが 2 になる。`snapshotDepth`、`preBufferStatus` によるリセット、`replayedPanes`（`server/herdr-client.ts:130-141,343-354`）はそのまま移す。これを省いて「snapshot の後にたまったイベントを流すだけ」にすると、snapshot がすでに `done` を示しているペインのイベントが done→done になって通知が消える。
- 外に見せる State は不変の値として `atomic.Pointer` で渡す（`getState` は actor を待たない）。
- WS は接続ごとに送信用の goroutine とバッファを持つ（`ws.send` は溜めて返るが、coder/websocket の `Write` は書き終わるまで止まるため）。バッファがあふれた接続は閉じる（Node は際限なく溜めるので、違いの記録に書く。携帯は再接続して最新の State を受け取る）。
- `broadcastState` は 3 か所から呼ばれる（`onState`、60 秒のタイマー `server/http.ts:273`、アカウントのキャッシュの `onChange` `server/http.ts:272`）。「State から送る JSON を作る → 直前の JSON と比べる → 全接続のバッファに積む」を 1 つのロックの中で行う。分けると古い State が後に届き、重複の抑止（`server/http.ts:961`）のせいで携帯が古いまま止まる。
- `startedProfiles` と `paneAccountCache` は mutex で守る。
- ロックの順番: `broadcastState` は配信のロックを持ったまま `paneAccounts.refresh`（`server/http.ts:955`）を呼び、その中でキャッシュのロックを取る。逆向きに、調べ終わったときの `onChange` は `broadcastState` を呼ぶ。そこで、`onChange` はキャッシュのロックを放してから呼ぶ（JS が `.then` の中で呼んでいるのと同じ。`server/account.ts:116-124`）。逆の順でロックを取ると止まる。

## 4. 段階

すべての段階で、**P5 まで本番は今の Node の bridge のまま**とする。Go のコードはこのリポジトリの中に置き、CI では Node のジョブの横に Go のジョブを足す。

置き場所:

```
go.mod                      module github.com/y011d4/herdr-plugin-agentweb
embed.go                    package agentweb: web/ の配布物（拡張子のパターン）と orchestrator/rules.md を go:embed
cmd/agentwebctl/main.go     サブコマンド: serve（今の server/main.ts）, run, start, stop, status, qr, overview, agent, worktree, orchestrator
internal/bridge/*.go        TS のモジュールと 1 対 1 のファイル（state.go, herdr_client.go, http.go, …）。パッケージは 1 つ
testdata/                   TS と Go で共有するテストデータ、通信とシナリオの記録
tools/fakeherdr/            偽の herdr（P0）
tools/scenario-ts/          TS 版の herdr-client を偽の herdr につなぎ、onState と onAgentStatus を記録する小さな node のスクリプト（P0。P5 の手順 6 で消す）
tools/shadowdiff/           並走の比較（P4）
```

パッケージを 1 つにするのは、TS のモジュールをそのまま写せて、import の循環を考えずに済み、テストから内部の関数を呼べる（今の TS のテスト用の差し替え口と同じ）からである。

### P0 準備と確認（3〜5 日）

1. **試作の回収。** `/tmp/claude-1000/...single-binary-compare.../scratchpad/wscheck/` の偽の herdr を `tools/fakeherdr/` に移す（/tmp は再起動で消える）。最小 Go 版と計測ハーネスは持ってこない（P2 で一から書くほうが早く、計測は比較レポートで済んでいる）。
2. **偽の herdr を育てる。** Unix ソケットで受けたリクエストを全部記録し、決めた応答を返す。加えて、決めた時刻にイベントを送る、snapshot の応答を遅らせる、購読の ack を遅らせるか返さない、接続を切る、ができるようにする。
3. **確認 A（herdr からバイナリを起動する）。** herdr-pluck で、相対パスの起動（`./bin/...`）と `[[build]]` でのスクリプトの実行はすでに動いている。残りを、別の id の使い捨てプラグイン（例: `y011d4.agentweb-gospike`）を一時ディレクトリから `herdr plugin link` して確かめる。動いている bridge と本体のチェックアウトには触らない。
   - pane（`[[panes]]`）でも相対パスで起動できるか。
   - プラグインに渡る環境変数（§3.3 の `HERDR_*`）。
   - `[[build]]` が動くときのカレントディレクトリ、`PATH`、ネットワークに出られるか（GitHub からの使い捨てのインストールで確かめる。リポジトリは空のテスト用のものを使う）。
   - `--ref` で入れたチェックアウトにタグがあるか（この機械の herdr-pluck のチェックアウトには `.git` はあるがタグがない。§8.2 はタグに頼らない作りにしてある）。
4. **凍結を始め、TS 版で記録を取る。** この worktree でビルドした Node の bridge と CLI を、偽の herdr に向けて動かす（`HERDR_SOCKET_PATH=<偽>`、ポート 8392、一時的な state、config、data のディレクトリ）。
   - 操作ごとの通信の記録: §5.3 の操作を REST、WS、CLI で 1 つずつ行い、その操作で herdr に届いたリクエストの列を、HTTP の応答、WS のメッセージ、CLI の出力と一緒に `testdata/wire/<操作>.json` に保存する。CLI の `worktree remove` などは、偽の snapshot の `repo_root` に対して本物の `git fetch` や `git branch -D` を実行するので、使い捨てのリポジトリを指すようにする。
   - herdr-client のシナリオの記録: `tools/scenario-ts/`（`server/herdr-client.ts` を import して `onState` と `onAgentStatus` を記録するスクリプト）で、§5.2 のシナリオ（snapshot 中の状態変化など）を偽の herdr で起こし、`testdata/scenarios/*.json` に保存する。これが Go 版の期待値になる。
   - 「一致」の定義: ペインごとの `agent_status` の遷移の列（from→to）と、最後の State が同じであること。`onState` の回数は、イベントの間隔が 250 ms（配信をまとめる時間）より長い場面でだけ比べる。
5. **herdr-client の設計の試作。** §3.7 の actor を Go で試作し（購読、ack、snapshot の重なり、バッファの再生まで）、手順 4 のシナリオの記録と一致することを確かめる。P2 でそのまま育てる。
6. **テストの対応表。** `node --test --test-reporter=tap` の出力からテスト名を抜き出して `docs/go-migration/test-map.md` を作る（grep ではループで作られる名前を拾えない。例: `server/test/prompt-identity.test.ts:104-105`）。ここで数えたサーバー側のテストの数を N とする（grep では 227、TAP では約 232）。Go 側は `t.Run` に同じ名前を付け、名前の突き合わせで漏れを数える。
7. **CI。** `.github/workflows/ci.yml` に Go のジョブを足す: `npm ci && npm run build:web`（embed するファイルを作るため）→ `go vet` → `go test -race ./...` → `govulncheck`。`package.json` に `build:web`（今の web 用の tsc 2 つ）を足す。既存の Node のジョブはそのまま残す。Dependabot に gomod を足し、`.npmrc` と同じく公開後 7 日の待ちを付ける。`.gitignore` に `bin/agentwebctl` を足す。

完了の条件: 確認 A の答えが出ている。記録が `testdata/` にある。actor の試作がシナリオの記録と一致する。Go の骨組みで CI が通る。

### P1 ソケット・HTTP・WS を使わない部分（6〜8 日）

移すもの: `ndjson`、`state`、`transcript-normalize`、`transcript` のファイルの読み出し（一時ファイルを使うテストを含む）、`overview`（整形）、`prompt-identity`、`notify`（メッセージ作成）、`config`、`agent-lifecycle`（rpc は差し替え可能な関数）、`worktree-resolve`（git の実行も含める。本物の git を動かすテストがあるため。`server/test/worktree-resolve.test.ts:252,325-327`）、`account` の純粋な部分（`parseProcStat`、`accountForConfigDir`、`accountEnv`、時計を差し替えられる `paneAccountCache`）、`auth`（token のファイル）、`pane-profile-store`、`orchestrator`（ディレクトリの書き出しまで）。

- 先に `testdata/vectors/prompt.json`（§6）を作ってから `prompt-identity` のテストを移す。今の TS のテストは `web/src/prompt.ts` を import して両者を突き合わせている（`server/test/prompt-identity.test.ts:4`）ので、その突き合わせを vectors に置き換える。
- サーバー側のテスト N 件（P0 の手順 6）を 1 対 1 で移す（§5.1）。
- TS のテストが読む JSON のテストデータは `testdata/` に移して、移行中は TS と Go が同じファイルを読む。
- 契約のテストデータを作る（§6）。web の型に、サーバーが送っているのに書かれていない `orchestratorPaneId`（`server/http.ts:283`）を足す（web は凍結していない）。

本番: Node のまま。Go はライブラリとテストだけ。
完了の条件: 対応表で N/N（移さないものは理由つきで列挙）。`go test -race` が通る。契約のテスト（§6）が Go と web の両方で通る。

### P2 残りの I/O 層（9〜13 日）

移すもの: `herdr-client`（P0 の試作を完成させる。1 回ごとの RPC、購読の張り替え、再接続の待ち時間の倍増、`agent.list` の取得と epoch、worktree の定期更新）、`transcript` の場所の解決（/proc を使う部分）、`account` の /proc と direnv、`http`（全ルート、enum の検査、本文 64 KB の上限、`ReadHeaderTimeout`）、WS（deflate、64 KB の上限、ping と pong、ペインと transcript の監視タイマー、Origin を確かめない）、静的ファイル（embed、明示の MIME 表、`no-cache`、パスの外に出ない検査）、ntfy、`serve`。

- テスト: P0 のシナリオの記録との一致、§5.2 の結合テスト、操作ごとの通信の記録との一致（§5.3）。
- http.ts（977 行）と herdr-client にはもとからテストがないので、この段階の大半はテストを書く時間になる。

本番: Node のまま。Go の `serve` は偽の herdr 相手に手元で動く。
完了の条件: シナリオの記録と通信の記録の両方に一致する（ただし違いの記録にあるものは除く）。§5.2 と §5.5 のテストが通る。サイズと RSS を測って記録する（判断には使わない）。

### P3 CLI（3〜4 日）

移すもの: `run`（子を起動せずにサーバーを同じプロセスで動かし、自分の PID を pidfile に書く）、`start`（自分自身を `serve` で切り離して起動する）、`stop`、`status`、`qr`、`overview`、`agent get/read/prompt/wait/start`、`worktree remove`、`orchestrator start`。

- pidfile の名前と置き場所（`bridge.pid`、`bridge-run.pid`）は変えない。bridge かどうかの判定は X7 のとおり。
- テスト: Node 版と Go 版の CLI を同じ偽の herdr に向けて、標準出力、標準エラー、終了コード、herdr に送ったリクエストを比べる（overview、拒否の経路、使い方の誤り、`agent get/read/prompt/wait` が herdr の CLI に渡す引数）。アカウントの判定は、P0 の record-wire と同じく、本物の /proc を持つ代わりのプロセス（2 つのアカウントの `sleep`）を偽の herdr が返すことで、許す側と拒否する側の両方を確かめる。CLI は親をたどって最初の `claude` のアカウントを自分のものとするので、Claude Code の中から動かすテストは `setsid` で切り離すか、判定の入口を差し替えられるようにする（P0 で確認）。本物の claude での確認は P4b で行う。

本番: Node のまま。
完了の条件: CLI の比較がすべて一致する（違いの記録にあるものは除く）。

### P4 並走と試用（作業 3〜4 日と、暦日 7 日）

**4a. 読むだけの並走（暦日 3 日）**

1. 並走用の config を作る: 今の `config.json` をコピーし、`notify_url` を消し、`orchestrators` の各項目に今のディレクトリを `dir` として書く。`dir` がある項目は「管理しない」扱いになり（`server/config.ts:68-70`）、Go 版はそこに何も書かない。`managed` は web に送られないので（`server/state.ts:402`）、State は Node 版と同じになる。
2. Go の bridge を `127.0.0.1:8391` で起動する。`HERDR_PLUGIN_CONFIG_DIR` は 1 のコピー、`HERDR_PLUGIN_STATE_DIR` と `XDG_DATA_HOME` は一時ディレクトリ、herdr のソケットは本物。これで Go 版が書くのは一時ディレクトリの token と pane-profiles.json だけになる。携帯の web はフォーカスを呼ばないので、herdr の「見た」の印も変わらない。
3. 比較の道具（`tools/shadowdiff`）を動かす:
   - 両方の `/api/state` を 5 秒ごとに取って比べる。比べないもの: `sinceUnixMs`、`connected` の一時的な変化。違いは、同じ JSON のパス（例: `workspaces[2].worktree.branch`）の違いが 70 秒以上続いたときだけ数える（worktree の更新が最大で約 60 秒、アカウントのキャッシュが 60 秒ごとなので、それより長い）。値ではなくパスで同じかどうかを見る。値で見ると、変わり続ける項目（`completionSeq` など）がずっと遅れていても数えられない。
   - 両方の `/ws` につなぎ、`agent_status` をペインごとの遷移の列（from→to）として比べる。ペインをまたいだ順番は比べない。
   - 数えた違いは、原因と扱い（Go を直す／違いの記録に書く）をつけてファイルに残す。
4. 3 日続けて説明のつかない違いがなければ 4b に進む。Go 版を直して起動し直したら、3 日は数え直す。

**4b. 試用（暦日 4 日）**

1. 携帯から Go 版に入れるよう、tailscale に 2 つ目のポートを足す: `tailscale serve --bg --https=8443 8391`。**`--https` を付けずに `tailscale serve --bg 8391` とすると、443 の割り当て（本番の Node 版）が置き換わる。** 実行の前後に `tailscale serve status` で 443 が 8390 のままであることを確かめる。4b の終わりに 8443 の割り当てを消す。
2. §5.4 の実機確認を、Go 版から使い捨てのタブに対して行う。
3. **CLI のアカウントの判定と worktree の削除を本物で確かめる。** 試験用の orchestrator を、一時的な `XDG_DATA_HOME` と、試験用の項目だけを持つ config で、Go 版の `agentwebctl orchestrator start test` から起動する（許可リストは Go のバイナリを指す）。試験用の項目の `env` には、その一時的な `HERDR_PLUGIN_CONFIG_DIR` と `XDG_DATA_HOME` も入れる（herdr が開くシェルには渡らないので、入れないと orchestrator の中の CLI が本物の config を読む）。その orchestrator に次をさせる:
   - `overview` に自分のアカウントの agent だけが出る。
   - ほかのアカウントのペインへの `agent get` が断られる。
   - 使い捨てのリポジトリで `agent start --worktree` ができる。
   - `agent prompt --wait` で起こされる。
   - マージしていない worktree の `worktree remove` が断られる。
   - マージ済みの worktree の `worktree remove` で、checkout とブランチが両方消える（`bin/agentwebctl.ts:540-548` の経路。P3 では偽の herdr のせいで通らないので、ここで初めて確かめる）。

   終わったら試験用の orchestrator、ワークスペース、リポジトリを片づける。
4. 携帯で Go 版を普段どおり何日か使う（別のトークン、別のポートなので service worker のキャッシュも別になる）。

完了の条件: 4a の 3 日と 4b の 4 日を通して、説明のつかない違いがない。§5.4 と 4b の 3 がすべて通る。§5.5 が通る。

### P5 切り替え（2 日）

1. `herdr-plugin.toml` のコマンドを `["./bin/agentwebctl", …]` にする。`[[build]]` は `scripts/plugin-build.sh` にする。この段階ではまだリリースがないので、スクリプトはソースからビルドするだけ（`npm ci --ignore-scripts && npm run build:web && go build`。Go と npm が要る）にする。リリースから落として検証する形には P6 で置き換える。インストールの道を段階ごとに 1 つにして、確かめるものを増やさないため。P5 から P6 までの間に GitHub から入れる人はまだいない想定である。
2. 手元では `npm ci && npm run build:web && go build -o bin/agentwebctl ./cmd/agentwebctl` でビルドし、`herdr plugin link` をやり直す（manifest が変わったので必須）。本体のチェックアウトにリンクしていることを確かめる。
3. **今の Node の bridge を Node の `stop` で止め、`/healthz` が応答しないことを確かめてから**、Go の bridge を起動する（Go 版は main.js の bridge も見分けられるが、Node 版は Go の bridge を見分けられない。戻すときに Go を止めずに Node の `stop` を使うと、pidfile だけ消えて Go の bridge がポートを握ったまま残る。だから、どちらの向きでも「今動いている側の `stop` で止めて、`/healthz` が応答しないことを確かめる」を守る）。`/healthz`、`/api/state`、携帯での表示、通知を確かめる。凍結はここで終わる。
4. orchestrator: bridge の起動で 3 つの管理ディレクトリの `rules.md` と `settings.json` が新しいパスに書き直されたことを、`grep -rE 'node |dist/bin' ~/.local/share/herdr-agentweb/orchestrators` が何も返さないことで確かめる。動いている orchestrator は再起動する。`dispatcher`（P-3）は利用者に直してもらうか、使っていなければ消す。
5. **戻す練習を一度する。** Go の `stop` で止め、`/healthz` が応答しないことを確かめ、切り替えのコミットを revert し、ビルドしてリンクし直し、Node で起動して orchestrator のパスが戻ることを確かめる。そのあと同じ手順でもう一度 Go に切り替える。
6. 1〜2 週間問題がなければ、`server/*.ts`、`bin/*.ts`、`server/test/` を消す。`package.json` は web のビルドとテストだけにする（`typescript` だけ。`ws` と `@types/ws` は消す）。CLAUDE.md と README を書き直す。`server/test/prompt.test.ts`（中身は web の `prompt.ts` のテスト）は `web/test/` に移す。この期間に新しい機能を足すときは Go 側に入れ、TS 版は戻すためだけに残す。

### P6 配布（4〜6 日）

§8 のとおり。LICENSE（MIT）、リリースの手順、`plugin-build.sh` の置き換え（リリースから落として検証する形。§8.2）、ほかの人向けの README、対応表（OS、CPU、herdr、Claude Code のバージョン）、herdr の schema とのずれを見るテスト（§6）、X5（QR）と X6 の決定。何も入っていない Linux（herdr だけ入れ、Node は入れない）で `herdr plugin install` から携帯の接続までを通す。

## 5. テストの計画

### 5.1 今のテストを Go で再現する

| 区分 | 件数（grep で数えた値。P0 で TAP の出力から数え直す） | 扱い |
|---|---|---|
| `server/test/` のうちサーバーのもの | 227（TAP では約 232。ループで作る名前を含むため） | P1 で Go に 1 対 1 で移す。`t.Run` に TS と同じ名前を付け、対応表で漏れを数える |
| `server/test/prompt.test.ts` | 11 | 中身は `web/src/prompt.ts` のテストなので TS のまま。P5 で `web/test/` に移す |
| `web/test/` | 48 | TS のまま |

移し方:
- 表を使ったテストにまとめるのは、同じ形の `it` が並んでいるときだけにする。名前は 1 件ずつ残す。
- そのまま移せないものは、理由をつけて対応表に書く。例: State の不変性のテストは「入力を書き換えない」テストにする。`pane-profile-store` の `__proto__` のテストは、Go の map では起きないので、「`__proto__` という名前のペインも普通のキーとして扱える」テストにする。
- テスト用の差し替え口（`_setGitRunForTest` など）は、パッケージ内の変数で同じことをする。

### 5.2 今はないテストを足す（P0 で TS 版から期待値を取り、P2・P3 で Go に当てる）

- **herdr-client のシナリオ:** 購読の ack が来ない／遅れる、ack の前の状態変化、snapshot 中に届いたイベントの再生（通知が消えない、二重にならない）、snapshot が 2 つ重なる場合、ペイン集合が変わったときの購読の張り替え（古い購読が先に切れる場合を含む）、再接続の待ち時間、`agent.list` の取得と epoch の確認。
- **HTTP:** `/api` の全ルートについて、トークンなしで 401、enum の誤りで 400（herdr には何も送らない）、本文 64 KB を超えたら拒否。静的ファイルはトークンなしで返り、パスの外に出られない。MIME と `Cache-Control`。
- **WS:** deflate のネゴシエーション、64 KB を超えるメッセージで 1009、ping と pong、ペインの監視の開始と停止、transcript の監視と `reset`、送信が詰まった接続が閉じられ、ほかの接続は止まらないこと、`broadcastState` を並行に呼んでも最後に届くのが最新の State であること。
- **CLI:** P3 の比較。

### 5.3 herdr に送るリクエストを操作ごとに比べる（通信の記録）

CLAUDE.md にある herdr の細かい挙動は、herdr と Claude Code の性質である。移植で変わりうるのは「同じリクエストを送っているか」だけなので、TS 版が送るリクエストを記録し、Go 版が同じものを送ることを確かめる。これが実機での確認を減らせる根拠になる。

記録する操作（P0 で TS 版から取る）:
- 文章の送信: `pane.send_text` で Ctrl+U（0x15）を 30 回、続いて `pane.send_input` に `text` と `keys: ["enter"]` を 1 回（1 行、複数行、大きな貼り付け）
- メニューの選択: 数字 1 文字を `pane.send_text` で送るだけで、Enter や矢印は送らない
- スクロール: SGR のホイール列を `pane.send_text` で送る
- agent の起動: `tab.create` / `pane.split` / `workspace.create` で `env` を渡し、`agent.start`、`agent_pane_busy` での再試行、`agent.get` で `interactive_ready` を待ってから `agent.prompt`
- 停止、名前の変更、clear（新しいペインを起動して古いものを閉じる）、worktree の作成と削除
- 不正な enum: herdr に何も送らずに 400 を返す
- 読み出し: `pane.read` の `source`、`lines`（1000 で頭打ち）、`format`
- CLI: `overview`、`agent start`、`worktree remove`、`orchestrator start`

比べ方:
- その操作が引き起こしたリクエストだけを比べる。裏で動くもの（状態変化の後の `agent.list`、アカウントのキャッシュの `pane.process_info`、作り直しの snapshot、worktree の更新）は除く。
- JSON として読んで比べる（キーの順番と `id` は無視）。
- 自動で付く agent 名の末尾の時刻（`server/agent-lifecycle.ts:83`）は伏せる。
- 再試行と待ちの回数（`server/agent-lifecycle.ts:107-113,135-138,157-164`）は、偽の herdr が同じ回数だけ「まだ」と答えるようにして揃える。
- 送る文字列（`text` の中身）は完全一致を求める。

### 5.4 実機で確かめ直すもの（P4b、使い捨てのタブで）

通信の記録で一致していれば herdr と Claude Code の側の挙動は同じはずなので、実機では本当に効いているかを一度ずつ見るだけにする。手順は `docs/go-migration/live-checks.md` に書き、P4 と、herdr や Claude Code を上げたときに使う。

| 確かめること | やり方 |
|---|---|
| 送信が 1 回で確定する（1 行、複数行、大きな貼り付け） | `herdr tab create` → claude を起動 → Go の bridge に POST → transcript に user の行が 1 つ出る → タブを閉じる |
| 手で打った下書きが Ctrl+U で消え、送る文と混ざらない | 下書きを `pane.send_text` で入れてから、bridge 経由で送る |
| 数字キーで AskUserQuestion の選択肢が選ばれて確定する | claude に AskUserQuestion を出させ、bridge の answer 経路で "2" を送る |
| 信頼の確認で `blocked` になり、最初の依頼が保留される | 信頼していないディレクトリで起動する |
| 1 回の接続で 1 回のリクエスト、イベント名の混在、`result.snapshot` | 本物の herdr につないだ Go の bridge のログで確かめる |
| 画面全体を使うペインのスクロール | 携帯（または headless Chrome の CDP で touch を再現。毎回新しいプロファイル）で、古い行へ動くことと、入力欄が汚れないことを確かめる |
| `completion_seq` と `state_change_seq` が web に届く | 完了したペインを携帯で開き、見たことが記録される |
| worktree のブランチ表示 | worktree のワークスペースで `git checkout` して、60 秒ほどで表示が変わる（キャッシュの 30 秒と、更新の間隔の 30 秒を足した長さ） |
| 多バイト文字（L9） | 日本語を含む長い画面を `pane.read` で読み、文字化けしない |

### 5.5 セキュリティの不変条件の確認

- `/api` と `/ws` は全部トークンが要る（全ルートを表で回すテスト）。`/healthz` と静的ファイルは意図して公開している（`server/http.ts:292-302`）。トークンの比較は `subtle.ConstantTimeCompare` で、長さが違えば先に拒否する。
- action の標準出力にトークンを出さない（`start`、`status`、`stop` の出力をテストで調べる）。
- 既定の待ち受けは loopback だけ。
- 静的ファイルがパスの外に出ない。
- transcript の読み出しが projects のルートの中に限られる（シンボリックリンクを含む）。
- アカウントが違う、または判定できないときは拒否する（overview、agent、worktree、clear）。許す側は P4b の 3 で確かめる。
- `launch_profiles` の許可リストにないものは起動しない。

### 5.6 観測

- 起動時に、バージョン、ポート、接続 URL（今と同じく run のペインと 0600 の bridge.log にだけ）を出す。herdr につながったら、herdr のバージョンと protocol を出し、確かめた範囲（今は protocol 22）の外なら警告を出す（§7.1）。
- herdr の接続と切断、RPC のエラー（今と同じく、識別子だけを出し、本文は出さない）、ntfy の失敗（1 回だけ）を記録する。
- 並走中は比較の道具が違いをファイルに残す。
- `/healthz` の形（`{"ok":true,"herdrConnected":true}`）は変えない。

## 6. web と Go の型を揃える

### 案の比較

| 案 | 内容 | 良い点 | 悪い点 |
|---|---|---|---|
| T1. Go の struct から TS の型を作る | `api.go` を正にして TS を生成する | 正が一つ | 判別共用体（`TimelineItem` の 5 種、WS メッセージの 6 種）と文字列の列挙（`AgentStatus`）を Go の struct から出すには、型ごとに追加の指定が要る。140 行の型のために生成器と CI の差分検査を持つことになる |
| T2. JSON Schema を手で書き、Go と TS の両方を作る | 契約を言語から切り離す | API を第三者に公開するなら便利 | schema を書く手間と生成器が 2 つ。herdr の schema は `#/schemas/<name>/$defs/...` という独自の形で、一般の生成器が扱いにくい |
| T3'. TS の型は手で書いたまま、Go が出した JSON を TS の型で検査する（**採用**） | 下のとおり | 新しい道具が要らない。共用体も null も TS の型の書き方のままで検査できる | 型を変えるときは Go と TS の両方を直す（検査が落ちるので気づく） |

### T3' の進め方

- **契約のテストデータ:** Go のテストが、代表的な State と、WS のメッセージ 6 種、`TimelineItem` の 5 種を JSON で `testdata/contract/*.json` に書き出す（`-update` で作り直し、ふだんは一致を確かめる）。null に意味がある配列（`agents`）は null の場合と配列の場合の両方を入れる。REST の応答は web に名前のついた型がない（transcript の応答の型は `web/src/app.ts:1489` の中にあり export されていない）ので、検査の対象にしない。
- **TS での検査:** 同じ Go のテストが、そのデータを `export const state: AppState = {…};` のような型注釈つきのオブジェクトリテラルにした `web/test/contract.gen.ts` も書き出す。今の tsconfig は `web/test` を型検査しない（`tsconfig.web.json` は `rootDir` が `web/src` で 4 ファイルだけを対象にしている。`node --test` は型を取り除くだけ）。そこで `noEmit` の `tsconfig.contract.json` を足し、npm のスクリプトから `tsc -p tsconfig.contract.json` を CI の web のジョブで回す。これで、足りない項目、余分な項目（オブジェクトリテラルの余分なプロパティの検査）、判別共用体（`kind`、`type`）と `AgentStatus` の誤り、null と配列の取り違えが型エラーになる。`agent_status` の `from` と `to` は web の型では `string` なので、値までは検査されない。
- 最初に回すと、サーバーが送っている `orchestratorPaneId`（`server/http.ts:283`）が web の `AppState` にないことで落ちる。P1 で web の型に足す。
- **web のテスト:** 描画の関数（`web/src/transcript.ts` など）に契約のテストデータを読ませて動くことを確かめる。
- 生成したファイルはコミットし、CI で作り直して差分がないことを確かめる。

### 両方の言語にある同じ処理

型のほかに、同じ処理が 2 つの言語に分かれる箇所がある。

- `parsePrompt`: `server/prompt-identity.ts:44` は `web/src/prompt.ts` の写しである。
- 会話の絞り込み: `server/overview.ts:51` は `web/src/transcript.ts` と同じ規則を使う。

どちらも `testdata/vectors/*.json` に入力と期待値を置き、Go と TS の両方のテストで同じものを回す。片方だけ直すとテストが落ちる。

### herdr との間の型

herdr の schema（protocol 22 で、リクエストの定義が 118、応答が 72、イベントが 26）から Go の型を全部作るのはやめる。使うのは 19 の RPC と 21 のイベントだけで、生成されたコードの大半は使わず、独自の `$ref` の形も扱いにくい。

- 使う RPC のパラメータと結果、使うイベントだけを Go の struct に手で書く。
- P6 で、`herdr api schema --json` の出力を `testdata/herdr-schema/protocol-22.json` に保存し、手で書いた struct のフィールドが schema の対応する定義（リクエスト、応答、イベントの 3 つ）にあることを確かめるテストを足す。ほかの人の herdr の版に合わせるときに使う。切り替えまでは、通信の記録と実機確認で足りる。

## 7. 環境の違いへの対応と、対応する OS・CPU

### 7.1 herdr のバージョン

- 接続したら snapshot の `protocol` と `version` をログと `status` の出力に出し、確かめた範囲の外なら警告する。機能ごとに断る仕組みは作らない（確かめたのが protocol 22 だけで、何を断るべきか決める材料がないため。切り替えの前に挙動を変えないためでもある）。
- manifest の `min_herdr_version` は、P6 で確かめた最も古い版にする（今わかっているのは 0.9.5。`completion_seq` は 0.9 系でしか確かめていない）。
- README とリリースノートに「確かめた herdr のバージョン」を書く。

### 7.2 Claude Code のバージョン

- deny 一覧は今のとおり Go のコードの中に置き、「確かめた Claude Code のバージョン」を一緒に書く。
- Claude Code を上げたときに測り直す手順（orchestrator のディレクトリで `tree`、`du`、`fd`、`lsof`、ディレクトリの外の `cat` が断られ、`agentwebctl` は通ること）を `live-checks.md` に書く。自動では回さない（Claude を動かすので費用がかかる）。
- C3（npm で入れた claude）は README の「既知の制限」に書く。

### 7.3 OS と CPU

| 時期 | linux/amd64 | linux/arm64 | darwin/arm64 | darwin/amd64 |
|---|---|---|---|---|
| P5（切り替え） | 対応。実機で確認 | ビルドだけ | ビルドだけ | ビルドだけ |
| P6（最初の公開） | 対応 | 対応。GitHub の arm64 ランナーで単体テストと偽の herdr での結合テスト（実機の herdr では確かめていない、と書く） | 試験的。macOS ランナーで単体テスト。アカウントの機能は拒否する | 試験的（同じ） |
| 後日 | | | Mac で確かめる人が出たら、sysctl（`kern.procargs2`、`kinfo_proc`。`golang.org/x/sys/unix` が要る）で E1 と E2 を作り、「対応」にする | 同じ |

- `CGO_ENABLED=0` で静的にリンクするので、glibc にも musl にも依存しない。
- Windows は herdr が対応していないので対象にしない。

## 8. 配布

### 8.1 案の比較

| 案 | 内容 | 判断 |
|---|---|---|
| D1. `[[build]]` で `go build` する | 使う人に Go と（web のビルドのために）Node が要る | 配る方法にはしない。リリースを作る前の P5 から P6 の間だけ使う（P5 の手順 1） |
| D2. `[[build]]` のスクリプトがリリースからバイナリを落として検証する | 使う人に要るのは `sh`、`curl` か `wget`、`sha256sum` か `shasum` だけ | **採用**。herdr-pluck と同じ形に、検証を足したもの |
| D3. バイナリをリポジトリにコミットする | 何も要らない | 採らない。リリースのたびに 4 × 7 MB が git の履歴に残る |

### 8.2 D2 の流れ

1. `herdr plugin install y011d4/herdr-plugin-agentweb --ref vX.Y.Z` で、herdr がリポジトリをそのタグで取ってくる。
2. `[[build]]` が `scripts/plugin-build.sh` を動かす。`herdr-plugin.toml` の `version` と `uname -s`・`uname -m` から、リリースの `agentwebctl_<ver>_<os>_<arch>`（圧縮しないバイナリ）を落とす。落とすかどうかはタグでは決めない（herdr のチェックアウトにはタグがないことがある。§4 P0 の確認 A）。**リポジトリにコミットされた `release/checksums.txt` に、その版とターゲットの行があるとき**に落とす。行がなければ（版を上げる途中のコミットなど）、理由を出して失敗する。
3. 落としたファイルの sha256 を `release/checksums.txt` と照らし合わせ、合えば `bin/agentwebctl` に置く。合わなければ何も置かずに失敗する。ソースからのビルドに切り替えることはしない（合わないのは改ざんか壊れたファイルなので、別の道で通してはいけない）。
4. herdr の action と pane が `./bin/agentwebctl` を起動する。

信頼の起点: herdr は取ってきたリポジトリのスクリプトをそのまま実行するので、使う人はすでにそのタグのリポジトリを信頼している。チェックサムをリリースではなくリポジトリに置けば、バイナリへの信頼もそのタグへの信頼と同じになる（リリースのファイルだけを差し替えられても通らない）。

### 8.3 リリースの手順（手元でビルドし、そのまま上げる）

1. `make release VERSION=x.y.z` を手元で実行する。これは次を行う:
   - その時点のコミットから一時的な `git worktree` を作り、そこで `npm ci && npm run build:web` を行う（gitignore された古い web のビルドの残りを入れないため）。
   - `GOTOOLCHAIN=go1.27.x`（`go.mod` の `toolchain` 行は最低の版を決めるだけで、手元に新しい Go があればそちらが使われるため）、`CGO_ENABLED=0`、`GOAMD64=v1`、`GOARM64=v8.0`、`-trimpath -buildvcs=false -ldflags "-X main.version=x.y.z"` で 4 つのバイナリを作る。
   - 4 つの sha256 を `release/checksums.txt` に書く。
2. `herdr-plugin.toml` の `version` と `release/checksums.txt` をコミットし、そのコミットにタグを付けて push する。
3. `gh release create vX.Y.Z` で、手順 1 のバイナリと `checksums.txt` をそのまま上げる。Release を作るのは手元なので、CI に書き込みの権限は要らない。
4. CI でビルドし直して同じバイナリになるかを確かめる仕組みは、今は作らない。誰かがその確認を必要としたら足す（手順 1 の固定があれば、同じバイナリになるはずである）。

### 8.4 ほかの人が使えるようにするために要ること

- `LICENSE`（MIT）を置く。
- README（英語と日本語）を書き直す:
  - 要るもの: herdr（確かめた版）、Linux（amd64、arm64）、macOS は試験的。任意で git 2.31 以上（ブランチ表示と worktree）、direnv（ディレクトリごとのアカウント）、gh、tailscale、qrencode（X5 の決定による）。Node は要らない。
  - インストール。更新は「`stop` → `herdr plugin update` → `start`」の順にする（更新でインストール先が変わると、古いバイナリで動く bridge を新しい方が止められないことがあるため）。アンインストールでは、state、config、data のディレクトリの場所を書く。`herdr plugin uninstall` はインストール先のディレクトリを残す（P0 で確認）ので、その消し方も書く。
  - 携帯からつなぐ方法、設定の一覧、セキュリティの考え方、対応表、既知の制限（macOS のアカウント機能、npm で入れた claude、`~/.config/claude/<name>` の置き方の前提）。
  - 困ったとき: `/healthz`、bridge.log の場所、herdr の protocol の警告。
- `status` の出力に、herdr のバージョンと protocol、見つかった任意のコマンド（git、direnv、gh、tailscale）を足す（トークンは出さない）。新しいサブコマンドは作らない。
- 依存の方針を CLAUDE.md に書き直す: 実行時は coder/websocket（と、P6 で決めれば rsc.io/qr）。開発時は Node と TypeScript（web のビルドと web のテストだけ）。

## 9. リスクと、途中でやめる判断の基準

### 9.1 リスク

| # | リスク | 起きやすさ | 影響 | 対策 |
|---|---|---|---|---|
| R1 | herdr-client の再接続とバッファ処理を移し損ね、通知を取りこぼすか二重に出す | 中 | 高 | §3.7 の actor の設計、P0 で TS 版から取ったシナリオの記録、P0 の試作、並走での `agent_status` の比較 |
| R2 | JSON の形がずれて web が壊れる（null と配列、共用体、エスケープ） | 中 | 高 | §6 の契約のテストデータと `tsc` での検査、並走での `/api/state` の比較 |
| R3 | 切り替えや戻しで、orchestrator の許可パスがずれる、または古い bridge がポートを握ったまま残る | 中 | 中 | X7 の判定、P5 の手順 3〜5（止めて確かめてから切り替える、grep で確かめる、戻す練習） |
| R4 | 凍結が長く（週 5 日で 5〜7 週間）、急ぎの機能を足せない | 中 | 中 | K5。凍結の対象はサーバーと CLI だけで、web は直せる |
| R5 | ほかの人の herdr の版が違い、接続が切られるか、`agent.start` が失敗する | 中 | 中 | protocol の警告、P6 の schema のずれのテスト、README の対応表 |
| R6 | macOS の利用者が、アカウントの機能が動かないことに驚く | 高 | 低 | 「試験的」と、拒否の理由を出すメッセージ |
| R7 | 同じ処理が 2 つの言語に分かれてずれる（parsePrompt、会話の絞り込み） | 中 | 中 | 共有のテスト入力（§6） |
| R8 | 並行処理のデータ競合（JS では起きなかった種類のバグ） | 中 | 中 | §3.7 の設計、`-race` |
| R9 | Claude Code の更新で deny 一覧や transcript の形が変わる | 中 | 中 | 移植とは別の問題。測り直しの手順と「確かめた版」の記載 |
| R10 | 並走や試用が本番を乱す（通知の二重送信、orchestrator の設定の書き換え、tailscale の 443 の置き換え） | 低 | 中 | P4a の 1〜2 の config の分け方、P4b の 1 の確認 |

### 9.2 事前の失敗想定（3 つ）

1. **切り替えの翌日、携帯に一部の完了通知が来ない。** 原因の候補: snapshot 中に届いたイベントの再生を移し損ねた。防ぐもの: P0 のシナリオの記録と actor の試作、並走での `agent_status` の比較。起きたら: P5 の手順 5 で戻し、記録から再現するシナリオを足す。
2. **切り替えた後、orchestrator が `agentwebctl` を実行するたびに断られる。** 原因の候補: settings.json に古い node のパスが残っている（bridge が起動の前に書き換えなかった、`dispatcher` を使っていた、動いていた orchestrator が古い設定を読んだまま）。防ぐもの: P4b の 3（Go のバイナリを指す許可リストで本物の orchestrator を動かす）と P5 の手順 4。起きたら: orchestrator を再起動する。それでもだめなら戻す。
3. **公開後、別の版の herdr を使う人が「agent を起動できない」と報告する。** 原因の候補: protocol の違いで `agent.start` の形や enum が違う。防ぐもの: 起動時の protocol の警告、README の対応表、P6 の schema のずれのテスト。起きたら: その人の `herdr api schema --json` をもらい、ずれのテストで違いを特定する。

### 9.3 途中でやめる判断の基準

| # | いつ | 基準 | やめたら |
|---|---|---|---|
| K1 | P0 の終わり | 確認 A で、herdr からバイナリを起動する方法がどれも動かない。または、actor の試作が P0 のシナリオの記録に合わず、合わせる方法の見通しが立たない | 計画を止めて凍結を解く。配れないか、一番危ない部分を移せないなら、Go にする意味がない。Node のまま、文書と LICENSE だけ整える |
| K2 | P1 の終わり | P1 に 16 作業日（見積もりの 2 倍）以上かかった。または、ここからの見積もりで全体が 60 作業日を超える | 続けるか利用者が決める。やめるなら Go のコードは別ブランチに残して凍結を解く |
| K3 | P2 の終わり | シナリオか通信の記録との説明のつかない違いが、直しても 2 回続けて 5 件以上残る | P4 に進まない。herdr-client か http の設計を見直す |
| K4 | P4 | P4 を始めてから 14 日で完了の条件に届かない。またはセキュリティの不変条件の退行が 1 件でもある | 切り替えない。原因を直すか、やめる |
| K5 | 凍結中いつでも | 急ぎの機能が必要になり、残りの移行が 2 週間を超える | 移行を一時止めて凍結を解き、TS で機能を入れる。再開するときは P0 の記録を取り直し、Go 側を追いつかせる |

## 10. ADR

- **決めたこと:** bridge サーバーと agentwebctl を Go の単一バイナリに移す。herdr-client の設計を P0 で試してから下の層から順に移し、別ポートで読むだけの並走と、使い捨てのタブでの試用で比べてから、manifest を一度に切り替える。web は TS のまま embed する。型は TS を手で書いたままにし、Go が出した JSON を TS の型で検査する。配布は、手元でビルドしたバイナリをリリースに上げ、リポジトリにコミットしたチェックサムで `[[build]]` のスクリプトが検証する。
- **判断の軸:** 挙動を変えないこと、Node なしで配れること、移行中のコスト。
- **検討した案:** 一括書き直し（すぐ切り替える案を含む）、機能ごとの置き換え（転送）、CLI を先に移す。型は Go から TS を生成する案と、JSON Schema から両方を作る案。配布は install 時の `go build`（予備としてだけ残す）と、バイナリのコミット。リリースは CI で作り直したものを上げる案（同じバイナリが作れることが前提になり、壊れやすい）。Bun（サイズのため利用者が除外）。
- **選んだ理由:** 本番を止めずに、同じであることを証拠で示してから切り替えられ、戻すのも簡単だから。並走は config を分けるだけで済み、型の検査も新しい道具が要らない。
- **結果:** 週 5 日の作業で 5〜7 週間の凍結。Go と TS の 2 つの言語を保守する（web の開発には Node が残る）。CLAUDE.md の「herdr の挙動」の記録は、通信の記録のテストとして残る。
- **後でやること:** macOS を sysctl で「対応」にする（Mac で確かめる人が必要）。herdr の新しい protocol への追従。Claude Code の更新に合わせた deny 一覧の測り直し。QR をバイナリの中で作るか（X5）。`herdr` の呼び方を揃える（X6）。

## 11. 承認のときに決めること

1. 凍結の長さ（週 5 日の作業で 5〜7 週間）を受け入れるか。受け入れられない場合は、K5 の一時停止を前提にするか、A'（P3 の後すぐに切り替える。§2）を選ぶ。推奨: 受け入れる。
2. 計画の承認後、どこまで進めて一度止めるか。推奨: P0 の終わり（K1 の判断）で一度止めて、結果を見てから P1 に進む。

## 12. 改訂の記録

改訂 2（Architect: SOUND-WITH-CHANGES、Critic: ITERATE を受けて）:
- herdr-client と WS の並行処理の設計を明記した（actor は I/O で止まらない、snapshot の重なり、WS の接続ごとの送信、`broadcastState` のロック）。P0 で TS 版からシナリオを記録し、actor を試作する（K1 に入れた）。
- 並走は `AGENTWEB_SHADOW` をやめ、config を分けるだけにした。読むだけの 3 日と試用の 4 日に分け、違いの数え方（70 秒続いたものだけ、ペインごとの遷移）、tailscale の 2 つ目のポート、Go の CLI のアカウントの判定を本物の orchestrator で確かめる手順を足した。
- 型は T1（Go から生成）をやめ、T3'（手書きの TS の型で Go の JSON を検査）にした。null に意味がある配列（`agents`）を明記した。
- P1 の範囲を、ファイルの読み書きだけをする部分まで広げた（227 件を P1 で移しきれるように）。
- bridge の判定を `agentwebctl serve|run` にし、戻しと更新の手順を「止めて確かめてから」にした。
- 凍結の期間を P0 の手順 4 から P5 の手順 3 までと定め、長さを 6〜8 週間に直した。
- リリースは圧縮しないバイナリのチェックサムにし、`GOTOOLCHAIN` などを固定し、一時的な worktree でビルドする。手元でビルドしたものを上げ、CI のビルドし直しは報告だけにした。
- protocol ごとに機能を断る仕組み、QR の内蔵、schema のずれのテストは、切り替えの後（P6）に回した。
- TS 版の不具合を直す違い（塊ごとの UTF-8 の復号）と、意図して揃える挙動（WS の Origin を確かめない）、プロキシの環境変数、HTTP のタイムアウト、外部コマンドの打ち切り、環境変数の一覧を §3 に足した。
- P5 の `[[build]]` は、リリースがないときにソースからビルドする予備を持つようにした。CI の Go のジョブは先に web をビルドする。
- 先例として herdr-pluck を挙げ、確認 A を小さくした。
- 数値を直した（サーバーは約 4,100 行、RPC は 19 種類、schema のイベントの定義は 26）。

改訂 3（2 回目。Architect: SOUND-WITH-CHANGES、Critic: APPROVE。細かい指摘を反映）:
- T3' の検査に専用の `tsconfig.contract.json` を足し、対象を State、WS のメッセージ、`TimelineItem` に絞った。web の型に `orchestratorPaneId` を足す。
- `paneAccountCache` の `onChange` はキャッシュのロックを放してから呼ぶ、というロックの順番を §3.7 に書いた。WS の詰まった接続を閉じることを違いの記録に入れた。
- マージ済みの worktree を消す経路（checkout とブランチの削除）を P4b で確かめる。CLI の記録は使い捨てのリポジトリに向ける。
- 並走の違いは JSON のパスで同じかどうかを見る。ブランチ表示の確認は 60 秒ほどにした。
- bridge の判定は、Linux では `/proc/<pid>/cmdline` で見る（パスに空白があっても崩れない）。
- テストの数は P0 で TAP から数えた N にした（grep の 227 に対して TAP では約 232）。worktree-resolve は本物の git を動かすテストがあるので、git の実行ごと P1 に入れた。
- P0 のシナリオの記録の道具（`tools/scenario-ts/`）と「一致」の定義を書いた。
- P4b は携帯から普段どおり使うので、原則 1 をそれに合わせた。試験用の orchestrator の `env` に一時的な config と data のディレクトリを入れる。
- P5 の `[[build]]` はソースからのビルドだけにし、P6 でリリースから落として検証する形に置き換える。落とすかどうかはタグではなく `release/checksums.txt` の行で決め、チェックサムが合わなければソースのビルドに逃げずに失敗する。CI でのビルドし直しの確認はやめた。
- web の embed はパターンで指定する（web は凍結していないので、ファイルが増えても配れるように）。
- 凍結の長さを「作業日で 21〜29 日と P4 の暦日 7 日。週 5 日の作業で 5〜7 週間」に直した。
