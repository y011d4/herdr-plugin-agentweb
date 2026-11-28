# Using the app

## Pane view gestures {#pane-view-gestures}


- **Pinch** zooms the terminal font (4–24px); **double-tap** returns to
  fit-to-width at the bottom. One finger pans.
- **Swipe down** scrolls into the pane's history — older output sits above the
  current screen, so dragging down reveals it (swipe up returns toward the
  latest output). For panes with terminal scrollback this is instant and local
  (the last 1000 lines are preloaded).
- Full-screen apps that keep no scrollback (e.g. Claude Code with
  `"tui": "fullscreen"`) scroll **their own** view instead: swipes are
  forwarded to the app as mouse-wheel events, with fling momentum. Expect a
  short delay per step — the app repaints remotely.
- While you read history, live updates pause; returning to the bottom (or
  double-tapping) resumes them.
- In a chat (a Claude pane's or a Home's), scrolling up from the newest message shows a
  **↓** at its bottom right, with a dot once new messages arrive; tapping it scrolls back to the
  newest message, and the chat follows new ones again.
- On a Home, a long press on a message (on a PC a right click, or the ↩ beside it) offers **Reply**: the
  composer shows a line of that message (✕ cancels it), and what you send starts with it as a quote, so
  the orchestrator knows what you answer. A reply shows that line on top of its bubble; tapping it
  scrolls to the message. The same menu has **Copy**.
- A Home's chat shows when each message was sent (your local time; the day too when it isn't today). The
  time is the one Claude Code recorded in its transcript, so a reload or a restart keeps it.

Tip: Claude Code's `"tui": "fullscreen"` setting is what prevents scrollback
from accumulating. Remove it (default renderer) and restarted sessions build
terminal scrollback, giving you the smooth local scrolling path everywhere.

## Keybinding (optional) {#keybinding}


```toml
# ~/.config/herdr/config.toml
[[keys.command]]
key = "prefix+m"
type = "plugin_action"
command = "y011d4.yoicks.status"
description = "yoicks bridge status"
```
