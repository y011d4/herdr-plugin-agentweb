/**
 * ui/HomePanel.tsx — a PC's Home panel, from PANEL_QUERY (1280px) on: the right column beside a Home, running or stopped
 * (ui/Pane.tsx draws it after the screen, in #screen, which style.css makes a row then). What that Home has for the user:
 * Needs you (its count: Todos.tsx's needsYou), its orchestrator's question, its account's blocked agents (as rows) and
 * its to-do list (Ask the orchestrator quotes an item in the composer beside it); then its other agents, working, done
 * and idle (byUrgency), and Open the list (#/agents/<name>). An agent's row opens it in herdr, its ⋮ also here, asks a
 * running Home's orchestrator about it (Ask the orchestrator, into the composer beside it) and stops it (Dashboard.tsx's
 * AgentRow). Narrower, the Home's status bar has the same in its popovers (Needs you, the counts).
 * Like the agents list it holds still while a finger is down (useHeldState).
 */
import { NavLink, Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { byUrgency, homeSummary, type DashboardCard } from '../dashboard-group.ts';
import { draftKey, setQuote } from '../drafts.ts';
import { homeAgentsHash, homeHash } from '../routes.ts';
import { store } from '../store.ts';
import { todoQuote } from '../transcript.ts';
import type { TodoItem } from '../types.ts';
import { AgentRow, agentCards, askAbout, orchestratorLabel, useHeldState } from './Dashboard.tsx';
import { StatusCounts } from './Status.tsx';
import { NeedsList, needsYou, useMinute } from './Todos.tsx';

const heading = (text: string, end?: ReactNode) => (
  <div className="flex items-center gap-2 px-3 pt-4 pb-1.5">
    <Text fz={11} fw={700} c="dimmed" tt="uppercase" lts="0.06em">{text}</Text>
    {end && <span className="ml-auto">{end}</span>}
  </div>
);

export function HomePanel({ name }: { name: string }) {
  const [state, hold] = useHeldState();
  const now = useMinute();
  const o = state?.orchestrators.find((x) => x.name === name);
  const cards = byUrgency(agentCards(state, o), store.seenDone);
  const s = homeSummary(cards, store.seenDone);
  const n = o && state ? needsYou(o, state, now) : 0;
  const rest = cards.filter((c) => !s.blocked.includes(c)); // the blocked ones are under Needs you
  // a running Home's composer, beside it, takes an item's quote
  const ask = o?.paneId ? (it: TodoItem): void => setQuote(draftKey('', o.name), todoQuote(it)) : undefined;
  const askAgent = o?.paneId ? (c: DashboardCard): void => askAbout(o.name, c) : undefined;
  const askOff = !!o?.headless?.pending; // the composer is the question's then
  return (
    <aside id="home-panel" aria-label={`${orchestratorLabel(o)}: what needs you, and its agents`} {...hold}
      className="w-[320px] shrink-0 overflow-y-auto overscroll-contain border-l border-(--color-border) bg-(--color-surface) px-2 pb-4">
      {o && (
        <>
          <section data-panel="needs">
            {heading(n ? `Needs you · ${n}` : 'Needs you')}
            <div className="px-3">
              {n || o.todos?.length ? <NeedsList o={o} s={s} now={now} ask={ask} askAgent={askAgent} rows /> : <Text fz={13} c="dimmed">Nothing waits on you.</Text>}
            </div>
          </section>
          <section data-panel="agents">
            {heading('Agents', <StatusCounts n={s} />)}
            {rest.map((c) => <AgentRow key={c.pane.paneId} card={c} ask={askAgent} askOff={askOff} />)}
            {!rest.length && <Text fz={13} c="dimmed" px={12}>{s.blocked.length ? 'Only the ones waiting on you.' : 'No agents.'}</Text>}
            <NavLink href={homeAgentsHash(homeHash(name))} className="home-panel-list mt-1 rounded-lg" label="Open the list" rightSection="›" />
          </section>
        </>
      )}
    </aside>
  );
}
