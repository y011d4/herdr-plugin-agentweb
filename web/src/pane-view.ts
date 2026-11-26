/**
 * pane-view.ts — the body of an opened pane (a pane route or a Home), in its container:
 * the terminal (terminal.ts) and the chat view of a Claude pane's transcript. It owns that DOM
 * and everything that feeds it: the transcript availability probe (one at a time), its WS
 * messages (pane_output, transcript_items, the pane's agent_status), the 3s refresh / fallback
 * polling and the pane's part of visibilitychange. For a blocked pane in chat it reads the
 * prompt off the screen (opts.prompt: ui/PromptPanel.tsx draws it and sends the answers) and
 * goes Back once a tapped answer lands. ui/Pane.tsx draws the rest (header, toggle button,
 * composer, Home's status bar and "doing now" line) and hears back through opts.
 * store.view.paneViewMode is its mode (wsSendWatch reads it). One per opened pane:
 * destroy() stops every timer and listener, and its late responses do nothing.
 */
import { ansiToHtml } from './ansi.ts';
import { apiGet } from './api.ts';
import { showToast } from './notify.ts';
import { answerOutcome, parsePrompt, promptIdentity, stripAnsi } from './prompt.ts';
import type { ParsedPrompt } from './prompt.ts';
import { orchestratorOfPane } from './routes.ts';
import { findPane, store } from './store.ts';
import { createTerminal } from './terminal.ts';
import { conversationItems, latestActivity, renderItems } from './transcript.ts';
import type { TimelineItem } from './transcript.ts';
import type { ReadResponse, TranscriptResponse, WsMessage, WsTranscriptItemsMessage } from './types.ts';
import { onWsMessage, wsSendWatch } from './ws.ts';

const STORAGE_VIEW = 'herdr_pane_view'; // preferred pane view: 'terminal' | 'chat'
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
  /** the toggle: chat or terminal; persist = remember it as the preferred view */
  setMode(mode: 'terminal' | 'chat', persist: boolean): void;
  /** a new State: the answer panel follows the pane's status */
  onState(): void;
  /** after input: re-read the terminal at once (terminal.ts echo) */
  echo(): void;
  /** a tapped answer to the prompt `id` is sent (`post`): once it lands and the agent resumes
   *  work, go Back to where the pane was opened from (not from Home, nor for "Chat about this": `chat`) */
  answered(id: string, chat: boolean, post: Promise<unknown>): void;
  /** after a 409: read the prompt on screen now and show it, unless `current()` turned false */
  reread(current: () => boolean): Promise<void>;
  destroy(): void;
}

// Chat is the default view; the terminal is only preferred if explicitly chosen.
function preferredView(): 'terminal' | 'chat' {
  return localStorage.getItem(STORAGE_VIEW) === 'terminal' ? 'terminal' : 'chat';
}

// Whether the state currently reports this pane as running Claude — the only
// kind that can ever have a transcript, so the only kind worth re-probing.
function paneIsClaude(paneId: string): boolean {
  const agent = findPane(paneId)?.pane?.agent;
  return (agent?.name ?? agent?.displayName ?? '').toLowerCase().includes('claude');
}

// A tapped answer until it is seen landing (settlePendingAnswer). `back`: where to go
// once the agent resumes work ('' = stay); `prompt`: the identity of the prompt it answers.
interface PendingAnswer {
  prompt: string; back: string;
  sent: boolean; resumed: boolean; timer: ReturnType<typeof setTimeout> | null;
}

