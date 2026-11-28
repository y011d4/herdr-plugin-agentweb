/**
 * ui/Todos.tsx — what waits on the user at a Home, and its to-do list. Each Home's "needs you" count:
 * the badge on its switcher button and its PC rail row (ui/Sidebar.tsx), and on its status bar (Pane.tsx's
 * HomeStatus, on a running Home and a stopped one alike) "Needs you · n", which opens a popover: its
 * account's blocked agents (a tap opens it: nav.ts's openAgent), its orchestrator's own question (answered below the
 * chat) and the to-do list, what its orchestrator wrote down (todos.ts); on a PC from 1280px the Home's panel shows the
 * same (NeedsList, ui/HomePanel.tsx) and the rail its blocked agents outside any Home, under Other (Blocked). An item due later waits
 * under Later until its time. A tap on an item opens its menu: Mark done ticks it off (DELETE …/todos/:id, the State
 * push then drops it; a running headless Home takes up what follows), on a running Home Ask the orchestrator puts its
 * quote into the composer (transcript.ts's todoQuote: its text, id, worker and link), to ask its orchestrator about it,
 * and Dismiss drops it undone (…?dismiss=1: its orchestrator is told it isn't needed, so no next step follows, and a
 * PR's item isn't taken for a merge). A link shows its host; an agent's name opens it (openAgentNamed).
 */
import { Anchor, Badge, Button, Group, Loader, Menu, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { apiDelete } from '../api.ts';
import { draftKey, setQuote } from '../drafts.ts';
import { homeSummary, orchestratorStatus, type DashboardCard, type HomeSummary } from '../dashboard-group.ts';
import { openAgent, openAgentNamed } from '../nav.ts';
import { showToast } from '../notify.ts';
import { findPane, store } from '../store.ts';
import { dueLabel, linkHost, splitTodos } from '../todos.ts';
import { todoQuote } from '../transcript.ts';
import type { AppState, OrchestratorView, TodoItem } from '../types.ts';
import { AgentRow, agentCards, cardTitle, orchestratorLabel } from './Dashboard.tsx';

/** The time, again at each minute's start: an item due later comes up when its time comes and a usage limit's
 *  countdown ticks (both whole minutes), with no State push. Each wait is measured again, so a phone asleep
 *  catches up as it wakes. */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const next = (): void => { t = setTimeout(() => { setNow(Date.now()); next(); }, 60_000 - (Date.now() % 60_000)); };
    next();
    return () => clearTimeout(t);
  }, []);
  return now;
}

/** Whether Home `o`'s orchestrator itself waits on the user: a headless one's question, a TUI one's
 *  prompt in its pane (the status its dot shows). */
const asksUser = (o: OrchestratorView): boolean =>
  orchestratorStatus(o, o.paneId ? findPane(o.paneId)?.pane : undefined, store.seenDone) === 'blocked';

/** What waits on the user at Home `o`: its account's blocked agents, its orchestrator itself when it
 *  waits, its items due now. */
export function needsYou(o: OrchestratorView, state: AppState, now: number): number {
  return homeSummary(agentCards(state, o), store.seenDone).blocked.length + (asksUser(o) ? 1 : 0) + splitTodos(o.todos ?? [], now).now.length;
}

/** The count on a Home's switcher button and PC rail row; nothing at 0. */
export function NeedsBadge({ n }: { n: number }) {
  return n > 0 ? <Badge className="home-needs shrink-0" color="blocked" c="white" size="sm" radius="xl" px={6}>{n}</Badge> : null;
}

/** Home `o`'s "Needs you · n" (`n`: needsYou, `s`: its agents' summary), orange while n > 0; "To-do · n" (dim)
 *  while only items due later wait; nothing while nothing does. A tap opens the popover under it: on a
 *  phone as wide as the screen allows, and no taller than the room below it (it scrolls); Escape, a
 *  tap outside or a tap on it again closes it, and so does leaving the screen (a blocked agent or a
 *  worker's name opens its drawer, an Ask the composer). The keyboard's focus goes into it, and back to the
 *  button (after an Ask: into the composer). */
