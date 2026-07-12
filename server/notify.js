let ntfyErrorLogged = false;

/**
 * Build the WS agent_status message for a status transition.
 *
 * @param {object} change  { paneId, from, to, agent }
 * @param {object} state   current normalized state
 * @returns {object}  WS message object
 */
export function buildAgentStatusMessage(change, state) {
  const { paneId, from, to, agent } = change;

  let workspaceLabel = null;
  let tabLabel = null;

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
    agent,
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
 * @param {object} change   { paneId, from, to, agent }
 * @param {object} state    current normalized state
 * @param {string|null} notifyUrl
 */
export async function sendNtfyNotification(change, state, notifyUrl) {
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
    await fetch(notifyUrl, {
      method: 'POST',
      headers: {
        'Title': title,
        'Content-Type': 'text/plain',
      },
      body,
    });
    ntfyErrorLogged = false;
  } catch (err) {
    if (!ntfyErrorLogged) {
      console.error('[notify] ntfy POST failed:', err.message);
      ntfyErrorLogged = true;
    }
  }
}
