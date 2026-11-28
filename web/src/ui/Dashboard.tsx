/**
 * ui/Dashboard.tsx — an agent as the app lists it, wherever it does (a Home's agents popover, its panel, the PC rail's
 * Other): AgentRow and its menu, the pieces of its lines (cardTitle, cardLocation, CardWhere, the chips), what a row that is
 * one target for its menu shares with a to-do item's (ROW_MENU, ROW_TARGET, ROW_CLASS, ROW_ITEM, MoreMark),
 * the agents a Home lists (agentCards) and the State such a list draws while a finger is down (useHeldState); and the
 * topbar's ⚙ and icon button. (The agents list it was named for is gone: each Home lists its own.)
 */
import { ActionIcon, Badge, Loader, Menu, NavLink, Text } from '@mantine/core';
import { useEffect, useRef, useState, type ComponentPropsWithRef, type HTMLAttributes, type KeyboardEvent, type TouchEvent } from 'react';
import { dashboardCards, shownStatus, type DashboardCard } from '../dashboard-group.ts';
import { draftKey, setQuote } from '../drafts.ts';
import { focusInHerdr, go, showAgent } from '../nav.ts';
import { findPane, store, subscribe } from '../store.ts';
import { useWide } from '../theme.ts';
import { agentQuote } from '../transcript.ts';
import type { AppState, OrchestratorView } from '../types.ts';
import { stopAgentFlow } from './Modals.tsx';
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

/** The start of a card's (or an agent row's) dim last line: the location, then the branch; short of room,
 *  the location is cut short faster (the branch says more). */
export function CardWhere({ card }: { card: DashboardCard }) {
  return (
    <span className="flex min-w-0">
      <span className="card-location min-w-0 shrink-[4] truncate">{cardLocation(card)}</span>
      {card.branch ? <span className="card-branch min-w-0 truncate before:px-1 before:content-['·']">{card.branch}</span> : null}
    </span>
  );
}

/** A card's (or a row's) chip of the agent's kind: the stable one, raw pane.agent's `name` (e.g. "claude"/"codex"), over
 *  displayName, which can be a richer label. */
const agentKind = ({ pane }: DashboardCard): string => pane.agent?.name || pane.agent?.displayName || 'agent';

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
 * The State a list of agents draws (this list, the PC rail, a Home panel, the agents popover) and the touch handlers for its scroll
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

/** An agent in a Home's agents popover (ui/Pane.tsx's AgentsButton), a PC's Home panel (ui/HomePanel.tsx) and the PC
 *  rail's Other (ui/Sidebar.tsx): the name, then at the line's right end how long ago its status changed and the status;
 *  under it its purpose (two lines at most, all of it on hover), then one dim line: the location and branch (cut short
 *  first), the kind and, in a linked worktree, the `worktree` chip, as a card's; at its end ⋮ (MoreMark). The row is one
 *  target, as a to-do item is: a click, a tap or Enter/Space anywhere on it opens its menu: on a PC Open in herdr (herdr's
 *  pane.focus: the PC's herdr switches to it) first, then Show here, its drawer in this app (the PC's terminal may be out of
 *  sight, or another machine's), on a phone Open, the drawer; on a running Home's rows Ask the orchestrator (`ask`: its
 *  quote into the Home's composer; off while its question is open, `askOff`); and Stop agent…, the drawer's (a confirm,
 *  then the pane closes: Modals.tsx's stopAgentFlow). */
