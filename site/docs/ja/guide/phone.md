# スマホへの公開

ブリッジは `127.0.0.1` のみで待ち受けます。そのため、スマホからそのループバックポートへ
トラフィックを運ぶ「何か」が必要です。下の経路から **1 つ** を選び、`public_url`
([設定 (config)](../reference/config) を参照) にスマホが使うアドレスを設定してください。ブリッジ側はどの経路か
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
