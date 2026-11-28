/**
 * Pure flattening + ordering for the agents dashboard, kept out of ui/Dashboard.tsx
 * so the logic is unit-testable on its own. Every agent pane across
 * all workspaces becomes one card in a single list, most recent status change
 * (sinceUnixMs) first. Each card carries its own workspace label and git context
 * since there are no per-workspace group headers.
 */
import type { AgentStatus, OrchestratorView, PaneNode, WorkspaceNode } from './types.ts';

export interface DashboardCard {
  /** always has an agent */
  pane: PaneNode;
  workspaceLabel: string;
  branch: string | null;
  isWorktree: boolean;
  tabLabel: string;
  /** 1-based position among the tab's agent panes, to tell split-pane cards apart */
  tabAgentIndex: number;
  tabAgentCount: number;
  /** what it is for, as its orchestrator said (AppState's purposes); null: nothing said */
  purpose: string | null;
}

/** Every agent but the `orchestrators` (they have Homes, not cards); with a `scope` (an
 *  orchestrator's account's agents), only those. */
export function dashboardCards(workspaces: WorkspaceNode[], orchestrators: Array<string | null> = [], scope: string[] | null = null,
  purposes: Record<string, string> = {}): DashboardCard[] {
  const cards = workspaces.flatMap((ws) => {
    const branch = ws.worktree?.branch || null;
    const isWorktree = ws.worktree?.isLinkedWorktree ?? false;
    return (ws.tabs ?? []).flatMap((t) => {
      const agentPanes = (t.panes ?? []).filter((p) => p.agent);
      return agentPanes.map((pane, i) => ({
        pane,
        workspaceLabel: ws.label || ws.workspaceId,
        branch,
        isWorktree,
        tabLabel: t.label,
        tabAgentIndex: i + 1,
        tabAgentCount: agentPanes.length,
        purpose: purposes[pane.paneId] || null,
      }));
    });
  });
  // Most recent status change first, in herdr's own order (stateChangeSeq): sinceUnixMs is
  // the bridge's clock and resets on a bridge restart, so alone it would sink an agent that has
  // been working since before it. A change not fetched yet (null) is the newest. Stable sort:
  // full ties (no seqs, e.g. an older herdr, and equal times) keep workspace order.
  const changed = (c: DashboardCard): number => c.pane.agent!.stateChangeSeq ?? Infinity;
  return cards
    .filter((c) => !orchestrators.includes(c.pane.paneId) && (!scope || scope.includes(c.pane.paneId)))
    .sort((a, b) => changed(b) - changed(a) || b.pane.agent!.sinceUnixMs - a.pane.agent!.sinceUnixMs);
}

export interface HomeSummary {
  /** agents waiting on the user, most recent first */
  blocked: DashboardCard[];
  working: number;
  done: number;
  /** idle + unknown */
  idle: number;
}

/** The home status bar over a Home's agents (dashboardCards): the ones that need the user, and counts of the rest. */
export function homeSummary(cards: DashboardCard[], seen: SeenDone = {}): HomeSummary {
  const s: HomeSummary = { blocked: [], working: 0, done: 0, idle: 0 };
  for (const c of cards) {
    const st = shownStatus(c.pane, seen);
    if (st === 'blocked') s.blocked.push(c);
    else if (st === 'working') s.working++;
    else if (st === 'done') s.done++;
    else s.idle++;
  }
  return s;
}

const URGENCY: Partial<Record<AgentStatus, number>> = { blocked: 0, working: 1, done: 2 };

/** A Home's agents popover order (ui/Pane.tsx's AgentsButton): blocked, working, done, then idle and unknown, each
 *  status in `cards`' own order (most recent status change first). */
export function byUrgency(cards: DashboardCard[], seen: SeenDone = {}): DashboardCard[] {
  const rank = (c: DashboardCard): number => URGENCY[shownStatus(c.pane, seen)] ?? 3;
  return [...cards].sort((a, b) => rank(a) - rank(b));
}

/**
 * Done panes this phone has already looked at: paneId -> herdr's completion_seq of
 * the done it saw. herdr's server-side "seen" flag (what turns done into idle) can
 * only be set by focusing the pane, which would switch the PC's screen, so the
 * phone keeps its own record, the way each herdr TUI client tracks the completions
 * it has viewed. completion_seq identifies the completion (unlike sinceUnixMs it
 * survives a bridge restart), so the next completion shows as done again.
 */
export type SeenDone = Record<string, number>;

/**
 * Record `paneId`'s current done as seen and prune entries whose pane has moved on
 * to another completion. A view is recorded only against a known completionSeq —
 * before it arrives there is nothing reliable to tie the view to, so the caller
 * retries on later states while the pane is still open. A done pane whose seq is
 * being (re)fetched (e.g. right after a bridge restart) keeps its existing record.
 */
export function markSeen(seen: SeenDone, workspaces: WorkspaceNode[], paneId: string): SeenDone {
  const next: SeenDone = {};
  for (const ws of workspaces) {
    for (const t of ws.tabs ?? []) {
      for (const p of t.panes ?? []) {
        const a = p.agent;
        if (a?.status !== 'done') continue;
        if (a.completionSeq == null) {
          if (p.paneId in seen) next[p.paneId] = seen[p.paneId];
        } else if (p.paneId === paneId || seen[p.paneId] === a.completionSeq) {
          next[p.paneId] = a.completionSeq;
        }
      }
    }
  }
  return next;
}

/** The status to show for an agent pane: a done the phone has seen reads as idle. */
export function shownStatus(pane: PaneNode, seen: SeenDone): AgentStatus {
  const { status, completionSeq } = pane.agent!;
  return status === 'done' && completionSeq != null && seen[pane.paneId] === completionSeq ? 'idle' : status;
}

/** An orchestrator's agents: `home` null is Other. */
export interface HomeGroup { home: OrchestratorView | null; cards: DashboardCard[] }

/**
 * The agents by orchestrator (the PC rail, ui/Sidebar.tsx, lists Other's blocked ones): each orchestrator, in config order, with its account's
 * agents in `cards`' order, then Other: the agents no orchestrator's account lists (left out when
 * empty). An agent is under every orchestrator of its account, as each Home counts it. One whose
 * account isn't known (`agents` null) gets none: its Home counts every agent, and listing them all
 * under it would repeat the other groups.
 */
export function homeGroups(cards: DashboardCard[], orchestrators: OrchestratorView[]): HomeGroup[] {
  const groups: HomeGroup[] = orchestrators.map((o) => ({ home: o, cards: cards.filter((c) => o.agents?.includes(c.pane.paneId)) }));
  const listed = new Set(groups.flatMap((g) => g.cards.map((c) => c.pane.paneId)));
  const other = cards.filter((c) => !listed.has(c.pane.paneId));
  return other.length ? [...groups, { home: null, cards: other }] : groups;
}

/** An orchestrator's dot (a Home's switcher, the PC rail): stopped without a pane, unknown while its
 *  pane (`pane`: findPane's) has no agent yet, else its agent's shown status. */
export function orchestratorStatus(o: OrchestratorView, pane: PaneNode | undefined, seen: SeenDone): AgentStatus | 'stopped' {
  return !o.paneId ? 'stopped' : pane?.agent ? shownStatus(pane, seen) : 'unknown';
}
