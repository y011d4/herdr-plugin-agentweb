/**
 * pane-view.ts — the body of an opened pane (a pane route or a Home), in its container:
 * the terminal (terminal.ts) and the chat view of a Claude pane's transcript. It owns that DOM
 * and everything that feeds it: the transcript availability probe (one at a time), its WS
 * messages (pane_output, transcript_items, the pane's agent_status), the 3s refresh / fallback
 * polling and the pane's part of visibilitychange. For a blocked pane in chat it reads the
 * prompt off the screen (opts.prompt: ui/PromptPanel.tsx draws it and sends the answers) and
 * closes its drawer once a tapped answer lands. ui/Pane.tsx draws the rest (header, toggle button,
 * composer, Home's status bar and "doing now" line) and hears back through opts.
 * store.view.paneViewMode is the mode of the view on show (wsSendWatch reads it). One per opened pane (a
 * Home under a drawer waits suspended, resumed as the drawer closes):
 * destroy() stops every timer and listener, and its late responses do nothing.
 * A headless orchestrator (hl:<name>) has no terminal: its view is the chat alone, empty until its
 * session's transcript has a line, and its question comes from the State (ui/Pane.tsx), not the screen.
 */
import { ansiToHtml } from './ansi.ts';
import { apiGet } from './api.ts';
import { closeAgent } from './nav.ts';
import { showToast } from './notify.ts';
import { answerOutcome, parsePrompt, promptIdentity, stripAnsi } from './prompt.ts';
import type { ParsedPrompt } from './prompt.ts';
import { orchestratorOfPane } from './routes.ts';
import { findPane, store } from './store.ts';
import { createTerminal } from './terminal.ts';
import { conversationItems, latestActivity } from './transcript.ts';
import { createChatLog } from './ui/ChatLog.tsx';
import type { TimelineItem, ToolUse } from './transcript.ts';
import type { ReadResponse, TranscriptResponse, WsMessage, WsTranscriptItemsMessage } from './types.ts';
import { onWsMessage, wsSendWatch } from './ws.ts';

const PANE_REFRESH_INTERVAL_MS = 3_000; // polling while pane detail is visible
const PROMPT_SCREEN_INTERVAL_MS = 1200;
const ANSWER_CONFIRM_MS = 10_000; // still on the same prompt this long after the press → say so

export interface PaneViewOpts {
  /** the terminal ⇄ chat toggle: shown once the pane has a transcript */
  showToggle(visible: boolean): void;
  /** store.view.paneViewMode was set (the toggle's label; Home's terminal keys) */
  modeChanged(): void;
  /** Home's "doing now": the orchestrator's latest tool call since it last spoke */
  activity(text: string | null): void;
  /** the answer panel's content while the pane is blocked in chat; null: no panel */
  prompt(p: PanelPrompt | null): void;
  /** the chat's ↓: `away`, the user left its newest item (it no longer follows); `unread`, items came
   *  meanwhile. Told only when either changes. */
  jump(away: boolean, unread: boolean): void;
}

/** What the answer panel (ui/PromptPanel.tsx) shows. */
export interface PanelPrompt {
  /** the menu read off the screen (null: none); kept while its identity holds */
  parsed: ParsedPrompt | null;
  /** its identity ('' without a menu): an answer's expect_prompt */
  id: string;
  /** the live screen as HTML (ansiToHtml); null before the first read */
  screen: string | null;
}

export interface PaneView {
  /** the toggle: chat or terminal; persist = remember it as the pane's view (for the app's life) */
  setMode(mode: 'terminal' | 'chat', persist: boolean): void;
  /** under a drawer (a Home's): it stops (no timers, no messages, no reads) and keeps its DOM as it is */
  suspend(): void;
  /** back on show: it goes on where it was (its mode, its chat and scroll), the shell re-sends its watch */
  resume(): void;
  /** a new State: the answer panel follows the pane's status */
  onState(): void;
  /** after input: re-read the terminal at once (terminal.ts echo) */
  echo(): void;
  /** a tapped answer to the prompt `id` is sent (`post`): once it lands and the agent resumes
   *  work, close the drawer (not on a Home, nor for "Chat about this": `chat`) */
  answered(id: string, chat: boolean, post: Promise<unknown>): void;
  /** after a 409: read the prompt on screen now and show it, unless `current()` turned false */
  reread(current: () => boolean): Promise<void>;
  /** the ↓: the chat scrolls to its newest item (smoothly, unless the user asks for reduced motion) and
   *  follows new ones again */
  toBottom(): void;
  destroy(): void;
}

