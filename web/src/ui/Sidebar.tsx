/**
 * ui/Sidebar.tsx — the PC sidebar, beside every screen but the token one on a wide screen
 * (WIDE_QUERY: ui/App.tsx draws it only then). Each orchestrator's Home is a heading over its
 * account's agents (homeGroups), then Other; above them All agents (#/agents), New agent and
 * Settings. A heading opens its Home, an agent its pane the list's way (openPane). The Home or the
 * agent on show, from the hash, is marked (aria-current).
 *
 * Like the agents list it gets every State push: it holds still while a finger is down
 * (useHeldState), and its rows are keyed by orchestrator and pane, so #sidebar, the scroll container,
 * stays the same element.
 */
import { NavLink } from '@mantine/core';
import { useSyncExternalStore } from 'react';
import { homeGroups, orchestratorStatus, shownStatus, type DashboardCard, type HomeGroup } from '../dashboard-group.ts';
import { homeHash } from '../routes.ts';
import { findPane, store } from '../store.ts';
import { agentCards, cardTitle, openPane, orchestratorLabel, useHeldState } from './Dashboard.tsx';
import { openNewAgent } from './Modals.tsx';

const subscribeHash = (fn: () => void): (() => void) => {
  addEventListener('hashchange', fn);
  return () => removeEventListener('hashchange', fn);
};

/** The pane a #/pane/<id> hash shows (null: none, or a malformed one). */
function shownPane(hash: string): string | null {
  try {
    return hash.startsWith('#/pane/') ? decodeURIComponent(hash.slice('#/pane/'.length)) : null;
  } catch {
    return null;
  }
}

const current = (on: boolean): 'page' | undefined => (on ? 'page' : undefined);

export function Sidebar() {
  const [state, hold] = useHeldState();
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  const cards = agentCards(state);
  return (
    <aside id="sidebar" aria-label="Homes and agents" {...hold}>
      <div className="sidebar-head">
        <span className="sidebar-title">Yoicks</span>
        <button className="topbar-action" data-action="new-agent" aria-label="New agent" onClick={() => { void openNewAgent(); }}>+</button>
        <button className="topbar-action" data-action="settings" aria-label="Settings" onClick={() => { location.hash = '#/settings'; }}>&#9881;</button>
      </div>
      <NavLink href="#/agents" className="sidebar-all" label="All agents" rightSection={cards.length}
        active={hash === '#/agents'} aria-current={current(hash === '#/agents')} />
      {homeGroups(cards, state?.orchestrators ?? []).map((g) => (
        <Group key={g.home ? `home:${g.home.name}` : 'other'} group={g} hash={hash} />
      ))}
    </aside>
  );
}

function Group({ group: { home, cards }, hash }: { group: HomeGroup; hash: string }) {
  const pane = shownPane(hash);
  let heading = <div className="sidebar-heading">Other</div>;
  if (home) {
    const on = hash === homeHash(home.name);
    const st = orchestratorStatus(home, home.paneId ? findPane(home.paneId)?.pane : undefined, store.seenDone);
    heading = (
      <NavLink href={homeHash(home.name)} className={`sidebar-home${home.paneId ? '' : ' stopped'}`} data-home={home.name}
        label={orchestratorLabel(home)} leftSection={<i className={`home-dot ${st}`}></i>} active={on} aria-current={current(on)} />
    );
  }
  return (
    <section className="sidebar-group" data-home={home?.name ?? ''}>
      {heading}
      {cards.map((c) => <Agent key={c.pane.paneId} card={c} on={c.pane.paneId === pane} />)}
    </section>
  );
}

// An agent as its card in the list has it: the title and (dim) the branch, the workspace below, its status.
function Agent({ card, on }: { card: DashboardCard; on: boolean }) {
  const { paneId } = card.pane;
  const st = shownStatus(card.pane, store.seenDone) || 'unknown';
  return (
    <NavLink component="button" className="sidebar-agent" data-sidebar-pane={paneId} noWrap
      label={<>{cardTitle(card)}{card.branch ? <span className="card-branch">{` ${card.branch}`}</span> : null}</>}
      description={card.workspaceLabel}
      rightSection={<span className={`status-badge ${st}`}>{st}</span>} active={on} aria-current={current(on)}
      onClick={() => openPane(paneId)} />
  );
}
