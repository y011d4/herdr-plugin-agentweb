/**
 * terminal.ts — an opened pane's terminal, on its `.terminal-output` element: one continuous
 * buffer (#term-history, the scrollback prefix, above #term-live, the current screen),
 * fit-to-width with pinch zoom and double-tap, and, for a full-screen app without
 * scrollback, swipes and the PC wheel forwarded as SGR wheel events (batched, with fling).
 * One per opened pane (pane-view.ts): destroy() stops its timers and listeners, and its
 * late responses do nothing.
 *
 * Never replace the terminal's DOM during a touch: the browser cancels the scroll gesture.
 * A screen arriving while a finger is down (or while the user reads above the bottom) waits
 * in pendingAnsi and is drawn on touchend / on returning to the bottom.
 */
import { ansiToHtml } from './ansi.ts';
import { apiGet, apiPost } from './api.ts';
import { showToast } from './notify.ts';
import { displayCols } from './prompt.ts';
import type { OkResponse, ReadResponse } from './types.ts';

export interface Terminal {
  /** a screen (a WS push or a read): drawn at once, or deferred while unsafe (see above) */
  render(ansi: string): void;
  /** reads the current screen over HTTP and renders it */
  refresh(): Promise<void>;
  /** fills #term-history with the scrollback above the screen */
  loadHistory(): Promise<void>;
  /** after input: re-reads the screen twice, so the echo shows at once */
  echo(): void;
  /** the bridge's app-scroll decision (pane_output / a visible read carry it) */
  setAppScroll(on: boolean): void;
  /** held (a Home's under a drawer): no reads, and none in flight applies; released by `false` */
  setHeld(on: boolean): void;
  destroy(): void;
}

const WHEEL_STEP_PX = 12; // finger travel per forwarded wheel event
const HISTORY_LINES = 1000;
const HISTORY_REFRESH_MS = 10_000;
const EMPTY_HISTORY_RETRY_MS = 1_500; // shorter retry when the last prefix was empty

let monoRatio: number | null = null; // monospace glyph width / font-size
let lastReadErrorToastAt = 0;

function measureMonoRatio(el: HTMLElement): number {
  if (monoRatio !== null) return monoRatio;
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(100);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px;';
  probe.style.fontFamily = getComputedStyle(el).fontFamily;
  document.body.appendChild(probe);
  monoRatio = probe.offsetWidth / 100 / 100 || 0.6;
  probe.remove();
  return monoRatio;
}

