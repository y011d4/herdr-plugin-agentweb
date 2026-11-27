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
