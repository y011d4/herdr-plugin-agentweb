/**
 * A Home's to-do list for the user (State `orchestrators[].todos`, the bridge's todo.go: what its
 * orchestrator wrote down for the user to do), as ui/Todos.tsx shows it. Pure: no DOM, no store.
 */
import type { TodoItem } from './types.ts';

/** The items to do now (no due, or come due), oldest first, and the ones due later, soonest first. */
export function splitTodos(items: TodoItem[], now: number): { now: TodoItem[]; later: TodoItem[] } {
  const later = items.filter((i) => i.due != null && i.due > now).sort((a, b) => a.due! - b.due!);
  return { now: items.filter((i) => !later.includes(i)), later };
}

/** A link's host, shown with it (the orchestrator wrote the link: the host says where it goes); null
 *  for anything but an http(s) URL, which is then not a link. */
export function linkHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : null;
  } catch {
    return null;
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** When an item is for, in local time: "today 18:00", "tomorrow 09:00", "yesterday 09:00", else
 *  "11/30 09:00"; `past` once it has come. */
export function dueLabel(due: number, now: number): { text: string; past: boolean } {
  const d = new Date(due);
  const day = (t: Date): number => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((day(d) - day(new Date(now))) / 86_400_000); // round: a DST day is 23 or 25 h
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const named: Record<number, string> = { [-1]: 'yesterday', 0: 'today', 1: 'tomorrow' };
  return { text: `${named[days] ?? `${d.getMonth() + 1}/${d.getDate()}`} ${hm}`, past: due <= now };
}

const HOUR = 3_600_000;

/** Snooze's presets at `now`, each to the whole minute (the bridge reminds at the minute's tick): in 1 and 3 hours, this
 *  evening (18:00, while that is an hour or more ahead) and tomorrow morning (09:00, as a due given as a date). */
export function snoozeChoices(now: number): { label: string; at: number }[] {
  const d = new Date(now);
  const day = (days: number, h: number): number => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, h).getTime();
  const inH = (h: number): number => Math.ceil((now + h * HOUR) / 60_000) * 60_000;
  return [
    { label: 'In 1 hour', at: inH(1) },
    { label: 'In 3 hours', at: inH(3) },
    ...(day(0, 18) - now >= HOUR ? [{ label: 'This evening', at: day(0, 18) }] : []),
    { label: 'Tomorrow morning', at: day(1, 9) },
  ];
}

/** `t` as an <input type="datetime-local"> takes it: local time, to the minute. */
export function localInput(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
