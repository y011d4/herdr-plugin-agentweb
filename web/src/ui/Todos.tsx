/**
 * ui/Todos.tsx — what waits on the user at a Home, and its to-do list. Each Home's "needs you" count:
 * the badge on its switcher button and its PC sidebar heading, and on its status bar (Pane.tsx's
 * HomeStatus, on a running Home and a stopped one alike) "Needs you · n", which opens a popover: its
 * account's blocked agents (a tap: the drawer), its orchestrator's own question (answered below the
 * chat) and the to-do list, what its orchestrator wrote down (todos.ts); on a PC the sidebar shows the same
 * (NeedsList) under the Home's heading, its blocked agents outside any Home under Other (Blocked). An item due later waits
 * under Later until its time; ✓ ticks one off (DELETE …/todos/:id, the State push then drops it). A
 * link shows its host; an agent's name opens its drawer. On a running Home, Ask puts an item's quote into the
 * composer (transcript.ts's todoQuote: its text, id, worker and link), to ask its orchestrator about it. The sidebar's
 * are `dense`: smaller, each item's text two lines at most (all of it on hover), its Ask on the line of its worker and link.
 */
import { ActionIcon, Anchor, Badge, Button, Group, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState, type ReactNode } from 'react';
import { apiDelete } from '../api.ts';
import { draftKey, setQuote } from '../drafts.ts';
import { homeSummary, orchestratorStatus, type DashboardCard, type HomeSummary } from '../dashboard-group.ts';
import { openAgent, openAgentNamed } from '../nav.ts';
import { showToast } from '../notify.ts';
import { findPane, store } from '../store.ts';
import { dueLabel, linkHost, splitTodos } from '../todos.ts';
import { todoQuote } from '../transcript.ts';
import type { AppState, OrchestratorView, TodoItem } from '../types.ts';
import { agentCards, cardTitle, orchestratorLabel } from './Dashboard.tsx';

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

/** The count on a Home's switcher button and sidebar heading; nothing at 0. */
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
      trapFocus returnFocus={!asked} middlewares={{ shift: { padding: 12 }, size: { padding: 12 } }}>
      <Popover.Target>
        <Button className="shrink-0" data-action="needs" size="compact-sm" radius="xl" fz={13} fw={700} variant={n ? 'filled' : 'default'}
          color="blocked" c={n ? 'white' : 'dimmed'} data-blocked={s.blocked.length} rightSection={<span className="text-[10px]">&#9662;</span>}
          onClick={() => { setAsked(false); setOpened(!opened); }}>
          {n ? `Needs you · ${n}` : `To-do · ${todos}`}
        </Button>
      </Popover.Target>
      <Popover.Dropdown className="overflow-y-auto overscroll-contain" data-needs-list="">
        <NeedsList o={o} s={s} now={now} ask={ask} />
      </Popover.Dropdown>
    </Popover>
  );
}

const head = (text: string): ReactNode => <Text fz={11} fw={700} c="dimmed" tt="uppercase" lts="0.06em">{text}</Text>;

/** What waits on the user at Home `o` (`s`: its agents' summary): its orchestrator's question, its blocked agents
 *  and its to-do list. The popover's, and on a PC the sidebar's (`dense`), under the Home's heading. */
export function NeedsList({ o, s, now, ask, dense }: { o: OrchestratorView; s: HomeSummary; now: number; ask?: (it: TodoItem) => void; dense?: boolean }) {
  return (
    <Stack gap={dense ? 8 : 12}>
      {asksUser(o) && <Text data-asks="" fz={13} c="blocked" fw={600}>{`${orchestratorLabel(o)} is waiting for your answer, below the chat.`}</Text>}
      <Blocked cards={s.blocked} />
      {(o.todos?.length ?? 0) > 0 && <Stack gap={4}>{head('To-do')}<Todos o={o} now={now} ask={ask} dense={dense} /></Stack>}
    </Stack>
  );
}

/** Agents waiting on the user, under "Waiting on you", as chips (a tap: its drawer). Nothing without any. */
export function Blocked({ cards }: { cards: DashboardCard[] }) {
  if (!cards.length) return null;
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
 *  each has Ask, off while its orchestrator's question is open (the composer is the question's then). */
