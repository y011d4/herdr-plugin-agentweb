# 設定 (config)

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
  "notify_url": null,
  "pr_watch": false,
  "orchestrators": [
    { "name": "default", "label": "", "env": {} }
  ],
  "launch_profiles": {
    "claude": { "argv": ["claude"] },
    "codex": { "argv": ["codex"] },
    "opencode": { "argv": ["opencode"] }
  }
}
```

- `host` — バインドアドレス。`127.0.0.1` のままにして前段に経路を置くのが推奨です
  ([スマホへの公開](../guide/phone) を参照)。LAN / VPN の IP にバインドすると直接プレーンな HTTP を
  配信します (動作はしますが、PWA はセキュアコンテキスト外で動くため Service Worker も
  システム通知も使えません)。
- `port` — ブリッジのポート (デフォルト 8390)。
- `public_url` — **リモートアクセスの中心スイッチ**。スマホがブリッジに到達するためのベース
  URL です。例: `"https://herdr.example.com"` (リバースプロキシや Cloudflare Tunnel)、ngrok の
  URL、`"https://gram.your-tailnet.ts.net"` (Tailscale) など。接続用の QR ペインはこの値から
  リンクを組み立てます。未設定の場合、ペインは Tailscale の自動検出 (serve の HTTPS アドレス、
  無ければ tailnet IP)、次いで `http://127.0.0.1:<port>` にフォールバックします — Tailscale
  以外の経路では必ず設定してください。[スマホへの公開](../guide/phone) も参照してください。
- `launch_profiles` — 名前を付けたエージェントの起動プロファイルです。orchestrator の `agent start --profile`、
  Clear、`POST /api/agents` が使います。各エントリは `{ "argv": [...] }` で、`argv[0]` は herdr が知っている
  エージェントの種類 (`claude`、`codex`、`opencode`、…。実行ファイルは herdr が選びます)、残りは固定の
  フラグです (この許可リストの要点は、呼び出し側が選べるのは*プロファイル名*だけで、生のコマンドは
  渡せないことです)。自分のエントリは上の組み込みのデフォルトに重ねられます (同じ名前ならその `argv` を
  上書きし、新しい名前は追加し、形の崩れたエントリは無視します)。たとえば
  `"claude-yolo": { "argv": ["claude", "--dangerously-skip-permissions"] }` のように別の起動方法を足せます。
- `orchestrators` — あなたの **orchestrator** です。話しかける相手の Claude Code エージェントで、仕事を
  ほかのエージェントに渡し、結果を伝えます。各エントリは `{ "name", "label", "env" }` で、`label` はスマホでの
  表示名、`env` は起動するときの環境変数です。ふつうは `CLAUDE_CONFIG_DIR` で Claude アカウントを選びます
  (`"~/.config/claude/work"`。先頭の `~` は展開します)。これで、たとえば仕事用と個人用の orchestrator を
  分けておけます。それぞれのディレクトリはプラグインが自分で用意し ([orchestrator](../guide/orchestrators) を
  参照)、スマホから (その Home の **Start**。止まっている間も Home は開けます) か、
  `<plugin dir>/bin/yoicks orchestrator start <name>` で起動します。アプリを開くと orchestrator の **Home** が
  出ます。そこには、やりとりだけのチャット (ツールの呼び出しは隠します)、その Claude アカウントの
  エージェントのステータスバー (あなたを待っているものと、ほかの数)、動いている間は「doing now」の行が
  あります。orchestrator 自身はエージェントの一覧に出ません。数をタップすると、それらのエージェントが blocked、
  working、done、idle の順に並びます (タップするとそのエージェントを開きます)。その **Open the list** で開く
  エージェントの一覧には、そのアカウントのエージェントだけが並びます (`#/agents/<name>`。Back で Home に戻ります)。全体の一覧の
  **← Home** は、最後に使った Home を開きます。いくつも動いているときは、Home に切り替えボタン (`label` と
  その状態) が出て、最後に使ったものを開き直します (`#/home/<name>`)。1 つも動いていなければ、アプリは
  一覧で開きます。
- `notify_url` — バックグラウンドプッシュ通知用の任意の [ntfy](https://ntfy.sh) トピック URL。
  例: **自己ホスト**した ntfy インスタンスに対する `https://ntfy.example.internal/herdr`。未設定
  (デフォルト) の場合、ブリッジは外部へのリクエストを一切行いません。アプリを閉じている間も
  プッシュを受け取りたい場合は、ntfy を自己ホストして tailnet にバインドし、ntfy の Android
  アプリを同じトピックに向けてください。
- `canary` — `false` にすると、ヘッドレスの orchestrator のために Claude Code を定期的に確かめる
  `scripts/claude-canary.sh` を止めます ([Claude Code の確認](../guide/headless#checking-claude-code) を参照)。
- `pr_watch` — `true` にすると、ヘッドレスの orchestrator がマージされた PR に自分で気づけます。ブリッジは
  1 分ごとに、あなたの `gh` (PC と同じログイン) を使い、やることリストにある github.com の PR リンクの状態を
  1 回の GraphQL 呼び出しでまとめて問い合わせます。マージかクローズされた PR の項目は消え、その
  orchestrator に知らせます (`[yoicks] PR merged: <url>`)。これで orchestrator は先に進めます (ローカルの
  rules が許すデプロイや、ワーカーの片付け)。ブリッジの PATH に `gh` があり、ログインしている
  (`gh auth status`) 必要があります。失敗したときは、リストに PR がある Home ごとに、エラー 1 つにつき
  1 回知らせます。既定では無効で、そのときは GitHub に何も送りません。

**変更の反映:** 設定は起動時に一度だけ読み込まれるため、編集後はブリッジを再起動してください
— `herdr plugin action invoke y011d4.yoicks.stop` の後に `…start`。

**環境変数による上書き:** `HERDR_YOICKS_HOST` と `HERDR_YOICKS_PORT` は `host` / `port` に
ついて `config.json` より優先されます (`public_url` と `notify_url` は config ファイルのみ)。
優先順位は 環境変数 → `config.json` → 組み込みデフォルト です。

> 開発用に bridge を直接実行する場合 (`./bin/yoicks run`)、`config.json` が読み込まれるのは
> `HERDR_PLUGIN_CONFIG_DIR` が config ディレクトリを指しているときだけです
> (`HERDR_PLUGIN_CONFIG_DIR="$(herdr plugin config-dir y011d4.yoicks)" ./bin/yoicks run`)。herdr はプラグインの
> アクションやペインに対してこれを自動設定するため、herdr 経由で起動する分にはそのまま動作します。
