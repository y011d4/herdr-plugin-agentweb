/**
 * ui/Dashboard.tsx — the agents list: #/agents, and #/agents/<name> (opened from that orchestrator's
 * Home: its account's agents, with ← Home back to it). One flat list, most recent status change
 * first (dashboardCards), never the orchestrators (each is started from its own Home).
 *
 * State pushes arrive constantly while the list is read. #screen-agents, the scroll container, stays
 * the same element while the list is shown and the cards are keyed by pane, so a push only rewrites
 * what changed: scrollTop and iOS momentum hold. While a finger is down the list doesn't change at all
 * (a rewrite mid-drag can cancel the scroll); the latest State shows once it lifts.
 */
import { ActionIcon, Badge, Button, Card, Center, Group, Loader, Text } from '@mantine/core';
import { useEffect, useRef, useState, useSyncExternalStore, type ComponentPropsWithRef, type HTMLAttributes, type TouchEvent } from 'react';
import { dashboardCards, shownStatus, type DashboardCard } from '../dashboard-group.ts';
import { openAgent } from '../nav.ts';
import { agentsScope, defaultHome, homeHash } from '../routes.ts';
import { findPane, lastHome, store, subscribe } from '../store.ts';
import type { AppState, OrchestratorView } from '../types.ts';
import type { Topbar } from './App.tsx';
import { StatusBadge } from './Status.tsx';

/** A card's tab: its name (the agent kind if a tab somehow has no label), with a per-tab index for
 *  split-pane agents. */
function tabTitle({ pane, tabLabel, tabAgentIndex, tabAgentCount }: DashboardCard): string {
  const base = tabLabel || pane.agent?.name || pane.agent?.displayName || 'agent';
  return tabAgentCount > 1 ? `${base} #${tabAgentIndex}` : base;
}

/** A card's label, its first line: herdr's name for the agent (the one `[yoicks]` notices use), else
 *  its tab (an agent the user runs directly has no name). Its purpose, when its orchestrator gave one,
 *  is the line under it. */
export function cardTitle(card: DashboardCard): string {
  return card.pane.agent?.herdrName || tabTitle(card);
}

/** Where a card's agent runs, as far as its name doesn't say: the workspace › the tab. */
export function cardLocation(card: DashboardCard): string {
  const tab = tabTitle(card);
  return tab === cardTitle(card) ? card.workspaceLabel : `${card.workspaceLabel} › ${tab}`;
}

/** The start of a card's (or a sidebar row's) dim last line: the location, then the branch; short of room,
 *  the location is cut short faster (the branch says more). */
export function CardWhere({ card }: { card: DashboardCard }) {
  return (
    <span className="flex min-w-0">
      <span className="card-location min-w-0 shrink-[4] truncate">{cardLocation(card)}</span>
      {card.branch ? <span className="card-branch min-w-0 truncate before:px-1 before:content-['·']">{card.branch}</span> : null}
    </span>
  );
}

/** The agents a list or a Home shows, most recent status change first: never the orchestrators,
 *  and for an orchestrator (`scope`) only its account's agents — all of them when that isn't known. */
export function agentCards(state: AppState | null, scope?: OrchestratorView): DashboardCard[] {
  return dashboardCards(state?.workspaces ?? [], (state?.orchestrators ?? []).map((o) => o.paneId), scope?.agents ?? null, state?.purposes);
}

/** An orchestrator's name: its configured label, else its workspace label. */
export function orchestratorLabel(o: OrchestratorView | undefined): string {
  return o?.label || (o?.paneId ? findPane(o.paneId)?.ws.label : '') || o?.name || 'Home';
}

export function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

/**
 * The State a list of agents draws (this list, the PC sidebar) and the touch handlers for its scroll
 * container. While a finger is down the list doesn't change at all (a rewrite mid-drag can cancel the
 * scroll); the latest State shows on the macrotask after the last finger lifts, so a still tap's
 * click lands first, on the card it pressed.
 */
export function useHeldState(): [AppState | null, Pick<HTMLAttributes<HTMLElement>, 'onTouchStart' | 'onTouchEnd' | 'onTouchCancel'>] {
  const [state, setState] = useState(store.appState);
  const touching = useRef(false);
  useEffect(() => {
    const apply = (): void => { if (!touching.current) setState(store.appState); };
    apply();
    return subscribe(apply);
  }, []);
  const lift = (e: TouchEvent): void => {
    if (e.touches.length > 0) return; // other fingers still down
    touching.current = false;
    setTimeout(() => { if (!touching.current) setState(store.appState); }, 0);
  };
  return [state, { onTouchStart: () => { touching.current = true; }, onTouchEnd: lift, onTouchCancel: lift }];
}

/** The list for `hash` (#/agents or #/agents/<name>). */
export function Dashboard({ hash }: { hash: string }) {
  const [state, hold] = useHeldState();

  if (!state) {
    return <Center id="screen-agents" h="100%"><Loader size={20} /></Center>;
  }
  const { workspaces = [] } = state;
  const cards = agentCards(state, agentsScope(hash, state));
  const empty = (text: string) => <Text className="empty-state" c="dimmed" ta="center" px={24} py={48}>{text}</Text>;
  // the scroll container: a 640px column from 600px wide up to lg, where the cards fill the width (a grid)
  return (
    <div id="screen-agents" data-ready="1" className={SCROLLER} {...hold}>
      {workspaces.length === 0 ? empty('No workspaces found.')
        : cards.length === 0 ? empty('No active agents.')
        : <div className={LIST}>{cards.map((c) => <AgentCard key={c.pane.paneId} card={c} />)}</div>}
    </div>
  );
}

