import type { StatusChange, NormalizedState, WsAgentStatusMessage } from './types.ts';

let ntfyErrorLogged = false;

/**
 * Build the WS agent_status message for a status transition.
 *
 * @param change  { paneId, from, to, agent }
 * @param state   current normalized state
 * @returns WS message object
 */
export function buildAgentStatusMessage(change: StatusChange, state: Pick<NormalizedState, 'workspaces'>): WsAgentStatusMessage {
  const { paneId, from, to, agent } = change;

  let workspaceLabel: string | null = null;
  let tabLabel: string | null = null;

  outer:
  for (const ws of (state.workspaces || [])) {
    for (const tab of (ws.tabs || [])) {
      for (const pane of (tab.panes || [])) {
        if (pane.paneId === paneId) {
          workspaceLabel = ws.label;
          tabLabel = tab.label;
          break outer;
        }
      }
    }
  }

  return {
    type: 'agent_status',
    paneId,
    // contract: agent is the display string, not the internal agent object
    agent: agent?.displayName ?? agent?.name ?? null,
    from,
    to,
    workspaceLabel,
    tabLabel,
  };
}

/**
 * Post an ntfy-style notification if notify_url is configured.
 * Failures are logged once and never crash the server.
 *
 * @param change   { paneId, from, to, agent }
 * @param state    current normalized state
 * @param notifyUrl
 */
export async function sendNtfyNotification(change: StatusChange, state: NormalizedState, notifyUrl: string | null): Promise<void> {
  if (!notifyUrl) return;
  if (change.to !== 'blocked' && change.to !== 'done') return;

  const msg = buildAgentStatusMessage(change, state);
  const rawName = change.agent?.displayName || change.agent?.name || 'agent';
  // HTTP header values must be ISO-8859-1; strip non-ASCII to avoid TypeError in Node's undici.
  const agentName = rawName.replace(/[^\x20-\x7E]/g, '?');
  const title = `${agentName} -> ${change.to}`;
  const body = msg.workspaceLabel
    ? `${msg.workspaceLabel}${msg.tabLabel ? '/' + msg.tabLabel : ''} · pane ${change.paneId}`
    : `pane ${change.paneId}`;

  try {
    const res = await fetch(notifyUrl, {
      method: 'POST',
      headers: {
        'Title': title,
        'Content-Type': 'text/plain',
      },
      body,
    });
    // fetch only rejects on network errors; an HTTP 4xx/5xx from ntfy still
    // resolves, so check the status or a broken notify_url would look healthy.
    if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
    ntfyErrorLogged = false;
  } catch (err) {
    if (!ntfyErrorLogged) {
      console.error('[notify] ntfy POST failed:', (err as Error).message);
      ntfyErrorLogged = true;
    }
  }
}
