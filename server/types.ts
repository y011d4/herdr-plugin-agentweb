/**
 * Shared type definitions for the herdr-agentweb bridge server.
 */

import type { LaunchProfile } from './agent-lifecycle.ts';

// ── Agent status ─────────────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

// ── Normalized state shapes ───────────────────────────────────────────────────

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

export interface WorktreeInfo {
  /** stable repo identity (path to the shared .git); workspaces sharing this belong to one repo */
  repoKey: string;
  repoName: string;
  repoRoot: string;
  checkoutPath: string;
  /** false = the repo's main checkout; true = a linked git worktree (a branch) */
  isLinkedWorktree: boolean;
  /** current branch (null when detached, or when only herdr's branch-less data is available) */
  branch: string | null;
}

export interface WorkspaceNode {
  workspaceId: string;
  label: string;
  cwd: string | null;
  /** git repo/worktree context, when herdr resolved one for this workspace; else null */
  worktree: WorktreeInfo | null;
  tabs: TabNode[];
}

export interface NormalizedState {
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
  // Internal indexes (stripped before sending to clients)
  _paneById: Map<string, PaneNode>;
  _tabById: Map<string, TabNode>;
}

// ── Agent status change ───────────────────────────────────────────────────────

export interface StatusChange {
  paneId: string;
  from: string;
  to: string;
  agent: AgentInfo;
}

// ── HerdrClient callbacks ─────────────────────────────────────────────────────

export interface HerdrClientCallbacks {
  socketPath: string;
  onState?: (state: NormalizedState) => void;
  onAgentStatus?: (change: StatusChange, state: NormalizedState) => void;
  onConnectionChange?: (isConnected: boolean) => void;
}

export interface HerdrClient {
  start(): void;
  isConnected(): boolean;
  getState(): NormalizedState | null;
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  destroy(): void;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface Config {
  host: string;
  port: number;
  notifyUrl: string | null;
  /** externally reachable base URL (config public_url), used for connect links */
  publicUrl: string | null;
  stateDir: string;
  socketPath: string;
  /** named launch profiles for starting agents (defaults + config.json launch_profiles) */
  launchProfiles: Record<string, LaunchProfile>;
}

// ── Raw herdr wire payloads (loose, index-signed) ─────────────────────────────

export interface RawPane {
  pane_id: string;
  workspace_id?: string;
  tab_id?: string;
  focused?: boolean;
  agent?: string;
  display_agent?: string;
  agent_status?: string;
  custom_status?: string;
  agent_message?: string;
  cwd?: string;
  foreground_cwd?: string;
  title?: string;
  [key: string]: unknown;
}

export interface RawTab {
  tab_id: string;
  workspace_id?: string;
  label?: string | number;
  number?: number;
  [key: string]: unknown;
}

export interface RawWorktree {
  repo_key?: string;
  repo_name?: string;
  repo_root?: string;
  checkout_path?: string;
  is_linked_worktree?: boolean;
  [key: string]: unknown;
}

export interface RawWorkspace {
  workspace_id: string;
  label?: string;
  active_tab_id?: string;
  worktree?: RawWorktree;
  [key: string]: unknown;
}

export interface RawSnapshot {
  version?: string;
  protocol?: number;
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
  workspaces?: RawWorkspace[];
  tabs?: RawTab[];
  panes?: RawPane[];
  [key: string]: unknown;
}

export interface RawAgentStatusChangedEvent {
  pane_id?: string;
  agent_status?: string;
  agent?: string;
  display_agent?: string;
  custom_status?: string;
  title?: string;
  [key: string]: unknown;
}

// ── WS message unions ─────────────────────────────────────────────────────────

export interface WsStateMessage {
  type: 'state';
  state: Omit<NormalizedState, '_paneById' | '_tabById'>;
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

export interface WsPingMessage {
  type: 'ping';
}

export interface WsPongMessage {
  type: 'pong';
}

export type WsInboundMessage = WsPingMessage;
export type WsOutboundMessage = WsStateMessage | WsAgentStatusMessage | WsPongMessage;

// ── NDJSON wire protocol ──────────────────────────────────────────────────────

export interface RpcRequest {
  type: 'request';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: { code?: string; message?: string };
}

export interface EventPush {
  event: string;
  data?: Record<string, unknown>;
}
