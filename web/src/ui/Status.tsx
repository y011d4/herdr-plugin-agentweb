/** ui/Status.tsx — an agent's status as the list, the PC sidebar and Home show it: a badge (its word on
 *  its color) and a dot. The colors are the theme's (theme.ts) and style.css's, named as the statuses
 *  are; an orchestrator's dot can also be `stopped` (a ring). */
import { Badge } from '@mantine/core';

const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
const known = (status: string): string => (STATUSES.has(status) ? status : 'unknown');
// the text on a badge: white but on idle's and unknown's grays
const TEXT: Record<string, string> = { idle: 'dark.1', unknown: 'dark.2' };

/** The status's word on its color; `small` for the sidebar's rows. */
export function StatusBadge({ status, small = false }: { status: string; small?: boolean }) {
  const s = known(status);
  return (
    <Badge className="status-badge shrink-0" data-status={status} color={s} c={TEXT[s] ?? 'white'} radius="xl"
      tt="lowercase" fw={600} fz={small ? 11 : 12} px={small ? 7 : 8}>
      {status}
    </Badge>
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
