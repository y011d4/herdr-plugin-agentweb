# Exposing the bridge to your phone


The bridge binds to `127.0.0.1` only, so something has to carry traffic from your
phone to that loopback port. Pick **one** of the transports below and set
`public_url` (see [Configuration](../reference/config)) to the address your phone will
use. The bridge doesn't care which one you use — it just serves the PWA and the API
on loopback.

Prefer a transport that gives you **HTTPS with a valid certificate**: that makes the
page a *secure context*, which is what enables the service worker, "Add to Home
screen", and Web Notifications. Plain HTTP still works for viewing, but those PWA
features stay off.

**Reverse proxy + your own domain** (Caddy / nginx / Traefik) — terminate TLS with a
real certificate and forward to the bridge. Caddy needs one line and provisions the
certificate for you:

```
# Caddyfile — DNS for herdr.example.com must resolve to this host
herdr.example.com {
    reverse_proxy 127.0.0.1:8390
}
```

Set `"public_url": "https://herdr.example.com"`. (On nginx, pass the WebSocket
`Upgrade`/`Connection` headers through so `/ws` works.)

**Cloudflare Tunnel** — no open ports, no public IP, valid HTTPS:

```bash
cloudflared tunnel --url http://127.0.0.1:8390   # prints an https://…trycloudflare.com URL
```

Set `public_url` to that URL, or bind a named tunnel to your own domain for a stable
address.

**Quick tunnel** (ngrok, localtunnel, …) — fastest to try, but the URL changes each
run:

```bash
ngrok http 8390                                  # prints an https URL with a valid cert
```

Because the address is ephemeral, either update `public_url` each run, or skip the QR
pane and just open `<printed-url>/?token=<token>` on the phone.

**VPN** (Tailscale, WireGuard, ZeroTier, …) — put the phone and the machine on the
same private network. Tailscale can also terminate HTTPS for you, so it needs no
separate reverse proxy:

```bash
tailscale serve --bg 8390                        # tailnet-only HTTPS, valid cert
```

Then open `https://<machine>.<tailnet>.ts.net/?token=<token>` (stop with `tailscale
serve reset`; don't use `tailscale funnel`). With a plain VPN IP instead — e.g.
`"public_url": "http://100.x.y.z:8390"` — it works over HTTP but without a secure
context, so the PWA features above stay off; front it with a reverse proxy if you
want them.

Whichever you pick, open `<public_url>/?token=<token>` on the phone (the connect QR
pane builds exactly this link) and use Chrome's "Add to Home screen".
