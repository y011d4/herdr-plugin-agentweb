# Security model


- The bridge talks to herdr through the local unix socket (file mode 0600), the
  same access any process of your user already has.
- Every `/api` and `/ws` request requires a bearer token, generated on first start
  and stored with mode 0600 in the plugin state dir. Unauthenticated requests get
  401. `GET /healthz` is the only open endpoint and returns no session data.
- Default bind is loopback-only; remote reachability is delegated to whatever
  transport you put in front (reverse proxy, tunnel, or VPN — see
  [Exposing the bridge to your phone](../guide/phone)). A VPN
  such as `tailscale serve` keeps the bridge inside a private network, adding a
  network-layer boundary on top of the token.
- Exposing it through a **public** domain (reverse proxy / Cloudflare Tunnel) makes
  the bridge reachable from the internet at the network layer, so the bearer token is
  then your only line of defense. The token is 128-bit (not brute-forceable), but
  treat the connect URL as a secret: it also rides in the query string, so it can
  land in reverse-proxy access logs. A VPN transport avoids that exposure.
- No telemetry, no external requests (unless you opt into `notify_url`, or `pr_watch`: then your
  `gh` asks GitHub for the state of the PRs on the headless orchestrators' to-do lists, nothing more).
- Anyone with the token can read agent output and type into your panes — treat the
  URL like an SSH key. Rotate by deleting `token` in the state dir and restarting.
  Tokens are 32 hex chars (128-bit); tokens created by older versions were 64 and
  stay valid until rotated.
