/**
 * ui/Todos.tsx — a Home's to-do list for the user, under its "Needs you" (Pane.tsx's HomeStatus, on a
 * running Home and a stopped one alike): what its orchestrator wrote down (todos.ts). An item due
 * later waits under Later until its time; ✓ ticks one off (DELETE …/todos/:id, the State push then
 * drops it). A link shows its host; an agent's name opens its drawer. And each Home's "needs you"
 * count, the badge on its switcher button and its PC sidebar heading.
 */
import { ActionIcon, Anchor, Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';
import { apiDelete } from '../api.ts';
import { homeSummary, orchestratorStatus } from '../dashboard-group.ts';
import { openAgentNamed } from '../nav.ts';
import { showToast } from '../notify.ts';
import { findPane, store } from '../store.ts';
import { dueLabel, linkHost, splitTodos } from '../todos.ts';
import type { AppState, OrchestratorView, TodoItem } from '../types.ts';
import { agentCards } from './Dashboard.tsx';

/** The time, again each minute: an item due later comes up when its time comes, with no State push. */
export function useMinute(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** What waits on the user at Home `o`: its account's blocked agents, its orchestrator itself when it
 *  waits (a headless one's question, a TUI one's prompt in its pane: the status its dot shows), its
 *  items due now. */
export function needsYou(o: OrchestratorView, state: AppState, now: number): number {
  const self = orchestratorStatus(o, o.paneId ? findPane(o.paneId)?.pane : undefined, store.seenDone) === 'blocked' ? 1 : 0;
  return homeSummary(agentCards(state, o), store.seenDone).blocked.length + self + splitTodos(o.todos ?? [], now).now.length;
}

/** The count on a Home's switcher button and sidebar heading; nothing at 0. */
export function NeedsBadge({ n }: { n: number }) {
  return n > 0 ? <Badge className="home-needs shrink-0" color="blocked" c="white" size="sm" radius="xl" px={6}>{n}</Badge> : null;
}

/** Home `o`'s items: the ones to do now, then Later (n), closed until tapped. Nothing without items. */
export function Todos({ o, now }: { o: OrchestratorView; now: number }) {
  const [open, setOpen] = useState(false);
  const { now: due, later } = splitTodos(o.todos ?? [], now);
  if (!due.length && !later.length) return null;
  return (
    // at most a third of the screen, so the counts row below (the way to the list) stays on it
    <Stack className="home-todos max-h-[32vh] overflow-y-auto" gap={2}>
      {due.map((it) => <Todo key={it.id} home={o.name} item={it} now={now} />)}
      {later.length > 0 && (
        <UnstyledButton className="self-start py-1 text-[12px] font-semibold text-(--color-text-dim)" data-action="todo-later"
          aria-expanded={open} onClick={() => setOpen(!open)}>
          {`Later (${later.length}) ${open ? '▾' : '›'}`}
        </UnstyledButton>
      )}
      {open && later.map((it) => <Todo key={it.id} home={o.name} item={it} now={now} />)}
    </Stack>
  );
}

function Todo({ home, item, now }: { home: string; item: TodoItem; now: number }) {
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
  return (
    <Group className="home-todo" data-todo={item.id} gap={10} wrap="nowrap">
      <ActionIcon variant="default" radius="xl" className="shrink-0" aria-label={`Done: ${item.text}`} data-action="todo-done"
        loading={busy} onClick={() => { void done(); }}>&#10003;</ActionIcon>
      <div className="min-w-0 flex-1">
        <Text fz={14} className="break-words">{item.text}</Text>
        {(item.agent || host || due) && (
          <Group gap={10} className="text-[12px]">
            {item.agent && <Anchor component="button" fz={12} data-agent={item.agent} onClick={() => openAgentNamed(item.agent!)}>{item.agent}</Anchor>}
            {host && <Anchor href={item.url!} target="_blank" rel="noopener noreferrer" fz={12} data-host={host}>{`${host} ↗`}</Anchor>}
            {due && <Text span fz={12} fw={due.past ? 600 : undefined} c={due.past ? 'blocked' : 'dimmed'} data-due={due.past ? 'past' : 'later'}>{due.past ? `due ${due.text}` : due.text}</Text>}
          </Group>
        )}
      </div>
    </Group>
  );
}
