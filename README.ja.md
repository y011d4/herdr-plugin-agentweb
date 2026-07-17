# herdr-plugin-agentweb

[English](./README.md) | **日本語**

[herdr](https://herdr.dev) で動いているすべてのコーディングエージェントを、スマホから
モニタリング・操作するための herdr プラグインです。小さなローカルブリッジサーバー
(Node.js) を起動し、モバイル向けの PWA を配信します。

- すべてのワークスペースにまたがる全エージェントのダッシュボード。ライブなステータス表示
  (idle / working / **blocked** / done) で、blocked のエージェントは先頭にソートされます。
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

- herdr >= 0.7.0 (Linux / macOS)
- Node.js >= 20
- スマホからブリッジに到達する手段 — リバースプロキシ、トンネル、または VPN
  (「スマホへの公開」の節を参照)。Tailscale は手軽な選択肢の一つで、必須ではありません。

## セットアップ

GitHub から直接インストールできます — herdr がリポジトリを取得し、ビルドまで自動で実行します:

```bash
herdr plugin install y011d4/herdr-plugin-agentweb
# バージョンを固定する場合:  herdr plugin install y011d4/herdr-plugin-agentweb --ref v0.1.0
```

clone も手動ビルドも不要です。`herdr plugin install` はマニフェストの `[[build]]`
(`npm ci` → `npm run build`) を実行するため、`PATH` に Node.js と `npm` が必要です。ローカルの
チェックアウトで開発したい場合は「開発」の節を参照してください。

ブリッジを起動する (いずれかの方法):

```bash
herdr plugin action invoke y011d4.agentweb.start   # デタッチしたデーモンとして起動
herdr plugin pane open --plugin y011d4.agentweb --entrypoint server  # ペイン内で可視化して起動
```

続いて、QR コードをスキャンしてスマホを接続します (システムパッケージ `qrencode` が必要。
無い場合は URL の表示にフォールバックします):

```bash
herdr plugin pane open --plugin y011d4.agentweb --entrypoint connect
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
| `y011d4.agentweb.start` | action | ブリッジをデタッチしたデーモンとして起動 |
| `y011d4.agentweb.stop` | action | 動作中のブリッジを停止 |
| `y011d4.agentweb.status` | action | 動作状況を報告し、URL を表示 (トークンなし) |
| `server` | pane | ブリッジを可視ペインで起動 (フォアグラウンド。トークン付き URL はここに表示) |
| `connect` | pane | 接続用の QR / URL をオーバーレイ表示 |

アクションは `herdr plugin action invoke <id>` で実行し、ペインは
`herdr plugin pane open --plugin y011d4.agentweb --entrypoint <id>` で開きます。デタッチした
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
command = "y011d4.agentweb.status"
description = "agent web bridge status"
```

## 設定 (config)

設定は完全に任意です — ブリッジはそのままでも動くデフォルトを持っています。何かを変更したい
ときは、プラグインの config ディレクトリに `config.json` を作成します。そのディレクトリは
次のコマンドで表示できます:

```bash
herdr plugin config-dir y011d4.agentweb
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
— `herdr plugin action invoke y011d4.agentweb.stop` の後に `…start`。

**環境変数による上書き:** `HERDR_AGENTWEB_HOST` と `HERDR_AGENTWEB_PORT` は `host` / `port` に
ついて `config.json` より優先されます (`public_url` と `notify_url` は config ファイルのみ)。
優先順位は 環境変数 → `config.json` → 組み込みデフォルト です。

> 開発用にサーバーを直接実行する場合 (`node server/main.ts`)、`config.json` が読み込まれるのは
> `HERDR_PLUGIN_CONFIG_DIR` が config ディレクトリを指しているときだけです。herdr はプラグインの
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

## API サーフェス (スクリプト用)

- `GET /api/state` — 正規化されたワークスペース / タブ / ペイン / エージェントのツリー
- `GET /api/panes/:paneId/read?source=visible|recent&lines=N&format=text|ansi`
- `POST /api/panes/:paneId/input` `{"text": "ls", "enter": true}` または `{"keys": ["ctrl+c"]}`
- `POST /api/panes/:paneId/focus`
- `POST /api/panes/:paneId/scroll` `{"direction": "up", "steps": 3}` — フルスクリーンアプリ向けの SGR ホイールイベント
- `POST /api/agents/:target/send` `{"text": "continue"}`
- `WS /ws?token=…` — `{"type":"state"}` スナップショットと `{"type":"agent_status"}` 遷移

## 開発

ローカルで開発する場合は、GitHub からインストールする代わりに作業ツリーを clone して
**link** します — `herdr plugin link` は herdr にあなたのチェックアウトを指させるので、編集が
そのまま反映されます:

```bash
git clone https://github.com/y011d4/herdr-plugin-agentweb
cd herdr-plugin-agentweb
npm install && npm run build     # 依存は ws のみ
herdr plugin link "$(pwd)"
```

ソースは TypeScript で、`server/`、`bin/`、`web/src/` にあります。ビルド済みの JS ディストリ
ビューションは `dist/` (server と bin) と `web/` (PWA アセット) に配置されます。

```bash
npm run build                  # 変更後に TS → JS を再コンパイル
npm test                       # ユニットテスト (node --test。.ts をネイティブ実行するため Node >= 23.6 が必要)
node server/main.ts            # ライブの herdr に対しフォアグラウンドで実行 (開発用、Node >= 23.6)
```

`herdr plugin link` は build コマンドを実行**しません** — 編集後は `npm run build` で再ビルド
してください (`herdr plugin link` の再実行は `herdr-plugin.toml` を変更したときだけ)。
`herdr plugin install` はマニフェストの build コマンドを自動で実行します。

ビルド済みの `dist/` を実行するには Node >= 20 が必要です。TS ソースを直接実行する (開発モード)
場合は、ネイティブの型ストリッピングのために Node >= 23.6 が必要です。

デタッチしたデーモンのログは `<state dir>/bridge.log` に出力されます
(`herdr plugin config-dir y011d4.agentweb` が config ディレクトリを表示します。state ディレクトリは
その兄弟、またはプラグインコマンド内では `$HERDR_PLUGIN_STATE_DIR`)。
