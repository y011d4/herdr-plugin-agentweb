# yoicks が決めること、あなたが決めること

yoicks のふるまいは、それぞれ次の 5 つのどこかで決まります。
思っていなかったことが起きたとき、このページを見れば、それがどこで決まっていて、どこを変えればよいか (あるいは変えられないこと) がわかります。

| 出どころ | 中身 | 誰が編集するか |
|---|---|---|
| **組み込み** | `yoicks` のバイナリと、それに同梱の orchestrator の規則 ([`orchestrator/rules.md`](https://github.com/y011d4/herdr-yoicks/blob/main/orchestrator/rules.md)) | 誰も編集しません。yoicks の更新で変わります |
| **`config.json`** | プラグインの[設定](./config) | あなた |
| **orchestrator のファイル** | そのディレクトリの `rules.md` (yoicks が書く) と `local.md` (あなたのもの) | 一部は yoicks が書き直し、残りはあなたのものです ([下](#files)) |
| **Claude Code の設定** | `.claude/settings.json`、`.claude/settings.local.json`、アカウント自体の設定 | yoicks は orchestrator ごとに 1 つだけ書きます。残りはあなたのものです |
| **yoicks の外** | herdr、git、direnv、`gh`、systemd、GitHub、ネットワークの経路 | あなたが、それぞれの道具で |

## ファイル {#files}

| ファイル | 場所 (既定) | 書くもの | 編集してよいか |
|---|---|---|---|
| `config.json` | `~/.config/herdr/plugins/config/y011d4.yoicks/` (`herdr plugin config-dir y011d4.yoicks` で表示) | あなた | はい。編集後はブリッジを再起動します |
| `CLAUDE.md` | `~/.local/share/herdr-yoicks/orchestrators/<name>/` | yoicks。ブリッジの起動時と、その orchestrator を起動するたびに書きます | いいえ。編集しても消えます |
| `rules.md` | 同じ | yoicks。同梱の規則から、その mode の部分だけ (PR watch が有効ならその部分も) を書きます | いいえ。編集しても消えます |
| `.claude/settings.json` | 同じ | yoicks | いいえ。編集しても消えます |
| `local.md` | 同じ | yoicks が一度だけ作り (コメントだけ)、以後はあなたのもの | はい。上書きされません |
| `.claude/settings.local.json` | 同じ | あなた (yoicks は書きません) | はい |
| `token`、`bridge.log`、`bridge.pid` と `bridge-run.pid`、`headless/<name>.json` と `.mcp.json`、`todos/<name>.json`、`agent-purposes.json`、`pane-profiles.json` | `~/.local/state/herdr/plugins/y011d4.yoicks/` | ブリッジ | いいえ (`token` を消すと作り直します。[セキュリティモデル](./security)を参照) |
| `canary.json` | 同じ | `scripts/claude-canary.sh` | いいえ |
| `yoicks-claude-canary.service` と `.timer` | `~/.config/systemd/user/` | `sh scripts/claude-canary.sh install` | 有効にするかどうかはあなたが決めます |

`~/.local/share` は `$XDG_DATA_HOME` があればそれ、`~/.local/state` は `$XDG_STATE_HOME` があればそれです。
herdr のプラグインのコマンドの中では、状態のディレクトリは `$HERDR_PLUGIN_STATE_DIR` です。

## Home と orchestrator {#orchestrators}

| ふるまい | 決めるもの | 場所 |
|---|---|---|
| どの Home があるか、その名前、表示名、並び順 | `config.json` | `orchestrators[].name`、`.label` (無ければ `default` が 1 つ) |
| それぞれが動く Claude アカウント | `config.json` | `orchestrators[].env.CLAUDE_CONFIG_DIR`。無ければ既定のアカウント (TUI なら、そのディレクトリの上の direnv の `.envrc` が指定するもの) |
| herdr のペインで動くか、ヘッドレスか | `config.json` | `orchestrators[].mode`。`"headless"`、無ければペイン |
| orchestrator が動かすプログラム | 組み込み | `launch_profiles` に関係なく、いつもただの `claude` |
| 仕事の渡し方、ワーカーの追い方、報告、片付け | 組み込み | `rules.md` (同梱の規則から) |
| どのリポジトリを受け持つか、答える言語、いつデプロイしてよいか… | あなた | `local.md` |
| TUI の orchestrator が実行できるもの | yoicks が書く | `.claude/settings.json`。`dontAsk` で、実行できるコマンドは `yoicks overview`、`yoicks agent …`、`yoicks worktree remove …` だけ、編集は拒否し、Claude Code の読み取り専用のツールは、そのディレクトリの中では今も使えます。あなたが足すものは `.claude/settings.local.json` へ |
| ヘッドレスの orchestrator が実行できるもの | 組み込み | ブリッジが渡すコマンドライン。AskUserQuestion と yoicks のツールだけで、シェルはありません。ディレクトリの設定で足すことはできず、ブリッジは API 課金を断るためだけにそれを読みます |
| 自分のアカウントのエージェントだけを見て動かすこと | 組み込み | 無効にはできません ([何に触れられるか](../guide/orchestrators#what-it-can-reach)) |

## ワーカー {#workers}

| ふるまい | 決めるもの | 場所 |
|---|---|---|
| orchestrator がワーカーを動かすコマンド | 組み込み | [`yoicks` のコマンド](./cli) (TUI)。ヘッドレスでは同じものがツールになり、`todo` が加わります |
| ワーカーを起動できるプログラム | `config.json` | `launch_profiles`。組み込みの `claude`、`codex`、`opencode` に重ねます |
| いつどのプロファイルを使うか (調べもの用の安いもの、など) | あなた | `local.md` |
| 新しい worktree の置き場所 | 組み込み | リポジトリの隣の `<repo>-wt-<branch>` |
| ワーカーの Claude アカウント | 組み込み | orchestrator と同じ。そのディレクトリの direnv が別のアカウントになる場所では断ります (`CLAUDE_CONFIG_DIR` の無いディレクトリは既定のアカウント)。新しい worktree では、direnv で確かめられない場所も断ります |
| 新しい worktree のアカウント | yoicks の外 | リポジトリの上にある `.envrc` (herdr は worktree に環境変数を渡せません) |
| ワーカー自身の権限と確認 | Claude Code の設定 | ふつうの Claude Code と同じく、そのアカウントとリポジトリの設定です。yoicks は何も書きません。確認にはそのペインであなたが答えます |
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

- **組み込み:** `todo` ツール、Home の **Needs you** の下のリスト、Stop・Clear・再起動をまたいで残すこと (`todos/<name>.json`)、期限が来た項目を 1 回だけ知らせること、あなたが項目を済ませたら orchestrator を起こすこと (止まっている orchestrator には伝えません)。
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
| モデル | あなた (Home で) | 選んだものは状態のディレクトリに残り、起動のたびに渡します |
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

- **組み込み:** 実際の Claude Code での確認と `scripts/claude-canary.sh` (チェックアウトの中)。ヘッドレスの項目があれば、ブリッジは最後の結果を表示し、失敗している間は警告し、失敗した確認ごとに 1 回知らせます。
- **yoicks の外:** 実行するのは、`claude-canary.sh install` が書き、あなたが有効にする 1 時間ごとの systemd のユーザータイマーです (スクリプト自体は、Claude Code の版が変わったときか 24 時間たったときだけ確かめます。`go` とチェックアウトが要ります)。
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
| Claude Code で確認なしにそのデプロイを実行できること | Claude Code の設定 | リポジトリの `.claude/settings.json` が `sh scripts/redeploy.sh main` だけを許可しています。ロールバックは確認します |
| orchestrator がマージのあとにデプロイすること | あなた | その `local.md` ([PR watch](#pr-watch)) |
| git のフック | yoicks の外 | リポジトリには含まれません。クローンの `.git/hooks` にあるものはあなた自身のものです |
| リリース | リポジトリ | `scripts/release.sh` ([リリース](../development#releasing)) |
