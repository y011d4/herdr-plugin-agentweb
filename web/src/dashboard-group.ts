/**
 * Pure flattening + ordering for the agents dashboard, extracted from app.ts
 * (which is DOM-coupled) so the logic is unit-testable. Every agent pane across
 * all workspaces becomes one card in a single list, most recent status change
 * (sinceUnixMs) first. Each card carries its own workspace label and git context
 * since there are no per-workspace group headers.
 */
import type { AgentStatus, PaneNode, WorkspaceNode } from './types.ts';

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
}

/** `pinned` panes (the orchestrators) go first, in that order, regardless of recency. */
export function dashboardCards(workspaces: WorkspaceNode[], pinned: Array<string | null> = []): DashboardCard[] {
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
      }));
    });
  });
  // sort is stable: equal times (every agent right after a bridge restart) keep workspace order
  const rank = (c: DashboardCard): number => {
    const i = pinned.indexOf(c.pane.paneId);
    return i === -1 ? pinned.length : i;
  };
  return cards.sort((a, b) => rank(a) - rank(b) || b.pane.agent!.sinceUnixMs - a.pane.agent!.sinceUnixMs);
}

export interface HomeSummary {
  /** agents waiting on the user, most recent first */
  blocked: DashboardCard[];
  working: number;
  done: number;
  /** idle + unknown */
  idle: number;
}

/** The home status bar: every agent but this Home's orchestrator (other orchestrators included) — the ones that need the user, and counts of the rest. */
export function homeSummary(workspaces: WorkspaceNode[], orchestratorPaneId: string | null, seen: SeenDone = {}): HomeSummary {
  const s: HomeSummary = { blocked: [], working: 0, done: 0, idle: 0 };
  for (const c of dashboardCards(workspaces)) {
    if (c.pane.paneId === orchestratorPaneId) continue;
    const st = shownStatus(c.pane, seen);
    if (st === 'blocked') s.blocked.push(c);
    else if (st === 'working') s.working++;
    else if (st === 'done') s.done++;
    else s.idle++;
  }
  return s;
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
