/**
 * ui/Sidebar.tsx — the PC's left column, the rail of Homes, beside every screen but the token one on a wide screen
 * (WIDE_QUERY: ui/App.tsx draws it only then). At its top, over the topbar's height, the app's name, the connection's
 * dot and ⚙ (Settings): the topbar beside it is the screen's own (a Home's header). Then each orchestrator's Home, a row
 * in config order that opens it (the Home on show marked): its dot (its orchestrator's state), its name, what waits on
 * the user there as a count (Todos.tsx's needsYou: its account's blocked agents, its question, its items due now), and
 * under them its account's other agents as counts (working, done, idle; each, a zero dimmed, so they line up). What waits there and the agents themselves
 * are the Home's: its panel at its right (ui/HomePanel.tsx), or below that width its status bar's popovers. Then Other,
 * the blocked agents no Home's account lists (a click opens one: nav.ts's openAgent, on a PC in herdr). At the bottom,
 * pinned, All agents (their count): the full list.
 *
 * Like the agents list it gets every State push: it holds still while a finger is down (useHeldState), and its rows are
 * keyed by orchestrator, so #sidebar, the scroll container, stays the same element.
 */
import { NavLink, Text } from '@mantine/core';
import { useSyncExternalStore, type ReactNode } from 'react';
import { homeGroups, homeSummary, orchestratorStatus } from '../dashboard-group.ts';
import { homeHash } from '../routes.ts';
import { findPane, store } from '../store.ts';
import type { AppState, OrchestratorView } from '../types.ts';
import { SettingsButton, agentCards, orchestratorLabel, useHeldState } from './Dashboard.tsx';
import { StatusCounts, StatusDot } from './Status.tsx';
import { Blocked, NeedsBadge, needsYou, useMinute } from './Todos.tsx';

const subscribeHash = (fn: () => void): (() => void) => {
  addEventListener('hashchange', fn);
  return () => removeEventListener('hashchange', fn);
};

const current = (on: boolean): 'page' | undefined => (on ? 'page' : undefined);

const heading = (text: string) => <Text className="sidebar-heading" px={12} pt={14} pb={4} fz={11} fw={700} c="dimmed" tt="uppercase" lts="0.06em">{text}</Text>;

export function Sidebar({ dot }: { dot: ReactNode }) {
  const [state, hold] = useHeldState();
  const now = useMinute();
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const cards = agentCards(state);
  const other = homeSummary(homeGroups(cards, state?.orchestrators ?? []).find((g) => !g.home)?.cards ?? [], store.seenDone).blocked;
  return (
    <aside id="sidebar" aria-label="Homes" {...hold}>
      {/* the topbar's height, kept in view over the list: the app's name, the connection (App.tsx's dot) and Settings */}
      <div className="sticky top-0 z-1 -mx-2 flex h-[52px] shrink-0 items-center gap-2.5 border-b border-(--color-border) bg-(--color-surface) pr-1 pl-4">
        <Text fw={700} fz={16}>Yoicks</Text>
        {dot}
        <span className="ml-auto" />
        <SettingsButton sidebar />
      </div>
      {heading('Homes')}
      <div className="flex flex-col gap-0.5">
        {state?.orchestrators.map((o) => <Home key={o.name} o={o} state={state} now={now} on={hash === homeHash(o.name)} />)}
      </div>
      {other.length > 0 && (
        <section className="sidebar-other" data-home="">
          {heading('Other')}
          <div className="px-3 pt-1"><Blocked cards={other} /></div>
        </section>
      )}
      {/* as tall as the topbar, at the bottom (#sidebar is a column): pinned there while the rows above run under it */}
      <div className="sticky bottom-0 z-1 -mx-2 mt-auto flex h-[52px] shrink-0 items-center border-t border-(--color-border) bg-(--color-surface) px-2">
        <NavLink href="#/agents" className="sidebar-all rounded-lg" label="All agents" rightSection={`${cards.length} ›`}
          active={hash === '#/agents'} aria-current={current(hash === '#/agents')} />
      </div>
    </aside>
  );
}

// A Home's row: its dot, its name and what waits there (a count), under them its agents' counts (without agents: 0 0 0)
function Home({ o, state, now, on }: { o: OrchestratorView; state: AppState; now: number; on: boolean }) {
  const s = homeSummary(agentCards(state, o), store.seenDone);
  const st = orchestratorStatus(o, o.paneId ? findPane(o.paneId)?.pane : undefined, store.seenDone);
  return (
    <NavLink href={homeHash(o.name)} className="sidebar-home rounded-lg" data-home={o.name} fw={600} c={o.paneId ? undefined : 'dimmed'}
      label={orchestratorLabel(o)} leftSection={<StatusDot status={st} />} rightSection={<NeedsBadge n={needsYou(o, state, now)} />}
      description={<span className="mt-1 block"><StatusCounts n={s} /></span>}
      active={on} aria-current={current(on)} />
  );
}