export function NeedsButton({ o, s, n, now }: { o: OrchestratorView; s: HomeSummary; n: number; now: number }) {
  const [opened, setOpened] = useState(false);
  const [asked, setAsked] = useState(false); // closed by an Ask: the focus stays in the composer
  // a running Home's composer takes it (it focuses in this tap: a phone's keyboard opens)
  const ask = o.paneId ? (it: TodoItem): void => {
    setQuote(draftKey('', o.name), todoQuote(it));
    setAsked(true);
    setOpened(false);
  } : undefined;
  useEffect(() => {
    if (!opened) return;
    const close = (): void => setOpened(false);
    addEventListener('hashchange', close);
    return () => removeEventListener('hashchange', close);
  }, [opened]);
  const todos = o.todos?.length ?? 0;
  if (!n && !todos) {
    if (opened) setOpened(false); // all done while open: the next one doesn't open it by itself
    return null;
  }
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-start" width="min(400px, calc(100vw - 24px))" radius="md" shadow="md"
      trapFocus returnFocus={!asked} middlewares={{ shift: { padding: 12 }, size: { padding: 12 } }} closeOnEscape={false}>
      <Popover.Target>
        <Button className="shrink-0" data-action="needs" size="compact-sm" radius="xl" fz={13} fw={700} variant={n ? 'filled' : 'default'}
          color="blocked" c={n ? 'white' : 'dimmed'} data-blocked={s.blocked.length} rightSection={<span className="text-[10px]">&#9662;</span>}
          onClick={() => { setAsked(false); setOpened(!opened); }}>
          {n ? `Needs you · ${n}` : `To-do · ${todos}`}
        </Button>
      </Popover.Target>
      {/* Mantine's own Escape (closeOnEscape) would take one meant for an item's menu inside it too */}
      <Popover.Dropdown className="overflow-y-auto overscroll-contain" data-needs-list=""
        onKeyDownCapture={(e) => { if (e.key === 'Escape' && !(e.target as Element).closest('[role="menu"]')) setOpened(false); }}>
        <NeedsList o={o} s={s} now={now} ask={ask} />
      </Popover.Dropdown>
    </Popover>
  );
}

const head = (text: string): ReactNode => <Text fz={11} fw={700} c="dimmed" tt="uppercase" lts="0.06em">{text}</Text>;

/** What waits on the user at Home `o` (`s`: its agents' summary): its orchestrator's question, its blocked agents
 *  and its to-do list. The popover's, and a PC's Home panel's (ui/HomePanel.tsx: its blocked agents as `rows`). */
export function NeedsList({ o, s, now, ask, rows }: { o: OrchestratorView; s: HomeSummary; now: number; ask?: (it: TodoItem) => void; rows?: boolean }) {
  return (
    <Stack gap={12}>
      {asksUser(o) && <Text data-asks="" fz={13} c="blocked" fw={600}>{`${orchestratorLabel(o)} is waiting for your answer, below the chat.`}</Text>}
      <Blocked cards={s.blocked} rows={rows} />
      {(o.todos?.length ?? 0) > 0 && <Stack gap={4}>{head('To-do')}<Todos o={o} now={now} ask={ask} /></Stack>}
    </Stack>
  );
}

/** Agents waiting on the user, under "Waiting on you", as chips (a tap opens it: nav.ts's openAgent), or as the agents
 *  popover's rows (`rows`: AgentRow, with a PC's ⋮). Nothing without any. */
export function Blocked({ cards, rows }: { cards: DashboardCard[]; rows?: boolean }) {
  if (!cards.length) return null;
  if (rows) return <Stack gap={0} className="-mx-3"><div className="px-3 pb-1">{head('Waiting on you')}</div>{cards.map((c) => <AgentRow key={c.pane.paneId} card={c} />)}</Stack>;
  return (
    <Stack gap={6}>
      {head('Waiting on you')}
      <Group gap={6}>
        {cards.map((c) => (
          <Button key={c.pane.paneId} className="home-chip max-w-full text-(--color-text)" variant="outline" color="blocked" size="compact-sm" radius="xl"
            fz={13} fw={600} data-pane-id={c.pane.paneId} onClick={() => openAgent(c.pane.paneId)}>
            {cardTitle(c)}<Text span fz={11} fw={500} c="dimmed" ml={6} truncate>{c.workspaceLabel}</Text>
          </Button>
        ))}
      </Group>
    </Stack>
  );
}

/** Home `o`'s items: the ones to do now, then Later (n), closed until tapped. Nothing without items. `ask`:
 *  each menu has Ask the orchestrator, off while its question is open (the composer is the question's then). */
export function Todos({ o, now, ask }: { o: OrchestratorView; now: number; ask?: (it: TodoItem) => void }) {
  const off = !!o.headless?.pending;
  const [open, setOpen] = useState(false);
  const { now: due, later } = splitTodos(o.todos ?? [], now);
  if (!due.length && !later.length) return null;
  return (
    <Stack className="home-todos" gap={0}>
      {due.map((it) => <Todo key={it.id} home={o.name} item={it} now={now} ask={ask && (() => ask(it))} off={off} />)}
      {later.length > 0 && (
        <UnstyledButton className="self-start py-1 text-[12px] font-semibold text-(--color-text-dim) hover:text-(--color-text)" data-action="todo-later"
          aria-expanded={open} onClick={() => setOpen(!open)}>
          {`Later (${later.length}) ${open ? '▾' : '›'}`}
        </UnstyledButton>
      )}
      {open && later.map((it) => <Todo key={it.id} home={o.name} item={it} now={now} ask={ask && (() => ask(it))} off={off} />)}
    </Stack>
  );
}

