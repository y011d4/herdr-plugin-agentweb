/**
 * ui/Sidebar.tsx — the PC sidebar, beside every screen but the token one on a wide screen
 * (WIDE_QUERY: ui/App.tsx draws it only then). At its top, over the topbar's height, the app's name, the connection's dot
 * and ⚙ (Settings): the topbar beside it is the screen's own (a Home's header). Then what waits on the user: each orchestrator's
 * Home a heading (it opens the Home) over what waits there (Todos.tsx's NeedsList: its question, its
 * account's blocked agents, its to-do list), then Other, the blocked agents no Home's account lists.
 * The to-do items there are the dense ones (two lines at most, all of it on hover). Under them the agents, folded
 * into one row (All agents, their count), pinned at the sidebar's bottom (in reach however long the lists above get):
 * a click unfolds them below it, grouped by Home (homeGroups: a Home's heading opens its list, #/agents/<name>, which a
 * phone opens from the Home's counts), each opening its pane the list's way (nav.ts's openAgent: its drawer), under Open
 * the list (#/agents), scrolled into view, and folds them again. The Home or the agent on show, from the hash, is
 * marked (aria-current).
 *
 * Like the agents list it gets every State push: it holds still while a finger is down
 * (useHeldState), and its rows are keyed by orchestrator and pane, so #sidebar, the scroll container,
 * stays the same element.
 */
import { NavLink, Text } from '@mantine/core';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { homeGroups, homeSummary, orchestratorStatus, shownStatus, type DashboardCard, type HomeGroup } from '../dashboard-group.ts';
import { draftKey, setQuote } from '../drafts.ts';
import { openAgent } from '../nav.ts';
import { homeAgentsHash, homeHash } from '../routes.ts';
import { findPane, store } from '../store.ts';
import { todoQuote } from '../transcript.ts';
import type { AppState, OrchestratorView, TodoItem } from '../types.ts';
import { CardWhere, SettingsButton, agentCards, cardTitle, orchestratorLabel, useHeldState } from './Dashboard.tsx';
import { StatusBadge, StatusDot } from './Status.tsx';
import { Blocked, NeedsBadge, NeedsList, needsYou, useMinute } from './Todos.tsx';

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

const heading = (text: string) => <Text className="sidebar-heading" px={12} py={4} fz={12} fw={700} c="dimmed" tt="uppercase" lts="0.06em">{text}</Text>;

export function Sidebar({ dot }: { dot: ReactNode }) {
  const [state, hold] = useHeldState();
  const now = useMinute();
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const [open, setOpen] = useState(false); // the agents, unfolded
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) list.current?.scrollIntoView({ block: 'nearest' }); }, [open]);
  const cards = agentCards(state);
  const groups = homeGroups(cards, state?.orchestrators ?? []);
  const other = homeSummary(groups.find((g) => !g.home)?.cards ?? [], store.seenDone).blocked;
  return (
    <aside id="sidebar" aria-label="Homes and agents" {...hold}>
      {/* the topbar's height, kept in view over the list: the app's name, the connection (App.tsx's dot) and Settings */}
      <div className="sticky top-0 z-1 -mx-2 flex h-[52px] shrink-0 items-center gap-2.5 border-b border-(--color-border) bg-(--color-surface) pr-1 pl-4">
        <Text fw={700} fz={16}>Yoicks</Text>
        {dot}
        <span className="ml-auto" />
        <SettingsButton sidebar />
      </div>
      {state?.orchestrators.map((o) => <Home key={o.name} o={o} state={state} now={now} on={hash === homeHash(o.name)} />)}
      {other.length > 0 && (
        <section className="sidebar-home mt-3.5" data-home="">
          {heading('Other')}
          <div className="px-3 pt-1"><Blocked cards={other} /></div>
        </section>
      )}
      {/* as tall as the topbar, at the bottom (#sidebar is a column): pinned there while the lists above run under it */}
      <div className="sticky bottom-0 z-1 -mx-2 mt-auto flex h-[52px] shrink-0 items-center border-t border-(--color-border) bg-(--color-surface) px-2">
        <NavLink component="button" className="sidebar-all rounded-lg" label="All agents" aria-expanded={open}
          rightSection={`${cards.length} ${open ? '▾' : '›'}`} onClick={() => setOpen(!open)} />
      </div>
      {/* unfolded, below it; scrolled into view, its top below the topbar's height and the row's */}
      {open && (
        <div ref={list} className="scroll-mt-[104px] pb-4" data-sidebar-agents="">
          <NavLink href="#/agents" className="sidebar-list rounded-lg" label="Open the list" rightSection="›"
            active={hash === '#/agents'} aria-current={current(hash === '#/agents')} />
          {groups.map((g) => <Group key={g.home ? `home:${g.home.name}` : 'other'} group={g} hash={hash} />)}
        </div>
      )}
    </aside>
  );
}

// A Home's heading (its dot, its name, what waits there as a count) over what waits there. Ask on a to-do
// item quotes it in that Home's composer (a running one's) and opens the Home.
function Home({ o, state, now, on }: { o: OrchestratorView; state: AppState; now: number; on: boolean }) {
  const n = needsYou(o, state, now);
  const st = orchestratorStatus(o, o.paneId ? findPane(o.paneId)?.pane : undefined, store.seenDone);
  const ask = o.paneId ? (it: TodoItem): void => {
    setQuote(draftKey('', o.name), todoQuote(it));
    location.hash = homeHash(o.name);
  } : undefined;
  return (
    <section className="sidebar-home mt-3.5" data-home={o.name}>
      <NavLink href={homeHash(o.name)} className="rounded-lg" data-home={o.name} fw={700} c={o.paneId ? undefined : 'dimmed'}
        label={orchestratorLabel(o)} leftSection={<StatusDot status={st} />} rightSection={<NeedsBadge n={n} />} active={on} aria-current={current(on)} />
      {(n > 0 || (o.todos?.length ?? 0) > 0) && (
        <div className="px-3 pt-1"><NeedsList o={o} s={homeSummary(agentCards(state, o), store.seenDone)} now={now} ask={ask} dense /></div>
      )}
    </section>
  );
}

// The unfolded agents of a Home (by its name, a link to its list: its heading is the one above) or Other.
function Group({ group: { home, cards }, hash }: { group: HomeGroup; hash: string }) {
  const pane = shownPane(hash);
  const list = home && homeAgentsHash(homeHash(home.name));
  return (
    <section className="sidebar-group mt-2" data-home={home?.name ?? ''}>
      {list ? (
        <a href={list} className="sidebar-home-list block hover:underline" title="Open the list" aria-current={current(hash === list)}>
          {heading(`${orchestratorLabel(home)} ›`)}
        </a>
      ) : heading('Other')}
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