export function createTerminal(outputEl: HTMLElement, { paneId }: { paneId: string }): Terminal {
  // Two sections updated independently, so live pushes never touch the scrollback DOM above.
  const historyEl = Object.assign(document.createElement('div'), { id: 'term-history' });
  const liveEl = Object.assign(document.createElement('div'), { id: 'term-live' });
  liveEl.append(Object.assign(document.createElement('span'), { className: 'loading-spinner' }));
  outputEl.replaceChildren(historyEl, liveEl);
  const listeners = new AbortController();
  const { signal } = listeners;
  let destroyed = false;
  let held = false; // setHeld
  let holds = 0; // each hold: a scrollback read from before it never applies

  // each pane opens fitted to width, scrolled to the bottom
  // null = auto-fit the pane width; a number = font px set by the pinch gesture
  let paneFontPx: number | null = null;
  // Bumped whenever a newer screen is rendered (WS push or HTTP read), so an
  // in-flight HTTP read can drop its response if newer output arrived meanwhile.
  let outputSeq = 0;
  // Incremented when a pane read starts; only the latest in-flight read renders,
  // so an earlier HTTP read can't win over a later one.
  let refreshReqSeq = 0;
  let terminalTouchActive = false; // a finger is on the terminal
  let pendingAnsi: string | null = null; // output received while unsafe to render
  let lastLiveAnsi = ''; // last rendered screen (for line counts and refits)
  let historyFetchedAt = 0;
  let lastPrefixEmpty = false; // last prefix fetch found no scrollback
  let historyRefreshing = false;
  // Full-screen apps (claude etc.) keep no terminal scrollback but scroll their
  // own view on SGR mouse wheel events — forward swipes through the bridge's
  // /scroll endpoint, which injects real wheel events into the pty.
  let appScrollPane = false;
  let wheelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Wheel events are batched (~70ms windows, sent as steps) so fast swipes
  // don't turn into dozens of http requests, and the view refreshes on a
  // rolling ~200ms cadence while scroll activity continues.
  let wheelQueue = 0; // >0 = up steps, <0 = down steps
  let wheelFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastWheelRefreshAt = 0;
  // Momentum: keep sending decaying wheel batches after the finger lifts, like
  // native fling. Renders are not deferred once the touch ends, so the view
  // visibly follows the fling.
  let flingTimer: ReturnType<typeof setInterval> | null = null;

  // ── Fit-to-width rendering with pinch zoom ──────────────────────────────────

  function applyFitFontSize(ansiStr: string): void {
    if (paneFontPx !== null) {
      outputEl.style.fontSize = `${paneFontPx.toFixed(2)}px`;
      return;
    }
    const plain = ansiStr.replace(/\x1b\[[0-9;:?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '');
    let cols = 20;
    for (const line of plain.split('\n')) {
      const w = displayCols(line);
      if (w > cols) cols = w;
    }
    const padding = 32; // .terminal-output horizontal padding
    const avail = outputEl.clientWidth - padding;
    const px = avail / (cols * measureMonoRatio(outputEl));
    // clamp: below ~6px nothing is readable — fall back to horizontal scrolling
    outputEl.style.fontSize = `${Math.max(6, Math.min(14, px)).toFixed(2)}px`;
  }

  // Pinch-to-zoom on the terminal: two fingers scale the font, double-tap
  // returns to fit-to-width. Page-level zoom stays untouched elsewhere.
  // Also tracks whether any finger is on the terminal: replacing the DOM
  // mid-gesture cancels the browser's touch scroll, so renders are deferred
  // while a gesture is active (see render).
  let pinchStartDist = 0;
  let pinchStartPx = 0;
  let lastTapEndAt = 0;
  let tapStartX = 0;
  let tapStartY = 0;
  let tapCandidate = false;
  let lastTouchY = 0;
  let wheelAccum = 0;
  let touchVelocity = 0; // px/ms, positive = finger moving down (scroll up)
  let lastMoveAt = 0;
  // Forward app-scroll wheel steps only for a gesture that began as a single
  // finger and never became a pinch. Dropping from two fingers to one leaves
  // lastTouchY stale, so forwarding then would send a large scroll burst.
  let singleFingerGesture = false;

  const touchDist = (t: TouchList): number =>
    Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  outputEl.addEventListener('touchstart', (e: TouchEvent) => {
    terminalTouchActive = true;
    if (e.touches.length === 2) {
      tapCandidate = false;
      singleFingerGesture = false;
      pinchStartDist = touchDist(e.touches);
      pinchStartPx = parseFloat(getComputedStyle(outputEl).fontSize) || 13;
    } else if (e.touches.length === 1) {
      tapCandidate = true;
      singleFingerGesture = true;
      tapStartX = e.touches[0].clientX;
      tapStartY = e.touches[0].clientY;
      lastTouchY = e.touches[0].clientY;
      wheelAccum = 0;
      touchVelocity = 0;
      lastMoveAt = performance.now();
      stopFling();
    }
  }, { passive: true, signal });

  outputEl.addEventListener('touchmove', (e: TouchEvent) => {
    if (e.touches.length === 1) {
      if (tapCandidate &&
          Math.hypot(e.touches[0].clientX - tapStartX, e.touches[0].clientY - tapStartY) > 10) {
        tapCandidate = false; // a scroll flick is not a tap
      }
      // app-scroll panes: translate vertical swipes into wheel events.
      // preventDefault stops the browser from also scrolling the container
      // off the bottom — that would defer the app's repaint into pendingAnsi
      // and freeze the forwarded scroll until the user returns to the bottom.
      if (appScrollPane && singleFingerGesture) {
        e.preventDefault();
        const y = e.touches[0].clientY;
        const dy = y - lastTouchY;
        const now = performance.now();
        const dt = now - lastMoveAt;
        if (dt > 0 && dt < 200) {
          touchVelocity = 0.7 * touchVelocity + 0.3 * (dy / dt);
        }
        lastMoveAt = now;
        wheelAccum += dy;
        lastTouchY = y;
        while (wheelAccum >= WHEEL_STEP_PX) { wheelAccum -= WHEEL_STEP_PX; queuePaneWheel(true); }
        while (wheelAccum <= -WHEEL_STEP_PX) { wheelAccum += WHEEL_STEP_PX; queuePaneWheel(false); }
      }
    }
    if (e.touches.length !== 2 || pinchStartDist === 0) return;
    e.preventDefault(); // keep the browser from zooming the whole page
    const px = Math.max(4, Math.min(24, pinchStartPx * (touchDist(e.touches) / pinchStartDist)));
    paneFontPx = px;
    outputEl.style.fontSize = `${px.toFixed(2)}px`;
  }, { passive: false, signal });

  outputEl.addEventListener('touchend', (e: TouchEvent) => {
    if (e.touches.length > 0) return; // fingers still down
    terminalTouchActive = false;
    pinchStartDist = 0;

    if (tapCandidate) {
      const now = Date.now();
      tapCandidate = false;
      if (now - lastTapEndAt < 300) {
        // double-tap (two stationary taps): back to the fitted bottom
        lastTapEndAt = 0;
        paneFontPx = null;
        outputEl.scrollTop = outputEl.scrollHeight;
        flushPendingOutput(); // render any deferred screen now we're back at the bottom
        void refreshPaneOutput();
        return;
      }
      lastTapEndAt = now;
    } else {
      lastTapEndAt = 0;
    }

    if (appScrollPane && singleFingerGesture) {
      // A pause before lifting means the last recorded velocity is stale — don't
      // fling off an earlier fast move the user has already stopped.
      if (performance.now() - lastMoveAt > 100) touchVelocity = 0;
      startFling(touchVelocity);
    }
    flushPendingOutput();
  }, { passive: true, signal });

  outputEl.addEventListener('touchcancel', () => {
    terminalTouchActive = false;
    pinchStartDist = 0;
    tapCandidate = false;
    singleFingerGesture = false;
    flushPendingOutput(); // deliver any output deferred during the cancelled gesture
  }, { passive: true, signal });

  // ── Wheel forwarding (app-scroll panes) ─────────────────────────────────────

  function queuePaneWheel(up: boolean): void {
    if (!appScrollPane) return; // app-scroll off — never queue SGR wheels for a normal pane
    wheelQueue += up ? 1 : -1;
    if (!wheelFlushTimer) {
      wheelFlushTimer = setTimeout(() => { void flushWheelQueue(); }, 70);
    }
  }

  async function flushWheelQueue(): Promise<void> {
    wheelFlushTimer = null;
    // app-scroll may have turned off (pane left full-screen) since these were
    // queued — drop them so we don't inject SGR wheel bytes into a normal pane.
    if (!appScrollPane) { wheelQueue = 0; stopFling(); return; }
    if (destroyed || wheelQueue === 0) return;
    const direction = wheelQueue > 0 ? 'up' : 'down';
    const steps = Math.min(30, Math.abs(wheelQueue));
    wheelQueue -= (direction === 'up' ? steps : -steps);
    if (wheelQueue !== 0) {
      // more queued than one request carries — keep flushing
      wheelFlushTimer = setTimeout(() => { void flushWheelQueue(); }, 70);
    }
    try {
      await apiPost<OkResponse>(`/api/panes/${encodeURIComponent(paneId)}/scroll`, { direction, steps });
    } catch { /* transient send failures just skip a scroll step */ }
    if (destroyed) return;
    const now = Date.now();
    if (now - lastWheelRefreshAt > 200) {
      lastWheelRefreshAt = now;
      void refreshPaneOutput();
    }
    if (wheelRefreshTimer) clearTimeout(wheelRefreshTimer);
    wheelRefreshTimer = setTimeout(() => { void refreshPaneOutput(); }, 150);
  }

  function stopFling(): void {
    if (flingTimer) { clearInterval(flingTimer); flingTimer = null; }
  }

  function startFling(velocityPxMs: number): void {
    stopFling();
    let v = Math.max(-3, Math.min(3, velocityPxMs));
    if (Math.abs(v) < 0.4) return;
    flingTimer = setInterval(() => {
      if (!appScrollPane) { stopFling(); return; } // pane left full-screen mid-fling
      v *= 0.82;
      const dist = v * 80;
      const steps = Math.floor(Math.abs(dist) / WHEEL_STEP_PX);
      if (steps === 0) { stopFling(); return; }
      for (let i = 0; i < steps; i++) queuePaneWheel(dist > 0);
    }, 80);
  }

  // ── Continuous terminal buffer ──────────────────────────────────────────────
  // #term-history holds the scrollback prefix (fetched from source=recent,
  // refreshed at most every 10s while the user reads it) and #term-live holds the
  // current screen (updated by WS pushes). The view is scrollable from the very
  // first swipe — no modes.

  // Fetch the scrollback and place everything ABOVE the current screen into
  // #term-history. source=recent ends with the lines currently on screen, so
  // the live section's line count is dropped from its tail to avoid the overlap.
  async function loadHistoryPrefix(): Promise<void> {
    // Requires a live screen: source=recent ends with the current screen, and
    // without lastLiveAnsi we can't trim it off, so we'd duplicate it into history.
    // (Bails harmlessly when the first pane read hasn't rendered yet; historyFetchedAt
    // stays 0 so the next above-bottom scroll retries once live output exists.)
    if (destroyed || held || historyRefreshing || terminalTouchActive || !lastLiveAnsi) return;
    historyRefreshing = true;
    const reqHolds = holds;
    try {
      const data = await apiGet<ReadResponse>(
        `/api/panes/${encodeURIComponent(paneId)}/read?source=recent&lines=${HISTORY_LINES}&format=ansi`
      );
      if (destroyed) return; // navigated away
      if (held || reqHolds !== holds) { historyFetchedAt = 0; return; } // under a drawer since: read again once back
      // A gesture may have started while the fetch was in flight; replacing the
      // history DOM / adjusting scrollTop now would cancel or jump it. Bail and
      // leave the cache dirty so the next above-bottom scroll refetches.
      if (terminalTouchActive) { historyFetchedAt = 0; return; }
      const recentLines = (data.ansi ?? data.text ?? '').split('\n');
      const liveLineCount = lastLiveAnsi ? lastLiveAnsi.split('\n').length : 0;
      const prefix = recentLines.slice(0, Math.max(0, recentLines.length - liveLineCount)).join('\n');
      // appScrollPane is driven by the WS pane_output push (server-computed from
      // fresh herdr scroll metadata) — nothing to recompute here. It only affects
      // the history-start marker below; an empty prefix on a full-screen app shows
      // no marker.
      // anchor by distance from the bottom: content only changes above the fold
      const fromBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight;
      if (prefix) historyEl.innerHTML = ansiToHtml(prefix);
      else historyEl.replaceChildren(...(appScrollPane ? [] : [Object.assign(document.createElement('div'), { className: 'history-start', textContent: '\u00b7 start of output \u00b7' })]));
      // Throttle refetches, but retry an empty result much sooner (see the scroll
      // handler): output may scroll off the live screen and become fetchable
      // history well before the normal 10s window, yet a per-scroll refetch would
      // flood the bridge.
      historyFetchedAt = Date.now();
      lastPrefixEmpty = !prefix;
      outputEl.scrollTop = outputEl.scrollHeight - fromBottom - outputEl.clientHeight;
    } catch {
      // scrollback is best-effort; the live screen keeps working without it
    } finally {
      if (reqHolds === holds) historyRefreshing = false; // a hold since freed it already (setHeld)
    }
  }

  // desktop equivalent of the swipe-to-wheel forwarding
  let wheelDeltaAccum = 0;
  outputEl.addEventListener('wheel', (e: WheelEvent) => {
    if (!appScrollPane) return;
    e.preventDefault(); // forward to the app; don't also scroll the container
    wheelDeltaAccum += e.deltaY;
    while (wheelDeltaAccum <= -30) { wheelDeltaAccum += 30; queuePaneWheel(true); }
    while (wheelDeltaAccum >= 30) { wheelDeltaAccum -= 30; queuePaneWheel(false); }
  }, { passive: false, signal });

  outputEl.addEventListener('scroll', () => {
    const fromBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight;
    if (fromBottom < 40) {
      flushPendingOutput();
    } else if (Date.now() - historyFetchedAt >
               (lastPrefixEmpty ? EMPTY_HISTORY_RETRY_MS : HISTORY_REFRESH_MS)) {
      // reading scrollback — freshen the prefix so lines that scrolled off the
      // live screen since the last fetch appear. An empty prefix is retried
      // sooner so newly-produced history shows up without a 10s wait.
      void loadHistoryPrefix();
    }
  }, { passive: true, signal });

  // Render the current screen into #term-live, following the bottom only when
  // the user was already there — never yank them out of scrollback.
  function renderPaneOutput(ansiStr: string): void {
    if (destroyed) return;
    outputSeq++; // newer screen content — invalidates any in-flight HTTP read
    const atBottom =
      outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 40;
    // Replacing the DOM under an active touch cancels the scroll gesture, and
    // resizing the live section while the user reads above would shift the
    // content they're reading — defer until safe.
    if (terminalTouchActive || !atBottom) {
      pendingAnsi = ansiStr;
      return;
    }
    pendingAnsi = null;
    lastLiveAnsi = ansiStr;
    // live advanced — lines may have scrolled off into history that the cached
    // prefix doesn't have yet; mark it dirty so the next scroll-up refetches.
    historyFetchedAt = 0;
    applyFitFontSize(ansiStr);
    liveEl.innerHTML = ansiToHtml(ansiStr);
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function flushPendingOutput(): void {
    if (pendingAnsi === null) return;
    const ansi = pendingAnsi;
    pendingAnsi = null;
    renderPaneOutput(ansi); // re-queues itself if still unsafe
  }

  async function refreshPaneOutput(): Promise<void> {
    if (destroyed || held) return;
    const seq = outputSeq;
    const reqId = ++refreshReqSeq;
    try {
      const data = await apiGet<ReadResponse>(
        `/api/panes/${encodeURIComponent(paneId)}/read?source=visible&lines=200&format=ansi`
      );
      if (destroyed || held) return; // navigated away, or under a drawer
      // A later read started while this one was in flight — let the newest win, so
      // an earlier HTTP read can't overwrite a newer one's fresher output.
      if (reqId !== refreshReqSeq) return;
      // A newer screen (WS push) rendered while this read was in flight — its
      // response is stale, so drop it rather than overwrite the newer content with
      // old output the server won't re-push.
      if (outputSeq !== seq) return;
      // Keep app-scroll fresh on the HTTP fallback path (WS down); the server
      // computes it the same way it does for pane_output pushes.
      if (typeof data.appScroll === 'boolean') appScrollPane = data.appScroll;
      renderPaneOutput(data.ansi ?? data.text ?? '');
    } catch (err) {
      const message = (err as Error).message;
      if (message === '401' || destroyed || held || reqId !== refreshReqSeq) return; // a newer read (or a hold) since
      // transient failures (bridge restart, herdr reconnect) must not wipe the
      // terminal the user is reading — keep the last render and toast instead
      if (lastLiveAnsi) {
        const now = Date.now();
        if (now - lastReadErrorToastAt > 10_000) {
          lastReadErrorToastAt = now;
          showToast('Output refresh failed', message);
        }
      } else {
        liveEl.textContent = `Error loading output: ${message}`;
      }
    }
  }

  return {
    render: renderPaneOutput,
    refresh: refreshPaneOutput,
    loadHistory: loadHistoryPrefix,
    // Right after sending input, fetch fresh output a couple of times so keypress
    // echo feels instant instead of waiting for the next push/poll cycle.
    echo() {
      setTimeout(() => { void refreshPaneOutput(); }, 120);
      setTimeout(() => { void refreshPaneOutput(); }, 500);
    },
    setAppScroll(on) { appScrollPane = on; },
    setHeld(on) {
      held = on;
      if (on) { refreshReqSeq++; holds++; historyRefreshing = false; } // a read in flight now never applies, also once released; nor holds up the next
    },
    destroy() {
      destroyed = true;
      listeners.abort();
      stopFling();
      if (wheelFlushTimer) clearTimeout(wheelFlushTimer);
      if (wheelRefreshTimer) clearTimeout(wheelRefreshTimer);
      wheelFlushTimer = wheelRefreshTimer = null;
    },
  };
}
