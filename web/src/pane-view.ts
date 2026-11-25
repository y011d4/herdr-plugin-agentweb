/**
 * pane-view.ts — the body of an opened pane (a pane route or a Home), in its container:
 * the terminal (terminal.ts), the chat view of a Claude pane's transcript, and the answer
 * panel of a blocked one. It owns that DOM and everything that feeds it: the transcript
 * availability probe (one at a time), its WS messages (pane_output, transcript_items, the
 * pane's agent_status), the 3s refresh / fallback polling, the pane's part of
 * visibilitychange, and the answer guards. ui/Pane.tsx draws the rest (header, toggle button,
 * composer, Home's status bar and "doing now" line) and hears back through opts.
 * store.view.paneViewMode is its mode (wsSendWatch reads it). One per opened pane:
 * destroy() stops every timer and listener, and its late responses do nothing.
 */
import { ansiToHtml } from './ansi.ts';
import { apiGet, apiPost } from './api.ts';
import { showToast } from './notify.ts';
import { answerOutcome, parsePrompt, promptIdentity, stripAnsi } from './prompt.ts';
import type { ParsedPrompt } from './prompt.ts';
import { orchestratorOfPane } from './routes.ts';
import { findPane, store } from './store.ts';
import { createTerminal } from './terminal.ts';
import { conversationItems, latestActivity, renderItems } from './transcript.ts';
import type { TimelineItem } from './transcript.ts';
import type { ReadResponse, TranscriptResponse, WsMessage, WsTranscriptItemsMessage } from './types.ts';
import { BUILD } from './ui/Settings.tsx';
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
}

export interface PaneView {
  /** the toggle: chat or terminal; persist = remember it as the preferred view */
  setMode(mode: 'terminal' | 'chat', persist: boolean): void;
  /** a new State: the answer panel follows the pane's status */
  onState(): void;
  /** after input: re-read the terminal at once (terminal.ts echo) */
  echo(): void;
  destroy(): void;
}

function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  gen: number; prompt: string; back: string;
  sent: boolean; resumed: boolean; timer: ReturnType<typeof setTimeout> | null;
}

