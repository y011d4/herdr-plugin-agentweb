/**
 * ui/Dashboard.tsx — the agents list: #/agents, and #/agents/<name> (opened from that orchestrator's
 * Home: its account's agents, with ← Home back to it). One flat list, most recent status change
 * first (dashboardCards), never the orchestrators (each is started from its own Home).
 *
 * State pushes arrive constantly while the list is read. #screen-agents, the scroll container, stays
 * the same element while the list is shown and the cards are keyed by pane, so a push only rewrites
 * what changed: scrollTop and iOS momentum hold. While a finger is down the list doesn't change at all
 * (a rewrite mid-drag can cancel the scroll); the latest State shows once it lifts.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type TouchEvent } from 'react';
import { dashboardCards, shownStatus, type DashboardCard } from '../dashboard-group.ts';
import { agentsScope, defaultHome, homeHash, paneRoute } from '../routes.ts';
import { findPane, lastHome, store, subscribe } from '../store.ts';
import type { AppState, OrchestratorView } from '../types.ts';
import type { Topbar } from './App.tsx';
import { openNewAgent } from './Modals.tsx';

/** A card's label: its tab name (the agent kind if a tab somehow has no label), with a per-tab
 *  index for split-pane agents. */
export function cardTitle({ pane, tabLabel, tabAgentIndex, tabAgentCount }: DashboardCard): string {
  const base = tabLabel || pane.agent?.name || pane.agent?.displayName || 'agent';
  return tabAgentCount > 1 ? `${base} #${tabAgentIndex}` : base;
}

/** The agents a list or a Home shows, most recent status change first: never the orchestrators,
 *  and for an orchestrator (`scope`) only its account's agents — all of them when that isn't known. */
export function agentCards(state: AppState | null, scope?: OrchestratorView): DashboardCard[] {
  return dashboardCards(state?.workspaces ?? [], (state?.orchestrators ?? []).map((o) => o.paneId), scope?.agents ?? null);
}

/** An orchestrator's name: its configured label, else its workspace label. */
export function orchestratorLabel(o: OrchestratorView | undefined): string {
  return o?.label || (o?.paneId ? findPane(o.paneId)?.ws.label : '') || o?.name || 'Home';
}

function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 5_000) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

const openPane = (paneId: string): void => { location.hash = paneRoute(store.appState, paneId); };

/** The list for `hash` (#/agents or #/agents/<name>). */
export function Dashboard({ hash }: { hash: string }) {
  const [state, setState] = useState(store.appState);
  const touching = useRef(false);
  useEffect(() => {
    const apply = (): void => { if (!touching.current) setState(store.appState); };
    apply();
    return subscribe(apply);
  }, []);
  // On the macrotask after the last finger lifts: a still tap's click lands first, on the card it pressed.
  const lift = (e: TouchEvent): void => {
    if (e.touches.length > 0) return; // other fingers still down
    touching.current = false;
    setTimeout(() => { if (!touching.current) setState(store.appState); }, 0);
  };

  if (!state) {
    return <div id="screen-agents" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><span className="loading-spinner"></span></div>;
  }
  const { workspaces = [] } = state;
  const cards = agentCards(state, agentsScope(hash, state));
  return (
    <div id="screen-agents" data-ready="1" onTouchStart={() => { touching.current = true; }} onTouchEnd={lift} onTouchCancel={lift}>
      {workspaces.length === 0 ? <div className="empty-state">No workspaces found.</div>
        : cards.length === 0 ? <div className="empty-state">No active agents.</div>
        : <div className="agent-list">{cards.map((c) => <Card key={c.pane.paneId} card={c} />)}</div>}
    </div>
  );
}

// One card. The list is flat, so each card names its own workspace; `branch` and the `worktree`
// chip come from that workspace. pane.title is usually null, so the tab name is the card label.
function Card({ card }: { card: DashboardCard }) {
  const { pane, workspaceLabel, branch, isWorktree } = card;
  const { paneId, agent, title } = pane;
  const { displayName, name, customStatus, message, sinceUnixMs } = agent!;
  // The chip shows the stable agent kind, so prefer `name` (raw pane.agent,
  // e.g. "claude"/"codex") over displayName, which can be a richer label.
  const agentKind = name || displayName || 'agent';
  const statusClass = shownStatus(pane, store.seenDone) || 'unknown';
  const meta = customStatus || message || '';
  const relTime = relativeTime(sinceUnixMs);
  return (
    <div className="agent-card" data-pane-id={paneId} role="button" tabIndex={0} onClick={() => openPane(paneId)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openPane(paneId); }}>
      <div className="agent-card-header">
        <span className="agent-name">{cardTitle(card)}</span>
        {branch ? <span className="card-branch">{branch}</span> : null}
        <span className={`status-badge ${statusClass}`}>{statusClass}</span>
      </div>
      {meta ? <div className="agent-custom-status">{meta}</div> : null}
      <div className="agent-card-meta">
        <span className="card-workspace">{workspaceLabel}</span>
        <span className="agent-kind">{agentKind}</span>
        {isWorktree ? <span className="card-worktree">worktree</span> : null}
        {title ? <span className="pane-title">{title}</span> : null}
        {relTime ? <span>{relTime}</span> : null}
      </div>
    </div>
  );
}

const useAppState = (): AppState | null => useSyncExternalStore(subscribe, () => store.appState);

function Title({ hash }: { hash: string }) {
  const scope = agentsScope(hash, useAppState());
  return <>Agents{scope && <span className="topbar-subtitle">&#183; {orchestratorLabel(scope)}</span>}</>;
}

// Orchestrators have no cards, so this is the way to a Home: its own, else the one used last
function HomeButton({ hash }: { hash: string }) {
  const state = useAppState();
  const home = agentsScope(hash, state) ?? defaultHome(state, lastHome());
  return home ? <button className="topbar-back" aria-label="Home" onClick={() => { location.hash = homeHash(home.name); }}>&#8592; Home</button> : null;
}

export const dashboardTopbar = (hash: string): Topbar => ({
  title: <Title hash={hash} />,
  left: <HomeButton hash={hash} />,
  right: (
    <>
      <button className="topbar-action" id="btn-new-agent" aria-label="New agent" onClick={() => { void openNewAgent(); }}>+</button>
      <button className="topbar-action" id="btn-settings" aria-label="Settings" onClick={() => { location.hash = '#/settings'; }}>&#9881;</button>
    </>
  ),
});
