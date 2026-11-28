/**
 * ui/Pane.tsx — an opened pane (#/pane/<id>, in ui/AgentDrawer.tsx's drawer, with the header pieces
 * here: PaneTitle, ViewToggle, AgentMenu) or an orchestrator's Home (#/home/<name>): Home's topbar,
 * Home's status bar (the switcher between running orchestrators, then one row: "Needs you · n", the
 * counts, and ⋮: a headless one's Compact, Clear and Stop) and "doing now" line, the composer and the quick keys, around the pane's body. The
 * body (terminal, chat) is pane-view.ts, imperative, in #pane-view: created on mount, destroyed on
 * unmount, one at a time. Below it, while the view reports a prompt, the answer panel (PromptPanel.tsx).
 * A pane's chat is read-only: its composer and keys show with its terminal,
 * and while it works ■ Interrupt sends Esc.
 * A headless orchestrator's Home (hl:<name>: no herdr pane) sends through /api/orchestrators/:name/*,
 * has ■ on its "doing now" line, its usage, model and warnings on the status bar and its question (the
 * State's headless.pending) in HeadlessPrompt; no terminal and no keys. While the question is open the
 * composer sends nothing but its Chat about this (Composer's `question`). A Home's composer also takes a quote
 * (a Reply on a message in its chat, an Ask on a to-do item), shown above it and sent before its text.
 *
 * State pushes re-render it constantly. The composer's textarea is uncontrolled (React never sets its
 * value), so a push never resets what is being typed, an IME composition included.
 */
import { ActionIcon, Button, CloseButton, FileButton, Group, Image, Indicator, Menu, NativeSelect, NavLink, Popover, SegmentedControl, Stack, Text, Textarea, UnstyledButton } from '@mantine/core';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { apiPost, headlessName, orchestratorPost } from '../api.ts';
import { DESKTOP_QUERY, enterSends } from '../composer-keys.ts';
import { draftKey, getDraft, getQuote, onQuote, pruneDrafts, setDraft, setQuote } from '../drafts.ts';
import { byUrgency, homeSummary, orchestratorStatus, type HomeSummary } from '../dashboard-group.ts';
import { fitImages, MAX_IMAGES, toAttachment, type ImageAttachment } from '../image.ts';
import { showToast } from '../notify.ts';
import { createPaneView, type PanelPrompt, type PaneView } from '../pane-view.ts';
import { parseQuote, type QuoteOf } from '../transcript.ts';
import { homeAgentsHash, homeHash, orchestratorOfPane } from '../routes.ts';
import { emit, findPane, store, subscribe } from '../store.ts';
import { dueLabel } from '../todos.ts';
import type { AppState, HeadlessCompact, HeadlessModel, HeadlessUsage, OrchestratorView } from '../types.ts';
import { QuoteText } from './ChatLog.tsx';
import { AgentRow, TopbarIcon, agentCards, orchestratorLabel, relativeTime, useHeldState } from './Dashboard.tsx';
import { StatusDot } from './Status.tsx';
import { NeedsBadge, NeedsButton, needsYou, useMinute } from './Todos.tsx';
import type { Topbar } from './App.tsx';
import { openCompact, previewImage } from './Modals.tsx';
import { answersSoFar, HeadlessPrompt, PromptPanel } from './PromptPanel.tsx';
import { TuiSteps } from './Settings.tsx';

type Mode = 'terminal' | 'chat';

// The open pane's view, and what it last reported for its pane, which its header shows too: whether the
// pane has a transcript (the terminal ⇄ chat toggle shows) and its mode (null: not reported yet). Keyed
// on the pane: a closing drawer's late unmount can't reset the next screen's.
let paneView: PaneView | null = null;
interface Toggle { shown: boolean; mode: Mode | null }
const NO_TOGGLE: Toggle = { shown: false, mode: null };
const toggles = new Map<string, Toggle>(); // per pane: a Home waiting under a drawer keeps its own
const setToggle = (paneId: string, t: Partial<Toggle>): void => {
  toggles.set(paneId, { ...(toggles.get(paneId) ?? NO_TOGGLE), ...t });
  emit();
};
/** What `paneId`'s view last reported (nothing once it is gone). */
const useToggle = (paneId: string): Toggle => useSyncExternalStore(subscribe, () => toggles.get(paneId) ?? NO_TOGGLE);
const useAppState = (): AppState | null => useSyncExternalStore(subscribe, () => store.appState);
let shownInput: HTMLTextAreaElement | null = null; // the composer on screen
let shownKey = ''; // and its draft's key (drafts.ts)
// The text of each draft key's send in flight (the latest): a composer reopened meanwhile doesn't show
// it, so it isn't sent twice. Storage keeps it until the send succeeds: a reload mid-send can't lose it.
const sendingDrafts = new Map<string, string>();

/** A new State: the answer panel follows the open pane's status. */
export function paneViewOnState(): void {
  paneView?.onState();
}

/** Leaving the pane (or Home) on screen: its view stops, and its late responses do nothing. The
 *  toggle resets now, not at the unmount: the next screen renders before that. */
export function closePaneView(): void {
  paneView?.destroy();
  paneView = null;
  for (const id of toggles.keys()) if (id !== waitingPane) toggles.delete(id); // a waiting Home's stays
}

// A Home's view waiting under a drawer (suspended), until the drawer closes back onto it or the Home goes.
let waiting: PaneView | null = null;
let waitingPane = '';
let paneViewPane = ''; // paneView's pane

/** A drawer opens over the Home on screen: its view waits, its DOM as it is. */
export function suspendPaneView(): void {
  paneView?.suspend();
  waiting = paneView;
  waitingPane = paneView ? paneViewPane : '';
  paneView = null;
}