export function createPaneView(container: HTMLElement, paneId: string, opts: PaneViewOpts): PaneView {
  const { view } = store;
  container.innerHTML =
    '<div class="terminal-output" id="terminal-output"></div>' +
    '<div class="chat-log" id="chat-log" style="display:none;"></div>' +
    '<div class="chat-prompt" id="chat-prompt" style="display:none;"></div>';
  const [terminalEl, chatEl, promptEl] = Array.from(container.children) as HTMLElement[];
  const term = createTerminal(terminalEl, { paneId });
  const listeners = new AbortController();
  const { signal } = listeners;
  let destroyed = false;

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
  let promptPanelKind: 'none' | 'blocked' = 'none';
  let promptScreenTimer: ReturnType<typeof setInterval> | null = null;
  let promptScreenId = ''; // identity of the on-screen prompt whose buttons are rendered (avoids re-render churn; guards stale taps)
  let promptPollSeq = 0; // monotonic request id; bumped on stop to invalidate an in-flight poll
  let promptPollActive = 0; // reqId of the poll currently in flight (0 = none) — prevents overlap
  let promptAnswerInFlight = false; // true while/just after a tapped answer is sent — blocks re-taps
  let answerCooldownTimer: ReturnType<typeof setTimeout> | null = null; // floors the post-send re-tap block
  let answerGen = 0; // per-answer token so a stale POST/timer can't clear the guard for a newer answer
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
    chatEl.innerHTML = items.length ? renderItems(items) : '<div class="chat-empty">No messages yet.</div>';
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
  // answer panel above the input bar: the question and tappable option buttons
  // parsed from the live prompt, with the raw terminal screen as collapsible
  // context. The composer and quick-keys remain available.
  function updatePromptPanel(): void {
    const status = findPane(paneId)?.pane?.agent?.status;
    const blocked = view.paneViewMode === 'chat' && status === 'blocked';
    if (!blocked) {
      // Pane is no longer waiting: the answer (if one was just sent) has landed, so
      // end the post-send cooldown that was suppressing re-taps.
      if (promptPanelKind !== 'none') { promptEl.style.display = 'none'; promptEl.innerHTML = ''; promptPanelKind = 'none'; promptScreenId = ''; }
      endAnswerCooldown();
      stopPromptScreenPoll();
      return;
    }
    if (promptPanelKind !== 'blocked') {
      // A fresh blocked episode (panel was hidden, now shown): a distinct prompt, so
      // clear any lingering cooldown from a prior answer before rendering its buttons.
      endAnswerCooldown();
      promptEl.style.display = '';
      promptEl.innerHTML =
        `<div class="chat-prompt-head">&#9203; Waiting for your input <span class="chat-prompt-build">${BUILD}</span></div>` +
        '<div class="chat-prompt-q" id="chat-prompt-q"></div>' +
        '<div class="chat-prompt-options" id="chat-prompt-options"></div>' +
        // starts open (no buttons yet, so the terminal is the only UI);
        // renderPromptPanel collapses it once a menu is parsed.
        '<details class="chat-prompt-term" id="chat-prompt-term" open><summary>Terminal</summary>' +
        '<div class="chat-prompt-screen" id="chat-prompt-screen"><span class="loading-spinner"></span></div></details>';
      promptPanelKind = 'blocked';
      promptScreenId = '';
    }
    startPromptScreenPoll();
  }

  // Clear the "answer just sent" state: re-enable the option buttons and drop the
  // in-flight guard. Called when the pane leaves `blocked` (answer landed) or a fresh
  // prompt appears, and by a timeout floor in case neither is observed.
  function endAnswerCooldown(): void {
    if (answerCooldownTimer) { clearTimeout(answerCooldownTimer); answerCooldownTimer = null; }
    promptAnswerInFlight = false;
    promptEl.classList.remove('chat-prompt-sending');
  }

  // Render the question + option buttons. Rebuild only when the prompt identity
  // changes, so a poll tick can't wipe a button the instant the user taps it, and a
  // genuinely new prompt (even one with the same parsed signature) does get fresh
  // buttons. `sid` is the identity of the screen `parsed` came from.
  function renderPromptPanel(parsed: ParsedPrompt | null, sid: string): void {
    const optsEl = promptEl.querySelector<HTMLElement>('#chat-prompt-options');
    if (!optsEl) return;
    if (sid === promptScreenId) return; // same prompt still on screen — don't rebuild (keeps a tap from being wiped)
    promptScreenId = sid;
    // The answer moved the agent on to another prompt (the next question, the Submit tab
    // of several): it landed, and the user stays for that one.
    if (parsed && pendingAnswer && sid !== pendingAnswer.prompt) dropPendingAnswer();
    const qEl = promptEl.querySelector('#chat-prompt-q');
    if (qEl) qEl.textContent = parsed?.question ?? '';
    optsEl.innerHTML = (parsed?.options ?? []).map((o) =>
      `<button class="ask-opt" type="button" data-ask-send="${escHtml(o.send)}"><span class="ask-opt-num">${escHtml(o.send)}</span>` +
      `<span class="ask-opt-text"><span class="ask-opt-label">${escHtml(o.label)}</span>` +
      (o.description ? `<span class="ask-opt-desc">${escHtml(o.description)}</span>` : '') + '</span></button>',
    ).join('');
    const termEl = promptEl.querySelector<HTMLDetailsElement>('#chat-prompt-term');
    // Collapse the terminal only when we have a question to show above the buttons.
    // If a menu parsed but its question couldn't be extracted, bare "Yes/No" buttons
    // would have no context — keep the terminal open so the user can read the prompt.
    if (termEl) termEl.open = !parsed?.question;
    // A different prompt is now on screen (its buttons were just rebuilt, so they are
    // NOT the stale answered ones) — end any post-answer cooldown so these fresh buttons
    // are immediately tappable, even if the pane went blocked→blocked without an observed
    // unblock. A transient unparsable screen (parsed === null) is left to the
    // unblock/floor path, not treated as a new prompt.
    if (parsed) endAnswerCooldown();
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
        renderPromptPanel(parsed, parsed ? promptIdentity(stripped) : '');
        const screen = promptEl.querySelector('#chat-prompt-screen');
        if (screen) screen.innerHTML = ansiToHtml(ansi);
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

  // Answer by selecting the tapped option. Pressing an option's digit in a numbered
  // menu selects AND submits it in one atomic keystroke — verified live: sending "3"
  // to an AskUserQuestion answered "cherry" with no Enter and no cursor movement. The
  // digit goes as a raw keystroke via send_text (`press`): a digit through send_input
  // is bracketed-paste-wrapped and ignored, and keys:[digit] is dropped by herdr (both
  // verified live). Selection is by number, so the ❯ cursor's position is irrelevant.
  //
  // The buttons are only re-rendered on the ~1.2s poll, so the prompt on screen may
  // have changed (answered on the desktop, timed out) since they were drawn. We send
  // the buttons' prompt identity as `expect_prompt`; the bridge re-reads the screen and
  // presses the digit ONLY if it still matches — check and send back-to-back on the
  // server, so nothing can slip in between (a client-side check would leave a round-trip
  // gap). A mismatch returns 409 and we refresh. An in-flight guard and a per-answer
  // generation token keep double-taps and stale async work off the shared guard.
  async function sendAskAnswer(target: string, btn: HTMLElement): Promise<void> {
    if (destroyed || promptAnswerInFlight) return;
    const to = parseInt(target, 10);
    // Claude's prompts never exceed ~6 options, so every option is a single digit; a
    // multi-digit option would submit on its first digit, so refuse it and leave the
    // terminal (always shown below) as the way to answer that out-of-range case.
    if (!Number.isInteger(to) || to < 1 || to > 9) return;
    const expectedId = promptScreenId; // region identity of the prompt these buttons belong to
    if (!expectedId) return;
    const myGen = ++answerGen; // token for THIS answer; a stale POST/timer must not touch a newer one
    promptAnswerInFlight = true;
    if (answerCooldownTimer) { clearTimeout(answerCooldownTimer); answerCooldownTimer = null; }
    promptEl.classList.add('chat-prompt-sending'); // disable the buttons while the answer settles
    btn.classList.add('ask-opt-sent');
    // Go Back once the agent resumes work — not from Home, and not for "Chat about this",
    // which hands the turn back to the user in this pane. Tracked before the POST: the
    // `working` push can beat its response.
    const chat = /^Chat about this/i.test(btn.querySelector('.ask-opt-label')?.textContent ?? '');
    dropPendingAnswer();
    const pending: PendingAnswer = {
      gen: myGen, prompt: expectedId, back: view.homeMode || chat ? '' : view.paneBackRoute,
      sent: false, resumed: false, timer: null,
    };
    pendingAnswer = pending;
    try {
      await apiPost(`/api/panes/${encodeURIComponent(paneId)}/input`, { press: String(to), expect_prompt: expectedId });
      if (destroyed || myGen !== answerGen) return; // left, or a newer tap superseded this — don't touch shared state
      if (pendingAnswer === pending) {
        pending.sent = true;
        pending.timer = setTimeout(() => {
          if (pendingAnswer !== pending) return;
          dropPendingAnswer();
          showToast('Answer not confirmed', 'The prompt is still waiting. Check the terminal.');
        }, ANSWER_CONFIRM_MS);
        settlePendingAnswer();
      }
      // The digit already submitted this prompt, but the panel keeps showing it (with
      // tappable buttons) until the pane's status refreshes. Hold the guard through
      // that window so a double-tap can't fire the same digit again into the *next*
      // prompt or the terminal. It's released the moment the pane leaves `blocked` or a
      // fresh prompt renders (endAnswerCooldown); this timer is only a floor, and it
      // no-ops if a newer answer has since started.
      answerCooldownTimer = setTimeout(() => { if (myGen === answerGen) endAnswerCooldown(); }, 1500);
    } catch (err) {
      if (myGen !== answerGen) return; // superseded — the newer answer owns the guard now
      if (pendingAnswer === pending) dropPendingAnswer(); // not pressed: stay
      btn.classList.remove('ask-opt-sent');
      endAnswerCooldown();
      if ((err as { code?: string }).code === 'prompt_changed') {
        // The prompt advanced before the digit landed — refresh to the live prompt and
        // let the user retap; never send into a different prompt.
        const live = await readPromptScreen();
        if (myGen === answerGen && !destroyed) renderPromptPanel(live?.parsed ?? null, live?.id ?? '');
        showToast('Prompt changed', 'The prompt updated before your tap was sent — try again.');
      } else {
        showToast('Send failed', (err as Error).message);
      }
    }
  }

  // Answer a pending prompt: tapping an option sends its menu key.
  promptEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.ask-opt') as HTMLElement | null;
    if (!btn) return;
    const send = btn.dataset.askSend;
    if (send) void sendAskAnswer(send, btn);
  }, { signal });

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
    destroy() {
      destroyed = true;
      listeners.abort();
      unsubscribe();
      if (paneRefreshTimer) clearInterval(paneRefreshTimer);
      stopPromptScreenPoll();
      if (answerCooldownTimer) clearTimeout(answerCooldownTimer);
      dropPendingAnswer(); // left the pane: nothing to go back from
      term.destroy();
    },
  };
}
