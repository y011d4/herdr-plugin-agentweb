/**
 * The agents list's card as app.ts rendered it before ui/Dashboard.tsx (copied verbatim from
 * e7d0701, with escHtml): the oracle of dashboard.test.tsx's card parity. Test-only; deleted
 * with app.ts.
 */
import { shownStatus } from '../src/dashboard-group.ts';
import type { DashboardCard } from '../src/dashboard-group.ts';
import { store } from '../src/store.ts';

function escHtml(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// One dashboard card. The list is flat (most recent status change first, see
// dashboardCards), so each card names its own workspace; `branch` and the
// `worktree` chip come from that workspace. pane.title is usually null, so the
// tab name is the card label, with a per-tab index for split-pane agents.
// A card's label: its tab name (the agent kind if a tab somehow has no label),
// with a per-tab index for split-pane agents.
function cardTitle({ pane, tabLabel, tabAgentIndex, tabAgentCount }: DashboardCard): string {
  const base = tabLabel || pane.agent?.name || pane.agent?.displayName || 'agent';
  return tabAgentCount > 1 ? `${base} #${tabAgentIndex}` : base;
}

export function renderCard(card: DashboardCard): string {
  const { pane, workspaceLabel, branch, isWorktree } = card;
  const { paneId, agent, title } = pane;
  const { displayName, name, customStatus, message, sinceUnixMs } = agent!;
  // The chip shows the stable agent kind, so prefer `name` (raw pane.agent,
  // e.g. "claude"/"codex") over displayName, which can be a richer label.
  const agentKind = name || displayName || 'agent';
  const cardLabel = cardTitle(card);
  const statusClass = shownStatus(pane, store.seenDone) || 'unknown';
  const meta = customStatus || message || '';
  const relTime = relativeTime(sinceUnixMs);

  return `
    <div class="agent-card" data-pane-id="${escHtml(paneId)}" role="button" tabindex="0">
      <div class="agent-card-header">
        <span class="agent-name">${escHtml(cardLabel)}</span>
        ${branch ? `<span class="card-branch">${escHtml(branch)}</span>` : ''}
        <span class="status-badge ${escHtml(statusClass)}">${escHtml(statusClass)}</span>
      </div>
      ${meta ? `<div class="agent-custom-status">${escHtml(meta)}</div>` : ''}
      <div class="agent-card-meta">
        <span class="card-workspace">${escHtml(workspaceLabel)}</span>
        <span class="agent-kind">${escHtml(agentKind)}</span>
        ${isWorktree ? '<span class="card-worktree">worktree</span>' : ''}
        ${title ? `<span class="pane-title">${escHtml(title)}</span>` : ''}
        ${relTime ? `<span>${escHtml(relTime)}</span>` : ''}
      </div>
    </div>`;
}