export function AgentRow({ card, ask, askOff = false }: { card: DashboardCard; ask?: (card: DashboardCard) => void; askOff?: boolean }) {
  const { pane, purpose } = card;
  const { paneId } = pane;
  const rel = relativeTime(pane.agent!.sinceUnixMs);
  const wide = useWide();
  return (
    <Menu {...ROW_MENU}>
      <Menu.Target>
        <NavLink component="div" {...ROW_TARGET} className={`agent-row rounded-lg ${ROW_CLASS}`} data-pane-id={paneId} data-agent-menu={paneId} noWrap
          label={<span className="flex items-center gap-2"><span className="min-w-0 truncate">{cardTitle(card)}</span><span className="ml-auto" />
            {rel ? <span className="shrink-0 text-[12px] text-(--color-text-dim)">{rel}</span> : null}<StatusBadge status={shownStatus(pane, store.seenDone) || 'unknown'} small /></span>}
          // spans (a row holds no <p>), each a line of its own; the purpose wraps, under the row's noWrap
          description={<>{purpose ? <Text span className="card-purpose my-0.5 whitespace-normal text-(--color-text)" fz={13} lh={1.3} lineClamp={2} title={purpose}>{purpose}</Text> : null}
            <span className="flex min-w-0 items-center gap-2"><CardWhere card={card} /><Tag>{agentKind(card)}</Tag>
              {card.isWorktree ? <Tag c="working">worktree</Tag> : null}</span></>}
          rightSection={<MoreMark />} />
      </Menu.Target>
      <Menu.Dropdown data-agent-more={paneId}>
        {wide && <Menu.Item {...ROW_ITEM} data-action="herdr" onClick={() => focusInHerdr(paneId)}>Open in herdr</Menu.Item>}
        <Menu.Item {...ROW_ITEM} data-action="show" onClick={() => showAgent(paneId)}>{wide ? 'Show here' : 'Open'}</Menu.Item>
        {ask && (
          <Menu.Item {...ROW_ITEM} data-action="ask" disabled={askOff} onClick={() => ask(card)}>
            Ask the orchestrator
            {askOff && <Text fz={12} c="dimmed">Answer its question first</Text>}
          </Menu.Item>
        )}
        <Menu.Divider />
        <Menu.Item {...ROW_ITEM} data-action="stop" color="var(--color-blocked)" onClick={() => { void stopAgentFlow(paneId); }}>Stop agent…</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** A row that is one target for its menu: an agent row, a to-do item (Todos.tsx). Its Menu (`ROW_MENU`) opens under it, at
 *  its end, and stays in the row's DOM (not a portal; fixed, so no scroll box clips it), so a popover the row sits in doesn't
 *  take a tap in the menu for one outside, and stays open over what the menu does. */
export const ROW_MENU = { position: 'bottom-end', withinPortal: false, floatingStrategy: 'fixed', radius: 'md' } as const;
/** The row itself (`ROW_TARGET`, `ROW_CLASS`): a button to assistive tech, focusable, Enter or Space opening the menu as a
 *  click does (a key in a link or a button inside it is that one's), the pointer over it, the row highlighted while hovered,
 *  pressed or its menu open. */
export const ROW_TARGET = {
  role: 'button',
  tabIndex: 0,
  onKeyDown: (e: KeyboardEvent<HTMLElement>): void => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.currentTarget.click(); }
  },
} as const;
export const ROW_CLASS = 'group cursor-pointer hover:bg-(--color-border) active:bg-(--color-border) data-expanded:bg-(--color-border) ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--color-accent)';
/** Its menu's items: 44px tall, the touch minimum. */
export const ROW_ITEM = { className: 'min-h-11', fz: 'md' } as const;

/** ⋮ at a row's end: a tap anywhere on the row opens its menu. Not a button of its own (the row is one): dim, the text's
 *  color while the row is hovered or its menu open; a spinner while the row is `busy`. */
export function MoreMark({ busy = false }: { busy?: boolean }) {
  return busy ? <Loader size={14} />
    : <span className="row-more shrink-0 text-(--color-text-dim) group-hover:text-(--color-text) group-data-expanded:text-(--color-text)" aria-hidden="true">&#8942;</span>;
}

/** Home `home`'s composer now quotes agent `card` (its name, purpose, pane id and status), to ask its orchestrator about
 *  it: an agent row's Ask the orchestrator, as a to-do item's (Todos.tsx). */
export function askAbout(home: string, card: DashboardCard): void {
  const { pane, purpose } = card;
  setQuote(draftKey('', home), agentQuote({ name: cardTitle(card), purpose, paneId: pane.paneId, status: shownStatus(pane, store.seenDone) || 'unknown' }));
}

// a card's small label: the agent kind, or (blue) worktree
const Tag = ({ c = 'dimmed', children }: { c?: string; children: string }) => (
  <Badge size="sm" radius="xl" bg="dark.6" c={c} fw={600} tt="none" className="shrink-0">{children}</Badge>
);

/** ⚙, Settings: at a topbar's right on a phone; on a PC at the sidebar's top (`sidebar`), none in the topbar. The sidebar's
 *  is in reach under an agent's drawer: Settings then takes the drawer's place (nav.ts's go), as any overlay over one. */
export function SettingsButton({ sidebar = false }: { sidebar?: boolean }) {
  return useWide() === sidebar ? <TopbarIcon id="btn-settings" label="Settings" onClick={() => go('#/settings')}>&#9881;</TopbarIcon> : null;
}

/** A topbar's (or a drawer's) icon button: 44px, dim, the text's color under the
 *  pointer. A button's props pass on (a menu's target gets its handlers and ref). */
export function TopbarIcon({ label, children, ...rest }: { label: string; children: string; 'data-action'?: string } & Omit<ComponentPropsWithRef<'button'>, 'children'>) {
  return <ActionIcon variant="subtle" color="gray" size="xl" fz={20} className="text-(--color-text-dim) hover:text-(--color-text)" aria-label={label} {...rest}>{children}</ActionIcon>;
}
