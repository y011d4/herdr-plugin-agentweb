# What is yoicks

*Yoicks* is the huntsman's cry that sends the pack on.

Monitor and control every coding agent running in [herdr](https://herdr.dev) from your
phone. A herdr plugin that runs a small local bridge server (a Go binary) and serves a
mobile-first PWA:

- Dashboard of all agents across all workspaces with live status
  (idle / working / **blocked** / done), blocked agents sorted to the top;
  a done agent you open on the phone reads as idle there (herdr's own state is left as is);
  each card shows its git branch, and a linked worktree's agents appear inside their
  main checkout, chipped as a worktree
- Rename, clear, and stop agents from the phone: each pane's **⋮** menu renames, clears
  (fresh session), or stops it (an orchestrator's Home has **Clear** and **Stop** buttons
  instead). Agents are started by the orchestrators, not by hand. **⚙** at the top right
  opens the settings
- Pane view: colored terminal output fitted to the phone width, pinch zoom,
  scrollback by swiping down, multiline input, and quick keys
  (Enter, ⌫, Esc, Ctrl+C, arrows, y/n, …). On a PC's browser, Enter sends and
  Shift+Enter inserts a newline; on a phone, Enter inserts a newline and Send sends
- Live updates over WebSocket (sub-second); OS notifications (Settings) when an
  agent becomes blocked or done while the app is in the background — tap to jump
  to the pane
- No accounts, no cloud, no third-party services. Everything stays on your machine;
  remote access is your choice of transport — a reverse proxy, a tunnel, or a VPN.

```
Android (Chrome / installed PWA)
   │  HTTPS via a reverse proxy, tunnel, or VPN (see "Exposing the bridge")
   ▼
bridge server (this plugin, binds 127.0.0.1:8390)
   │  ndjson over the herdr unix socket
   ▼
herdr server
```