const NEAR_BOTTOM_PX = 60; // a chat scrolled this close to its end is on its newest item: it follows again, no ↓

// The view a pane was switched to here, for the app's life (not stored): a pane opens on its chat, but for
// one whose terminal was chosen. (One terminal choice once made every pane open on its terminal.)
const chosenView = new Map<string, 'terminal' | 'chat'>();
const preferredView = (paneId: string): 'terminal' | 'chat' => chosenView.get(paneId) ?? 'chat';

// Whether the state currently reports this pane as running Claude — the only
// kind that can ever have a transcript, so the only kind worth re-probing.
function paneIsClaude(paneId: string): boolean {
  const agent = findPane(paneId)?.pane?.agent;
  return (agent?.name ?? agent?.displayName ?? '').toLowerCase().includes('claude');
}

// A tapped answer until it is seen landing (settlePendingAnswer). `back`: close the drawer once
// the agent resumes work (false = stay); `prompt`: the identity of the prompt it answers.
interface PendingAnswer {
  prompt: string; back: boolean;
  sent: boolean; resumed: boolean; timer: ReturnType<typeof setTimeout> | null;
}

/** The view a pane opens on: a headless orchestrator's chat; a Claude pane's chat, but where its terminal was
 *  chosen (an orchestrator's always its chat); any other pane's terminal. Also the route's first watch (App.tsx). */
export function openingMode(paneId: string): 'terminal' | 'chat' {
  if (paneId.startsWith('hl:')) return 'chat';
  return paneIsClaude(paneId) && (preferredView(paneId) === 'chat' || orchestratorOfPane(store.appState, paneId)) ? 'chat' : 'terminal';
}

