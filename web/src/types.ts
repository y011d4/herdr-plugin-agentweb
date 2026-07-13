/**
 * Shared type definitions for the web PWA client.
 * Duplicated from server shapes — the two builds are separate; do not cross-import server code.
 */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  name: string | null;
  displayName: string | null;
  status: AgentStatus;
  customStatus: string | null;
  message: string | null;
  sinceUnixMs: number;
}

export interface PaneNode {
  paneId: string;
  focused: boolean;
  cwd: string | null;
  title: string | null;
  agent: AgentInfo | null;
}

export interface TabNode {
  tabId: string;
  label: string;
  panes: PaneNode[];
}

export interface WorkspaceNode {
  workspaceId: string;
  label: string;
  cwd: string | null;
  tabs: TabNode[];
}

export interface AppState {
  connected: boolean;
  herdr: {
    version: string | null;
    protocol: number | null;
  };
  focused: {
    workspaceId: string | null;
    tabId: string | null;
    paneId: string | null;
  };
  workspaces: WorkspaceNode[];
}

export interface WsStateMessage {
  type: 'state';
  state: AppState;
}

export interface WsAgentStatusMessage {
  type: 'agent_status';
  paneId: string;
  agent: string | null;
  from: string;
  to: string;
  workspaceLabel: string | null;
  tabLabel: string | null;
}

export interface WsPongMessage {
  type: 'pong';
}

export interface WsPaneOutputMessage {
  type: 'pane_output';
  paneId: string;
  ansi: string;
  // server-computed from fresh herdr scroll metadata: true for a full-screen app
  // that should receive forwarded SGR wheel events instead of local scrolling.
  appScroll: boolean;
}

export interface WsPaneGoneMessage {
  type: 'pane_gone';
  paneId: string;
}

export type WsMessage =
  | WsStateMessage
  | WsAgentStatusMessage
  | WsPongMessage
  | WsPaneOutputMessage
  | WsPaneGoneMessage;