// the menu's Ask: a speech bubble, drawn as ChatLog.tsx's REPLY_ICON
const ASK_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
  </svg>
);

// An item is one target: a tap or a click on it (not on its worker or its link, which are theirs), or Enter/Space on it, opens
// its menu under it: Mark done, on a running Home Ask the orchestrator (off while its question is open), Dismiss; the arrow keys
// move in it, Escape closes it (just it: NeedsButton leaves an Escape from inside a menu to the menu). The menu stays in the
// item's DOM (not a portal; fixed, so no scroll box clips it), so the Needs you popover doesn't take a tap in it for one outside
// and stays open over a Mark done. ⋮ at its right says it has one. Ask's quote focuses the composer: the menu then doesn't
// put the focus back on the item (`back`).
function Todo({ home, item, now, ask, off }: { home: string; item: TodoItem; now: number; ask?: () => void; off: boolean }) {
  const [busy, setBusy] = useState(false);
  const [back, setBack] = useState(true);
  const host = item.url ? linkHost(item.url) : null;
  const due = item.due != null ? dueLabel(item.due, now) : null;
  // done, or dismissed: off the list undone, and its orchestrator told so (no next step follows)
  const remove = async (dismiss: boolean): Promise<void> => {
    setBusy(true); // until the State push drops it
    try {
      await apiDelete(`/api/orchestrators/${encodeURIComponent(home)}/todos/${encodeURIComponent(item.id)}${dismiss ? '?dismiss=1' : ''}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return; // gone already: its orchestrator ticked it off
      setBusy(false);
      showToast(dismiss ? 'Could not dismiss it' : 'Could not tick it off', (err as Error).message);
    }
  };
  const own = (e: SyntheticEvent): void => e.stopPropagation(); // a link's tap is the link's, not the menu's
  return (
    <Menu position="bottom-end" withinPortal={false} floatingStrategy="fixed" disabled={busy} returnFocus={back} onOpen={() => setBack(true)}>
      <Menu.Target>
        {/* a line under each but the list's last, so items of two or three lines don't run together */}
        <div role="button" tabIndex={0} data-todo={item.id} aria-busy={busy || undefined}
          className={`home-todo -mx-2 flex cursor-pointer items-center gap-2 border-b border-(--color-border) px-2 last:border-b-0
            hover:bg-(--color-border) active:bg-(--color-border) data-expanded:bg-(--color-border) focus-visible:outline-2
            focus-visible:-outline-offset-2 focus-visible:outline-(--color-accent) aria-busy:opacity-50 min-h-11 py-1.5`}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.currentTarget.click(); }
          }}>
          <div className="min-w-0 flex-1">
            <Text fz={14} className="break-words">{item.text}</Text>
            {(item.agent || host || due) && (
              <Group gap={10} className="text-[12px]">
                {item.agent && <Anchor component="button" fz={12} data-agent={item.agent} onClick={(e) => { own(e); openAgentNamed(item.agent!); }}>{item.agent}</Anchor>}
                {host && <Anchor href={item.url!} target="_blank" rel="noopener noreferrer" fz={12} data-host={host} onClick={own}>{`${host} ↗`}</Anchor>}
                {due && <Text span fz={12} fw={due.past ? 600 : undefined} c={due.past ? 'blocked' : 'dimmed'} data-due={due.past ? 'past' : 'later'}>{due.past ? `due ${due.text}` : due.text}</Text>}
              </Group>
            )}
          </div>
          {busy ? <Loader size={14} /> : <span className="shrink-0 text-(--color-text-dim)" aria-hidden="true">&#8942;</span>}
        </div>
      </Menu.Target>
      <Menu.Dropdown data-todo-menu={item.id}>
        <Menu.Item className="min-h-11" fz="md" leftSection={<span className="w-4 text-center" aria-hidden="true">&#10003;</span>} data-action="todo-done"
          onClick={() => { void remove(false); }}>Mark done</Menu.Item>
        {ask && (
          <Menu.Item className="min-h-11" fz="md" leftSection={ASK_ICON} data-action="todo-ask" disabled={off} onClick={() => { setBack(false); ask(); }}>
            Ask the orchestrator
            {off && <Text fz={12} c="dimmed">Answer its question first</Text>}
          </Menu.Item>
        )}
        <Menu.Item className="min-h-11" fz="md" leftSection={<span className="w-4 text-center" aria-hidden="true">&#10005;</span>} data-action="todo-dismiss"
          onClick={() => { void remove(true); }}>
          Dismiss
          <Text fz={12} c="dimmed">Not needed: no follow-up</Text>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
