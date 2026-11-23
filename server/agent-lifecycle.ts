/**
 * Agent lifecycle orchestration (start / stop / rename / clear).
 *
 * Pure orchestration over an injected herdr `rpc` (no direct I/O), so it is
 * unit-testable with a fake rpc — mirroring the injectable git runner in
 * worktree-resolve.ts. http.ts wires these behind REST routes; the actual socket
 * work stays in herdr-client.ts.
 *
 * Everything goes through herdr's own agent/pane API (verified against herdr
 * 0.9.5's `herdr api schema --json`, protocol 22). Since herdr 0.8, agent.start
 * no longer spawns a pane: it launches an agent *kind* into an existing idle shell
 * pane, so we open that pane first (tab.create / pane.split / worktree.create's
 * root pane):
 *   - tab.create  { cwd?, workspace_id?, label?, focus } → { root_pane: { pane_id } }
 *   - pane.split  { target_pane_id, direction, cwd?, focus } → { pane: { pane_id } }
 *   - agent.start { name, kind, pane_id, args? } → { agent: { pane_id, ... } }  (agent_pane_busy
 *     while the new pane's shell is still starting)
 *   - pane.close  { pane_id }
 *   - agent.rename{ target, name }
 *   - agent.get   { target } → { agent: { pane_id, agent, cwd, interactive_ready, ... } }
 *   - agent.prompt{ target, text }  (agent_not_ready until the agent is interactive)
 * Agent names must match herdr's ^[a-z][a-z0-9_-]{0,31}$.
 *
 * Security: agents are launched only from a fixed profile allowlist — a caller
 * never supplies raw argv/command. (The bearer token already grants full pane
 * input ≈ a shell, so cwd is not a new privilege, but arbitrary argv would let a
 * caller pick the *program*, so that stays gated behind named profiles.)
 */

export interface LaunchProfile {
  /** the agent kind + fixed flags, e.g. ["claude", "--dangerously-skip-permissions"]. argv[0]
   *  goes to herdr as the agent `kind` (herdr picks the executable for it), the rest as args. */
  argv: string[];
  /** human label for the profile */
  label: string;
}

export const DEFAULT_LAUNCH_PROFILES: Record<string, LaunchProfile> = {
  claude: { argv: ['claude'], label: 'Claude Code' },
  codex: { argv: ['codex'], label: 'Codex' },
  opencode: { argv: ['opencode'], label: 'opencode' },
};

/** A validation/orchestration failure carrying the HTTP status http.ts should return. */
export class LifecycleError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.status = status;
    this.code = code;
  }
}

export type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

function badRequest(message: string): LifecycleError {
  return new LifecycleError(400, 'invalid_params', message);
}

const NAME_RULE = 'name must contain a letter a-z (agent names use a-z, 0-9, - and _)';

/**
 * Fit a name to herdr's agent-name rule (^[a-z][a-z0-9_-]{0,31}$): lowercase it, join
 * words with "-", drop leading non-letters, cap at 32. Returns null when nothing usable
 * is left (e.g. no a-z at all).
 */
export function agentName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return name || null;
}

/** `<profile>-<base36 time>`, trimming the profile part (never the unique timestamp) to fit
 *  herdr's 32-char limit — so two auto names from a long profile key can't collide. */
