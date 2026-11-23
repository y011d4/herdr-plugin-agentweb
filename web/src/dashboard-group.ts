/**
 * Pure flattening + ordering for the agents dashboard, extracted from app.ts
 * (which is DOM-coupled) so the logic is unit-testable. Every agent pane across
 * all workspaces becomes one card in a single list, most recent status change
 * (sinceUnixMs) first. Each card carries its own workspace label and git context
 * since there are no per-workspace group headers.
 */
import type { PaneNode, WorkspaceNode } from './types.ts';

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

/** `pinnedPaneId` (the orchestrator) goes first regardless of recency. */
export function dashboardCards(workspaces: WorkspaceNode[], pinnedPaneId: string | null = null): DashboardCard[] {
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
  const pinned = (c: DashboardCard): number => (c.pane.paneId === pinnedPaneId ? 1 : 0);
  return cards.sort((a, b) => pinned(b) - pinned(a) || b.pane.agent!.sinceUnixMs - a.pane.agent!.sinceUnixMs);
}

export interface HomeSummary {
  /** agents waiting on the user, most recent first */
  blocked: DashboardCard[];
  working: number;
  done: number;
  /** idle + unknown */
  idle: number;
}

/** The home status bar: every agent but the orchestrator itself — the ones that need the user, and counts of the rest. */
export function homeSummary(workspaces: WorkspaceNode[], orchestratorPaneId: string | null): HomeSummary {
  const s: HomeSummary = { blocked: [], working: 0, done: 0, idle: 0 };
  for (const c of dashboardCards(workspaces)) {
    if (c.pane.paneId === orchestratorPaneId) continue;
    const st = c.pane.agent!.status;
    if (st === 'blocked') s.blocked.push(c);
    else if (st === 'working') s.working++;
    else if (st === 'done') s.done++;
    else s.idle++;
  }
  return s;
}