// no scroll anchoring: a push that reorders the cards would scroll the list after the card the browser
// anchored on (Chrome's; Safari has none), so scrollTop holds as said above
const SCROLLER = 'flex-1 overflow-y-auto [overflow-anchor:none] pb-[calc(var(--safe-bottom)+8px)] min-[600px]:max-lg:mx-auto min-[600px]:max-lg:w-full min-[600px]:max-lg:max-w-[640px]';
// one column of cards, side by side from lg
const LIST = 'agent-list mt-4 flex flex-col gap-2.5 px-4 min-[600px]:px-6 lg:grid lg:grid-cols-[repeat(auto-fill,minmax(340px,1fr))]';

// One card: the name and the status; the purpose (two lines at most, all of it on hover); what it's
// doing; then one dim line, cut short rather than wrapped: the location and the branch (the list is
// flat, so each card names its own), the kind, the `worktree` chip (from that workspace), the time.
function AgentCard({ card }: { card: DashboardCard }) {
  const { pane, purpose, isWorktree } = card;
  const { paneId, agent, title } = pane;
  const { displayName, name, customStatus, message, sinceUnixMs } = agent!;
  // The chip shows the stable agent kind, so prefer `name` (raw pane.agent,
  // e.g. "claude"/"codex") over displayName, which can be a richer label.
  const agentKind = name || displayName || 'agent';
  const status = shownStatus(pane, store.seenDone) || 'unknown';
  const meta = customStatus || message || '';
  const relTime = relativeTime(sinceUnixMs);
  return (
    <Card className={CARD} data-pane-id={paneId} role="button" tabIndex={0} withBorder radius={10} padding={0} px={16} py={14}
      onClick={() => openAgent(paneId)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openAgent(paneId); }}>
      <Group gap={10} wrap="nowrap" mb={6}>
        <Text className="agent-name min-w-0" fw={600} truncate>{cardTitle(card)}</Text>
        <span className="ml-auto" />
        <StatusBadge status={status} />
      </Group>
      {purpose ? <Text className="card-purpose" fz={14} lh={1.35} mb={6} lineClamp={2} title={purpose}>{purpose}</Text> : null}
      {meta ? <Text fz={13} c="dimmed" mb={4} truncate>{meta}</Text> : null}
      <Group gap={12} fz={13} c="dimmed" wrap="nowrap">
        <CardWhere card={card} />
        <Tag>{agentKind}</Tag>
        {isWorktree ? <Tag c="working">worktree</Tag> : null}
        {title ? <Text fz={12} inherit truncate>{title}</Text> : null}
        {relTime ? <span className="shrink-0 whitespace-nowrap">{relTime}</span> : null}
      </Group>
    </Card>
  );
}

// Mantine's Card on the app's surface (a pressed card, and a hovered one on a PC, the lighter surface-2)
const CARD = 'agent-card bg-(--color-surface) [-webkit-tap-highlight-color:transparent] active:bg-(--color-surface-2) lg:hover:bg-(--color-surface-2)';

// a card's small label: the agent kind, or (blue) worktree
const Tag = ({ c = 'dimmed', children }: { c?: string; children: string }) => (
  <Badge size="sm" radius="xl" bg="dark.6" c={c} fw={600} tt="none" className="shrink-0">{children}</Badge>
);

const useAppState = (): AppState | null => useSyncExternalStore(subscribe, () => store.appState);

// Orchestrators have no cards, so this is the way to a Home (its chat, as a new entry: the list may
// have been opened from anywhere). A Home's own list (#/agents/<name>): back to that Home, by its
// name, at every width. The full list: ← Home, to the one used last (on a PC the sidebar's headings
// do that instead, style.css).
function HomeButton({ hash }: { hash: string }) {
  const state = useAppState();
  const scope = agentsScope(hash, state);
  const home = scope ?? defaultHome(state, lastHome());
  if (!home) return null;
  const open = (): void => { location.hash = homeHash(home.name); };
  const name = scope && orchestratorLabel(scope);
  return name ? <BackButton label={`Back to ${name}`} onClick={open}>{`\u2190 ${name}`}</BackButton>
    : <BackButton label="Home" onClick={open}>{'\u2190 Home'}</BackButton>;
}

export const dashboardTopbar = (hash: string): Topbar => ({
  title: 'Agents', // a Home's list: its ← names the Home
  left: <HomeButton hash={hash} />,
  right: <TopbarIcon id="btn-settings" label="Settings" onClick={() => { location.hash = '#/settings'; }}>&#9881;</TopbarIcon>,
});

/** A topbar's (or a drawer's) icon button: 44px, dim, the text's color under the
 *  pointer. A button's props pass on (a menu's target gets its handlers and ref). */
export function TopbarIcon({ label, children, ...rest }: { label: string; children: string; 'data-action'?: string } & Omit<ComponentPropsWithRef<'button'>, 'children'>) {
  return <ActionIcon variant="subtle" color="gray" size="xl" fz={20} className="text-(--color-text-dim) hover:text-(--color-text)" aria-label={label} {...rest}>{children}</ActionIcon>;
}

/** A topbar's way back (to a Home): the accent's text, 44px tall, flush with the bar's left edge; a long
 *  name is cut short (…), leaving the title room. */
export function BackButton({ label, children, onClick }: { label: string; children: string; onClick: () => void }) {
  return (
    <Button className="topbar-back -ml-2 min-w-11 text-(--color-accent) hover:text-(--color-text)" variant="subtle" h={44} px={8} maw="40vw" fz={16} fw={400}
      aria-label={label} onClick={onClick}><span className="truncate">{children}</span></Button>
  );
}
