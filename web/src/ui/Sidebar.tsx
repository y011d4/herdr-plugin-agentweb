/**
 * ui/Sidebar.tsx — the PC sidebar, beside every screen but the token one on a wide screen
 * (WIDE_QUERY: ui/App.tsx draws it only then). Each orchestrator's Home is a heading over its
 * account's agents (homeGroups), then Other; above them All agents (#/agents). Settings is the
 * topbar's ⚙, at the screen's top right. A heading opens its Home, an agent its pane the list's way (nav.ts's openAgent: its drawer). The Home or the
 * agent on show, from the hash, is marked (aria-current).
 *
 * Like the agents list it gets every State push: it holds still while a finger is down
 * (useHeldState), and its rows are keyed by orchestrator and pane, so #sidebar, the scroll container,
 * stays the same element.
 */
import { NavLink, Text } from '@mantine/core';
import { useSyncExternalStore } from 'react';
import { homeGroups, orchestratorStatus, shownStatus, type DashboardCard, type HomeGroup } from '../dashboard-group.ts';
import { openAgent } from '../nav.ts';
import { homeHash } from '../routes.ts';
import { findPane, store } from '../store.ts';
import { CardWhere, agentCards, cardTitle, orchestratorLabel, useHeldState } from './Dashboard.tsx';
import { StatusBadge, StatusDot } from './Status.tsx';
import { NeedsBadge, needsYou, useMinute } from './Todos.tsx';

const subscribeHash = (fn: () => void): (() => void) => {
  addEventListener('hashchange', fn);
  return () => removeEventListener('hashchange', fn);
};

/** The pane a #/pane/<id> hash shows (null: none, or a malformed one). */
function shownPane(hash: string): string | null {
  try {
    return hash.startsWith('#/pane/') ? decodeURIComponent(hash.slice('#/pane/'.length)) : null;
  } catch {
    return null;
  }
}

const current = (on: boolean): 'page' | undefined => (on ? 'page' : undefined);

export function Sidebar() {
  const [state, hold] = useHeldState();
  const now = useMinute();
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const cards = agentCards(state);
  return (
    <aside id="sidebar" aria-label="Homes and agents" {...hold}>
      {/* the topbar's height, kept in view over the list */}
      <div className="sticky top-0 z-1 -mx-2 mb-2 flex h-[52px] items-center border-b border-(--color-border) bg-(--color-surface) px-4">
        <Text fw={700} fz={16}>Yoicks</Text>
      </div>
      <NavLink href="#/agents" className="sidebar-all rounded-lg" label="All agents" rightSection={cards.length}
        active={hash === '#/agents'} aria-current={current(hash === '#/agents')} />
      {homeGroups(cards, state?.orchestrators ?? []).map((g) => (
        <Group key={g.home ? `home:${g.home.name}` : 'other'} group={g} hash={hash} needs={g.home && state ? needsYou(g.home, state, now) : 0} />
      ))}
    </aside>
  );
}

// needs: what waits on the user at its Home (Todos.tsx's needsYou), its heading's badge
function Group({ group: { home, cards }, hash, needs }: { group: HomeGroup; hash: string; needs: number }) {
  const pane = shownPane(hash);
  let heading = <Text className="sidebar-heading" px={12} py={4} fz={12} fw={700} c="dimmed" tt="uppercase" lts="0.06em">Other</Text>;
  if (home) {
    const on = hash === homeHash(home.name);
    const st = orchestratorStatus(home, home.paneId ? findPane(home.paneId)?.pane : undefined, store.seenDone);
    heading = (
      <NavLink href={homeHash(home.name)} className="rounded-lg" data-home={home.name} fw={700} c={home.paneId ? undefined : 'dimmed'}
        label={orchestratorLabel(home)} leftSection={<StatusDot status={st} />} rightSection={<NeedsBadge n={needs} />} active={on} aria-current={current(on)} />
    );
  }
  return (
    <section className="sidebar-group mt-3.5" data-home={home?.name ?? ''}>
      {heading}
      {cards.map((c) => <Agent key={c.pane.paneId} card={c} on={c.pane.paneId === pane} />)}
    </section>
  );
}

// An agent as its card in the list has it: the name and its status at the line's right end, then over the
// row's whole width its purpose (two lines at most, all of it on hover) and the location and branch.
function Agent({ card, on }: { card: DashboardCard; on: boolean }) {
  const { paneId } = card.pane;
  const { purpose } = card;
  const st = shownStatus(card.pane, store.seenDone) || 'unknown';
  return (
    <NavLink component="button" className="rounded-lg" data-sidebar-pane={paneId} noWrap pl={28}
      label={<span className="flex items-center gap-2"><span className="min-w-0 truncate">{cardTitle(card)}</span><span className="ml-auto" /><StatusBadge status={st} small /></span>}
      // spans (a button holds no <p>), each a line of its own; the purpose wraps, under the row's noWrap
      description={<>{purpose ? <Text span className="card-purpose my-0.5 whitespace-normal text-(--color-text)" fz={13} lh={1.3} lineClamp={2} title={purpose}>{purpose}</Text> : null}
        <CardWhere card={card} /></>}
      active={on} aria-current={current(on)}
      onClick={() => openAgent(paneId)} />
  );
}
