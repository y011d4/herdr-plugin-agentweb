<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/public/icons/lockup.svg">
    <img src="site/docs/public/lockup-light.svg" alt="yoicks" width="300">
  </picture>
</p>

# herdr-yoicks

**English** | [日本語](./README.ja.md)

*Yoicks* is the huntsman's cry that sends the pack on.

A [herdr](https://herdr.dev) plugin for running many coding agents at once through one of them. You hand the work
to an **orchestrator**, a Claude Code agent you talk to on its **Home**. It starts a worker for each task (in a git
worktree of its own when several change one repository), follows them, and comes back to you only when one is done
or needs you. A headless orchestrator also keeps a to-do list of what only you can do and, with `pr_watch` on,
goes on after a PR is merged. A small local bridge serves all of it to your phone or a PC's browser: no account, no cloud.

**Documentation: https://yoicks.y011d4.com/docs/en/** (日本語: https://yoicks.y011d4.com/docs/ja/)

<p align="center">
  <img src="site/static/screens/home-pc.webp" width="800"
    alt="yoicks on a PC: the Homes on the left, a Home's chat with its orchestrator in the middle, and on the right what waits on you, the to-do list and the agents">
</p>

## Install

You need [herdr](https://herdr.dev) 0.9.5 or later on Linux (amd64 or arm64; macOS is experimental), and a way for
your phone to reach the bridge: a reverse proxy, a tunnel or a VPN. The plugin is one prebuilt binary, checked
against the checksums committed with its release.

```bash
herdr plugin install y011d4/herdr-yoicks --ref v0.1.0
```

Then give your phone a way in, and write the address it will use as `public_url` in the plugin's `config.json`
(`herdr plugin config-dir y011d4.yoicks` prints its dir; see
[Exposing the bridge to your phone](https://yoicks.y011d4.com/docs/en/guide/phone)). Without it, the connect QR
uses a Tailscale address it finds, else `http://127.0.0.1:<port>`, which a phone can't open. Then start the bridge
and scan the QR:

```bash
herdr plugin action invoke y011d4.yoicks.start                      # the bridge, as a daemon
herdr plugin pane open --plugin y011d4.yoicks --entrypoint connect  # the QR code to scan with your phone
```

## Documentation

| Page | What is in it |
| --- | --- |
| [What is yoicks](https://yoicks.y011d4.com/docs/en/) | what an orchestrator does, and the app |
| [Install](https://yoicks.y011d4.com/docs/en/guide/install) | requirements, updating, rolling back, uninstalling |
| [Start and connect](https://yoicks.y011d4.com/docs/en/guide/start) | the bridge's actions and panes, the connect QR |
| [Exposing the bridge to your phone](https://yoicks.y011d4.com/docs/en/guide/phone) | a reverse proxy, a tunnel or a VPN, and HTTPS |
| [Using the app](https://yoicks.y011d4.com/docs/en/guide/app) | the pane view's gestures, a keybinding |
| [Orchestrators](https://yoicks.y011d4.com/docs/en/guide/orchestrators) | their directories, rules and Claude accounts |
| [Headless orchestrators](https://yoicks.y011d4.com/docs/en/guide/headless) | the bridge's own `claude -p`, the to-do list, the Claude Code check |
| [Configuration](https://yoicks.y011d4.com/docs/en/reference/config) | every `config.json` key |
| [What yoicks does vs. what you configure](https://yoicks.y011d4.com/docs/en/reference/built-in-vs-configured) | what is built in, and what is yours to set |
| [The yoicks commands](https://yoicks.y011d4.com/docs/en/reference/cli) | the CLI an orchestrator drives its workers with |
| [API](https://yoicks.y011d4.com/docs/en/reference/api) | REST and WebSocket, for scripting |
| [Security model](https://yoicks.y011d4.com/docs/en/reference/security) | the token, the bind, what goes out |
| [Compatibility and troubleshooting](https://yoicks.y011d4.com/docs/en/reference/troubleshooting) | platforms, known limitations, what to check |
| [Development and releasing](https://yoicks.y011d4.com/docs/en/development) | building from source, tests, releases |

The docs' sources are [`site/docs/`](site/docs/) (English and Japanese, the same pages). [`CLAUDE.md`](CLAUDE.md) is
for agents working on this repository.

## License

[MIT](LICENSE)
