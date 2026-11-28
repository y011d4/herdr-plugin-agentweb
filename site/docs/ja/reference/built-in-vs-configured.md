# yoicks が決めること、あなたが決めること

yoicks のふるまいは、それぞれ [5 つの出どころ](#sources)のどこかで決まります。
思っていなかったことが起きたとき、このページを見れば、それがどこで決まっていて、どこを変えればよいか (あるいは変えられないこと) がわかります。

## ファイルの場所 {#files}

yoicks が読み書きするファイルとディレクトリを、場所ごとに並べます。
各行には、誰が書くかと、それが何かを書いています。
書くのは **yoicks** (ブリッジか `yoicks` のコマンド)、**あなた**、**Claude Code**、またはほかの道具です。
*書き直し* とあるものは、ブリッジの起動時と、その orchestrator を起動するたびに yoicks が書き直すので、編集しても消えます。

パスは既定のものです。
`~/.local/share` は `$XDG_DATA_HOME` があればそれ、`~/.local/state` は `$XDG_STATE_HOME`、タイマーの `~/.config` は `$XDG_CONFIG_HOME` があればそれです。
herdr のプラグインのコマンドの中では、状態のディレクトリは `$HERDR_PLUGIN_STATE_DIR`、設定のディレクトリは `$HERDR_PLUGIN_CONFIG_DIR` です。
ソケットの場所は `$HERDR_SOCKET_PATH` で変わります。

### herdr のディレクトリ: 設定とバイナリ {#herdr-dir}

```text
~/.config/herdr/
├── herdr.sock           herdr: ソケット。ブリッジはここから入る
└── plugins/
    ├── config/y011d4.yoicks/
    │   └── config.json  あなた: プラグインの設定
    └── github-installations/y011d4.yoicks-…/
        └── bin/yoicks   herdr (インストールと更新で): バイナリ
```

設定のディレクトリは `herdr plugin config-dir y011d4.yoicks` で表示できます。
[`config.json`](./config) を編集したらブリッジを再起動します。
リンクしたプラグインは、代わりに[そのチェックアウト](#checkout)の `bin/yoicks` を動かします。

### orchestrator のディレクトリ {#orchestrator-dirs}

```text
~/.local/share/herdr-yoicks/orchestrators/
└── <name>/                      Home ごとに 1 つ (無ければ default)
    ├── CLAUDE.md                yoicks、書き直し: 入口のファイル
    ├── rules.md                 yoicks、書き直し: 同梱の規則
    ├── local.md                 あなた: この Home のためのあなたの規則
    └── .claude/
        ├── settings.json        yoicks、書き直し: 権限
        └── settings.local.json  あなた: それに足すもの
```

`CLAUDE.md` は `rules.md` (同梱の規則のうち、その mode の部分) を、続けて `local.md` を読み込みます。
`.claude/settings.json` は、TUI の orchestrator が実行できるものです。
`local.md` は yoicks が一度だけ (コメントだけを書いて) 作り、そのあとは書きません。
それぞれの orchestrator はこのディレクトリで動きます。
TUI の orchestrator は、これでほかのエージェントと見分けます。

### プラグインの状態 {#state-dir}

```text
~/.local/state/herdr/plugins/y011d4.yoicks/
├── token                       yoicks: アクセストークン
├── bridge.log                  yoicks: ブリッジのログ
├── bridge.pid, bridge-run.pid  yoicks: ブリッジのプロセス ID
├── pane-profiles.json          yoicks: エージェントの起動プロファイル
├── agent-purposes.json         yoicks: ワーカーの目的の行
├── todos/<name>.json           yoicks: ヘッドレスのやることリスト
├── headless/<name>.json        yoicks: セッション、モデル、使用量
├── headless/<name>.mcp.json    yoicks: その MCP の設定
└── canary.json                 claude-canary.sh: 最後の確認
```

どれも編集するものではありません。
`token` を消すと作り直します ([セキュリティモデル](./security))。

### Claude Code のアカウント {#claude-accounts}

```text
~/.claude/                      既定 (CLAUDE_CONFIG_DIR 未設定)
├── settings.json               あなた: アカウントの設定
└── projects/…/<session>.jsonl  Claude Code: トランスクリプト
~/.claude.json                  Claude Code: 既定のログイン
~/.config/claude/work/          別のアカウント: CLAUDE_CONFIG_DIR
├── settings.json               あなた
├── projects/…                  Claude Code
└── .claude.json                Claude Code
```

`work` は例です。
どの `CLAUDE_CONFIG_DIR` もアカウントで、yoicks はアカウントを `projects/` ディレクトリで見分けます。
yoicks はここのファイルを何も書きません。
ヘッドレスを起動する前には、API 課金を断るために、アカウントの `settings.json`、orchestrator のディレクトリの 2 つ、管理された設定 (`/etc/claude-code/managed-settings.json`) を読みます。

### あなたのリポジトリ {#repositories}

```text
~/src/work/                          リポジトリを置くディレクトリ (例)
├── .envrc                           あなた (direnv): アカウント
├── <repo>/                          ワーカーが動くリポジトリ
│   ├── .claude/settings.json        あなた: ワーカーの権限
│   ├── .claude/settings.local.json  あなた: 同じもので手元だけ
│   └── .git/hooks/                  あなた (yoicks は入れない)
└── <repo>-wt-<branch>/              yoicks (herdr 経由): worktree
```

`.envrc` は、この下すべてのアカウントを決めます。
たとえば `export CLAUDE_CONFIG_DIR=$HOME/.config/claude/work` です。
herdr は worktree に環境変数を渡せないので、新しい worktree のアカウントはこれで決まります。
`<branch>` の、英数字と `.`、`_`、`-` 以外の文字は `-` になります。

### systemd {#systemd}

```text
~/.config/systemd/user/
├── yoicks-claude-canary.service   確認を実行する
└── yoicks-claude-canary.timer     1 時間ごと (あなたが有効にしたら)
```

どちらも `sh scripts/claude-canary.sh install` が書きます。タイマーを有効にするまでは何も動きません。

### yoicks のチェックアウト {#checkout}

チェックアウトをプラグインとしてリンクしたときと、yoicks で作業するときだけのものです。

```text
herdr-yoicks/
├── bin/yoicks                plugin-build.sh: ソースからビルド
├── orchestrator/rules.md     yoicks: 同梱の規則
├── scripts/claude-canary.sh  yoicks: Claude Code の確認
├── .claude/settings.json     yoicks: redeploy.sh main を許可
└── .git/hooks/               あなた (リポジトリには含まれない)
```

## 5 つの出どころ {#sources}

| 出どころ | 中身 | 誰が編集するか |
|---|---|---|
| **組み込み** | [`yoicks` のバイナリ](#herdr-dir)と、それに同梱の orchestrator の規則 ([`orchestrator/rules.md`](https://github.com/y011d4/herdr-yoicks/blob/main/orchestrator/rules.md)) | 誰も編集しません。yoicks の更新で変わります |
| **`config.json`** | プラグインの[設定](./config) ([場所](#herdr-dir)) | あなた |
| **orchestrator のファイル** | [そのディレクトリ](#orchestrator-dirs) | `CLAUDE.md`、`rules.md`、`.claude/settings.json` は yoicks が書き直します。`local.md` と `.claude/settings.local.json` はあなたのものです |
| **Claude Code の設定** | [アカウントのもの](#claude-accounts)、[リポジトリのもの](#repositories)、orchestrator のもの | yoicks が書くのは orchestrator の `.claude/settings.json` だけです |
| **yoicks の外** | herdr、git、direnv、`gh`、systemd、GitHub、ネットワークの経路 | あなたが、それぞれの道具で |

## Home と orchestrator {#orchestrators}

| ふるまい | 決めるもの | 場所 |
|---|---|---|
| どの Home があるか、その名前、表示名、並び順 | `config.json` | `orchestrators[].name`、`.label` (無ければ `default` が 1 つ) |
| それぞれが動く Claude アカウント | `config.json` | `orchestrators[].env.CLAUDE_CONFIG_DIR`。無ければ既定のアカウント (TUI なら、そのディレクトリの上の direnv の `.envrc` が指定するもの) |
| herdr のペインで動くか、ヘッドレスか | `config.json` | `orchestrators[].mode`。`"headless"`、無ければペイン |
| orchestrator が動かすプログラム | 組み込み | `launch_profiles` に関係なく、いつもただの `claude` |
| 仕事の渡し方、ワーカーの追い方、報告、片付け | 組み込み | その [`rules.md`](#orchestrator-dirs) |
| どのリポジトリを受け持つか、答える言語、いつデプロイしてよいか… | あなた | その [`local.md`](#orchestrator-dirs) |
| TUI の orchestrator が実行できるもの | yoicks が書く | その [`.claude/settings.json`](#orchestrator-dirs)。実行できるコマンドは `yoicks overview`、`yoicks agent …`、`yoicks worktree remove …` だけで (`dontAsk`: ほかは聞かずに断ります)、編集は拒否し、Claude Code の読み取り専用のツールは、そのディレクトリの中では今も使えます。あなたが足すものはその `settings.local.json` へ |
| ヘッドレスの orchestrator が実行できるもの | 組み込み | ブリッジが渡すコマンドライン。AskUserQuestion と yoicks のツールだけで、シェルはありません。ディレクトリの設定で足すことはできません |
| 自分のアカウントのエージェントだけを見て動かすこと | 組み込み | 無効にはできません ([何に触れられるか](../guide/orchestrators#what-it-can-reach)) |

## ワーカー {#workers}

| ふるまい | 決めるもの | 場所 |
|---|---|---|
| orchestrator がワーカーを動かすコマンド | 組み込み | [`yoicks` のコマンド](./cli) (TUI)。ヘッドレスでは同じものがツールになり、`todo` が加わります |
| ワーカーを起動できるプログラム | `config.json` | `launch_profiles`。組み込みの `claude`、`codex`、`opencode` に重ねます |
| いつどのプロファイルを使うか (調べもの用の安いもの、など) | あなた | `local.md` |
| 新しい worktree の置き場所 | 組み込み | [リポジトリの隣](#repositories) |
| ワーカーの Claude アカウント | 組み込み | orchestrator と同じ。そのディレクトリの direnv が別のアカウントになる場所では断ります (`CLAUDE_CONFIG_DIR` の無いディレクトリは既定のアカウント)。新しい worktree では、direnv で確かめられない場所も断ります |
| 新しい worktree のアカウント | yoicks の外 | リポジトリの上にある [`.envrc`](#repositories) |
| ワーカー自身の権限と確認 | Claude Code の設定 | ふつうの Claude Code と同じく、[そのアカウント](#claude-accounts)と[リポジトリ](#repositories)の設定です。yoicks は何も書きません。確認にはそのペインであなたが答えます |
| ワーカーの名前の下の目的の行 | orchestrator | ヘッドレスの `agent_start` の `purpose`。同梱の規則が付けるよう求めています |

## orchestrator を起こすもの {#wakes}

**ヘッドレス**の orchestrator はブリッジが起こします。メッセージの文面は組み込みです:

- `[yoicks] <worker>: <from> → <to>` — 頼んだワーカーが終わったか、答えを待って止まったとき。
  3 秒以内のものは 1 つのメッセージにまとめます。
  ワーカーが自分から再開したターン (バックグラウンドの処理や、あなたがそのペインで頼んだこと) は、その終わりが 10 秒続いてから起こします。
- `[yoicks] <worker>: ready, task not sent` — 起動時に質問で止まっていたワーカーが、仕事を受けられるようになったとき。
- `[yoicks] to-do done by the user: <text> (<worker>, <url>)` — あなたがやることリストの項目を済ませたとき (動いている間だけ)。
- `[yoicks] PR merged: <url> (<worker>); its to-do item is removed`、`PR closed without merging: …`、`PR <url> can't be read …` — PR watch から。
- `[yoicks] restarted while you were working; check overview.` — ターンの途中で再起動したあと。

起きたあとに何をするかは、`rules.md` と、あなたの `local.md` が決めます。

**TUI** の orchestrator にはこうしたメッセージは届きません。
同梱の規則が `yoicks agent prompt <name> "<task>" --wait` をバックグラウンドで実行させ、そのコマンドが終わることで起きます。

## やることリスト {#todos}

ヘッドレスの orchestrator だけのものです。

- **組み込み:** `todo` ツール、Home の **Needs you** の下のリスト、Stop・Clear・再起動をまたいで残すこと ([状態のディレクトリ](#state-dir)に)、期限が来た項目を 1 回だけ知らせること、あなたが項目を済ませたら orchestrator を起こすこと (止まっている orchestrator には伝えません)。
- **同梱の規則**が、何を載せるかを決めます。あなたにしかできないこと (マージする PR、ログイン、あなたが返すべき判断) で、待っているワーカーや orchestrator 自身の質問は載せません (Home がもともと表示します)。
- **あなたの `local.md`** で付け足せます。
- 項目を済ませるのは Home で**あなた**が行います。

## PR watch {#pr-watch}

- **有効か無効か:** `config.json` の `pr_watch` (ヘッドレスの項目だけ)。既定は無効で、そのときは GitHub に何も送りません。
- **組み込み:** やることリストの github.com の PR リンクを 1 分ごとに調べること、マージかクローズされた PR の項目を消すこと、上の起こすメッセージ。
- **yoicks の外:** ブリッジの PATH にあってログインしている `gh`。PR の状態はそのログインで読みます。
- **マージのあと:** 同梱の規則は、あなたの `local.md` がそのリポジトリでのデプロイを許しているときだけ、ワーカーに (書かれたチェックをして) デプロイさせます。許していなければ、orchestrator はマージを伝えるだけです。どちらの場合も、そのあとワーカーを片付けます。マージ後のデプロイは、いつもあなたの規則で、yoicks の規則ではありません。

## 終わったペインを閉じる {#auto-close}

組み込みで、無効にする設定はありません。
ワーカーのエージェントが終了してシェルが前面に戻ると、ブリッジは `yoicks agent start` (または `agent_start` ツール) がそのワーカーのために開いたタブを閉じます (そのタブのシェルには `YOICKS_WORKER=1` が付いています)。
あなたが開いたペインと orchestrator のペインは閉じません。
新しい worktree で起動したワーカーも、この方法では閉じません (herdr は新しい worktree に環境変数を渡せないので、そのシェルには印がありません)。
リンクされた worktree のワークスペースの最後のペインも同じです。
これらは `yoicks worktree remove` が worktree と一緒に閉じます。

## ヘッドレスの Home {#headless}

| ふるまい | 決めるもの | 場所 |
|---|---|---|
| ヘッドレスで動かすこと | `config.json` | `orchestrators[].mode: "headless"` |
| サブスクリプションだけで動くこと (API キーの課金を断る)、落ちたあとの再起動、ブリッジと一緒に止まること | 組み込み | [ヘッドレスの orchestrator](../guide/headless) |
| モデル | あなた (Home で) | 選んだものは[状態のディレクトリ](#state-dir)に残り、起動のたびに渡します |
| Compact、Clear、Stop | あなた (Home で) | その **⋮** |
| 使用量の行 (`5h · 7d · ctx`) と、コンテキストが 70% を超えたときのオレンジの印 | 組み込み | Claude Code 自身のストリームから。設定するものはありません |

## 通知 {#notifications}

| どこに | 何を | 決めるもの |
|---|---|---|
| スマホの OS の通知 | エージェントやヘッドレスの Home の blocked と done、ヘッドレスの Home の警告と期限の来たやること、Claude Code の確認の失敗 (アプリがバックグラウンドの間) | 設定 → **Enable notifications** (端末ごと) と、ブラウザの許可 |
| [ntfy](https://ntfy.sh) | 同じもの | `config.json` の `notify_url` (未設定なら何も送りません) |
| PC (herdr の通知) | ヘッドレスの Home の blocked と done、その警告と期限の来たやること、Claude Code の確認の失敗 | 組み込み。ペインのエージェントについては出しません |
| アプリのトースト | あなたの操作の結果 | 組み込み |

## Claude Code の確認 {#canary}

- **組み込み:** 実際の Claude Code での確認と [`scripts/claude-canary.sh`](#checkout)。ヘッドレスの項目があれば、ブリッジは最後の結果を表示し、失敗している間は警告し、失敗した確認ごとに 1 回知らせます。
- **yoicks の外:** 実行するのは、`claude-canary.sh install` が書き、あなたが有効にする 1 時間ごとの [systemd のユーザータイマー](#systemd)です (スクリプト自体は、Claude Code の版が変わったときか 24 時間たったときだけ確かめます。`go` とチェックアウトが要ります)。
- **止めるには:** `config.json` に `"canary": false` (読むのはスクリプトで、ブリッジではありません)、またはタイマーを無効にします。[Claude Code の確認](../guide/headless#checking-claude-code)を参照してください。

## ブリッジへの到達 {#network}

| ふるまい | 決めるもの | 場所 |
|---|---|---|
| バインドアドレスとポート | `config.json` | `host`、`port` (`HERDR_YOICKS_HOST` と `HERDR_YOICKS_PORT` が優先) |
| 接続用 QR の URL | `config.json` | `public_url`。未設定なら Tailscale を検出します |
| 経路 (`tailscale serve`、リバースプロキシ、トンネル) | yoicks の外 | [スマホへの公開](../guide/phone) |
| bearer トークン、既定でループバックだけ、頼まれない限り外へのリクエストはしないこと | 組み込み | [セキュリティモデル](./security) |

## yoicks の開発 {#developing}

yoicks 自身のリポジトリで作業するときだけのものです。インストールしたプラグインには関係しません。

| ふるまい | 決めるもの | 場所 |
|---|---|---|
| CI | リポジトリ | `.github/workflows/ci.yml` |
| e2e のチェック | リポジトリ | `tools/e2e.ts`。CI は Tier 1 を PR ごとと main への push ごとに実行します |
| PR のスクリーンショット | リポジトリ | `screenshots.yml` が main と PR の画面を撮り、`screenshots-publish.yml` が比べて `screenshots` のステータスを付けます |
| 変わったスクリーンショットの承認 | メンテナー | PR のボットのコメントのチェックボックスに印を付けること。ほかに承認する方法はありません |
| main へのマージに必要なチェック | yoicks の外 | GitHub のブランチ保護 (リポジトリの設定。ここでは `web`、`bridge`、`e2e`、`screenshots`) |
| 動いているブリッジへのデプロイ | リポジトリ | `sh scripts/redeploy.sh main`。そのコミットの CI の実行が通るまで (`gh` で) 待ちます ([開発](../development)) |
| Claude Code で確認なしにそのデプロイを実行できること | Claude Code の設定 | [チェックアウトの `.claude/settings.json`](#checkout) がそのコマンドだけを許可しています。ロールバックは確認します |
| orchestrator がマージのあとにデプロイすること | あなた | その `local.md` ([PR watch](#pr-watch)) |
| git のフック | yoicks の外 | [クローンの `.git/hooks`](#checkout) にあるものはあなた自身のものです。リポジトリには含まれません |
| リリース | リポジトリ | `scripts/release.sh` ([リリース](../development#releasing)) |