function autoName(profile: string): string {
  const ts = Date.now().toString(36);
  const base = (agentName(profile) ?? 'agent').slice(0, 31 - ts.length).replace(/-+$/, '');
  return `${base}-${ts}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to retry agent.start while a just-opened pane's shell is still starting. */
const SHELL_READY_MS = 10_000;
/** How long to wait for a new agent to become interactive before giving up on its task
 *  (herdr's own `agent start` default timeout). */
const AGENT_READY_MS = 30_000;

function herdrCode(err: unknown): string | undefined {
  return (err as { herdrCode?: string } | null)?.herdrCode;
}

/**
 * Launch `profile` into the idle shell pane `paneId` (agent.start). A pane we just
 * opened reports agent_pane_busy until its shell is up, so retry that briefly — the
 * same thing `herdr agent start` does.
 */
async function launchInPane(rpc: Rpc, paneId: string, profile: LaunchProfile, name: string): Promise<RawAgentInfo | null> {
  const [kind, ...args] = profile.argv;
  const deadline = Date.now() + SHELL_READY_MS;
  for (;;) {
    try {
      return agentFromResult(await rpc('agent.start', { name, kind, pane_id: paneId, args }));
    } catch (err) {
      if (herdrCode(err) !== 'agent_pane_busy' || Date.now() >= deadline) throw err;
      await sleep(100);
    }
  }
}

/** Best-effort pane close (rolling back a pane we opened); never throws. */
async function closeQuietly(rpc: Rpc, paneId: string | undefined): Promise<void> {
  if (!paneId) return;
  try {
    await rpc('pane.close', { pane_id: paneId });
  } catch {
    /* best-effort: must not mask the error the caller is about to see */
  }
}

/**
 * Send a new agent its first prompt. agent.prompt refuses an agent that is still
 * launching (agent_not_ready), so wait until herdr reports it interactive.
 */
async function deliverTask(rpc: Rpc, paneId: string, text: string): Promise<boolean> {
  const deadline = Date.now() + AGENT_READY_MS;
  try {
    for (;;) {
      const agent = agentFromResult(await rpc('agent.get', { target: paneId }));
      if (agent?.interactive_ready === true) break;
      // blocked on a startup dialog: it won't become ready without the user
      if (agent?.agent_status === 'blocked' || Date.now() >= deadline) return false;
      await sleep(250);
    }
    await rpc('agent.prompt', { target: paneId, text });
    return true;
  } catch {
    return false;
  }
}

/** Validate a single config launch-profile entry; return it normalized or null. */
function normalizeProfile(key: string, raw: unknown): LaunchProfile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const argv = entry.argv;
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) return null;
  const label = typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label : key;
  return { argv: argv as string[], label };
}

/**
 * Merge config.json `launch_profiles` over the built-in defaults. A well-formed
 * entry (non-empty string[] argv) is added or overrides a default; malformed
 * entries are dropped (graceful — a bad config never removes the defaults).
 */
export function parseLaunchProfiles(raw: unknown): Record<string, LaunchProfile> {
  const merged: Record<string, LaunchProfile> = { ...DEFAULT_LAUNCH_PROFILES };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return merged;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // `merged["__proto__"] = …` would hit the prototype setter, not add a
    // profile; `constructor`/`prototype` are prototype-chain names too. Skip them
    // rather than corrupt merged. (Lookups use Object.hasOwn, so an inherited name
    // can't masquerade as a profile anyway — this is defense in depth.)
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const profile = normalizeProfile(key, value);
    if (profile) merged[key] = profile;
  }
  return merged;
}

// ── result extraction ─────────────────────────────────────────────────────────

interface RawAgentInfo {
  pane_id?: string;
  name?: string | null;
  agent?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  interactive_ready?: boolean;
  agent_status?: string;
}

function agentFromResult(result: unknown): RawAgentInfo | null {
  const agent = (result as { agent?: RawAgentInfo } | null)?.agent;
  return agent && typeof agent === 'object' ? agent : null;
}

// ── start ─────────────────────────────────────────────────────────────────────

export interface StartAgentInput {
  profile?: unknown;
  cwd?: unknown;
  name?: unknown;
  workspace?: unknown;
  task?: unknown;
  /** create a worktree first and launch the agent inside it (atomic — rolled back
   *  if the agent fails to start, so the client never sees a dangling worktree) */
  worktree?: CreateWorktreeInput;
  /** open a new workspace at cwd instead of a tab in `workspace` (or the focused one) */
  newWorkspace?: boolean;
}

export interface StartAgentOptions {
  /** runs once the agent is up; throwing rolls the start back (pane/worktree) and rethrows
   *  (by then the agent has run, so a worktree with changes is kept, not forced away) */
  verify?: (paneId: string) => Promise<void>;
}

export interface StartAgentResult {
  paneId: string;
  name: string;
  agent: string | null;
  taskDelivered?: boolean;
}

export async function startAgent(
  rpc: Rpc,
  profiles: Record<string, LaunchProfile>,
  input: StartAgentInput,
  opts: StartAgentOptions = {},
): Promise<StartAgentResult> {
  // Object.hasOwn, not `in`: `in` also matches inherited names ("toString",
  // "__proto__", …), which would wrongly accept them as profiles from POST input.
  if (typeof input.profile !== 'string' || !Object.hasOwn(profiles, input.profile)) {
    throw badRequest(`unknown profile: ${String(input.profile)}`);
  }
  const profile = profiles[input.profile];

  if (input.name !== undefined && typeof input.name !== 'string') throw badRequest('name must be a string');
  if (input.cwd !== undefined && (typeof input.cwd !== 'string' || input.cwd === '')) throw badRequest('cwd must be a non-empty string');
  if (input.workspace !== undefined && typeof input.workspace !== 'string') throw badRequest('workspace must be a string');
  if (input.task !== undefined && typeof input.task !== 'string') throw badRequest('task must be a string');

  const typed = typeof input.name === 'string' && input.name.trim() !== '' ? agentName(input.name) : undefined;
  if (typed === null) throw badRequest(NAME_RULE);
  const name = typed ?? autoName(input.profile);

  // Open the shell pane the agent launches into. A `worktree` spec creates a fresh
  // worktree and uses its root pane; otherwise a new tab (labelled with the agent
  // name) at the cwd, in the requested workspace. If the agent then fails to start we
  // undo that (best-effort) so the caller never has to clean up a dangling tab or
  // worktree, or hit "branch already exists" on retry.
  let paneId: string | undefined;
  // undoes what was opened; says what it had to leave behind, if anything
  let rollback: (launched: boolean) => Promise<string | null>;
  if (input.worktree !== undefined) {
    const wt = await createWorktree(rpc, input.worktree);
    paneId = wt.paneId ?? undefined;
    rollback = async (launched) => {
      // A launched agent (failed verify) may already have written files: remove only a
      // clean worktree, else just stop the agent and keep the checkout.
      if (await rollbackWorktree(rpc, wt.workspaceId, !launched) || !launched) return null;
      await closeQuietly(rpc, paneId);
      return `${wt.checkoutPath} has changes, so it was kept`;
    };
  } else {
    const params: Record<string, unknown> = { label: name, focus: false };
    if (typeof input.cwd === 'string') params.cwd = input.cwd;
    let opened: { root_pane?: { pane_id?: string } } | null;
    if (input.newWorkspace === true) {
      // herdr labels a new workspace after its dir
      opened = (await rpc('workspace.create', { cwd: params.cwd, focus: false })) as typeof opened;
    } else if (typeof input.workspace === 'string' && input.workspace) {
      opened = (await rpc('tab.create', { ...params, workspace_id: input.workspace })) as typeof opened;
    } else {
      try {
        opened = (await rpc('tab.create', params)) as typeof opened;
      } catch (err) {
        // herdr has no workspace to put the tab in (all closed): open a workspace
        // instead, as agent.start itself did before herdr 0.8.
        if (herdrCode(err) !== 'workspace_not_found') throw err;
        opened = (await rpc('workspace.create', params)) as typeof opened;
      }
    }
    paneId = opened?.root_pane?.pane_id;
    rollback = async () => { await closeQuietly(rpc, paneId); return null; };
  }

  let started: RawAgentInfo | null;
  let launched = false;
  try {
    if (!paneId) throw new LifecycleError(502, 'error', 'herdr returned no pane to start the agent in');
    started = await launchInPane(rpc, paneId, profile, name);
    launched = true;
    await opts.verify?.(paneId);
  } catch (err) {
    const kept = await rollback(launched);
    if (kept) throw new LifecycleError(409, 'worktree_kept', `${(err as Error).message}; ${kept}`);
    throw err;
  }

  const result: StartAgentResult = { paneId, name, agent: started?.agent ?? null };

  // Best-effort initial task. Target the pane id (unambiguous) rather than the name.
  // A failed delivery must not fail the (successful) start. When a task field was
  // supplied, taskDelivered always reports the outcome (false for an empty task that
  // was skipped), so the client can tell it apart from "no task".
  if (typeof input.task === 'string') {
    result.taskDelivered = input.task.length > 0 && await deliverTask(rpc, paneId, input.task);
  }
  return result;
}

// ── stop ──────────────────────────────────────────────────────────────────────

export async function stopAgent(rpc: Rpc, paneId: string): Promise<{ paneId: string }> {
  await rpc('pane.close', { pane_id: paneId });
  return { paneId };
}

// ── rename ────────────────────────────────────────────────────────────────────

export async function renameAgent(rpc: Rpc, target: string, name: unknown): Promise<{ name: string }> {
  const clean = agentName(name);
  if (!clean) throw badRequest(NAME_RULE);
  await rpc('agent.rename', { target, name: clean });
  return { name: clean };
}

// ── clear (fresh session = launch a replacement, then close the old pane) ──────

export interface ClearAgentResult {
  paneId: string;
  name: string;
  closedOld: boolean;
  /** the launch profile the replacement was started with (for the bridge to re-record) */
  profile: string;
  /** the pane id resolved from the target and closed (the store-cleanup key) */
  oldPaneId: string;
}

/** Find the profile whose command matches a herdr-detected agent type. */
function profileForAgentType(profiles: Record<string, LaunchProfile>, detected: string | null): string | null {
  if (!detected) return null;
  if (Object.hasOwn(profiles, detected)) return detected;
  const lower = detected.toLowerCase();
  for (const key of Object.keys(profiles)) {
    const k = key.toLowerCase();
    if (lower.includes(k) || k.includes(lower)) return key;
  }
  return null;
}

export async function clearAgent(
  rpc: Rpc,
  profiles: Record<string, LaunchProfile>,
  target: string,
  lookupProfile?: (paneId: string) => string | undefined,
): Promise<ClearAgentResult> {
  const agent = agentFromResult(await rpc('agent.get', { target }));
  if (!agent) throw new LifecycleError(404, 'not_found', 'agent not found');

  // `target` may be an agent name, not a pane id — resolve to the pane id herdr
  // reports so the profile lookup and later store cleanup key by the right thing.
  const oldPaneId = agent.pane_id;
  if (!oldPaneId) throw new LifecycleError(502, 'error', 'agent has no pane id');

  // Prefer the profile this agent was actually started with (the bridge records it
  // per resolved pane id): inferring from herdr's detected type collapses a custom
  // variant (e.g. "claude-yolo") back onto the base "claude" profile and drops its
  // argv. Fall back to inference for agents the bridge didn't start.
  const preferred = lookupProfile?.(oldPaneId);
  const key = (preferred && Object.hasOwn(profiles, preferred))
    ? preferred
    : profileForAgentType(profiles, agent.agent ?? null);
  if (!key) throw new LifecycleError(422, 'no_profile', `no launch profile matches agent type: ${String(agent.agent)}`);

  // Relaunch where the agent was launched (the shell's cwd), not where its foreground
  // process wandered: the same dir keeps its identity (e.g. the orchestrator, which is
  // recognized by its launch dir) and its project context.
  const cwd = agent.cwd || agent.foreground_cwd || null;

  // Open the replacement's shell as a split of the old pane, so it stays in the old
  // agent's tab/workspace and takes over its slot once the old pane closes.
  const splitParams: Record<string, unknown> = { target_pane_id: oldPaneId, direction: 'right', focus: false };
  if (cwd) splitParams.cwd = cwd;
  const split = (await rpc('pane.split', splitParams)) as { pane?: { pane_id?: string } } | null;
  const paneId = split?.pane?.pane_id;
  const name = autoName(key);
  try {
    if (!paneId) throw new LifecycleError(502, 'error', 'herdr returned no pane to start the replacement in');
    await launchInPane(rpc, paneId, profiles[key], name);
  } catch (err) {
    await closeQuietly(rpc, paneId);
    throw err;
  }

  // Replacement is up; retire the old pane. A close failure just leaves the old
  // pane around (reported), rather than failing an otherwise-successful clear.
  let closedOld = true;
  try {
    await rpc('pane.close', { pane_id: oldPaneId });
  } catch {
    closedOld = false;
  }
  return { paneId, name, closedOld, profile: key, oldPaneId };
}

// ── create a git worktree (herdr worktree.create over the socket) ──────────────

export interface CreateWorktreeInput {
  /** repo to branch from — a cwd inside it (herdr resolves the repo root) */
  repo?: unknown;
  /** or an existing workspace in that repo */
  workspace?: unknown;
  /** new branch name; herdr auto-generates a `worktree/…` name when blank */
  branch?: unknown;
  /** base ref for the new branch (e.g. "origin/main"); herdr's default when blank */
  base?: unknown;
  /** checkout dir for the worktree; herdr's worktrees dir when absent */
  path?: unknown;
}

export interface CreateWorktreeResult {
  workspaceId: string | null;
  checkoutPath: string;
  branch: string | null;
  /** the worktree's root shell pane */
  paneId: string | null;
}

export async function createWorktree(rpc: Rpc, input: CreateWorktreeInput): Promise<CreateWorktreeResult> {
  if (input.repo !== undefined && typeof input.repo !== 'string') throw badRequest('repo must be a string');
  if (input.workspace !== undefined && typeof input.workspace !== 'string') throw badRequest('workspace must be a string');
  if (input.branch !== undefined && typeof input.branch !== 'string') throw badRequest('branch must be a string');
  if (input.base !== undefined && typeof input.base !== 'string') throw badRequest('base must be a string');
  if (input.path !== undefined && (typeof input.path !== 'string' || input.path === '')) throw badRequest('path must be a non-empty string');
  const repo = typeof input.repo === 'string' ? input.repo : '';
  const workspace = typeof input.workspace === 'string' ? input.workspace : '';
  if (!repo && !workspace) throw badRequest('repo (a cwd in the repo) or workspace is required');

  const params: Record<string, unknown> = { focus: false };
  if (repo) params.cwd = repo;
  if (workspace) params.workspace_id = workspace;
  const branch = typeof input.branch === 'string' ? input.branch.trim() : '';
  if (branch) params.branch = branch;
  const base = typeof input.base === 'string' ? input.base.trim() : '';
  if (base) params.base = base;
  if (typeof input.path === 'string') params.path = input.path;

  // herdr's worktree_created result carries the git-worktree object as `worktree`
  // (its checkout dir is `path`, NOT `checkout_path`) and the opened workspace as
  // `workspace` (whose own `worktree.checkout_path` is the same dir) + a `root_pane`.
  const res = (await rpc('worktree.create', params)) as {
    worktree?: { path?: string; branch?: string | null; open_workspace_id?: string };
    workspace?: { workspace_id?: string; worktree?: { checkout_path?: string } };
    root_pane?: { pane_id?: string };
  };
  const checkoutPath = res.worktree?.path || res.workspace?.worktree?.checkout_path;
  if (!checkoutPath) throw new LifecycleError(502, 'error', 'worktree created but herdr returned no checkout path');
  return {
    workspaceId: res.workspace?.workspace_id ?? res.worktree?.open_workspace_id ?? null,
    checkoutPath,
    branch: res.worktree?.branch ?? (branch || null),
    paneId: res.root_pane?.pane_id ?? null,
  };
}

/** Best-effort removal of a worktree we just created (rollback); never throws. Without
 *  `force`, herdr refuses a worktree with changes. Reports whether it was removed. */
async function rollbackWorktree(rpc: Rpc, workspaceId: string | null, force = true): Promise<boolean> {
  if (!workspaceId) return false;
  try {
    await rpc('worktree.remove', { workspace_id: workspaceId, force });
    return true;
  } catch {
    /* best-effort: a failed rollback leaves a worktree behind, but must not mask
       the original agent-start error the caller is about to see */
    return false;
  }
}
