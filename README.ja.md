# herdr-yoicks

[English](./README.md) | **日本語**

*Yoicks* は、狩人が猟犬の群れを先へ駆り立てる掛け声です。以前の名前は `herdr-plugin-agentweb` です
([agentweb からの改名](#agentweb-からの改名) を参照)。

[herdr](https://herdr.dev) で動いているすべてのコーディングエージェントを、スマホから
モニタリング・操作するための herdr プラグインです。小さなローカルブリッジサーバー
(Go のバイナリ) を起動し、モバイル向けの PWA を配信します。

- すべてのワークスペースにまたがる全エージェントのダッシュボード。ライブなステータス表示
  (idle / working / **blocked** / done) で、blocked のエージェントは先頭にソートされます。
  done のエージェントをスマホで開くと、スマホ上では idle と表示されます (herdr 側の状態は変えません)。
  各カードに git ブランチ名が表示され、リンクされた worktree のエージェントは
  メインチェックアウトのリスト内に worktree チップ付きで表示されます
- ペイン表示: 端末出力をスマホ幅に合わせてカラー表示。ピンチズーム、下スワイプで
  スクロールバック、複数行入力、クイックキー (Enter、⌫、Esc、Ctrl+C、矢印、y/n、…)
- WebSocket によるライブ更新 (サブ秒)。エージェントが blocked / done になったときの通知
  — タップでそのペインへジャンプ、右スワイプで消去
- アカウント不要・クラウド不要・サードパーティサービス不要。すべてが自分のマシン内で完結し、
  リモートアクセスの経路は自分で選べます — リバースプロキシ、トンネル、または VPN。

```
Android (Chrome / インストールした PWA)
   │  リバースプロキシ / トンネル / VPN 経由の HTTPS (「スマホへの公開」を参照)
   ▼
ブリッジサーバー (本プラグイン、127.0.0.1:8390 で待ち受け)
   │  herdr の unix ソケット上で ndjson
   ▼
herdr サーバー
```

## 必要要件

- [herdr](https://herdr.dev) >= 0.9.5 (「対応状況」の節を参照)
- Linux (amd64、arm64)。macOS (Apple シリコン、Intel) は試験的な対応です。
- ほかにインストールするものはありません。プラグインはビルド済みのバイナリ 1 つで、インストール時に
  `sh`、`curl` か `wget`、`sha256sum` か `shasum` という普通の道具で取得し、検証します。Node.js も
  Go も要りません。
- スマホからブリッジに到達する手段 — リバースプロキシ、トンネル、または VPN
  (「スマホへの公開」の節を参照)。Tailscale は手軽な選択肢の一つで、必須ではありません。
- 任意のコマンド (あれば使います):
  - `git` 2.31 以上 — カードのブランチ名、worktree
  - `qrencode` — 接続用の QR コード (無ければ接続ペインは URL を表示します)
  - `tailscale` — ブリッジを `tailscale serve` の後ろに置いたとき、接続 URL を自動で検出します
  - `direnv` — [orchestrator](./README.md#orchestrators) のための、ディレクトリごとの Claude アカウント
  - `gh` — `worktree remove` が squash merge されたブランチを見分けます

## セットアップ

リリースを GitHub から直接インストールします:

```bash
herdr plugin install y011d4/herdr-yoicks --ref v0.1.0
```

clone もビルドも不要です。`herdr plugin install` はマニフェストの `[[build]]`
(`scripts/plugin-build.sh release`) を実行します。これは、その版の OS と CPU に合うバイナリを
[GitHub のリリース](https://github.com/y011d4/herdr-yoicks/releases) から取得し、そのタグの
リポジトリにコミットされた `release/checksums.txt` の SHA-256 と照らし合わせます。合わないバイナリは
インストールしません。(`--ref` を付けないと herdr は既定のブランチを入れ、その `herdr-plugin.toml` に
書かれた版のリリースを取得します。) ローカルのチェックアウトで開発したい場合は「開発」の節を参照してください。

### 更新

ブリッジを止め、更新し、起動し直します。この順番を守ってください。更新でプラグインのディレクトリが
変わるので、新しい `stop` は古いバイナリが起動したブリッジを見つけられないことがあります:

```bash
herdr plugin action invoke y011d4.yoicks.stop   # 終わるまで待つ
herdr plugin update                               # または: herdr plugin install … --ref v<新しい版>
herdr plugin action invoke y011d4.yoicks.start
```

続いて、動いている orchestrator をそれぞれ起動し直します (Home の **Clear**)。bridge は起動のときに
rules と許可リストを新しい `yoicks` のパスに書き直しますが、動いている orchestrator は古いパスを呼び続けます。
以前の、管理されない orchestrator のディレクトリ (`orchestrator_dir`、または古い `dispatcher`) は利用者のもので、
書き直されません。その `CLAUDE.md` と `.claude/settings.json` の古いパス (改名より前なら
`…/bin/agentwebctl`、Go の bridge より前なら `node …/dist/bin/agentwebctl.js`) を
`<plugin dir>/bin/yoicks` に自分で直すか、管理される `orchestrators` に移ってください。

### agentweb からの改名

v0.1.0 より前、このプラグインの ID は `y011d4.agentweb`、バイナリは `agentwebctl` でした。herdr は
新しい ID を別のプラグインとして扱うので、改名より前のインストールは手で移します:

1. 古いブリッジを止め、終わるまで待つ: `herdr plugin action invoke y011d4.agentweb.stop`
2. この版をインストール (またはリンク) する。`config.json` を `herdr plugin config-dir y011d4.agentweb`
   から `herdr plugin config-dir y011d4.yoicks` へ、`token` と `pane-profiles.json` を
   `~/.local/state/herdr/plugins/y011d4.agentweb/` から `~/.local/state/herdr/plugins/y011d4.yoicks/`
   へコピーする (`$XDG_STATE_HOME` があれば、どちらも `$XDG_STATE_HOME/herdr/plugins/` の下)。
   トークンを移せば、ペアリング済みのスマホは同じ URL のまま使えます。
3. 起動し (`herdr plugin action invoke y011d4.yoicks.start`)、動いている orchestrator を Clear して
   から、`herdr plugin uninstall y011d4.agentweb` (または `unlink`) する。

`~/.local/share/herdr-agentweb` は、あるあいだ使い続けます。orchestrator のディレクトリが動かないので、
Claude Code のメモリ、会話の履歴、フォルダの信頼設定もそのまま残ります。新しい `status` と `stop` は、
古いプラグインが起動したブリッジ (`agentwebctl`。pid ファイルは古い state ディレクトリにある) も見つけ、
`start` はそれが動いているあいだは起動を断ります。手順 1 を飛ばしても、古いブリッジが動き続けることはありません。`HERDR_AGENTWEB_HOST`/`_PORT` は
`HERDR_YOICKS_HOST`/`_PORT` になりました。

### 前の版に戻す

前のリリースに戻すときは、ブリッジを止め、その版を入れ直して起動します:

```bash
herdr plugin action invoke y011d4.yoicks.stop   # 終わるまで待つ
herdr plugin uninstall y011d4.yoicks            # トークン、config、orchestrator のディレクトリは残る
herdr plugin install y011d4/herdr-yoicks --ref v<前の版>
herdr plugin action invoke y011d4.yoicks.start
```

そのあと、更新のときと同じく、動いている orchestrator を Clear してください。

link したチェックアウト ([開発](#開発) を参照) は、代わりに `sh scripts/redeploy.sh <commit>` で戻します。

### アンインストール

```bash
herdr plugin action invoke y011d4.yoicks.stop
herdr plugin config-dir y011d4.yoicks            # アンインストールの前に config ディレクトリを控える
herdr plugin uninstall y011d4.yoicks
```

`herdr plugin uninstall` はファイルを残します。要らないものを消してください:

- インストールしたチェックアウト: `~/.config/herdr/plugins/github-installations/y011d4.yoicks-*`
  (古い herdr では `~/.config/herdr/plugins/github/y011d4.yoicks-*`)
- state ディレクトリ `~/.local/state/herdr/plugins/y011d4.yoicks` (`$XDG_STATE_HOME` があればその下):
  アクセストークン、`bridge.log`、`pane-profiles.json`
- 上で控えた config ディレクトリ (`config.json`)
- `~/.local/share/herdr-yoicks` (改名より前からなら `herdr-agentweb`。`$XDG_DATA_HOME` があればその下):
  orchestrator のディレクトリ。
  自分で書いた `local.md` も含みます

### 起動

ブリッジを起動する (いずれかの方法):

```bash
herdr plugin action invoke y011d4.yoicks.start   # デタッチしたデーモンとして起動
herdr plugin pane open --plugin y011d4.yoicks --entrypoint server  # ペイン内で可視化して起動
```

続いて、QR コードをスキャンしてスマホを接続します (システムパッケージ `qrencode` が必要。
無い場合は URL の表示にフォールバックします):

```bash
herdr plugin pane open --plugin y011d4.yoicks --entrypoint connect
```

このオーバーレイペインには、接続 URL の QR がアクセストークン付きで表示されます — 設定した
`public_url` があればそれを、無ければ自動検出した Tailscale アドレスを、それも無ければ
`http://127.0.0.1:<port>` を使います。経路の選び方と `public_url` の設定は「スマホへの公開」の
節を参照してください。`start` / `status` はトークンを含まない URL を表示します。トークンは
state ディレクトリ (`token` ファイル。パスはアクションの出力に表示されます) に置かれます。

### ブリッジの管理

プラグインは 3 つのワークスペースアクションと 2 つのペインを公開しています:

| エントリポイント | 種別 | 内容 |
| --- | --- | --- |
| `y011d4.yoicks.start` | action | ブリッジをデタッチしたデーモンとして起動 |
| `y011d4.yoicks.stop` | action | 動作中のブリッジを停止 |
| `y011d4.yoicks.status` | action | 動作状況、URL (トークンなし)、プラグインと herdr の版、見つかった任意のコマンドを表示 |
| `server` | pane | ブリッジを可視ペインで起動 (フォアグラウンド。トークン付き URL はここに表示) |
| `connect` | pane | 接続用の QR / URL をオーバーレイ表示 |

アクションは `herdr plugin action invoke <id>` で実行し、ペインは
`herdr plugin pane open --plugin y011d4.yoicks --entrypoint <id>` で開きます。デタッチした
デーモンとフォアグラウンドの `server` ペインは排他です — どちらか一方だけを起動してください。

### スマホへの公開

ブリッジは `127.0.0.1` のみで待ち受けます。そのため、スマホからそのループバックポートへ
トラフィックを運ぶ「何か」が必要です。下の経路から **1 つ** を選び、`public_url`
(「設定 (config)」の節を参照) にスマホが使うアドレスを設定してください。ブリッジ側はどの経路か
を気にしません — ループバック上で PWA と API を配信するだけです。

できれば **正当な証明書付きの HTTPS** を提供する経路を選んでください。それによりページが
*セキュアコンテキスト* になり、Service Worker・「ホーム画面に追加」・Web 通知が有効になります。
プレーンな HTTP でも閲覧はできますが、これらの PWA 機能は無効のままです。

**リバースプロキシ + 独自ドメイン** (Caddy / nginx / Traefik) — 正当な証明書で TLS を終端し、
ブリッジへ転送します。Caddy なら 1 行で、証明書も自動発行されます:

```
# Caddyfile — herdr.example.com の DNS がこのホストを指している必要があります
herdr.example.com {
    reverse_proxy 127.0.0.1:8390
}
```

`"public_url": "https://herdr.example.com"` を設定します (nginx の場合は `/ws` が動くように
WebSocket の `Upgrade` / `Connection` ヘッダを通してください)。

**Cloudflare Tunnel** — ポート開放も公開 IP も不要で、正当な HTTPS が得られます:

```bash
cloudflared tunnel --url http://127.0.0.1:8390   # https://…trycloudflare.com の URL が表示される
```

その URL を `public_url` に設定するか、named tunnel を独自ドメインに紐づけて固定アドレスに
します。

**クイックトンネル** (ngrok、localtunnel、…) — 一番手軽ですが、URL は毎回変わります:

```bash
ngrok http 8390                                  # 正当な証明書付きの https URL が表示される
```

アドレスが毎回変わるので、`public_url` を毎回更新するか、QR ペインを使わずスマホで
`<表示された URL>/?token=<token>` を直接開いてください。

**VPN** (Tailscale、WireGuard、ZeroTier、…) — スマホとマシンを同じプライベートネットワークに
入れます。Tailscale は HTTPS の終端もできるため、別途リバースプロキシは不要です:

```bash
tailscale serve --bg 8390                        # tailnet 内限定の HTTPS、正当な証明書
```

その後 `https://<machine>.<tailnet>.ts.net/?token=<token>` を開きます (停止は
`tailscale serve reset`。`tailscale funnel` は使わないでください)。プレーンな VPN IP を使う
場合 — 例: `"public_url": "http://100.x.y.z:8390"` — HTTP では動きますがセキュアコンテキストに
ならないため、上記の PWA 機能は無効のままです。必要ならリバースプロキシを前段に置いてください。

どれを選んでも、スマホで `<public_url>/?token=<token>` を開き (接続 QR ペインはまさにこの
リンクを生成します)、Chrome の「ホーム画面に追加」を使います。

## ペイン表示のジェスチャー

- **ピンチ** で端末フォントをズーム (4〜24px)、**ダブルタップ** で最下部の fit-to-width
  に戻ります。1 本指でパンします。
- **下スワイプ** でペインの履歴へスクロールします — 古い出力が現在の画面の上にあり、下に
  ドラッグすると現れます (上スワイプで最新の出力へ戻ります)。端末スクロールバックを持つ
  ペインでは、これはローカルかつ即時です (直近 1000 行が先読みされます)。
- スクロールバックを持たないフルスクリーンアプリ (例: `"tui": "fullscreen"` の Claude Code)
  は、**アプリ自身**の表示をスクロールします: スワイプはマウスホイールイベントとしてアプリに
  転送され、フリックの慣性も付きます。1 ステップごとに少し遅延があります — アプリがリモートで
  再描画するためです。
- 履歴を読んでいる間はライブ更新が一時停止します。最下部に戻る (またはダブルタップ) すると
  再開します。

ヒント: スクロールバックが溜まらないのは Claude Code の `"tui": "fullscreen"` 設定が原因です。
これを外す (デフォルトのレンダラーにする) と、再起動したセッションで端末スクロールバックが
蓄積され、どこでも滑らかなローカルスクロールの経路が使えるようになります。

### キーバインド (任意)

```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "y011d4.yoicks.status"
description = "yoicks bridge status"
```

## 設定 (config)

設定は完全に任意です — ブリッジはそのままでも動くデフォルトを持っています。何かを変更したい
ときは、プラグインの config ディレクトリに `config.json` を作成します。そのディレクトリは
次のコマンドで表示できます:

```bash
herdr plugin config-dir y011d4.yoicks
```

すべてのキーは任意で、上書きしたいものだけを含めれば OK です。デフォルトを含めた全体の形は
次のとおりです:

```json
{
  "host": "127.0.0.1",
  "port": 8390,
  "public_url": null,
  "notify_url": null
}
```

- `host` — バインドアドレス。`127.0.0.1` のままにして前段に経路を置くのが推奨です
  (「スマホへの公開」の節を参照)。LAN / VPN の IP にバインドすると直接プレーンな HTTP を
  配信します (動作はしますが、PWA はセキュアコンテキスト外で動くため Service Worker も
  システム通知も使えません)。
- `port` — ブリッジのポート (デフォルト 8390)。
- `public_url` — **リモートアクセスの中心スイッチ**。スマホがブリッジに到達するためのベース
  URL です。例: `"https://herdr.example.com"` (リバースプロキシや Cloudflare Tunnel)、ngrok の
  URL、`"https://gram.your-tailnet.ts.net"` (Tailscale) など。接続用の QR ペインはこの値から
  リンクを組み立てます。未設定の場合、ペインは Tailscale の自動検出 (serve の HTTPS アドレス、
  無ければ tailnet IP)、次いで `http://127.0.0.1:<port>` にフォールバックします — Tailscale
  以外の経路では必ず設定してください。「スマホへの公開」の節も参照。
- `notify_url` — バックグラウンドプッシュ通知用の任意の [ntfy](https://ntfy.sh) トピック URL。
  例: **自己ホスト**した ntfy インスタンスに対する `https://ntfy.example.internal/herdr`。未設定
  (デフォルト) の場合、ブリッジは外部へのリクエストを一切行いません。アプリを閉じている間も
  プッシュを受け取りたい場合は、ntfy を自己ホストして tailnet にバインドし、ntfy の Android
  アプリを同じトピックに向けてください。

**変更の反映:** 設定は起動時に一度だけ読み込まれるため、編集後はブリッジを再起動してください
— `herdr plugin action invoke y011d4.yoicks.stop` の後に `…start`。

**環境変数による上書き:** `HERDR_YOICKS_HOST` と `HERDR_YOICKS_PORT` は `host` / `port` に
ついて `config.json` より優先されます (`public_url` と `notify_url` は config ファイルのみ)。
優先順位は 環境変数 → `config.json` → 組み込みデフォルト です。

> 開発用に bridge を直接実行する場合 (`./bin/yoicks run`)、`config.json` が読み込まれるのは
> `HERDR_PLUGIN_CONFIG_DIR` が config ディレクトリを指しているときだけです
> (`HERDR_PLUGIN_CONFIG_DIR="$(herdr plugin config-dir y011d4.yoicks)" ./bin/yoicks run`)。herdr はプラグインの
> アクションやペインに対してこれを自動設定するため、herdr 経由で起動する分にはそのまま動作します。

## セキュリティモデル

- ブリッジは herdr とローカルの unix ソケット (ファイルモード 0600) 経由で通信します。これは
  同じユーザーの任意のプロセスがすでに持っているアクセス権と同等です。
- すべての `/api` と `/ws` リクエストにはベアラートークンが必要です。トークンは初回起動時に
  生成され、プラグインの state ディレクトリにモード 0600 で保存されます。認証されていない
  リクエストは 401 になります。`GET /healthz` だけが唯一のオープンなエンドポイントで、
  セッションデータは返しません。
- デフォルトのバインドはループバックのみで、リモート到達性は前段に置いた経路 (リバース
  プロキシ / トンネル / VPN。「スマホへの公開」の節を参照) に委ねます。`tailscale serve` の
  ような VPN はブリッジをプライベートネットワーク内に保ち、トークンに加えてネットワーク層の
  境界を追加します。
- **公開**ドメイン経由 (リバースプロキシ / Cloudflare Tunnel) で公開すると、ネットワーク層では
  インターネットから到達可能になり、防御はベアラートークン 1 本だけになります。トークンは
  128 ビット (総当りは非現実的) ですが、接続 URL は秘密として扱ってください — トークンはクエリ
  文字列にも載るため、リバースプロキシのアクセスログに残りうるからです。VPN 経由ならこの露出を
  避けられます。
- テレメトリなし、外部リクエストなし (`notify_url` を明示的に有効にした場合を除く)。
- トークンを持つ者は誰でもエージェントの出力を読み、ペインに入力できます — URL は SSH 鍵と
  同じように扱ってください。ローテーションするには state ディレクトリの `token` を削除して
  再起動します。トークンは 32 桁の 16 進数 (128 ビット) です。旧バージョンが生成した 64 桁の
  トークンも、ローテーションするまでは有効です。

## 対応状況

| | 状況 |
| --- | --- |
| Linux amd64 | 対応。日常的に使っています |
| Linux arm64 | 対応。CI が arm64 でテスト (偽の herdr を相手にしたブリッジの動作を含む) を回しています。本物の herdr ではまだ動かしていません |
| macOS arm64 / amd64 | 試験的。両方ともビルドしますが、CI で単体テストを回しているのは arm64 だけです。本物の herdr ではまだ動かしていません。「既知の制限」を参照 |
| herdr | 0.9.5 (ソケットの protocol 22) で確認。ほかの protocol では、ブリッジが `bridge.log` に警告を出し、`status` にも表示します |
| Claude Code | 2.1.322 で確認: orchestrator の権限の規則と、チャット表示が読む transcript の形 |

Windows は対象外です (herdr が動きません)。バイナリは静的にリンクしている (`CGO_ENABLED=0`) ので、
glibc でも musl でも、どの Linux ディストリビューションでも動きます。

## 既知の制限

- **macOS では Claude アカウントの確認ができません。** エージェントの Claude アカウントは Linux の
  `/proc` から読みます。macOS では、ペインのアカウントが要るコマンド (`overview`、`agent …`、
  `worktree remove`) は断られ、orchestrator の Home にはそのアカウントのものではなく全エージェントが並び、
  **Clear** はアカウントを確かめずに起動し直し、CLI は自分の `CLAUDE_CONFIG_DIR` を呼び出し元のアカウントと
  みなします。
- **npm で入れた Claude Code** は `node` として動くので、`yoicks` はそれを呼び出し元の orchestrator の
  Claude のプロセスと見分けられず、自分の `CLAUDE_CONFIG_DIR` で代わりにします。orchestrator には
  Claude Code のネイティブインストーラーで入れたものを使ってください。
- **チャット表示の transcript** は `~/.claude/projects` と `~/.config/claude/<name>/projects` から探します。
  Linux では、ほかの `CLAUDE_CONFIG_DIR` を使うエージェントもプロセスの環境変数から見つけますが、
  macOS では見つけられず、そのペインは端末の表示のままになります。

## 困ったとき

- `curl -s http://127.0.0.1:8390/healthz` が `{"ok":true,"herdrConnected":true}` を返すはずです。応答が
  なければブリッジが動いていません (起動して `bridge.log` を読んでください)。`"herdrConnected":false` なら、
  herdr のソケット (`$HERDR_SOCKET_PATH`、既定は `~/.config/herdr/herdr.sock`) につながっていません。
- `herdr plugin action invoke y011d4.yoicks.status` は、プラグインと herdr の版、herdr の protocol
  (確認済みでなければ警告つき)、herdr がプラグインに渡す PATH で見つかった任意のコマンドを表示します。
  出力は `herdr plugin log list --plugin y011d4.yoicks` の `stdout` で読めます。
- デタッチしたブリッジのログは state ディレクトリ (`~/.local/state/herdr/plugins/y011d4.yoicks`) の
  `bridge.log` です。動いている版、つながった herdr、エラーが出ます。トークン付きの接続 URL も
  書かれているので、ほかの人に見せないでください。
- 更新した後もスマホに古いアプリが出るときは、閉じて開き直してください (service worker が裏で新しい版を
  取得します)。
- 接続ペインに URL だけが出て QR コードが出ないときは、`qrencode` を入れてください。

## API サーフェス (スクリプト用)

- `GET /api/state` — 正規化されたワークスペース / タブ / ペイン / エージェントのツリー
- `GET /api/panes/:paneId/read?source=visible|recent&lines=N&format=text|ansi`
- `POST /api/panes/:paneId/input` `{"text": "ls", "enter": true}` または `{"keys": ["ctrl+c"]}`
- `POST /api/panes/:paneId/focus`
- `POST /api/panes/:paneId/scroll` `{"direction": "up", "steps": 3}` — フルスクリーンアプリ向けの SGR ホイールイベント
- `POST /api/agents/:target/send` `{"text": "continue"}` — 入力を受け付けられる状態のエージェントにプロンプトを送る
  (herdr の `agent.prompt`。`text` は空にできない)
- `WS /ws?token=…` — `{"type":"state"}` スナップショットと `{"type":"agent_status"}` 遷移

## 開発

ローカルで開発する場合は、GitHub からインストールする代わりに作業ツリーを clone して
**link** します — `herdr plugin link` は herdr にあなたのチェックアウトを指させるので、編集が
そのまま反映されます:

ソースからのビルドには、Go (`go.mod` の版) と、web UI の Vite によるビルドと Vitest のテストのための
Node.js (22.x の 22.18 以降、24.x、26 以降のいずれか。23 と 25 は不可。`package.json` の `engines`) と
`npm` が要ります。

```bash
git clone https://github.com/y011d4/herdr-yoicks
cd herdr-yoicks
sh scripts/plugin-build.sh          # web UI、続いて bin/yoicks (Go)。このチェックアウトから
herdr plugin link "$(pwd)"
```

bridge と CLI は Go (`cmd/yoicks`、`internal/bridge`) です。PWA は `web/src/` の TypeScript と React で
(`main.tsx` がシェルの `ui/App.tsx` を起動します)、Vite で `web/dist` にビルドされ、バイナリに埋め込まれます。

```bash
sh scripts/plugin-build.sh          # 変更後に再ビルド。web の変更も (バイナリが web UI を埋め込むため)
go test ./...                       # Go のテスト
npm test                            # web UI のテスト (Vitest)
./bin/yoicks run                    # ライブの herdr に対しフォアグラウンドで実行 (config は「設定」の節を参照)
YOICKS_DEV_BRIDGE=http://127.0.0.1:8390 npm run dev   # ソースの web UI を :5174 で (ホットリロード)。
                                    # /api と /ws は動いているブリッジへ中継。?token=<そのトークン> で開く
```

herdr は link したプラグインの build コマンドを実行**しません** (`herdr plugin link` でも、link したものを
飛ばす `herdr plugin update` でも) — 編集後は `sh scripts/plugin-build.sh` で再ビルドしてください
(`herdr plugin link` の再実行は `herdr-plugin.toml` を変更したときだけ)。これは常にチェックアウトをそのまま
ビルドします。`sh scripts/plugin-build.sh release` は、インストールのときと同じく、`herdr-plugin.toml` の版の
リリースのバイナリを取得します。

link したチェックアウトの新しいコミットを動いているブリッジに出すときや、前のコミットに戻すときは、
そのチェックアウトで次を実行します:

```bash
sh scripts/redeploy.sh main         # main を origin/main に fast-forward し、ビルドして再起動
sh scripts/redeploy.sh <commit>     # 前のコミットに同じことをする (detached)
```

stop と start のアクションと `/healthz` を待ち、そのあと設定 → App version に出るはずの `BUILD` と
`CACHE` を表示します。変更の残ったツリーや、`herdr-plugin.toml` が変わる切り替えは、何も止めずに断ります
(herdr は link した manifest をキャッシュするため。`herdr plugin link` を含む手作業の手順を表示します)。
stop の後に失敗したときは、元のバイナリを起動し直します。

デタッチしたデーモンのログは `<state dir>/bridge.log` に出力されます
(`~/.local/state/herdr/plugins/y011d4.yoicks`、プラグインコマンド内では `$HERDR_PLUGIN_STATE_DIR`)。

### リリース

メンテナー向け。リリースするコミットの、変更のないチェックアウトで:

```bash
scripts/release.sh 0.2.0    # 一時的な worktree で、固定した Go のツールチェーンで dist/release/* を作り、
                            # release/checksums.txt とマニフェストの版を書く
git add herdr-plugin.toml release/checksums.txt && git commit -m "release v0.2.0" && git tag v0.2.0
git push origin main v0.2.0
gh release create v0.2.0 dist/release/* --title v0.2.0 --notes "…"
```

バイナリは作ったまま、圧縮せずに上げます。そのチェックサムはタグと一緒にコミットしたもので、
`scripts/plugin-build.sh` がインストールのときに照らし合わせます。リリースノートには、確認した herdr と
Claude Code の版を書いてください。

## ライセンス

[MIT](LICENSE)
