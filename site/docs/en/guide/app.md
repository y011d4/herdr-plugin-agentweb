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
