/**
 * Shared type definitions for the web PWA client.
 * They mirror the Go bridge's JSON (internal/bridge/types.go);
 * internal/bridge/contract_test.go and `npm run check:contract` keep the two in step.
 */

import type { TimelineItem } from './transcript.ts';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface AgentInfo {
  name: string | null;
  displayName: string | null;
  status: AgentStatus;
  customStatus: string | null;
  message: string | null;
  sinceUnixMs: number;
  /** herdr's completion_seq: which completion this idle/done status is (null until the bridge fetches it) */
  completionSeq: number | null;
  /** herdr's state_change_seq: herdr's order of status changes, kept across bridge restarts
   *  (null until the bridge fetches it, e.g. right after a change) */
  stateChangeSeq: number | null;
}

export interface PaneNode {
  paneId: string;
  focused: boolean;
  /** where the pane is now (foreground process cwd, else the shell's) — moves with `cd` */
  cwd: string | null;
  /** the pane shell's cwd — where its agent was launched; stable while the agent runs */
  launchCwd: string | null;
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
  /** the configured orchestrators (config orchestrators / orchestrator_dir), in order: the
   *  agent running in each one's dir (paneId) is shown as a Home (#/home/<name>) */
  orchestrators: OrchestratorView[];
  /** the first running orchestrator's pane, kept for clients older than `orchestrators` */
  orchestratorPaneId: string | null;
}

export interface OrchestratorView {
  name: string;
  /** '' = use the workspace label */
  label: string;
  paneId: string | null;
  /** the agent panes of its Claude account (itself included); null when that isn't known */
  agents: string[] | null;
  /** 'tui': an agent in a herdr pane; 'headless': the bridge's own claude -p child, whose
   *  paneId is 'hl:<name>' while it runs (it has no herdr pane, only a transcript) */
  mode: 'tui' | 'headless';
  /** a headless orchestrator's state; null for 'tui' */
  headless: HeadlessView | null;
}

export interface HeadlessView {
  status: 'stopped' | 'idle' | 'working' | 'blocked' | 'done' | 'error';
  /** counts its completed turns (an interrupted one isn't) */
  completionSeq: number;
  /** a question waiting for the user: always null for now */
  pending: null;
  usage: HeadlessUsage | null;
  /** what went wrong, kept until the next start or clear */
  warnings: HeadlessWarning[];
}

export interface UsageWindow {
  /** 0–1 */
  utilization: number;
  /** ms */
  resetsAt: number;
}

export interface HeadlessUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  /** percent of the context window; null until a turn has ended */
  contextPct: number | null;
  /** when the rate limits were read (ms); 0 = not yet */
  at: number;
}

export interface HeadlessWarning {
  kind: string;
  message: string;
  /** ms */
  since: number;
  /** what the Home offers for it */
  actions: Array<'interrupt' | 'clear' | 'tui'>;
}

// ── REST responses (the wire recordings in contract.gen.ts check them) ──

/** GET /api/profiles: the launch profiles, name + label only */
export interface ProfilesResponse {
  profiles: Array<{ name: string; label: string }>;
}

/** POST /api/agents */
export interface AgentStartResponse {
  ok: true;
  paneId: string;
  name: string;
  /** the agent herdr detected, null when none yet */
  agent: string | null;
  /** present only when a task was sent: false when the agent wasn't ready for it */
  taskDelivered?: boolean;
}

/** POST /api/panes/:id/rename: the name herdr stored (fitted to its name rule) */
export interface RenameResponse {
  ok: true;
  name: string;
}

/** POST /api/agents/:target/clear: the replacement pane */
export interface ClearResponse {
  ok: true;
  paneId: string;
  name: string;
  closedOld: boolean;
  profile: string;
  oldPaneId: string;
}

/** POST /api/panes/:id/scroll (and the other bare acknowledgements) */
export interface OkResponse {
  ok: true;
}

/** GET /api/panes/:id/read: `ansi` for format=ansi, else `text`; appScroll on a visible read
 *  (the decision the WS pane_output push carries) */
export interface ReadResponse {
  ansi?: string | null;
  text?: string | null;
  appScroll?: boolean;
}

/** GET /api/panes/:id/transcript: available=false → no Claude transcript for the pane (the
 *  terminal stays); with ?session=&after= only the items past the cursor, else the tail (reset) */
export interface TranscriptResponse {
  available: boolean;
  sessionId?: string;
  items?: TimelineItem[];
  cursor?: number;
  reset?: boolean;
  truncated?: boolean;
}

/** Every /api error */
export interface ApiErrorResponse {
  error: { code: string; message: string };
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

/** a headless orchestrator's new warning (once per kind and session) */
export interface WsOrchestratorAlertMessage {
  type: 'orchestrator_alert';
  name: string;
  kind: string;
  message: string;
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

// Chat-view transcript push. available=false → not a claude pane (or transcript
// not on this host); the client keeps the terminal view. reset=true replaces the
// log (initial load / new session); reset=false appends new items.
export interface WsTranscriptItemsMessage {
  type: 'transcript_items';
  paneId: string;
  available: boolean;
  sessionId?: string;
  items: TimelineItem[];
  cursor: number;
  reset: boolean;
}

export type WsMessage =
  | WsStateMessage
  | WsAgentStatusMessage
  | WsOrchestratorAlertMessage
  | WsPongMessage
  | WsPaneOutputMessage
  | WsPaneGoneMessage
  | WsTranscriptItemsMessage;