export function createPaneView(container: HTMLElement, paneId: string, opts: PaneViewOpts): PaneView {
  const { view } = store;
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

  // ── Chat view (Claude Code transcript) ──────────────────────────────────────
  // A claude pane can be shown as its structured transcript instead of the raw
  // terminal (view.paneViewMode). Availability is probed per pane; the terminal stays the fallback.
  // chat view starts closed; availability is probed after the terminal loads
  view.paneViewMode = 'terminal';
  let chatAvailable = false;
  let chatSessionId: string | null = null;
  let chatCursor = 0; // byte offset into the transcript for incremental fetches
  let chatProbing = false; // an availability probe is in flight — prevents overlap
  let activity: string | null = null; // Home: latest tool call since the orchestrator last spoke

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
    try {
      const data = await apiGet<TranscriptResponse>(`/api/panes/${encodeURIComponent(paneId)}/transcript`);
      if (destroyed) return;
      chatAvailable = data.available;
      opts.showToggle(chatAvailable);
      // the orchestrator is someone to talk to: always open it as chat
      if (chatAvailable && (preferredView() === 'chat' || orchestratorOfPane(store.appState, paneId))) switchToChat(data, false);
      else opts.modeChanged(); // staying on the terminal: Home reveals its keys
    } catch {
      // leave the terminal view; toggle stays hidden (Home reveals the keys)
      if (!destroyed) opts.modeChanged();
    } finally {
      chatProbing = false;
    }
  }

  // persist=true only for an explicit user toggle; automatic switches (honoring an
  // existing preference, or falling back on a transient transcript miss) must not
  // rewrite the stored preference.
  function switchToChat(initial?: TranscriptResponse, persist = true): void {
    if (!chatAvailable || destroyed) return;
    view.paneViewMode = 'chat';
    if (persist) localStorage.setItem(STORAGE_VIEW, 'chat');
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
    view.paneViewMode = 'terminal';
    if (persist) localStorage.setItem(STORAGE_VIEW, 'terminal');
    chatEl.style.setProperty('display', 'none');
    terminalEl.style.setProperty('display', '');
    opts.modeChanged();
    updatePromptPanel(); // hide the answer panel (chat-only)
    wsSendWatch(); // server: stop transcript watch, resume pane watch
    void term.refresh(); // repaint the live screen the user returns to
  }

  async function loadChatInitial(): Promise<void> {
    // switchToChat starts the WS transcript watch alongside this request; if that
    // watch (or anything else) advances the chat state while this GET is in flight,
    // its result is stale — capture the start state and drop a mismatched reply so
    // the slower initial load can't replace a fresher log or rewind the cursor.
    const reqSession = chatSessionId;
    const reqCursor = chatCursor;
    try {
      const data = await apiGet<TranscriptResponse>(`/api/panes/${encodeURIComponent(paneId)}/transcript`);
      if (destroyed || view.paneViewMode !== 'chat') return;
      if (chatSessionId !== reqSession || chatCursor !== reqCursor) return; // superseded in flight
      if (!data.available) { chatAvailable = false; opts.showToggle(false); switchToTerminal(false); return; }
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
    const prevFromBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight;
    if (view.homeMode) {
      activity = latestActivity(items, null);
      opts.activity(activity);
      items = conversationItems(items);
    }
    if (items.length) chatEl.innerHTML = renderItems(items);
    else chatEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'chat-empty', textContent: 'No messages yet.' }));
    chatEl.scrollTop = preserveScroll
      ? (prevFromBottom < 40 ? chatEl.scrollHeight : prevTop)
      : chatEl.scrollHeight;
  }

  function appendChatItems(items: TimelineItem[]): void {
    if (items.length === 0) return;
    if (view.homeMode) {
      activity = latestActivity(items, activity);
      opts.activity(activity);
      items = conversationItems(items);
      if (items.length === 0) return;
    }
    // follow the bottom only if the user is already there — don't yank them out of
    // history they've scrolled up to read.
    const atBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 60;
    chatEl.querySelector('.chat-empty')?.remove();
    chatEl.insertAdjacentHTML('beforeend', renderItems(items));
    if (atBottom) chatEl.scrollTop = chatEl.scrollHeight;
  }

  function onTranscriptItems(msg: WsTranscriptItemsMessage): void {
    if (!msg.available) {
      chatAvailable = false;
      opts.showToggle(false);
      if (view.paneViewMode === 'chat') switchToTerminal(false);
      return;
    }
    chatAvailable = true;
    opts.showToggle(true);
    if (view.paneViewMode !== 'chat') return; // availability noted; content applies only in chat mode
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
    if (destroyed || view.paneViewMode !== 'chat') return;
    // The response is only valid against the state this request started from. If
    // anything (a WS reset/push, or a newer poll) advances the session or cursor
    // while the request is in flight, applying it — append OR reset — would
    // duplicate or rewind, so capture the start state and drop a mismatched reply.
    const reqCursor = chatCursor;
    const reqSession = chatSessionId;
    const q = chatSessionId ? `?session=${encodeURIComponent(chatSessionId)}&after=${reqCursor}` : '';
    try {
      const data = await apiGet<TranscriptResponse>(`/api/panes/${encodeURIComponent(paneId)}/transcript${q}`);
      if (destroyed || view.paneViewMode !== 'chat') return;
      // Drop any response whose request start no longer matches the current state
      // BEFORE acting on it — a stale available:false must not force the terminal
      // after a WS push/reset already advanced the chat.
      if (chatSessionId !== reqSession || chatCursor !== reqCursor) return; // superseded in flight
      if (!data.available) { chatAvailable = false; opts.showToggle(false); switchToTerminal(false); return; }
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
    const blocked = view.paneViewMode === 'chat' && status === 'blocked';
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
      if (view.paneViewMode !== 'chat' || destroyed) { stopPromptScreenPoll(); return; }
      if (document.hidden) return; // a full screen read every 1.2s — skip while nobody can see it
      if (findPane(paneId)?.pane?.agent?.status !== 'blocked') { updatePromptPanel(); return; }
      const reqId = ++promptPollSeq;
      promptPollActive = reqId;
      try {
        const data = await apiGet<ReadResponse>(`/api/panes/${encodeURIComponent(paneId)}/read?source=visible&format=ansi`);
        // stopPromptScreenPoll bumps promptPollSeq to invalidate a poll from a prior
        // session; the in-flight guard means no concurrent tick supersedes this one.
        if (reqId !== promptPollSeq || destroyed || view.paneViewMode !== 'chat') return;
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
  // agent moved on, so the view goes Back to where the pane was opened from
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
    if (outcome === 'back' && a.back) location.hash = a.back;
  }

  // ── Server messages, polling, visibility ────────────────────────────────────

  const unsubscribe = onWsMessage((msg: WsMessage) => {
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
      if ((msg.to === 'blocked' || msg.to === 'done') && !document.hidden) void term.refresh();
    }
  });

  function startPaneRefresh(): void {
    paneRefreshTimer = setInterval(() => {
      if (document.hidden) return;
      // A claude pane's transcript may appear shortly after the pane opens (session
      // just started, JSONL not written yet). Re-probe until chat is found so the
      // view upgrades without a manual reload; non-claude panes are never probed.
      if (!chatAvailable && view.paneViewMode === 'terminal' && paneIsClaude(paneId)) {
        void initChatAvailability();
      }
      // While the WS watch is pushing, client polling is redundant — poll only as
      // a fallback when the socket is down, for whichever view is active.
      if (!store.wsConnected) {
        if (view.paneViewMode === 'chat') void pollChatFallback();
        else void term.refresh();
      }
    }, PANE_REFRESH_INTERVAL_MS);
  }

  // Back on screen: re-read what's shown. In chat mode the transcript watch keeps
  // pushing while the WS is up, so the HTTP fallback must only run when the socket is
  // down — otherwise a fallback response racing a WS push duplicates items and rewinds
  // chatCursor. (The shell's own listener resumes the watch and clears notifications.)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (view.paneViewMode === 'chat') { if (!store.wsConnected) void pollChatFallback(); }
    else void term.refresh();
  }, { signal });

  // Current screen first (small, fast), then the scrollback above it so the
  // view is continuously scrollable from the very first swipe; then polling, and
  // the probe for a Claude transcript (it reveals the toggle and switches to chat
  // when that's the preferred view).
  void (async () => {
    await term.refresh();
    // Left while the first read was in flight: no history load against a gone view.
    if (destroyed) return;
    void term.loadHistory();
    startPaneRefresh();
    void initChatAvailability();
  })();

  return {
    setMode(mode, persist) {
      if (mode === 'chat') switchToChat(undefined, persist); else switchToTerminal(persist);
    },
    onState() {
      if (destroyed) return;
      updatePromptPanel(); // agent may have just become (un)blocked
      settlePendingAnswer(); // ...because a tapped answer landed
    },
    echo: term.echo,
    answered(id, chat, post) {
      if (destroyed) return;
      // Tracked before the POST answers: the `working` push can beat its response.
      dropPendingAnswer();
      const pending: PendingAnswer = { prompt: id, back: view.homeMode || chat ? '' : view.paneBackRoute, sent: false, resumed: false, timer: null };
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
      const live = await readPromptScreen();
      if (current() && !destroyed) renderPromptPanel(live?.parsed ?? null, live?.id ?? '');
    },
    destroy() {
      destroyed = true;
      listeners.abort();
      unsubscribe();
      if (paneRefreshTimer) clearInterval(paneRefreshTimer);
      stopPromptScreenPoll();
      dropPendingAnswer(); // left the pane: nothing to go back from
      term.destroy();
    },
  };
}
