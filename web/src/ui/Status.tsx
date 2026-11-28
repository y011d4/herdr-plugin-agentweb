/** ui/Status.tsx — an agent's status as the list, the PC rail and Home show it: a badge (its word on
 *  its color) and a dot. The colors are the theme's (theme.ts) and style.css's, named as the statuses
 *  are; an orchestrator's dot can also be `stopped` (a ring). */
import { Badge } from '@mantine/core';

const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
const known = (status: string): string => (STATUSES.has(status) ? status : 'unknown');
// the text on a badge: white but on idle's and unknown's grays
const TEXT: Record<string, string> = { idle: 'dark.1', unknown: 'dark.2' };

/** The status's word on its color; `small` for the agent rows (a Home panel's, the agents popover's). */
export function StatusBadge({ status, small = false }: { status: string; small?: boolean }) {
  const s = known(status);
  return (
    <Badge className="status-badge shrink-0" data-status={status} color={s} c={TEXT[s] ?? 'white'} radius="xl"
      tt="lowercase" fw={600} fz={small ? 11 : 12} px={small ? 7 : 8}>
      {status}
    </Badge>
  );
}

const COUNTED = ['working', 'done', 'idle'] as const;

/** A Home's agents as counts, each after its status's dot (the rail's rows, the panel's heading): working, done, idle. A
 *  zero keeps its place unseen, so the rows' counts line up; nothing without any. */
export function StatusCounts({ n }: { n: Record<(typeof COUNTED)[number], number> }) {
  if (!n.working && !n.done && !n.idle) return null;
  return (
    <span className="status-counts flex items-center gap-2.5 text-[12px] tabular-nums text-(--color-text-dim)">
      {COUNTED.map((k) => (
        <span key={k} data-count={k} className={`flex items-center gap-1 ${n[k] ? '' : 'invisible'}`}>
          <StatusDot status={k} />{n[k]}<span className="sr-only">{` ${k}`}</span>
        </span>
      ))}
    </span>
  );
}

/** A status's dot before a name (an orchestrator's: its Home's state). */
export function StatusDot({ status }: { status: string }) {
  const ring = status === 'stopped';
  const s = known(status);
  return (
    <span className="status-dot inline-block size-2 shrink-0 rounded-full" data-status={status}
      style={ring ? { boxShadow: 'inset 0 0 0 1px var(--color-idle)' } : { background: `var(--color-${s === 'unknown' ? 'idle' : s})` }} />
  );
}