export function createPaneView(container: HTMLElement, paneId: string, opts: PaneViewOpts): PaneView {
  const { view } = store;
  const headless = paneId.startsWith('hl:');
  const terminalEl = Object.assign(document.createElement('div'), { className: 'terminal-output', id: 'terminal-output' });
  const chatEl = Object.assign(document.createElement('div'), { className: 'chat-log', id: 'chat-log' });
  chatEl.style.display = 'none';
  container.replaceChildren(terminalEl, chatEl);
  const term = createTerminal(terminalEl, { paneId });
  const listeners = new AbortController();
  const { signal } = listeners;
  let destroyed = false;
  // A tap on a link while text in the log is selected only ends the selection: on a phone
  // that tap is how a selection is dismissed, so it mustn't open a tab. (A long press on a
  // link keeps the browser's own menu: open, copy the link.)
  chatEl.addEventListener('click', (e) => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !chatEl.contains(sel.anchorNode) || !(e.target as Element).closest('a')) return;
    e.preventDefault();
    sel.removeAllRanges();
  }, { signal });

  // `pinned`: the chat stays at its newest item: an append follows, and so does the log growing under it (an
  // image coming in after its item was drawn) or its box shrinking (the composer growing, the phone's keyboard).
  // The user unpins it, scrolling up (a scroll down to the end, or the ↓, pins it again) or opening a tool
  // result that runs past the end; not the log growing, which a scroll position alone can't tell from it.
  // The ↓ (opts.jump) shows while it is unpinned, with a dot once items came meanwhile.
  let pinned = true;
  let unread = false;
  let lastTop = 0;
  let told = { away: false, unread: false };
  const fromBottom = (): number => chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
  function reportJump(): void {
    const away = mode === 'chat' && !pinned;
    if (!away) unread = false;
    if (away === told.away && unread === told.unread) return;
    told = { away, unread };
    opts.jump(away, unread);
  }
  const toEnd = (): void => { pinned = true; chatEl.scrollTop = chatEl.scrollHeight; };
  chatEl.addEventListener('scroll', () => {
    if (fromBottom() < NEAR_BOTTOM_PX) pinned = true;
    else if (chatEl.scrollTop < lastTop) pinned = false;
    lastTop = chatEl.scrollTop;
    reportJump();
  }, { signal, passive: true });
  chatEl.addEventListener('toggle', () => { // a <details>: the user's own change to the log
    pinned = fromBottom() < NEAR_BOTTOM_PX;
    reportJump();
  }, { signal, capture: true });
  const stay = (): void => { if (mode === 'chat' && pinned) toEnd(); };
  chatEl.addEventListener('load', stay, { signal, capture: true });
  const resized = new ResizeObserver(stay);
  resized.observe(chatEl);
  signal.addEventListener('abort', () => resized.disconnect());

  // ── Chat view (Claude Code transcript) ──────────────────────────────────────
  // A claude pane can be shown as its structured transcript instead of the raw
  // terminal (view.paneViewMode). Availability is probed per pane; the terminal stays the fallback.
  // set as it opens (openingMode): a Claude pane on its chat but where its terminal was chosen, any other
  // pane on its terminal, probed for a transcript once its screen is in
  view.paneViewMode = 'terminal';
  let mode: 'terminal' | 'chat' = 'terminal'; // this view's (view.paneViewMode is the one on show's)
  let suspended = false; // under a drawer (suspend/resume)
  let epoch = 0; // bumped by each suspend: a response to a request from before it never applies
  let wanted: { mode: 'terminal' | 'chat'; persist: boolean } | null = null; // a setMode while suspended, for the resume
  const home = view.homeMode; // a Home's view (the global changes under a drawer)
  const chat = createChatLog(chatEl, { home }); // draws the items (React) into chatEl; this keeps the scroll
  let historyLoaded = false; // the terminal's scrollback is in (read with a look at the terminal until it is)
  let chatAvailable = false;
  let chatSessionId: string | null = null;
  let chatCursor = 0; // byte offset into the transcript for incremental fetches
  let chatProbing = false; // an availability probe is in flight — prevents overlap
  let activity: string | null = null; // Home: latest tool call since the orchestrator last spoke
  let calls = new Map<string, ToolUse>(); // Home: its questions' and yoicks tool calls, by tool_use id, so their results show (conversationItems)

  // Pending-prompt panel: when a claude pane is blocked (waiting for input), the
  // chat surfaces an answer UI — tappable options for a pending AskUserQuestion,
  // or the live terminal screen for any other prompt (permission, plan, y/n).
  let prompt: PanelPrompt | null = null; // the panel's content (null: no panel)
  let promptScreenTimer: ReturnType<typeof setInterval> | null = null;
  let promptPollSeq = 0; // monotonic request id; bumped on stop to invalidate an in-flight poll
  let promptPollActive = 0; // reqId of the poll currently in flight (0 = none) — prevents overlap
  let pendingAnswer: PendingAnswer | null = null;
  let paneRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // One GET decides availability, reveals the toggle, and (when chat is preferred)
  // switches straight in using the payload it just fetched — no second request.
  async function initChatAvailability(): Promise<void> {
    if (chatProbing) return; // one probe in flight — don't overlap (so a slow probe still applies)
    chatProbing = true;
    const reqEpoch = epoch;
    try {
      const data = await apiGet<TranscriptResponse>(`/api/panes/${encodeURIComponent(paneId)}/transcript`);
      if (destroyed || suspended || reqEpoch !== epoch) return;
      chatAvailable = data.available;
      opts.showToggle(chatAvailable);
      // the orchestrator is someone to talk to: always open it as chat
      if (chatAvailable && (preferredView(paneId) === 'chat' || orchestratorOfPane(store.appState, paneId))) switchToChat(data, false);
      else opts.modeChanged(); // staying on the terminal: Home reveals its keys
    } catch {
      // leave the terminal view; toggle stays hidden (Home reveals the keys)
      if (!destroyed && !suspended && reqEpoch === epoch) opts.modeChanged();
    } finally {
      chatProbing = false;
    }
  }

  // persist=true only for an explicit user toggle; automatic switches (honoring an
  // existing preference, or falling back on a transient transcript miss) must not
  // rewrite the stored preference.
  function switchToChat(initial?: TranscriptResponse, persist = true): void {
    if (!chatAvailable || destroyed || suspended) return;
    view.paneViewMode = mode = 'chat';
    if (persist) chosenView.set(paneId, 'chat');
    terminalEl.style.setProperty('display', 'none');
    chatEl.style.setProperty('display', '');
    opts.modeChanged();
    if (initial?.items) {
      chatSessionId = initial.sessionId ?? null;
      chatCursor = initial.cursor ?? 0;
      renderChatReset(initial.items);
    } else {
      void loadChatInitial();
    }
    wsSendWatch(); // server: stop pane watch, start transcript watch
    updatePromptPanel(); // reveal the answer panel if the pane is already blocked
  }

  function switchToTerminal(persist = true): void {
    if (destroyed || suspended) return;
    view.paneViewMode = mode = 'terminal';
    if (persist) chosenView.set(paneId, 'terminal');
    chatEl.style.setProperty('display', 'none');
    terminalEl.style.setProperty('display', '');
    reportJump(); // no ↓ over the terminal
    opts.modeChanged();
    updatePromptPanel(); // hide the answer panel (chat-only)
    wsSendWatch(); // server: stop transcript watch, resume pane watch
    lookAtTerminal(); // repaint the live screen the user returns to
  }

  // The terminal's live screen, read again, and its scrollback with its first look (a pane opened on its chat,
  // or one suspended before its first read was done).
  function lookAtTerminal(): void {
    const lookEpoch = epoch; // one from before a suspend leaves the scrollback to the resume's look
    void term.refresh().then(() => {
      if (destroyed || suspended || lookEpoch !== epoch || historyLoaded) return;
      void term.loadHistory().then((ok) => { if (ok) historyLoaded = true; });
    });
  }

  async function loadChatInitial(): Promise<void> {
    // switchToChat starts the WS transcript watch alongside this request; if that
    // watch (or anything else) advances the chat state while this GET is in flight,
    // its result is stale — capture the start state and drop a mismatched reply so
    // the slower initial load can't replace a fresher log or rewind the cursor.
    const reqSession = chatSessionId;
    const reqCursor = chatCursor;
    const reqEpoch = epoch;
    try {
      const data = await apiGet<TranscriptResponse>(`/api/panes/${encodeURIComponent(paneId)}/transcript`);
      if (destroyed || suspended || reqEpoch !== epoch || mode !== 'chat') return;
      if (chatSessionId !== reqSession || chatCursor !== reqCursor) return; // superseded in flight
      if (!data.available) { noTranscript(); return; }
      opts.showToggle(!headless); // opened on its chat: the toggle once a transcript is there (the socket may be down)
      chatSessionId = data.sessionId ?? null;
      chatCursor = data.cursor ?? 0;
      renderChatReset(data.items ?? []);
    } catch {
      // keep whatever is shown; the WS watch will refresh
    }
  }

  function renderChatReset(items: TimelineItem[], preserveScroll = false): void {
    // A reconnect re-watch resends the same session's tail; keep the user where
    // they were reading instead of snapping to the bottom.
    const prevTop = chatEl.scrollTop;
    if (home) {
      activity = latestActivity(items, null);
      opts.activity(activity);
      calls = new Map();
      items = conversationItems(items, calls);
    }
    chat.reset(items);
    if (preserveScroll && !pinned) chatEl.scrollTop = prevTop;
    else toEnd();
    reportJump();
  }

  function appendChatItems(items: TimelineItem[]): void {
    if (items.length === 0) return;
    if (home) {
      activity = latestActivity(items, activity);
      opts.activity(activity);
      items = conversationItems(items, calls);
      if (items.length === 0) return;
    }
    // follow the end only while pinned there — don't yank the user out of history they've scrolled up to read
    chat.append(items);
    if (pinned) toEnd();
    else unread = true;
    reportJump();
  }

  // No transcript: a pane falls back to its terminal. A headless orchestrator has none: its chat
  // shows empty until its session's first line (a start or a Clear writes none before the first message).
  function noTranscript(): void {
    if (headless) {
      if (chatSessionId !== null || !chatEl.hasChildNodes()) {
        chatSessionId = null;
        chatCursor = 0;
        renderChatReset([]);
      }
      return;
    }
    chatAvailable = false;
    opts.showToggle(false);
    if (mode === 'chat') switchToTerminal(false);
  }

  function onTranscriptItems(msg: WsTranscriptItemsMessage): void {
    if (!msg.available) {
      noTranscript();
      return;
    }
    chatAvailable = true;
    opts.showToggle(!headless); // a headless orchestrator has no terminal to toggle to
    if (mode !== 'chat') return; // availability noted; content applies only in chat mode
    // a re-watch (a reconnect, a resume) resending what is on show: nothing to redraw
    // ponytail: one that moved on comes back as a same-session reset (one redraw, scroll kept); appending
    // from the cursor instead needs watch_transcript to take one
    if (msg.reset && msg.sessionId != null && msg.sessionId === chatSessionId && msg.cursor === chatCursor) return;
    if (msg.reset || msg.sessionId !== chatSessionId) {
      // Same session (a reconnect re-watch) → keep scroll; a new session → bottom.
      const sameSession = msg.sessionId != null && msg.sessionId === chatSessionId;
      chatSessionId = msg.sessionId ?? null;
      chatCursor = msg.cursor;
      renderChatReset(msg.items, sameSession);
    } else {
      chatCursor = msg.cursor;
      appendChatItems(msg.items);
    }
  }

  // HTTP fallback while the WS is down: fetch items past the cursor for the same
  // session (mirrors the transcript watch).
  async function pollChatFallback(): Promise<void> {
    if (destroyed || suspended || mode !== 'chat') return;
    const reqEpoch = epoch;
    // The response is only valid against the state this request started from. If
    // anything (a WS reset/push, or a newer poll) advances the session or cursor
    // while the request is in flight, applying it — append OR reset — would
    // duplicate or rewind, so capture the start state and drop a mismatched reply.
    const reqCursor = chatCursor;
    const reqSession = chatSessionId;
    const q = chatSessionId ? `?session=${encodeURIComponent(chatSessionId)}&after=${reqCursor}` : '';
    try {
      const data = await apiGet<TranscriptResponse>(`/api/panes/${encodeURIComponent(paneId)}/transcript${q}`);
      if (destroyed || suspended || reqEpoch !== epoch || mode !== 'chat') return;
      // Drop any response whose request start no longer matches the current state
      // BEFORE acting on it — a stale available:false must not force the terminal
      // after a WS push/reset already advanced the chat.
      if (chatSessionId !== reqSession || chatCursor !== reqCursor) return; // superseded in flight
      if (!data.available) { noTranscript(); return; }
      chatAvailable = true;
      opts.showToggle(!headless); // opened on its chat with the socket down: the toggle once a transcript is there
      if (data.reset || data.sessionId !== chatSessionId) {
        chatSessionId = data.sessionId ?? null;
        chatCursor = data.cursor ?? 0;
        renderChatReset(data.items ?? []);
      } else {
        const next = data.cursor ?? chatCursor;
        if (next <= chatCursor) return; // no new items past what we've shown
        chatCursor = next;
        appendChatItems(data.items ?? []);
      }
    } catch {
      // transient; retry next tick
    }
  }

  // ── Pending-prompt panel (answer UI when the pane is blocked) ────────────────

  // When a claude pane is blocked (waiting for input) and chat is active, show an
  // answer panel above the input bar (ui/PromptPanel.tsx): the question and tappable
  // option buttons parsed from the live prompt, with the raw terminal screen as
  // collapsible context. The composer and quick-keys remain available.
  function showPrompt(p: PanelPrompt | null): void {
    prompt = p;
    opts.prompt(p);
  }

  function updatePromptPanel(): void {
    const status = findPane(paneId)?.pane?.agent?.status;
    const blocked = !headless && mode === 'chat' && status === 'blocked';
    if (!blocked) {
      // Pane is no longer waiting: the answer (if one was just sent) has landed. The
      // panel goes, and with it the post-send cooldown that was suppressing re-taps.
      if (prompt) showPrompt(null);
      stopPromptScreenPoll();
      return;
    }
    // A fresh blocked episode (panel was hidden, now shown): a distinct prompt, on a
    // new panel with no cooldown left from a prior answer.
    if (!prompt) showPrompt({ parsed: null, id: '', screen: null });
    startPromptScreenPoll();
  }

  // The prompt on screen: a new one only when its identity changes, so a poll tick
  // can't wipe a button the instant the user taps it, and a genuinely new prompt (even
  // one with the same parsed signature) does get fresh buttons. `sid` is the identity
  // of the screen `parsed` came from; `screen`, that screen (HTML).
  function renderPromptPanel(parsed: ParsedPrompt | null, sid: string, screen = prompt?.screen ?? null): void {
    if (!prompt) return; // the panel went meanwhile
    if (sid === prompt.id) { // same prompt still on screen — same buttons (keeps a tap from being wiped)
      if (screen !== prompt.screen) showPrompt({ ...prompt, screen });
      return;
    }
    // The answer moved the agent on to another prompt (the next question, the Submit tab
    // of several): it landed, and the user stays for that one.
    if (parsed && pendingAnswer && sid !== pendingAnswer.prompt) dropPendingAnswer();
    showPrompt({ parsed, id: sid, screen });
  }

  function startPromptScreenPoll(): void {
    if (promptScreenTimer) return;
    const tick = async (): Promise<void> => {
      if (promptPollActive) return; // a poll is in flight — don't overlap (so slow reads aren't all discarded)
      if (mode !== 'chat' || destroyed) { stopPromptScreenPoll(); return; }
      if (document.hidden) return; // a full screen read every 1.2s — skip while nobody can see it
      if (findPane(paneId)?.pane?.agent?.status !== 'blocked') { updatePromptPanel(); return; }
      const reqId = ++promptPollSeq;
      promptPollActive = reqId;
      try {
        const data = await apiGet<ReadResponse>(`/api/panes/${encodeURIComponent(paneId)}/read?source=visible&format=ansi`);
        // stopPromptScreenPoll bumps promptPollSeq to invalidate a poll from a prior
        // session; the in-flight guard means no concurrent tick supersedes this one.
        if (reqId !== promptPollSeq || destroyed || mode !== 'chat') return;
        const ansi = data.ansi ?? data.text ?? '';
        const stripped = stripAnsi(ansi);
        const parsed = parsePrompt(stripped);
        renderPromptPanel(parsed, parsed ? promptIdentity(stripped) : '', ansiToHtml(ansi));
      } catch { /* transient — keep the last screen */ } finally {
        if (promptPollActive === reqId) promptPollActive = 0; // only our own poll clears the guard
      }
    };
    void tick();
    promptScreenTimer = setInterval(() => { void tick(); }, PROMPT_SCREEN_INTERVAL_MS);
  }

  function stopPromptScreenPoll(): void {
    if (promptScreenTimer) { clearInterval(promptScreenTimer); promptScreenTimer = null; }
    promptPollSeq++;      // invalidate any in-flight poll so its late response can't render
    promptPollActive = 0; // let a fresh poll start after re-entering (the old one won't clear this)
  }

  // Read the live prompt off the screen: its parsed form and its region identity
  // (null if the read fails). `id` is '' when no prompt/menu is present.
  async function readPromptScreen(): Promise<{ parsed: ParsedPrompt | null; id: string } | null> {
    try {
      const d = await apiGet<ReadResponse>(`/api/panes/${encodeURIComponent(paneId)}/read?source=visible&format=ansi`);
      const stripped = stripAnsi(d.ansi ?? d.text ?? '');
      const parsed = parsePrompt(stripped);
      return { parsed, id: parsed ? promptIdentity(stripped) : '' };
    } catch { return null; }
  }

  function dropPendingAnswer(): void {
    if (pendingAnswer?.timer) clearTimeout(pendingAnswer.timer);
    pendingAnswer = null;
  }

  // After a tapped answer: the pane going `working` shows it reached the agent and the
  // agent moved on, so its drawer closes, back to the screen it was opened from
  // (answerOutcome). Several questions only get there after the Submit tab: each earlier
  // answer leaves the pane blocked on the next prompt (renderPromptPanel drops the
  // pending answer). A permission prompt is treated the same: Yes resumes work, while No
  // leaves the agent waiting for the user's instructions (blocked → done, no `working`,
  // seen live), so the user stays to type them.
  function settlePendingAnswer(): void {
    const a = pendingAnswer;
    if (!a) return;
    const status = findPane(paneId)?.pane?.agent?.status;
    if (status === 'working') a.resumed = true; // may come before the press is confirmed
    const outcome = answerOutcome(a.sent, a.resumed, status);
    if (outcome === 'wait') return;
    dropPendingAnswer();
    if (outcome === 'back' && a.back) closeAgent();
  }

  // ── Server messages, polling, visibility ────────────────────────────────────

  const unsubscribe = onWsMessage((msg: WsMessage) => {
    if (suspended) return; // its watch is the drawer's now: what comes is late
    if (msg.type === 'pane_output' && msg.paneId === paneId) {
      term.setAppScroll(msg.appScroll); // server decides from fresh scroll metadata
      term.render(msg.ansi);
    } else if (msg.type === 'transcript_items' && msg.paneId === paneId) {
      onTranscriptItems(msg);
    } else if (msg.type === 'agent_status' && msg.paneId === paneId) {
      // A tapped answer's pane going `working`: these events come one by one, while state
      // snapshots are debounced and can skip a short `working` (blocked → done).
      if (msg.to === 'working' && pendingAnswer) {
        pendingAnswer.resumed = true;
        settlePendingAnswer();
      }
      // Refresh the screen (not while hidden — visibilitychange re-reads it on return)
      if ((msg.to === 'blocked' || msg.to === 'done') && !document.hidden && !headless) void term.refresh();
    }
  });

  function startPaneRefresh(): void {
    if (paneRefreshTimer) return; // one at a time
    paneRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      // A claude pane's transcript may appear shortly after the pane opens (session
      // just started, JSONL not written yet). Re-probe until chat is found so the
      // view upgrades without a manual reload; non-claude panes are never probed.
      if (!chatAvailable && mode === 'terminal' && paneIsClaude(paneId)) {
        void initChatAvailability();
      }
      // While the WS watch is pushing, client polling is redundant — poll only as
      // a fallback when the socket is down, for whichever view is active.
      if (!store.wsConnected) {
        if (mode === 'chat') void pollChatFallback();
        else void term.refresh();
      }
    }, PANE_REFRESH_INTERVAL_MS);
  }

  // Back on screen: re-read what's shown. In chat mode the transcript watch keeps
  // pushing while the WS is up, so the HTTP fallback must only run when the socket is
  // down — otherwise a fallback response racing a WS push duplicates items and rewinds
  // chatCursor. (The shell's own listener resumes the watch and clears notifications.)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || suspended) return;
    if (mode === 'chat') { if (!store.wsConnected) void pollChatFallback(); }
    else void term.refresh();
  }, { signal });

  // Current screen first (small, fast), then the scrollback above it so the
  // view is continuously scrollable from the very first swipe; then polling, and
  // the probe for a Claude transcript (it reveals the toggle and switches to chat
  // when that's the preferred view).
  if (openingMode(paneId) === 'chat') {
    // straight to the chat: a headless orchestrator has no terminal; a Claude pane opens on its chat, not
    // its terminal first (its transcript's GET and watch tell; none: the terminal, then its first look)
    chatAvailable = true;
    startPaneRefresh();
    switchToChat(undefined, false);
  } else void (async () => {
    const startEpoch = epoch;
    await term.refresh();
    // Left (or suspended) while the first read was in flight: no history load against a gone view; a resume
    // looks at the terminal itself.
    if (destroyed || suspended || startEpoch !== epoch) return;
    void term.loadHistory().then((ok) => { if (ok) historyLoaded = true; });
    startPaneRefresh();
    void initChatAvailability();
  })();

  return {
    setMode(next, persist) {
      if (destroyed) return; // a late caller (an answer landing after the pane was left)
      if (suspended) { wanted = { mode: next, persist }; return; } // under a drawer: as it resumes
      if (next === 'chat') switchToChat(undefined, persist); else switchToTerminal(persist);
    },
    suspend() {
      if (destroyed) return;
      suspended = true;
      epoch++;
      term.setHeld(true);
      if (paneRefreshTimer) clearInterval(paneRefreshTimer);
      paneRefreshTimer = null;
      stopPromptScreenPoll();
      dropPendingAnswer();
    },
    resume() {
      if (destroyed || !suspended) return;
      suspended = false;
      term.setHeld(false);
      view.paneViewMode = mode;
      opts.showToggle(chatAvailable && !headless);
      opts.modeChanged();
      startPaneRefresh();
      updatePromptPanel();
      historyLoaded = false; // output may have scrolled into it under the drawer: the next look reads it again
      const w = wanted;
      wanted = null;
      if (w && w.mode !== mode) { // asked for under the drawer (a typing option's press landing)
        if (w.mode === 'chat') switchToChat(undefined, w.persist); else switchToTerminal(w.persist);
      } else if (mode === 'terminal') lookAtTerminal();
    },
    onState() {
      if (destroyed || suspended) return;
      updatePromptPanel(); // agent may have just become (un)blocked
      settlePendingAnswer(); // ...because a tapped answer landed
    },
    echo: headless ? () => {} : term.echo,
    answered(id, chat, post) {
      if (destroyed) return;
      // Tracked before the POST answers: the `working` push can beat its response.
      dropPendingAnswer();
      const pending: PendingAnswer = { prompt: id, back: !home && !chat, sent: false, resumed: false, timer: null };
      pendingAnswer = pending;
      post.then(() => {
        if (pendingAnswer !== pending) return; // left, or a newer answer took over
        pending.sent = true;
        pending.timer = setTimeout(() => {
          if (pendingAnswer !== pending) return;
          dropPendingAnswer();
          showToast('Answer not confirmed', 'The prompt is still waiting. Check the terminal.');
        }, ANSWER_CONFIRM_MS);
        settlePendingAnswer();
      }, () => {
        if (pendingAnswer === pending) dropPendingAnswer(); // not pressed: stay
      });
    },
    async reread(current) {
      if (suspended) return; // under a drawer: the resume polls the prompt anew
      const reqEpoch = epoch;
      const live = await readPromptScreen();
      if (current() && !destroyed && !suspended && reqEpoch === epoch) renderPromptPanel(live?.parsed ?? null, live?.id ?? '');
    },
    toBottom() {
      if (destroyed || mode !== 'chat') return;
      pinned = true; // a scroll up on its way unpins it again
      chatEl.scrollTo({ top: chatEl.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      reportJump();
    },
    destroy() {
      destroyed = true;
      listeners.abort();
      unsubscribe();
      if (paneRefreshTimer) clearInterval(paneRefreshTimer);
      stopPromptScreenPoll();
      dropPendingAnswer(); // left the pane: nothing to go back from
      term.destroy();
      chat.destroy();
    },
  };
}
