/**
 * Pure grouping + status-ordering for the agents dashboard, extracted from
 * app.ts (which is DOM-coupled) so the logic is unit-testable. Linked worktrees
 * are grouped under their main checkout (matched by repoKey) and rendered as one
 * status-sorted list; the top-level entries are ordered by urgency so a blocked
 * worktree agent pulls its whole group above idle main-checkout agents.
 */
import type { WorkspaceNode } from './types.ts';

// Lower = more urgent. Drives both card order within a group and group order.
export function statusOrder(status: string): number {
  return ({ blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 } as Record<string, number>)[status] ?? 5;
}

// Most urgent agent status in a workspace; workspaces without agents sort last.
export function workspaceUrgency(ws: WorkspaceNode): number {
  const ranks = (ws.tabs ?? [])
    .flatMap((t) => t.panes ?? [])
    .filter((p) => p.agent)
    .map((p) => statusOrder(p.agent!.status));
  return ranks.length ? Math.min(...ranks) : 6;
}

/** A top-level dashboard entry and the workspaces rendered as its single group. */
export interface DashboardGroup {
  /** The workspace that owns the group's label/badge: a main checkout, or an
   *  orphan worktree whose main checkout isn't open. */
  entry: WorkspaceNode;
  /** `entry` followed by the linked worktrees grouped under it, in workspace order. */
  members: WorkspaceNode[];
}

/**
 * Group linked worktrees under their main checkout (matched by repoKey) and
 * order the resulting top-level entries by urgency — a blocked worktree agent
 * pulls its whole group ahead of an idle main checkout. A worktree whose main
 * checkout isn't open, and every non-worktree workspace, stays top-level. Pure:
 * no DOM, and the input array/objects are not mutated.
 */
export function groupWorkspacesForDashboard(workspaces: WorkspaceNode[]): DashboardGroup[] {
  const mainByRepo = new Map<string, WorkspaceNode>();
  for (const ws of workspaces) {
    const wt = ws.worktree;
    if (wt && !wt.isLinkedWorktree && wt.repoKey) mainByRepo.set(wt.repoKey, ws);
  }
  const worktreesOfMain = new Map<string, WorkspaceNode[]>();
  const absorbed = new Set<string>();
  for (const ws of workspaces) {
    const wt = ws.worktree;
    if (!wt?.isLinkedWorktree || !wt.repoKey) continue;
    const main = mainByRepo.get(wt.repoKey);
    if (!main || main.workspaceId === ws.workspaceId) continue;
    const arr = worktreesOfMain.get(main.workspaceId);
    if (arr) arr.push(ws);
    else worktreesOfMain.set(main.workspaceId, [ws]);
    absorbed.add(ws.workspaceId);
  }

  const entryUrgency = (ws: WorkspaceNode): number => {
    const wts = worktreesOfMain.get(ws.workspaceId) ?? [];
    return Math.min(workspaceUrgency(ws), ...wts.map(workspaceUrgency));
  };
  return workspaces
    .filter((ws) => !absorbed.has(ws.workspaceId))
    .sort((a, b) => entryUrgency(a) - entryUrgency(b))
    .map((ws) => ({ entry: ws, members: [ws, ...(worktreesOfMain.get(ws.workspaceId) ?? [])] }));
}
