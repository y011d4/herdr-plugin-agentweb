/**
 * Agent lifecycle orchestration (start / stop / rename / clear).
 *
 * Pure orchestration over an injected herdr `rpc` (no direct I/O), so it is
 * unit-testable with a fake rpc — mirroring the injectable git runner in
 * worktree-resolve.ts. http.ts wires these behind REST routes; the actual socket
 * work stays in herdr-client.ts.
 *
 * Everything goes through herdr's own agent/pane API (verified against the
 * bundled `herdr api schema --json`, protocol 16):
 *   - agent.start { name, argv, cwd?, workspace_id?, focus } → { agent: { pane_id, agent, ... } }
 *   - pane.close  { pane_id }
 *   - agent.rename{ target, name }
 *   - agent.get   { target } → { agent: { pane_id, agent, cwd, foreground_cwd, ... } }
 *   - agent.send  { target, text }
 *
 * Security: agents are launched only from a fixed profile allowlist — a caller
 * never supplies raw argv/command. (The bearer token already grants full pane
 * input ≈ a shell, so cwd is not a new privilege, but arbitrary argv would let a
 * caller pick the *program*, so that stays gated behind named profiles.)
 */

export interface LaunchProfile {
  /** the command + fixed flags to exec, e.g. ["claude", "--dangerously-skip-permissions"] */
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

const NAME_MAX = 80;

function badRequest(message: string): LifecycleError {
  return new LifecycleError(400, 'invalid_params', message);
}

/** Trim and cap a display name; returns null when nothing usable is left. */
function compactName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, NAME_MAX);
  return trimmed.length > 0 ? trimmed : null;
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

  const name = compactName(input.name) ?? `${input.profile}-${Date.now().toString(36)}`;

  const params: Record<string, unknown> = { name, argv: profile.argv, focus: false };
  if (typeof input.cwd === 'string') params.cwd = input.cwd;
  if (typeof input.workspace === 'string') params.workspace_id = input.workspace;

  const started = agentFromResult(await rpc('agent.start', params));
  const paneId = started?.pane_id;
  if (!paneId) throw new LifecycleError(502, 'error', 'agent started but herdr returned no pane id');

  const result: StartAgentResult = { paneId, name, agent: started.agent ?? null };

  // Best-effort initial task. Target the pane id herdr just returned (unambiguous)
  // rather than the name — a name can collide with another agent, and even the
  // auto-generated one could clash across two near-simultaneous starts, misrouting
  // the first instruction. An agent may not be ready to accept input the instant
  // it launches, so a send failure must not fail the (successful) start. When a
  // task field was supplied, taskDelivered always reports the outcome (false for an
  // empty task that was skipped), so the client can tell it apart from "no task".
  if (typeof input.task === 'string') {
    if (input.task.length > 0) {
      try {
        await rpc('agent.send', { target: paneId, text: input.task });
        result.taskDelivered = true;
      } catch {
        result.taskDelivered = false;
      }
    } else {
      result.taskDelivered = false;
    }
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
  const clean = compactName(name);
  if (!clean) throw badRequest('name must be a non-empty string');
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
  preferredProfile?: string,
): Promise<ClearAgentResult> {
  const agent = agentFromResult(await rpc('agent.get', { target }));
  if (!agent) throw new LifecycleError(404, 'not_found', 'agent not found');

  // Prefer the profile this agent was actually started with (the bridge records
  // it per pane): inferring from herdr's detected type collapses a custom variant
  // (e.g. "claude-yolo") back onto the base "claude" profile and drops its argv.
  // Fall back to inference for agents the bridge didn't start.
  const key = (preferredProfile && Object.hasOwn(profiles, preferredProfile))
    ? preferredProfile
    : profileForAgentType(profiles, agent.agent ?? null);
  if (!key) throw new LifecycleError(422, 'no_profile', `no launch profile matches agent type: ${String(agent.agent)}`);

  const oldPaneId = agent.pane_id;
  if (!oldPaneId) throw new LifecycleError(502, 'error', 'agent has no pane id');
  const cwd = agent.foreground_cwd || agent.cwd || null;

  const name = `${key}-${Date.now().toString(36)}`;
  const startParams: Record<string, unknown> = { name, argv: profiles[key].argv, focus: false };
  if (cwd) startParams.cwd = cwd;

  const started = agentFromResult(await rpc('agent.start', startParams));
  const paneId = started?.pane_id;
  if (!paneId) throw new LifecycleError(502, 'error', 'replacement started but herdr returned no pane id');

  // Replacement is up; retire the old pane. A close failure just leaves the old
  // pane around (reported), rather than failing an otherwise-successful clear.
  let closedOld = true;
  try {
    await rpc('pane.close', { pane_id: oldPaneId });
  } catch {
    closedOld = false;
  }
  return { paneId, name, closedOld, profile: key };
}