/** The drawer closed back onto that Home: its view goes on (false: there was none, e.g. a stopped Home). */
export function resumePaneView(): boolean {
  if (!waiting) return false;
  paneView = waiting;
  paneViewPane = waitingPane;
  waiting = null;
  waitingPane = '';
  paneView.resume();
  return true;
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

async function interrupt(name: string): Promise<void> {
  try {
    await orchestratorPost(name, 'interrupt');
  } catch (err) {
    showToast('Interrupt failed', (err as Error).message);
  }
}

/** A Home's Clear and Stop (App.tsx's confirm flows), in its status bar's ⋮ (HomeMenu). */
export type HomeActions = { clear: () => void; stop: () => void };

/** A pane, or (with `home`: the orchestrator `name`) a running orchestrator's Home. */
export function Pane({ paneId, home, actions, name = '' }: { paneId: string; home: boolean; actions?: HomeActions; name?: string }) {
  const state = useAppState();
  const { mode } = useToggle(paneId);
  const [activity, setActivity] = useState<string | null>(null); // Home: the latest tool call since it last spoke
  const [prompt, setPrompt] = useState<PanelPrompt | null>(null); // the answer panel's, while blocked in chat
  const [jump, setJump] = useState<{ unread: boolean } | null>(null); // the chat's ↓, while scrolled up from its end
  const body = useRef<HTMLDivElement>(null);
  const own = useRef<PaneView | null>(null); // this screen's view (paneView: the one on show, a drawer's over a Home)
  // Reads the screen first, then the scrollback, then polls and probes for a transcript.
  useEffect(() => {
    const view = createPaneView(body.current!, paneId, {
      showToggle: (shown) => setToggle(paneId, { shown }),
      modeChanged: () => setToggle(paneId, { mode: store.view.paneViewMode }),
      activity: setActivity,
      prompt: setPrompt,
      jump: (away, unread) => setJump(away ? { unread } : null),
      // a Home's: into its draft, but not while its question is open (the composer is the question's then)
      reply: (quote) => {
        const hl = headlessName(paneId);
        if (hl && store.appState?.orchestrators?.find((o) => o.name === hl)?.headless?.pending) {
          showToast('Answer the question first', 'Replies wait while its question is open.');
          return;
        }
        setQuote(draftKey(paneId, name), quote);
      },
    });
    paneView = own.current = view;
    paneViewPane = paneId;
    return () => {
      view.destroy();
      if (paneView === view) paneView = null;
      if (waiting === view) { waiting = null; waitingPane = ''; }
      toggles.delete(paneId);
      setPrompt(null);
      setJump(null);
    };
  }, [paneId]);
  // "doing now": only while the orchestrator works — its latest tool call, or "thinking…" between them
  const working = findPane(paneId)?.pane?.agent?.status === 'working';
  // A pane's chat is for reading: typing and keys are its terminal's (one tap away). Shown until the
  // view is in chat: a bar showing up later would shrink a terminal already scrolled to its bottom
  // (hiding one grows the chat).
  const readOnly = !home && mode === 'chat';
  const hl = headlessName(paneId);
  const headless = hl ? state?.orchestrators?.find((o) => o.name === hl)?.headless : null;
  const pending = headless?.pending;
  // a compaction: "compacting…" while it runs, then how it went, until the next turn begins
  const compacting = headless?.compact?.state === 'running';
  const compacted = headless?.compact && !compacting ? compactLine(headless.compact) : null;
  const [chatting, setChatting] = useState(''); // the question whose Chat about this was pressed: the composer writes about it
  const chatOn = !!pending && chatting === pending.id;
  return (
    <div id="screen-pane" className={home ? 'screen-home' : undefined} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {home && <HomeStatus name={name} state={state} actions={actions} />}
      {/* the engine's (pane-view.ts): the terminal and the chat (its images and workers' names: ui/ChatLog.tsx) */}
      <div id="pane-view" ref={body} style={{ display: 'contents' }}></div>
      {/* over the chat's bottom-right corner, above whatever is under it; with nothing under it (a pane's chat
          at rest), above the phone's home indicator. On a PC at the readable column's edge. */}
      {jump && (
        <div className="relative z-[1] h-0 shrink-0">
          <Indicator className={`absolute right-4 lg:right-(--wide-gutter) ${readOnly && !working && !prompt ? 'bottom-[calc(var(--safe-bottom)+12px)]' : 'bottom-3'}`}
            color="accent" size={10} offset={5} withBorder disabled={!jump.unread}>
            <ActionIcon id="btn-chat-bottom" variant="default" size="xl" radius="xl" fz={18} className="shadow-md"
              aria-label={jump.unread ? 'Jump to the latest message (new messages)' : 'Jump to the latest message'} title="Jump to the latest message"
              onClick={() => own.current?.toBottom()}>&#8595;</ActionIcon>
          </Indicator>
        </div>
      )}
      {prompt && paneView && <PromptPanel paneId={paneId} prompt={prompt} view={paneView} />}
      {hl && pending && <HeadlessPrompt key={pending.id} name={hl} pending={pending} chatting={chatOn} onChat={() => setChatting(pending.id)} />}
      {home && (
        <Group id="home-activity" gap={8} wrap="nowrap" py={6} className="shrink-0 px-4 border-t border-(--color-border) bg-(--color-bg) lg:px-(--wide-gutter)"
          style={working || compacted ? undefined : { display: 'none' }}>
          <Text flex={1} ff="monospace" fz={12} c="dimmed" truncate>{working ? (compacting ? 'compacting…' : activity ? `▸ ${activity}` : 'thinking…') : compacted}</Text>
          {hl && working && <Button id="btn-home-interrupt" {...SMALL} c="blocked" aria-label="Interrupt" onClick={() => { void interrupt(hl); }}>&#9632;</Button>}
        </Group>
      )}
      {/* Esc: Claude Code's interrupt, the one key a read-only chat keeps */}
      {readOnly && working && (
        <div className={`${BAR} px-3 pt-2 pb-[calc(var(--safe-bottom)+8px)]`}>
          <Button variant="default" fullWidth id="btn-pane-interrupt" onClick={() => { void sendKey(paneId, { keys: ['esc'] }); }}>&#9632; Interrupt</Button>
        </div>
      )}
      {/* hidden, not unmounted: what is typed stays, as across a terminal ⇄ chat switch */}
      <div className={`input-bar ${BAR} pb-(--safe-bottom)`} style={readOnly ? { display: 'none' } : undefined}>
        <Composer paneId={paneId} home={home} name={name} question={pending?.id ?? ''} chatting={chatOn} />
        {/* Home hides the terminal keys while chatting; they come back with the terminal. A row that
            scrolls sideways, its scrollbar hidden. */}
        <div id="quickkey-row" className="flex gap-1.5 overflow-x-auto px-3 pb-2 [scrollbar-width:none] lg:px-(--wide-gutter)"
          style={home && mode !== 'terminal' ? { display: 'none' } : undefined}>
          {KEYS.map(([label, payload]) => (
            <Button key={label} className={QKEY} variant="default" size="compact-md" h={36} radius={6} ff="monospace" fz={12} fw={400}
              onClick={() => { void sendKey(paneId, payload); }}>{label}</Button>
          ))}
        </div>
      </div>
    </div>
  );
}

// Home status bar: with two or more orchestrators configured a switcher between their Homes (a
// stopped one dimmed: its Home has Start), then one row: "Needs you · n" (its account's blocked
// agents, its own question, its to-do items: Todos.tsx's NeedsButton, a popover), the counts of its
// agents (AgentsButton, a popover of them), and at the right a headless one's usage and model and the orchestrator's ⋮ (HomeMenu:
// Compact, Clear, Stop; the row wraps where it must: a phone, a narrow PC); under it a headless one's
// warnings (`clear`: their Clear, on a stopped Home too).
function HomeStatus({ name, state, actions, clear = actions?.clear }: { name: string; state: AppState | null; actions?: HomeActions; clear?: () => void }) {
  const now = useMinute();
  if (!state) return <Stack id="home-status" className={STATUS_BAR}></Stack>;
  const all = state.orchestrators ?? [];
  const self = all.find((o) => o.name === name);
  const s = homeSummary(agentCards(state, self), store.seenDone);
  const usage = self?.headless?.usage ? <Usage usage={self.headless.usage} now={now} /> : null;
  return (
    <Stack id="home-status" gap={8} py={8} className={`px-3.5 ${STATUS_BAR}`}>
      {/* a PC's sidebar does this (style.css hides it there): the row scrolls sideways, its scrollbar hidden */}
      {all.length >= 2 && (
        <Group className="home-switch overflow-x-auto [scrollbar-width:none]" gap={6} wrap="nowrap">
          {all.map((o) => {
            const pane = o.paneId ? findPane(o.paneId)?.pane : undefined;
            const on = o.name === name;
            return (
              <Button key={o.name} className={`home-switch-btn shrink-0 ${on ? 'border-(--color-accent) text-(--color-text)' : 'bg-transparent text-(--color-text-dim)'}`}
                variant="default" size="compact-sm" radius="xl" fz={13} fw={600} opacity={o.paneId ? undefined : 0.55}
                aria-current={on ? 'page' : undefined} data-stopped={o.paneId ? undefined : ''} data-orch={o.name} data-pane-id={o.paneId ?? undefined}
                leftSection={<StatusDot status={orchestratorStatus(o, pane, store.seenDone)} />} rightSection={<NeedsBadge n={needsYou(o, state, now)} />}
                onClick={() => { location.hash = homeHash(o.name); }}>
                {orchestratorLabel(o)}
              </Button>
            );
          })}
        </Group>
      )}
      <Group className="home-row" gap="6px 14px">
        {self && <NeedsButton o={self} s={s} n={needsYou(self, state, now)} now={now} />}
        <AgentsButton name={name} s={s} />
        {(usage || self?.headless || actions) && (
          <Group gap={10} className="ml-auto">
            {usage}
            {self?.headless && <ModelPicker o={self} />}
            {actions && <HomeMenu name={name} o={self} actions={actions} />}
          </Group>
        )}
      </Group>
      {self?.headless && <HeadlessWarnings o={self} clear={clear} />}
    </Stack>
  );
}

// A Home's counts of its agents (`s`; the blocked ones are on Needs you), the way to them: an outlined pill, as its other
// buttons (below sm only the numbers: the words come back with the room). A tap opens the popover under it, as Needs you's
// does (Todos.tsx's NeedsButton: as wide as a phone allows, no taller than the room below it; Escape, a tap outside, a tap
// on it again and leaving the screen close it; the focus goes into it and back): its account's agents, blocked first, then
// working, done and idle (byUrgency), each opening its drawer, then Open the list (#/agents/<name>). Like the agents list it
// holds still while a finger is down (useHeldState).
function AgentsButton({ name, s }: { name: string; s: HomeSummary }) {
  const [opened, setOpened] = useState(false);
  const [held, hold] = useHeldState();
  useEffect(() => {
    if (!opened) return;
    const close = (): void => setOpened(false);
    addEventListener('hashchange', close);
    return () => removeEventListener('hashchange', close);
  }, [opened]);
  const cards = byUrgency(agentCards(held, held?.orchestrators.find((o) => o.name === name)), store.seenDone);
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" width="min(400px, calc(100vw - 24px))" radius="md" shadow="md"
      trapFocus returnFocus middlewares={{ shift: { padding: 12 }, size: { padding: 12 } }}>
      <Popover.Target>
        <Button {...SMALL} className="home-counts shrink-0 bg-transparent hover:bg-(--color-surface-2)" classNames={{ label: 'gap-x-3' }} size="compact-sm" fz={13} fw={400}
          data-action="agents" title="Agents" aria-label={`Agents: ${s.working} working, ${s.done} done, ${s.idle} idle`}
          rightSection={<span className="text-[10px]" aria-hidden="true">&#9662;</span>} onClick={() => setOpened(!opened)}>
          <span data-count=""><Dot status="working" />{s.working}<span className="max-sm:hidden"> working</span></span>
          <span data-count=""><Dot status="done" />{s.done}<span className="max-sm:hidden"> done</span></span>
          <span data-count=""><Dot status="idle" />{s.idle}<span className="max-sm:hidden"> idle</span></span>
        </Button>
      </Popover.Target>
      <Popover.Dropdown className="overflow-y-auto overscroll-contain" p={6} data-agents-list="" {...hold}>
        {cards.length ? cards.map((c) => <AgentRow key={c.pane.paneId} card={c} />) : <Text c="dimmed" fz={13} px={12} py={8}>No active agents.</Text>}
        <div className="mt-1 border-t border-(--color-border) pt-1">
          <NavLink href={homeAgentsHash(homeHash(name))} className="agents-open-list rounded-lg" label="Open the list" rightSection="›" />
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

// Home's status bar, on the surface below the topbar (padding as classes: Mantine's px, inline, would beat lg:)
const STATUS_BAR = 'shrink-0 border-b border-(--color-border) bg-(--color-surface) lg:px-(--wide-gutter)';
// Home's small outlined buttons (its ⋮, ■, a warning's): dim text unless given a color
const SMALL = { variant: 'default', size: 'compact-xs', radius: 'xl', fz: 12, fw: 600, c: 'dimmed', className: 'bg-transparent hover:bg-(--color-surface-2)' } as const;
// a count's dot, before its number
const Dot = ({ status }: { status: string }) => <span className="mr-[5px] inline-block align-[1px]"><StatusDot status={status} /></span>;

const STALE_LIMITS_MS = 10 * 60_000;
const pct = (n: number): string => `${Math.round(n)}%`;

/** The usage parts a headless Home shows: 5h, 7d and fable (stale: read over 10 min ago) and the context,
 *  each only when known. */
export function usageParts(u: HeadlessUsage, now: number): Array<{ text: string; stale: boolean; high?: boolean }> {
  const stale = !u.at || now - u.at > STALE_LIMITS_MS;
  const parts: Array<{ text: string; stale: boolean; high?: boolean }> = [];
  if (u.fiveHour) parts.push({ text: `5h ${pct(u.fiveHour.utilization * 100)}`, stale });
  if (u.sevenDay) parts.push({ text: `7d ${pct(u.sevenDay.utilization * 100)}`, stale });
  if (u.fable) parts.push({ text: `fable ${pct(u.fable.utilization * 100)}`, stale });
  if (u.contextPct != null) parts.push({ text: `ctx ${pct(u.contextPct)}`, stale: false, ...(u.contextPct >= COMPACT_HINT_PCT && { high: true }) });
  return parts;
}

/** How long until `at`, as a limit's countdown says it: whole minutes, rounded up (so 1m until the moment itself),
 *  in its two largest units, a zero one left out (45m, 2h13m, 2h, 3d4h); '' once it has come. */
export function untilText(at: number, now: number): string {
  const m = Math.ceil((at - now) / 60_000);
  if (m <= 0) return '';
  const [d, h, min] = [Math.floor(m / 1440), Math.floor(m / 60) % 24, m % 60];
  return d ? `${d}d${h ? `${h}h` : ''}` : h ? `${h}h${min ? `${min}m` : ''}` : `${min}m`;
}

/** The usage popover's rows: each known limit, its use and when it resets (Claude Code's `resetsAt`): the time
 *  left and the clock time, or that it has reset since it was read. */
export function resetRows(u: HeadlessUsage, now: number): Array<{ name: string; used: string; when: string }> {
  const rows: Array<{ name: string; used: string; when: string }> = [];
  for (const [name, w] of [['5h', u.fiveHour], ['7d', u.sevenDay], ['fable', u.fable]] as const) {
    if (!w) continue;
    const left = untilText(w.resetsAt, now), clock = dueLabel(w.resetsAt, now).text;
    rows.push({ name, used: pct(w.utilization * 100), when: !w.resetsAt ? 'reset time unknown' : left ? `resets in ${left} · ${clock}` : `has reset (${clock})` });
  }
  return rows;
}

// The usage figures (`now`: HomeStatus's useMinute, so an open popover's countdowns tick at each minute's start). With a
// limit known, they are a button opening a popover of when each resets (Escape, a tap outside close it; the focus
// goes into it and back, as Needs you's does).
function Usage({ usage, now }: { usage: HeadlessUsage; now: number }) {
  const [opened, setOpened] = useState(false);
  const parts = usageParts(usage, now);
  if (!parts.length) return null;
  const text = (
    <Text id="home-usage" span fz={12} c="dimmed" className="tabular-nums">
      {parts.map((p, i) => <span key={p.text} className={p.stale ? 'stale opacity-50' : p.high ? 'high text-(--color-blocked)' : undefined}>{i ? ` · ${p.text}` : p.text}</span>)}
    </Text>
  );
  const rows = resetRows(usage, now);
  if (!rows.length) return text;
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" radius="md" shadow="md" trapFocus returnFocus middlewares={{ shift: { padding: 12 } }}>
      <Popover.Target>
        <UnstyledButton data-action="usage" title="When the usage limits reset" className="-mx-1 flex rounded-sm px-1 hover:bg-(--color-surface-2)"
          onClick={() => setOpened(!opened)}>
          {text}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown data-usage-resets="" px={14} py={10}>
        <div className="grid grid-cols-[auto_auto_auto] gap-x-3 gap-y-1.5 text-[13px] tabular-nums">
          {rows.map((r) => (
            <div key={r.name} data-limit={r.name} className="contents">
              <span className="font-semibold">{r.name}</span><span className="text-right">{r.used}</span><span className="text-(--color-text-dim)">{r.when}</span>
            </div>
          ))}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

/** From this much of its context in use, the Home suggests a Compact (the ctx and the button in orange); it never runs one. */
export const COMPACT_HINT_PCT = 70;

/** A compaction that has ended, as the "doing now" line says it. */
export function compactLine(c: HeadlessCompact): string {
  if (c.state === 'failed') return `compact failed: ${c.error}`;
  if (c.to == null) return 'compacted';
  return `compacted: ctx ${c.from == null ? '' : `${pct(c.from)} → `}${pct(c.to)}`;
}

// A Home's ⋮, at its status bar's end (as a pane's is in its drawer's header: AgentMenu): a headless one's Compact…
// (Modals.tsx's dialog: its focus, then /compact; between turns only, as the bridge allows), Clear and Stop, each
// through its confirmation. ■ stays one tap away on the "doing now" line: it only ends the turn. Once the context is
// COMPACT_HINT_PCT full, a small orange dot on ⋮ and the context on Compact… suggest it.
function HomeMenu({ name, o, actions }: { name: string; o?: OrchestratorView; actions: HomeActions }) {
  const h = o?.headless;
  const ctx = h?.usage?.contextPct;
  const hint = ctx != null && ctx >= COMPACT_HINT_PCT;
  const busy = h?.status === 'working' || h?.status === 'blocked';
  const item = { className: 'min-h-11', fz: 'md' } as const;
  return (
    <Indicator color="blocked" size={7} offset={3} disabled={!hint} data-hint={hint ? '' : undefined}>
      <Menu id="btn-home-menu" position="bottom-end" width={240} radius="md">
        <Menu.Target>
          <Button {...SMALL} px={9} fz={14} aria-label={hint ? `Orchestrator actions (ctx ${pct(ctx)}: Compact suggested)` : 'Orchestrator actions'}>&#8942;</Button>
        </Menu.Target>
        <Menu.Dropdown>
          {h && (
            <Menu.Item id="hm-compact" {...item} disabled={busy} onClick={() => openCompact(name)}
              rightSection={busy ? <Text span fz={12} c="dimmed">after this turn</Text> : hint ? <Text span fz={12} c="blocked">ctx {pct(ctx)}</Text> : null}>
              Compact…
            </Menu.Item>
          )}
          <Menu.Item id="hm-clear" {...item} onClick={actions.clear}>Clear (fresh session)…</Menu.Item>
          <Menu.Item id="hm-stop" {...item} color="var(--color-blocked)" onClick={actions.stop}>Stop…</Menu.Item>
        </Menu.Dropdown>
      </Menu>
    </Indicator>
  );
}

// A headless orchestrator's model, from Claude Code's /model list (none until a child of this bridge gave
// it): it shows the model in effect (a resumed session keeps the one it last ran on), and a pick
// switches to it in place, or for its next start when stopped; not while a turn runs (the bridge
// refuses that too).
function ModelPicker({ o }: { o: OrchestratorView }) {
  const h = o.headless!;
  if (!h.models.length) return null;
  // the entry for the model in effect: the choice when it stands for it, else the first that does, else
  // the model itself, unlisted, so any pick is a change; not said yet (just started, or picked while
  // stopped): the choice, or '…' for none
  const base = (id: string): string => id.replace(/\[.*\]$/, ''); // opus[1m] is opus
  const runs = (m?: HeadlessModel): boolean => !!m && base(m.resolvedModel) === base(h.activeModel);
  const chosen = h.models.find((m) => m.value === h.model);
  const current = !h.activeModel || runs(chosen) ? h.model : h.models.find(runs)?.value ?? h.activeModel;
  const data = [...(h.models.some((m) => m.value === current) ? [] : [{ value: current, label: current || '…', disabled: true }]),
    ...h.models.map((m) => ({ value: m.value, label: m.displayName }))];
  const pick = async (model: string): Promise<void> => {
    try {
      await orchestratorPost(o.name, 'model', { model });
    } catch (err) {
      // model_pending: Claude Code hasn't answered yet, and the Home shows the model once it does
      showToast((err as { code?: string }).code === 'model_pending' ? 'Model change pending' : 'Model not changed', (err as Error).message);
    }
  };
  return (
    <NativeSelect id="home-model" size="xs" w="max-content" aria-label="Model" value={current} disabled={h.status === 'working' || h.status === 'blocked'}
      data={data} onChange={(e) => { void pick(e.currentTarget.value); }} />
  );
}

// A headless orchestrator's warnings, one line each (what went wrong, since when) with what it
// offers: ■ (interrupt), Clear, and the steps back to the TUI, shown in place (the config is edited
// by hand: the app never writes it).
function HeadlessWarnings({ o, clear }: { o: OrchestratorView; clear?: () => void }) {
  const [steps, setSteps] = useState(false);
  const warnings = o.headless?.warnings ?? [];
  if (!warnings.length) return null;
  return (
    <Stack id="home-warnings" className="home-warnings" gap={6}>
      {warnings.map((w) => (
        <Group key={w.kind} className="home-warning" data-kind={w.kind} gap="4px 8px" fz={12} c="blocked">
          <Text inherit flex="1 1 200px" miw={0} className="wrap-anywhere">{`⚠ ${w.message}`}<Text span inherit c="dimmed">{` · ${relativeTime(w.since) || 'now'}`}</Text></Text>
          <Group gap={6}>
            {w.actions.includes('interrupt') && <Button {...SMALL} data-action="interrupt" onClick={() => { void interrupt(o.name); }}>&#9632; Interrupt</Button>}
            {w.actions.includes('clear') && clear && <Button {...SMALL} data-action="clear" onClick={clear}>Clear</Button>}
            {w.actions.includes('tui') && <Button {...SMALL} data-action="tui" onClick={() => setSteps(!steps)}>Back to TUI</Button>}
          </Group>
        </Group>
      ))}
      {steps && <TuiSteps name={o.name} />}
    </Stack>
  );
}

// the bottom bars: the composer's and a read-only chat's ■
const BAR = 'shrink-0 border-t border-(--color-border) bg-(--color-surface)';
// a quick key: dim, the accent while pressed
const QKEY = 'qkey shrink-0 text-(--color-text-dim) active:border-(--color-accent) active:bg-(--color-accent) active:text-white';

// what the composer says it sends a quote of
const QUOTING: Record<QuoteOf, string> = {
  you: 'Replying to the orchestrator', me: 'Replying to your message', notice: 'Replying to a yoicks notice', todo: 'Asking about a to-do',
};

const autoGrow = (t: HTMLTextAreaElement): void => {
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
};

// The one composer: an agent's pane and an orchestrator's Home alike. On a touch device Enter
// inserts a newline and only the Send button sends, so the phone keyboard can't fire off half-typed
// commands; on a PC Enter sends and Shift+Enter inserts a newline (composer-keys.ts). What is typed is
// kept as the Home's (`name`) or the pane's draft (drafts.ts) until it is sent. A headless
// orchestrator's also takes images (+, or pasted), shown above it until sent (not kept as a draft).
// While its question is open (`question`: its id) it is locked, its draft kept, Enter and Send doing
// nothing, until the panel's Chat about this (`chatting`) gives it an empty field: what is sent then
// names the question, which the bridge declines with it. Once the question is gone, the draft is back.
// A draft's quote (drafts.ts: a Home's Reply, Ask on a to-do item) shows above it, ✕ drops it, and the
// message sends it first; while the composer writes about the question it is left out, and back after.
function Composer({ paneId, home, name, question = '', chatting = false }:
  { paneId: string; home: boolean; name: string; question?: string; chatting?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const resetPicker = useRef<() => void>(null);
  const key = draftKey(paneId, home ? name : undefined);
  const [placeholder] = useState(() => (home ? `Message ${orchestratorLabel(orchestratorOfPane(store.appState, paneId))}…` : 'Send text…'));
  const [quote, setShownQuote] = useState(() => getQuote(key));
  useEffect(() => {
    setShownQuote(getQuote(key));
    // a Reply or an Ask: to type at once (in the tap, so a phone's keyboard opens)
    return onQuote((k, line) => {
      if (k !== key) return;
      setShownQuote(line);
      if (line) input.current?.focus();
    });
  }, [key]);
  const q = quote && !chatting ? parseQuote(quote) : null;
  const shownQuote = useRef(quote);
  shownQuote.current = quote;
  const hl = headlessName(paneId); // no pane to type into: its message goes to the bridge's child
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const shown = useRef(images);
  shown.current = images;
  const sendingImages = useRef(false);
  const locked = !!question && !chatting;
  const chatNow = useRef(chatting);
  chatNow.current = chatting;
  const chatSending = useRef(false); // a Chat about this in flight: once it ends, the draft is back (if the question went meanwhile)
  const draftImages = useRef<ImageAttachment[]>([]); // the draft's images, set aside while writing about the question
  // the draft again (it stayed in drafts.ts) and its images, with what was written about the question and not sent
  const backToDraft = (t: HTMLTextAreaElement, rest: string): void => {
    t.value = [getDraft(key), rest].filter(Boolean).join('\n\n');
    if (rest) setDraft(key, t.value);
    autoGrow(t);
    const aside = draftImages.current;
    draftImages.current = [];
    if (aside.length) setImages((cur) => fitImages(aside, cur));
  };
  const wasChatting = useRef(false);
  useLayoutEffect(() => {
    const t = input.current!;
    if (chatting === wasChatting.current) return;
    wasChatting.current = chatting;
    if (chatting) {
      t.value = '';
      autoGrow(t);
      draftImages.current = shown.current;
      setImages([]);
      t.focus();
    } else if (!chatSending.current) backToDraft(t, t.value);
  }, [chatting]);
  const [preparing, setPreparing] = useState(0); // images being scaled: no send until they are there
  const attach = async (files: File[]): Promise<void> => {
    const picked = files.filter((f) => f.type.startsWith('image/'));
    if (!picked.length) return;
    const forDraft = !chatNow.current;
    let added: ImageAttachment[];
    setPreparing((n) => n + 1);
    try {
      added = await Promise.all(picked.map(toAttachment));
    } catch {
      showToast('Image not added', 'This browser could not read it');
      return;
    } finally {
      setPreparing((n) => n - 1);
    }
    const toDraft = forDraft && chatNow.current; // picked for the draft, read once Chat about this opened: the draft's
    const into = toDraft ? draftImages.current : shown.current;
    const next = fitImages(into, added);
    if (next.length < into.length + added.length) showToast('Not every image was added', `At most ${MAX_IMAGES}, 1 MB in all, per message`);
    if (toDraft) draftImages.current = next;
    else setImages(next);
  };
  useLayoutEffect(() => {
    const t = input.current!;
    shownInput = t;
    shownKey = key;
    const stored = getDraft(key);
    const draft = sendingDrafts.get(key) === stored ? '' : stored;
    if (draft) {
      t.value = draft;
      autoGrow(t);
    }
    return () => {
      if (shownInput === t) shownInput = null;
      // leaving with text about the question unsent: kept with the draft (images aren't kept, as ever)
      if (chatNow.current && t.value && !chatSending.current) setDraft(key, [getDraft(key), t.value].filter(Boolean).join('\n\n'));
    };
  }, [paneId, key]);

  const send = async (): Promise<void> => {
    const t = input.current!;
    const text = t.value;
    const sent = shown.current;
    if ((!text && !sent.length) || sendingImages.current || preparing || locked) return;
    sendingImages.current = sent.length > 0; // an upload takes a while: a second tap mustn't send them twice
    const about = chatting ? question : ''; // Chat about this: not the draft
    const line = q?.line ?? ''; // its quote, first
    const full = [line, text].filter(Boolean).join('\n\n');
    if (about) chatSending.current = true;
    else if (text) sendingDrafts.set(key, text);
    try {
      // clear:true wipes the pane's composer first so this message submits on its own — never
      // merged with a half-typed draft the user left in the pane that yoicks can't see. Scope it
      // to Claude Code panes: Ctrl+U safely clears Claude's input box, but to another app it's a
      // raw control byte a full-screen / non-readline TUI could act on. Other panes just get
      // text+enter. enter:true then submits in the same request.
      const isClaude = findPane(paneId)?.pane?.agent?.name === 'claude';
      const aboutIt = hl && about ? { question: about, ...(answersSoFar.has(hl) ? { answers: answersSoFar.get(hl) } : {}) } : {};
      await (hl ? orchestratorPost(hl, 'send', { text: full, ...(sent.length ? { images: sent } : {}), ...aboutIt }) : apiPost(inputUrl(paneId), { text: full, enter: true, ...(isClaude ? { clear: true } : {}) }));
      if (t.value === text) { // clear on success, but keep text typed mid-send
        t.value = '';
        autoGrow(t);
      }
      if (about && !chatNow.current) backToDraft(t, t.value); // the question went while it was on its way
      if (text && !about && getDraft(key) === text) setDraft(key, '');
      // sent: dropped, unless another was picked meanwhile (on show, the one shown: storage may have kept none)
      if (line && (t.isConnected ? shownQuote.current : getQuote(key)) === line) setQuote(key, '');
      if (sent.length) setImages((cur) => cur.filter((i) => !sent.includes(i))); // and images added mid-send
      paneView?.echo();
    } catch (err) {
      if (about) { // still in the field; the draft with it, if the question (or the Home) went meanwhile
        if (!chatNow.current || !t.isConnected) backToDraft(t, t.value);
        showToast('Send failed', (err as Error).message);
        return;
      }
      if ((err as { code?: string }).code === 'question_pending') { // came first: the State shows it in a moment
        showToast('Not sent: a question came first', 'Answer it, or press Chat about this to write about it. Your message is kept.');
        return;
      }
      // the draft again, unless a newer one is stored (a later send's success left none); a composer
      // empty under its key (reopened, a Home's after a Clear's new pane too) shows it
      if (text && !getDraft(key)) {
        setDraft(key, text);
        if (store.appState) pruneDrafts(store.appState); // not for a pane closed meanwhile: herdr reuses its id
      }
      const live = shownKey === key ? shownInput : null;
      if (text && live && !live.value && getDraft(key) === text) {
        live.value = text;
        autoGrow(live);
      }
      showToast('Send failed', (err as Error).message);
    } finally {
      sendingImages.current = false;
      chatSending.current = false;
      if (sendingDrafts.get(key) === text) sendingDrafts.delete(key);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const key = e.nativeEvent; // React's event has no isComposing: an IME's confirming Enter must never send
    if (!enterSends(key, matchMedia(DESKTOP_QUERY).matches)) return;
    e.preventDefault();
    if (!key.repeat) void send(); // a held Enter sends once, not once per auto-repeat
  };

  // a pasted image (a screenshot) is attached; its file name, if the clipboard has one, isn't typed
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...e.clipboardData.files];
    if (!hl || !files.some((f) => f.type.startsWith('image/'))) return;
    e.preventDefault();
    void attach(files);
  };

  return (
    <>
      {images.length > 0 && (
        <div id="input-images" className="flex gap-2 overflow-x-auto px-3 pt-2 lg:px-(--wide-gutter)">
          {images.map((a, i) => {
            const src = `data:${a.mediaType};base64,${a.data}`;
            return (
              <span key={i} className="relative shrink-0">
                <UnstyledButton aria-label="View image" onClick={() => previewImage(src, 'Attached image')}>
                  <Image src={src} alt="" h={56} w="auto" maw={96} fit="cover" radius={6} className="border border-(--color-border)" />
                </UnstyledButton>
                <CloseButton className="absolute -top-1.5 -right-1.5" size={22} radius="xl" variant="filled" bg="dark.6" c="dark.0"
                  aria-label="Remove image" onClick={() => setImages((cur) => cur.filter((x) => x !== a))} />
              </span>
            );
          })}
        </div>
      )}
      {q && (
        <Group id="composer-quote" data-quote-of={q.of} gap={8} wrap="nowrap" pt={8} className="px-3 lg:px-(--wide-gutter)">
          <div className="min-w-0 flex-1 border-l-3 border-(--color-accent) pl-2 text-(--color-text-dim)"><QuoteText q={q} head={QUOTING[q.of]} /></div>
          <CloseButton size={28} aria-label={q.of === 'todo' ? 'Cancel the question about the to-do' : 'Cancel the reply'} onClick={() => setQuote(key, '')} />
        </Group>
      )}
      {locked && (
        <Text id="composer-locked" fz={12} c="blocked" pt={8} className="px-3 lg:px-(--wide-gutter)">
          Answer the question above, or press Chat about this to write about it.
        </Text>
      )}
      <Group gap={6} wrap="nowrap" pt={8} pb={6} className="px-3 lg:px-(--wide-gutter)">
        {hl && (
          // the picker's input is hidden; picking the same file again works (reset after each pick)
          <FileButton resetRef={resetPicker} accept="image/*" multiple inputProps={{ id: 'input-image-picker' }}
            onChange={(files) => { void attach(files); resetPicker.current?.(); }}>
            {(props) => <ActionIcon {...props} id="btn-attach" variant="default" size="xl" radius={8} fz={20} disabled={locked} aria-label="Attach images">+</ActionIcon>}
          </FileButton>
        )}
        {/* Mantine's look, the composer's own text: 14px (iOS zooms in on focus, as before), at most 120px tall (autoGrow) */}
        <Textarea id="pane-input" ref={input} rows={1} placeholder={chatting ? 'Write about the question…' : placeholder} disabled={locked} autoCorrect="off" autoCapitalize="off" spellCheck={false}
          className="flex-1" styles={{ input: { fontSize: 14, lineHeight: 1.4, maxHeight: 120, background: 'var(--color-bg)', paddingTop: 10, paddingBottom: 10 } }}
          onKeyDown={onKeyDown} onPaste={onPaste} onInput={(e) => { autoGrow(e.currentTarget); if (!chatting) setDraft(key, e.currentTarget.value); }} />
        <Button id="btn-send-enter" miw={64} px={12} fz={13} disabled={preparing > 0 || locked} onClick={() => { void send(); }}>Send</Button>
      </Group>
    </>
  );
}

// The title: the pane's agent and where it is, or for a Home the orchestrator and what it's up to.
// A pane gone from the State keeps its last title (a Home holds through its orchestrator's replacement).
export function PaneTitle({ paneId, home }: { paneId: string; home: boolean }) {
  const state = useAppState();
  const last = useRef<ReactNode>(null);
  const found = findPane(paneId);
  if (found || last.current === null) {
    if (home) {
      const st = found?.pane?.agent?.status ?? '';
      const sub = st === 'working' ? 'working…' : st === 'blocked' ? 'needs you' : 'ready';
      last.current = <>{orchestratorLabel(orchestratorOfPane(state, paneId))}<Subtitle className="home-state" c={st === 'working' || st === 'blocked' ? st : undefined}>{`· ${sub}`}</Subtitle></>;
    } else {
      const name = found?.pane?.agent?.herdrName || found?.pane?.agent?.displayName || found?.pane?.agent?.name || found?.pane?.title || paneId;
      // the name and (dim) where it is: the tab, unless the name already says it (agent start labels the tab by
      // the name); under them, small, what it is for, as its orchestrator said (one line, all of it on hover)
      const purpose = state?.purposes?.[paneId];
      const where = !found ? '' : found.tab.label && found.tab.label !== name ? `${found.ws.label} / ${found.tab.label}` : found.ws.label;
      const head = <>{name}{where ? <Subtitle>{`· ${where}`}</Subtitle> : null}</>;
      last.current = !purpose ? head : <>
        <div className="truncate">{head}</div>
        <Text className="title-purpose" fz={12} fw={400} lh={1.3} c="dimmed" truncate title={purpose}>{purpose}</Text>
      </>;
    }
  }
  return last.current;
}

// terminal ⇄ chat, hidden until the pane has a transcript. A pane's: Chat | Term, the one on show
// marked (each segment's label carries data-mode). A Home's: one button to the terminal and back
// (>_ / Chat; Esc, Ctrl+C and the arrows live in the terminal's keys), never remembered.
export function ViewToggle({ paneId, home }: { paneId: string; home: boolean }) {
  const { shown, mode } = useToggle(paneId);
  const hidden = shown ? undefined : { display: 'none' };
  if (home) {
    return (
      <Button id="btn-view-toggle" variant="default" size="compact-sm" radius="xl" fw={400} style={hidden} aria-label="Toggle terminal"
        onClick={() => paneView?.setMode(store.view.paneViewMode === 'chat' ? 'terminal' : 'chat', false)}>
        {mode === 'terminal' ? 'Chat' : '>_'}
      </Button>
    );
  }
  return (
    <SegmentedControl id="btn-view-toggle" size="xs" radius="xl" style={hidden} value={mode ?? 'chat'}
      data={[{ value: 'chat', label: <span data-mode="chat">Chat</span> }, { value: 'terminal', label: <span data-mode="terminal">Term</span> }]}
      onChange={(m) => paneView?.setMode(m as Mode, true)} />
  );
}

// the dim part of a title: where the pane is, or what the Home is up to (`c`: its status's color)
const Subtitle = ({ className = '', c, children }: { className?: string; c?: string; children: string }) => (
  <Text span className={`topbar-subtitle ${className}`} fz={12} fw={400} ml={6} c={c ?? 'dimmed'}>{children}</Text>
);

const settingsButton = <TopbarIcon id="btn-settings" label="Settings" onClick={() => { location.hash = '#/settings'; }}>&#9881;</TopbarIcon>;

export interface AgentActions { rename: () => void; clear: () => void; stop: () => void }

/** Whether ⋮'s menu is open: the drawer's Escape closes the drawer only while it isn't (ui/AgentDrawer.tsx). */
export let agentMenuOpen = false;

/** A pane's ⋮: Mantine's menu under it (closes on a pick, a tap outside or Escape). Each item
 *  44px tall, the app's touch target. Any Escape while it is open closes it: Mantine's own handler is the
 *  dropdown's, and its focus moves in only a moment after it opens (a timer), so an Escape from ⋮ before that
 *  closed nothing, the menu staying and, with a menu open, the drawer too. */
export function AgentMenu({ actions }: { actions: AgentActions }) {
  const [opened, setOpened] = useState(false);
  useLayoutEffect(() => { // as it commits: no Escape meanwhile finds the menu shown and the drawer not told
    agentMenuOpen = opened;
    if (!opened) return;
    const onKey = (e: globalThis.KeyboardEvent): void => { if (e.key === 'Escape' && !e.isComposing) setOpened(false); };
    addEventListener('keydown', onKey, true);
    return () => { agentMenuOpen = false; removeEventListener('keydown', onKey, true); };
  }, [opened]);
  return (
    <Menu id="btn-agent-menu" position="bottom-end" width={220} radius="md" opened={opened} onChange={setOpened}>
      <Menu.Target><TopbarIcon label="Agent actions">&#8942;</TopbarIcon></Menu.Target>
      <Menu.Dropdown>
        <Menu.Item id="am-rename" className="min-h-11" fz="md" onClick={actions.rename}>Rename…</Menu.Item>
        <Menu.Item id="am-clear" className="min-h-11" fz="md" onClick={actions.clear}>Clear (fresh session)…</Menu.Item>
        <Menu.Item id="am-stop" className="min-h-11" fz="md" color="var(--color-blocked)" onClick={actions.stop}>Stop agent…</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** A running Home's topbar: the orchestrator, the view toggle and Settings (its agents' counts, the
 *  way to its list, its ⋮ (Compact, Clear, Stop) are on its status bar). A pane's header is its drawer's (ui/AgentDrawer.tsx). */
export const homeTopbar = (paneId: string): Topbar => ({
  title: <PaneTitle paneId={paneId} home />,
  right: (
    <>
      <ViewToggle paneId={paneId} home />
      {settingsButton}
    </>
  ),
});

// ── A stopped orchestrator's Home ─────────────────────────────────────────────

function StoppedTitle({ name }: { name: string }) {
  const o = useAppState()?.orchestrators?.find((x) => x.name === name);
  return <>{orchestratorLabel(o)}<Subtitle className="home-state">· stopped</Subtitle></>;
}

export const stoppedHomeTopbar = (name: string): Topbar => ({
  title: <StoppedTitle name={name} />,
  right: settingsButton,
});

/** #/home/<name> while that orchestrator isn't running: its account's agents and Start (a headless
 *  one's warnings too, with `clear`). Once the State shows it running, the shell (ui/App.tsx) opens
 *  its running Home in place of this. */
export function StoppedHome({ name, clear }: { name: string; clear?: () => void }) {
  const state = useAppState();
  const [busy, setBusy] = useState(false);
  const start = async (): Promise<void> => {
    setBusy(true); // until the State shows it running
    try {
      await orchestratorPost(name, 'start');
    } catch (err) {
      setBusy(false);
      showToast('Could not start the orchestrator', (err as Error).message);
    }
  };
  return (
    <div id="screen-home-stopped" className="screen-home" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <HomeStatus name={name} state={state} clear={clear} />
      <Stack flex={1} align="center" justify="center" gap={12} px={16} py={24}>
        <Text c="dimmed">{`${orchestratorLabel(state?.orchestrators?.find((o) => o.name === name))} is not running.`}</Text>
        <Button id="btn-home-start" px={28} disabled={busy} onClick={() => { void start(); }}>{busy ? 'Starting…' : 'Start'}</Button>
      </Stack>
    </div>
  );
}
