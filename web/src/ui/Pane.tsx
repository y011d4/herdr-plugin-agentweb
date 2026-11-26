/**
 * ui/Pane.tsx — an opened pane (#/pane/<id>) or an orchestrator's Home (#/home/<name>): the topbar,
 * Home's status bar (the switcher between running orchestrators, the agents waiting on the user,
 * the counts, Clear and Stop) and "doing now" line, the composer and the quick keys, around the pane's body. The
 * body (terminal, chat) is pane-view.ts, imperative, in #pane-view: created on mount, destroyed on
 * unmount, one at a time. Below it, while the view reports a prompt, the answer panel (PromptPanel.tsx).
 *
 * State pushes re-render it constantly. The composer's textarea is uncontrolled (React never sets its
 * value), so a push never resets what is being typed, an IME composition included.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import { apiPost } from '../api.ts';
import { DESKTOP_QUERY, enterSends } from '../composer-keys.ts';
import { homeSummary, shownStatus } from '../dashboard-group.ts';
import { showToast } from '../notify.ts';
import { createPaneView, type PanelPrompt, type PaneView } from '../pane-view.ts';
import { homeAgentsHash, orchestratorOfPane, paneRoute } from '../routes.ts';
import { emit, findPane, keptTasks, store, subscribe } from '../store.ts';
import type { AppState } from '../types.ts';
import { agentCards, cardTitle, orchestratorLabel } from './Dashboard.tsx';
import type { Topbar } from './App.tsx';
import { PromptPanel } from './PromptPanel.tsx';

type Mode = 'terminal' | 'chat';

// The open pane's view, and what it last reported, which its topbar shows too: whether the pane has a
// transcript (the terminal ⇄ chat toggle shows) and its mode (null: not reported yet).
let paneView: PaneView | null = null;
const NO_TOGGLE: { shown: boolean; mode: Mode | null } = { shown: false, mode: null };
let toggle = NO_TOGGLE;
const setToggle = (t: Partial<typeof toggle>): void => { toggle = { ...toggle, ...t }; emit(); };
const useToggle = () => useSyncExternalStore(subscribe, () => toggle);
const useAppState = (): AppState | null => useSyncExternalStore(subscribe, () => store.appState);
let shownInput: HTMLTextAreaElement | null = null; // the composer on screen

/** A new State: the answer panel follows the open pane's status. */
export function paneViewOnState(): void {
  paneView?.onState();
}

/** Leaving the pane (or Home) on screen: its view stops, and its late responses do nothing. The
 *  toggle resets now, not at the unmount: the next screen renders before that. */
export function closePaneView(): void {
  paneView?.destroy();
  paneView = null;
  toggle = NO_TOGGLE;
}

const KEYS: Array<[string, Record<string, unknown>]> = [
  ['Enter', { keys: ['enter'] }],
  ['⌫', { keys: ['backspace'] }],
  ['Esc', { keys: ['esc'] }],
  ['Ctrl+C', { keys: ['ctrl+c'] }],
  ['↑', { keys: ['up'] }],
  ['↓', { keys: ['down'] }],
  ['Tab', { keys: ['tab'] }],
  ['y', { text: 'y', enter: true }],
  ['n', { text: 'n', enter: true }],
  ['1', { text: '1' }],
  ['2', { text: '2' }],
  ['3', { text: '3' }],
];

const inputUrl = (paneId: string): string => `/api/panes/${encodeURIComponent(paneId)}/input`;

async function sendKey(paneId: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await apiPost(inputUrl(paneId), payload);
    paneView?.echo();
  } catch (err) {
    showToast('Key send failed', (err as Error).message);
  }
}

/** A Home's Clear and Stop (App.tsx's confirm flows), on its status bar: a Home has no ⋮. */
export type HomeActions = { clear: () => void; stop: () => void };

