/**
 * Pure text overview of every herdr agent, for an orchestrator agent to read
 * via `agentwebctl.js overview`. No I/O: the CLI fetches agent.list /
 * session.snapshot, each agent's transcript items or screen text, and passes
 * them in. Output is plain, compact, ANSI-free text.
 */

import type { TimelineItem } from './transcript-normalize.ts';

export interface RawAgent {
  name?: string | null;
  pane_id: string;
  agent?: string;
  agent_status?: string;
  workspace_id?: string;
  tab_id?: string;
  cwd?: string;
  foreground_cwd?: string;
  agent_session?: { source?: string; value?: string } | null;
}

export interface RawSnapshot {
  workspaces?: Array<{ workspace_id: string; label?: string }>;
  tabs?: Array<{ tab_id: string; label?: string }>;
}

/** Per-agent detail gathered by the CLI: transcript items (claude) or screen text. */
export interface AgentDetail {
  items?: TimelineItem[];
  screen?: string;
}

const STATUS_ORDER = ['blocked', 'working', 'done', 'idle', 'unknown'];
const rank = (s: string | undefined): number => {
  const i = STATUS_ORDER.indexOf(s ?? 'unknown');
  return i === -1 ? STATUS_ORDER.length - 1 : i;
};

// Collapse whitespace and control chars (incl. ESC) to single spaces, then cap
// by code points so a surrogate pair is never split.
// User turns Claude Code writes itself (background-task wakeups, reminders, slash
// commands and their output, `!` shell runs) — not what the agent was asked to do.
// `<pasted_content>` is the user's own paste, so it counts. (Mirrors the web
// home chat's filter in web/src/transcript.ts; the two builds don't share code.)
const INJECTED_USER_TURN = /^\s*<(task-notification|system-reminder|local-command-[\w-]+|command-(name|message|args)|bash-(input|stdout|stderr))>/;

export function clip(s: string, max: number): string {
  const flat = s.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  const cps = Array.from(flat);
  return cps.length > max ? cps.slice(0, max - 1).join('') + '…' : flat;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The agents to report, in display order (status rank, stable), minus the caller's pane. */
export function orderAgents(agents: RawAgent[], selfPaneId: string | undefined): RawAgent[] {
  return agents.filter((a) => a.pane_id !== selfPaneId).sort((a, b) => rank(a.agent_status) - rank(b.agent_status));
}

export function formatOverview(
  agents: RawAgent[],
  snapshot: RawSnapshot,
  details: Map<string, AgentDetail>,
  selfPaneId: string | undefined,
  now: number,
): string {
  const ordered = orderAgents(agents, selfPaneId);
  if (ordered.length === 0) return 'no other agents';
  const wsLabel = new Map((snapshot.workspaces ?? []).map((w) => [w.workspace_id, w.label]));
  const tabLabel = new Map((snapshot.tabs ?? []).map((t) => [t.tab_id, t.label]));

  return ordered.map((a) => {
    const status = a.agent_status ?? 'unknown';
    const items = (details.get(a.pane_id)?.items ?? []);
    const main = items.filter((i) => !i.sidechain);
    const newestTs = items.findLast((i) => i.ts !== null)?.ts ?? null;
    const where = [wsLabel.get(a.workspace_id ?? ''), tabLabel.get(a.tab_id ?? '')].filter(Boolean).join(' › ');
    const meta = [`pane ${a.pane_id}`, newestTs !== null ? `last activity ${ago(now - newestTs)}` : null].filter(Boolean).join(', ');
    const lines = [[a.name || a.pane_id, status, where, `(${meta})`].filter(Boolean).join('  ')];

    const task = main.findLast((i) => i.kind === 'user' && !INJECTED_USER_TURN.test(i.text));
    if (task?.kind === 'user') lines.push(`  task: ${clip(task.text, 160)}`);
    const last = main.findLast((i) => i.kind === 'assistant');
    if (last?.kind === 'assistant') lines.push(`  last: ${clip(last.text, 300)}`);
    const tail = main.at(-1);
    if (tail?.kind === 'tool_use' && (status === 'working' || status === 'blocked')) {
      lines.push(`  ${status === 'blocked' ? 'pending' : 'doing'}: ${clip(`${tail.name} ${tail.summary}`, 300)}`);
    }

    const screen = details.get(a.pane_id)?.screen;
    if (items.length === 0 && screen) {
      // Keep lines with a letter/digit, dropping blank lines and box-drawing rules.
      const text = screen.split('\n').filter((l) => /[\p{L}\p{N}]/u.test(l)).slice(-4).map((l) => l.trim()).join(' ⏎ ');
      if (text) lines.push(`  screen: ${clip(text, 300)}`);
    }
    return lines.join('\n');
  }).join('\n');
}
