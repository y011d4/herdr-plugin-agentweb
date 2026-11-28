# Start and connect

## Starting {#starting}


Start the bridge (any of these):

```bash
herdr plugin action invoke y011d4.yoicks.start   # detached daemon
herdr plugin pane open --plugin y011d4.yoicks --entrypoint server  # visible in a pane
```

Then connect the phone by scanning a QR code (requires the `qrencode` system
package; falls back to printing the URL):

```bash
herdr plugin pane open --plugin y011d4.yoicks --entrypoint connect
```

The overlay pane shows a QR of your connect URL with the access token included:
your configured `public_url` when set, otherwise an auto-detected Tailscale
address, otherwise `http://127.0.0.1:<port>`. See
[Exposing the bridge to your phone](./phone) to pick a
transport and set `public_url`. This pane is the only place that shows the token:
`start`/`status`, the `server` pane and `bridge.log` show the URL without it. The
token lives in the state dir (`token` file, printed path in the action output).

## Managing the bridge {#managing-the-bridge}


The plugin exposes three workspace actions and two panes:

| Entrypoint | Kind | What it does |
| --- | --- | --- |
| `y011d4.yoicks.start` | action | Start the bridge as a detached daemon |
| `y011d4.yoicks.stop` | action | Stop the running bridge |
| `y011d4.yoicks.status` | action | Report whether it's running, the URL (no token), the versions of the plugin and herdr, and which optional commands it finds |
| `server` | pane | Run the bridge in a visible pane (foreground; the URL is shown here, without the token) |
| `connect` | pane | Show the connect QR / URL as an overlay |

Invoke an action with `herdr plugin action invoke <id>`; open a pane with
`herdr plugin pane open --plugin y011d4.yoicks --entrypoint <id>`. The detached
daemon and the foreground `server` pane are mutually exclusive — start one or the
other, not both.