export function Pane({ paneId, home, actions }: { paneId: string; home: boolean; actions?: HomeActions }) {
  const state = useAppState();
  const { mode } = useToggle();
  const [activity, setActivity] = useState<string | null>(null); // Home: the latest tool call since it last spoke
  const [prompt, setPrompt] = useState<PanelPrompt | null>(null); // the answer panel's, while blocked in chat
  const body = useRef<HTMLDivElement>(null);
  // Reads the screen first, then the scrollback, then polls and probes for a transcript.
  useEffect(() => {
    const view = createPaneView(body.current!, paneId, {
      showToggle: (shown) => setToggle({ shown }),
      modeChanged: () => setToggle({ mode: store.view.paneViewMode }),
      activity: setActivity,
      prompt: setPrompt,
    });
    paneView = view;
    return () => {
      view.destroy();
      if (paneView === view) paneView = null;
      toggle = NO_TOGGLE;
      setPrompt(null);
    };
  }, [paneId]);
  // "doing now": only while the orchestrator works — its latest tool call, or "thinking…" between them
  const working = findPane(paneId)?.pane?.agent?.status === 'working';
  return (
    <div id="screen-pane" className={home ? 'screen-home' : undefined} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {home && <HomeStatus paneId={paneId} state={state} actions={actions} />}
      <div id="pane-view" ref={body} style={{ display: 'contents' }}></div>
      {prompt && paneView && <PromptPanel paneId={paneId} prompt={prompt} view={paneView} />}
      {home && (
        <div className="home-activity" id="home-activity" style={working ? undefined : { display: 'none' }}>
          {working ? (activity ? `▸ ${activity}` : 'thinking…') : null}
        </div>
      )}
      <div className="input-bar">
        <Composer paneId={paneId} home={home} />
        {/* Home hides the terminal keys while chatting; they come back with the terminal */}
        <div className="quickkey-row" id="quickkey-row" style={home && mode !== 'terminal' ? { display: 'none' } : undefined}>
          {KEYS.map(([label, payload]) => (
            <button key={label} className="qkey" onClick={() => { void sendKey(paneId, payload); }}>{label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Home status bar: with several orchestrators running a switcher between their Homes (tap = that
// orchestrator's pane, which routes to its Home like any chip), its agents waiting on the user
// (tap → that agent) and counts of the rest (tap → its list), then the orchestrator's Clear and Stop.
function HomeStatus({ paneId, state, actions }: { paneId: string; state: AppState | null; actions?: HomeActions }) {
  if (!state) return <div className="home-status" id="home-status"></div>;
  const s = homeSummary(agentCards(state, orchestratorOfPane(state, paneId)), store.seenDone);
  const running = (state.orchestrators ?? []).filter((o) => o.paneId);
  const open = (id: string): void => { location.hash = paneRoute(store.appState, id); };
  return (
    <div className="home-status" id="home-status">
      {running.length >= 2 && (
        <div className="home-switch">
          {running.map((o) => {
            const pane = findPane(o.paneId!)?.pane;
            const st = pane?.agent ? shownStatus(pane, store.seenDone) : 'unknown';
            return (
              <button key={o.paneId} className={`home-switch-btn${o.paneId === paneId ? ' active' : ''}`} data-pane-id={o.paneId!} onClick={() => open(o.paneId!)}>
                <i className={`home-dot ${st}`}></i>{orchestratorLabel(o)}
              </button>
            );
          })}
        </div>
      )}
      {s.blocked.length > 0 && (
        <div className="home-attn">
          <span className="home-attn-label">Needs you</span>
          {s.blocked.map((c) => (
            <button key={c.pane.paneId} className="home-chip" data-pane-id={c.pane.paneId} onClick={() => open(c.pane.paneId)}>
              {cardTitle(c)}<span className="home-chip-ws">{c.workspaceLabel}</span>
            </button>
          ))}
        </div>
      )}
      <div className="home-row">
        <button className="home-counts" data-go="agents" onClick={() => { location.hash = homeAgentsHash(location.hash); }}>
          <span><i className="home-dot working"></i>{`${s.working} working`}</span>
          <span><i className="home-dot done"></i>{`${s.done} done`}</span>
          <span><i className="home-dot idle"></i>{`${s.idle} idle`}</span>
          <span className="home-counts-more">All agents &#8250;</span>
        </button>
        {actions && (
          <span className="home-actions">
            <button className="home-action" id="btn-home-clear" onClick={actions.clear}>Clear</button>
            <button className="home-action danger" id="btn-home-stop" onClick={actions.stop}>Stop</button>
          </span>
        )}
      </div>
    </div>
  );
}

const autoGrow = (t: HTMLTextAreaElement): void => {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
};

// The one composer: an agent's pane and an orchestrator's Home alike. On a touch device Enter
// inserts a newline and only the Send button sends, so the phone keyboard can't fire off half-typed
// commands; on a PC Enter sends and Shift+Enter inserts a newline (composer-keys.ts).
function Composer({ paneId, home }: { paneId: string; home: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [placeholder] = useState(() => (home ? `Message ${orchestratorLabel(orchestratorOfPane(store.appState, paneId))}…` : 'Send text…'));
  // A new agent's first task the bridge couldn't deliver lands here, ready to send, and stays (with
  // the user's edits) until sent, so leaving the pane doesn't lose it. While its send is in flight the
  // composer is locked, here and in a view reopened meanwhile.
  useLayoutEffect(() => {
    const t = input.current!;
    shownInput = t;
    const draft = keptTasks.draft(paneId);
    if (draft !== null) {
      t.value = draft;
      autoGrow(t);
    }
    t.disabled = keptTasks.sending(paneId);
    return () => { if (shownInput === t) shownInput = null; };
  }, [paneId]);

  const send = async (): Promise<void> => {
    const t = input.current!;
    const text = t.value;
    if (!text || keptTasks.sending(paneId)) return;
    const kept = keptTasks.beginSend(paneId, text); // false unless the pane has a kept task
    if (kept) t.disabled = true;
    let restored: string | null = null;
    try {
      // clear:true wipes the pane's composer first so this message submits on its own — never
      // merged with a half-typed draft the user left in the pane that yoicks can't see. Scope it
      // to Claude Code panes: Ctrl+U safely clears Claude's input box, but to another app it's a
      // raw control byte a full-screen / non-readline TUI could act on. Other panes just get
      // text+enter. enter:true then submits in the same request.
      const isClaude = findPane(paneId)?.pane?.agent?.name === 'claude';
      await apiPost(inputUrl(paneId), { text, enter: true, ...(isClaude ? { clear: true } : {}) });
      if (kept) keptTasks.finishSend(paneId, true);
      if (t.value === text) { // clear on success, but keep text typed mid-send
        t.value = '';
        autoGrow(t);
      }
      paneView?.echo();
    } catch (err) {
      if (kept) restored = keptTasks.finishSend(paneId, false);
      showToast('Send failed', (err as Error).message);
    } finally {
      if (kept) {
        // Unlock the pane's composer as displayed now — this one, or one reopened during the send
        // (this textarea is then detached) — and on failure show the task in it again.
        t.disabled = false;
        const live = store.view.activePaneId === paneId ? shownInput : null;
        if (live) {
          live.disabled = false;
          if (restored !== null) {
            live.value = restored;
            autoGrow(live);
          }
        }
      }
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const key = e.nativeEvent; // React's event has no isComposing: an IME's confirming Enter must never send
    if (!enterSends(key, matchMedia(DESKTOP_QUERY).matches)) return;
    e.preventDefault();
    if (!key.repeat) void send(); // a held Enter sends once, not once per auto-repeat
  };

  return (
    <div className="input-row">
      <textarea id="pane-input" ref={input} rows={1} placeholder={placeholder} autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onKeyDown={onKeyDown} onInput={(e) => { autoGrow(e.currentTarget); keptTasks.edit(paneId, e.currentTarget.value); }}></textarea>
      <button className="input-send-btn" id="btn-send-enter" onClick={() => { void send(); }}>Send</button>
    </div>
  );
}

// The title: the pane's agent and where it is, or for a Home the orchestrator and what it's up to.
// A pane gone from the State keeps its last title (a Home holds through its orchestrator's replacement).
function Title({ paneId, home }: { paneId: string; home: boolean }) {
  const state = useAppState();
  const last = useRef<ReactNode>(null);
  const found = findPane(paneId);
  if (found || last.current === null) {
    if (home) {
      const st = found?.pane?.agent?.status ?? '';
      const sub = st === 'working' ? 'working…' : st === 'blocked' ? 'needs you' : 'ready';
      last.current = <>{orchestratorLabel(orchestratorOfPane(state, paneId))}<span className={`topbar-subtitle home-state ${st}`}>{`· ${sub}`}</span></>;
    } else {
      const label = found?.pane?.agent?.displayName || found?.pane?.agent?.name || found?.pane?.title || paneId;
      const context = found ? `${found.ws.label} / ${found.tab.label}` : '';
      last.current = <>{label}{context ? <span className="topbar-subtitle">{`· ${context}`}</span> : null}</>;
    }
  }
  return last.current;
}

// terminal ⇄ chat, hidden until the pane has a transcript (on a Home: Esc / Ctrl+C / arrows live in the terminal's keys)
function ViewToggle({ home }: { home: boolean }) {
  const { shown, mode } = useToggle();
  const label = home ? (mode === 'terminal' ? 'Chat' : '>_') : (mode === 'chat' ? 'Terminal' : 'Chat');
  return (
    <button className={`topbar-action view-toggle${home ? ' home-view-toggle' : ''}`} id="btn-view-toggle" style={shown ? undefined : { display: 'none' }}
      aria-label={home ? 'Toggle terminal' : undefined} onClick={() => paneView?.setMode(store.view.paneViewMode === 'chat' ? 'terminal' : 'chat', !home)}>
      {label}
    </button>
  );
}

/** The topbar: a pane's Back (to `back`), a Home's Agents; the view toggle; a pane's agent-actions
 *  kebab (`menu`: rename, clear, stop), a Home's Settings (its Clear and Stop are on its status bar). */
export const paneTopbar = (paneId: string, home: boolean, back: string, menu: () => void): Topbar => ({
  title: <Title paneId={paneId} home={home} />,
  left: home ? undefined : (
    <button className="topbar-back" aria-label="Back" onClick={() => { location.hash = back; }}>{`← ${back.startsWith('#/home/') ? 'Home' : 'Agents'}`}</button>
  ),
  right: (
    <>
      {home && <button className="topbar-action home-agents-btn" id="btn-home-agents" onClick={() => { location.hash = homeAgentsHash(location.hash); }}>Agents</button>}
      <ViewToggle home={home} />
      {home
        ? <button className="topbar-action" id="btn-settings" aria-label="Settings" onClick={() => { location.hash = '#/settings'; }}>&#9881;</button>
        : <button className="topbar-action" id="btn-agent-menu" aria-label="Agent actions" onClick={menu}>&#8942;</button>}
    </>
  ),
});