export function Todos({ o, now, ask, dense }: { o: OrchestratorView; now: number; ask?: (it: TodoItem) => void; dense?: boolean }) {
  const off = !!o.headless?.pending;
  const [open, setOpen] = useState(false);
  const { now: due, later } = splitTodos(o.todos ?? [], now);
  if (!due.length && !later.length) return null;
  return (
    <Stack className="home-todos" gap={0}>
      {due.map((it) => <Todo key={it.id} home={o.name} item={it} now={now} ask={ask && (() => ask(it))} off={off} dense={dense} />)}
      {later.length > 0 && (
        <UnstyledButton className="self-start py-1 text-[12px] font-semibold text-(--color-text-dim) hover:text-(--color-text)" data-action="todo-later"
          aria-expanded={open} onClick={() => setOpen(!open)}>
          {`Later (${later.length}) ${open ? '▾' : '›'}`}
        </UnstyledButton>
      )}
      {open && later.map((it) => <Todo key={it.id} home={o.name} item={it} now={now} ask={ask && (() => ask(it))} off={off} dense={dense} />)}
    </Stack>
  );
}

// `dense` (the sidebar's): smaller, ✓ centered on the row as the popover's, the text two lines at most (all of it on hover), and Ask at the
// right end of the line under it with the worker, the link and the due time (`inline`), so the text has the row's width
function Todo({ home, item, now, ask, off, dense }: { home: string; item: TodoItem; now: number; ask?: () => void; off: boolean; dense?: boolean }) {
  const [busy, setBusy] = useState(false);
  const host = item.url ? linkHost(item.url) : null;
  const due = item.due != null ? dueLabel(item.due, now) : null;
  const done = async (): Promise<void> => {
    setBusy(true); // until the State push drops it
    try {
      await apiDelete(`/api/orchestrators/${encodeURIComponent(home)}/todos/${encodeURIComponent(item.id)}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return; // gone already: its orchestrator ticked it off
      setBusy(false);
      showToast('Could not tick it off', (err as Error).message);
    }
  };
  const meta = !!(item.agent || host || due);
  const inline = dense && meta;
  const askButton = ask && (
    <Button className={`shrink-0 ${inline ? 'ml-auto' : ''}`} variant="subtle" size={dense ? 'compact-xs' : 'compact-sm'} fz={dense ? 12 : 13} data-action="todo-ask"
      aria-label={`Ask about: ${item.text}`} disabled={off} title={off ? 'Answer the question first' : undefined} onClick={ask}>Ask</Button>
  );
  return (
    // a line under each but the list's last, so items of two or three lines don't run together
    <Group className={`home-todo border-b border-(--color-border) last:border-b-0 ${dense ? 'py-1' : 'py-1.5'}`} data-todo={item.id} gap={dense ? 8 : 10}
      wrap="nowrap">
      <ActionIcon variant="default" radius="xl" size={dense ? 'sm' : undefined} className="shrink-0" aria-label={`Done: ${item.text}`} data-action="todo-done"
        loading={busy} onClick={() => { void done(); }}>&#10003;</ActionIcon>
      <div className="min-w-0 flex-1">
        <Text fz={dense ? 13 : 14} lh={dense ? 1.45 : undefined} className="break-words" lineClamp={dense ? 2 : undefined} title={dense ? item.text : undefined}>{item.text}</Text>
        {meta && (
          <Group gap={10} className="text-[12px]">
            {item.agent && <Anchor component="button" fz={12} data-agent={item.agent} onClick={() => openAgentNamed(item.agent!)}>{item.agent}</Anchor>}
            {host && <Anchor href={item.url!} target="_blank" rel="noopener noreferrer" fz={12} data-host={host}>{`${host} ↗`}</Anchor>}
            {due && <Text span fz={12} fw={due.past ? 600 : undefined} c={due.past ? 'blocked' : 'dimmed'} data-due={due.past ? 'past' : 'later'}>{due.past ? `due ${due.text}` : due.text}</Text>}
            {inline && askButton}
          </Group>
        )}
      </div>
      {!inline && askButton}
    </Group>
  );
}
