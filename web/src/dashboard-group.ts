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

export function dashboardCards(workspaces: WorkspaceNode[]): DashboardCard[] {
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
  return cards.sort((a, b) => b.pane.agent!.sinceUnixMs - a.pane.agent!.sinceUnixMs);
}
