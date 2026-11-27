/**
 * ui/Modals.tsx — the modal dialogs, one at a time, drawn into #modal-root: Confirm (on Mantine's
 * Modal), Rename, New agent and the image preview. A modal closes on a backdrop tap, Escape or its
 * buttons; its close() is idempotent and fires the opener's onClose exactly once (so a
 * confirm resolves on dismiss). Opening one closes the one before.
 */
import { Modal } from '@mantine/core';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { apiGet, apiPost } from '../api.ts';
import { taskToKeep } from '../kept-tasks.ts';
import { showToast } from '../notify.ts';
import { keptTasks, store } from '../store.ts';
import type { AgentStartResponse, ProfilesResponse, RenameResponse } from '../types.ts';

// mantine: drawn by Mantine's Modal (the confirm), else by Overlay below
interface Open { id: number; render: (close: () => void) => ReactNode; close: () => void; className: string; mantine: boolean }

let current: Open | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const changed = (): void => { for (const fn of listeners) fn(); };
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** Shows a modal (closing the one on show); returns its close(). */
function showModal(render: (close: () => void) => ReactNode, onClose?: () => void, className = 'modal', mantine = false): () => void {
  current?.close();
  const id = ++seq;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (current?.id === id) { current = null; changed(); }
    onClose?.();
  };
  current = { id, render, close, className, mantine };
  changed();
  return close;
}

export function Modals() {
  const open = useSyncExternalStore(subscribe, () => current);
  if (!open) return null;
  if (open.mantine) return <MantineDialog key={open.id} close={open.close} className={open.className}>{open.render(open.close)}</MantineDialog>;
  return <Overlay key={open.id} close={open.close} className={open.className}>{open.render(open.close)}</Overlay>;
}

// Overlay's look on Mantine's Modal: the same backdrop, fade and width, and above the toasts (z 1000).
// Mantine closes it on Escape and a backdrop tap, traps the focus and gives it back on close.
function MantineDialog({ close, className, children }: { close: () => void; className: string; children: ReactNode }) {
  return (
    <Modal.Root opened onClose={close} centered zIndex={2000} size="min(92vw, 420px)" xOffset={16} yOffset={16}
      transitionProps={{ transition: 'fade', duration: 150 }} classNames={{ content: className }}>
      <Modal.Overlay color="#000" backgroundOpacity={0.55} data-modal-backdrop />
      <Modal.Content>{children}</Modal.Content>
    </Modal.Root>
  );
}

// Above everything (toasts are z 1000, modals sit higher: style.css).
function Overlay({ close, className, children }: { close: () => void; className: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className={className} role="dialog" aria-modal="true">{children}</div>
    </div>
  );
}

// The last few previews' images by their history entries, so Back or Forward onto one shows it again
// (an older entry stays blank, as after a reload). Opening a preview drops the forward entries, so
// only Forward after a close, or the ones hash changes left behind, can still be reached.
const PREVIEWS_KEPT = 5;
const previewed = new Map<number, { src: string; alt: string }>();

/** An image, fit to the screen. A tap on it or around it, ×, Escape or the phone's Back closes it: it
 *  opens on a history entry of its own at the same URL (no hashchange, so no route), which a close by
 *  any other means takes back off. Focus goes to × and back to the opener. */
export function previewImage(src: string, alt: string): void {
  const mark = Math.random(); // this preview's entry, not a stale one a reload or a hash change left behind
  previewed.set(mark, { src, alt });
  if (previewed.size > PREVIEWS_KEPT) previewed.delete(previewed.keys().next().value!);
  history.pushState({ imagePreview: mark }, '');
  showPreview(src, alt, mark);
}

function showPreview(src: string, alt: string, mark: number): void {
  const opener = document.activeElement as HTMLElement | null;
  const close = showModal((close) => (
    <>
      <img src={src} alt={alt} onClick={close} />
      <button className="image-preview-close" aria-label="Close" autoFocus onClick={close}>&times;</button>
    </>
  ), () => {
    removeEventListener('popstate', close);
    if (history.state?.imagePreview === mark) history.back();
    opener?.focus();
  }, 'image-preview');
  addEventListener('popstate', close);
}
// Forward onto a closed preview's entry, or Back onto one a hash change left behind, shows it again:
// else the entry shows nothing and, at the same URL, the next Back seems to do nothing. (After a
// reload the map is empty and such an entry stays blank.)
addEventListener('popstate', () => {
  const mark: unknown = history.state?.imagePreview;
  const p = typeof mark === 'number' ? previewed.get(mark) : undefined;
  if (p) showPreview(p.src, p.alt, mark as number);
});

const textInput = { type: 'text', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

// ── Confirm ───────────────────────────────────────────────────────────────────

/** Yes/no; resolves false on cancel or dismiss. `danger` styles the confirm button as destructive. */
export function confirmModal(title: string, message: string, confirmLabel: string, danger: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    showModal((close) => (
      <>
        <div className="modal-title">{title}</div>
        <div className="modal-message">{message}</div>
        <div className="modal-actions">
          <button className="btn-secondary" id="cf-cancel" onClick={close}>Cancel</button>
          <button className={`btn-primary${danger ? ' danger' : ''}`} id="cf-ok" style={{ width: 'auto' }} onClick={() => { result = true; close(); }}>{confirmLabel}</button>
        </div>
      </>
    ), () => resolve(result), 'modal', true);
  });
}

// ── Rename (from a pane's ⋮, ui/Pane.tsx's AgentMenu) ────────────────────────

/** Rename… (the header follows the State). */
export function openRename(paneId: string, current: string): void {
  showModal((close) => <Rename paneId={paneId} current={current} close={close} />);
}

function Rename({ paneId, current, close }: { paneId: string; current: string; close: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { input.current!.focus(); input.current!.select(); }, []);
  const save = async (): Promise<void> => {
    const name = input.current!.value.trim();
    if (!name) { setError('Name is required.'); return; }
    setBusy(true);
    try {
      // the bridge fits the name to herdr's rule (lowercase, a-z0-9-_), so show what it stored
      const res = await apiPost<RenameResponse>(`/api/panes/${encodeURIComponent(paneId)}/rename`, { name });
      close();
      showToast('Renamed', `Agent renamed to ${res.name ?? name}`);
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };
  return (
    <>
      <div className="modal-title">Rename agent</div>
      <label className="modal-field"><span>Name</span><input id="rn-name" ref={input} defaultValue={current} {...textInput} /></label>
      <div className="modal-error" id="rn-error">{error}</div>
      <div className="modal-actions">
        <button className="btn-secondary" id="rn-cancel" onClick={close}>Cancel</button>
        <button className="btn-primary" id="rn-save" style={{ width: 'auto' }} disabled={busy} onClick={() => { void save(); }}>Save</button>
      </div>
    </>
  );
}

// ── New agent ─────────────────────────────────────────────────────────────────

const CUSTOM = '__custom__';
interface Dir { path: string; label: string; workspaceId: string }

// Directories to launch an agent in: one per open workspace/worktree, so on a
// phone you pick an existing repo/worktree from a list instead of typing a path.
// Prefer a herdr worktree's stable checkout path over the (mutable) pane cwd.
function agentStartDirs(): Dir[] {
  const dirs: Dir[] = [];
  const seen = new Set<string>();
  for (const ws of store.appState?.workspaces ?? []) {
    const path = ws.worktree?.checkoutPath || ws.cwd;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const branch = ws.worktree?.branch ? ` · ${ws.worktree.branch}` : '';
    const wt = ws.worktree?.isLinkedWorktree ? ' (worktree)' : '';
    dirs.push({ path, label: `${ws.label || ws.workspaceId}${branch}${wt}`, workspaceId: ws.workspaceId });
  }
  return dirs;
}

/** "New agent": loads the launch profiles, then asks for a profile, a directory (from the open
 *  workspaces / worktrees, or a custom path; optionally a new worktree branched from it), and
 *  optionally a name and a first task. */
export async function openNewAgent(): Promise<void> {
  let profiles: ProfilesResponse['profiles'];
  try {
    profiles = (await apiGet<ProfilesResponse>('/api/profiles')).profiles ?? [];
  } catch (err) {
    showToast('Could not load profiles', (err as Error).message);
    return;
  }
  if (profiles.length === 0) {
    showToast('No launch profiles', 'Configure launch_profiles in the bridge config.');
    return;
  }
  // Directory choices come straight from the State — default to the focused workspace
  // so "another agent in this repo/worktree" is the zero-typing path.
  const dirs = agentStartDirs();
  const focusedWs = store.appState?.workspaces.find((w) => w.workspaceId === store.appState?.focused.workspaceId);
  const focusedPath = focusedWs ? (focusedWs.worktree?.checkoutPath || focusedWs.cwd) : null;
  const dir = dirs.find((d) => d.path === focusedPath)?.path ?? dirs[0]?.path ?? CUSTOM;
  showModal((close) => <NewAgent profiles={profiles} dirs={dirs} initialDir={dir} close={close} />);
}

function NewAgent({ profiles, dirs, initialDir, close }: { profiles: ProfilesResponse['profiles']; dirs: Dir[]; initialDir: string; close: () => void }) {
  const [f, setF] = useState({ profile: profiles[0].name, dir: initialDir, cwd: '', worktree: false, branch: '', base: '', name: '', task: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (k: 'profile' | 'dir' | 'cwd' | 'branch' | 'base' | 'name' | 'task') => ({
    value: f[k],
    onChange: (e: { target: { value: string } }) => { const v = e.target.value; setF((p) => ({ ...p, [k]: v })); },
  });

  const start = async (): Promise<void> => {
    const val = (s: string): string => s.trim();
    const body: Record<string, unknown> = { profile: val(f.profile) };
    const name = val(f.name); if (name) body.name = name;
    const task = val(f.task); if (task) body.task = task;
    setBusy(true);
    setError('');
    // The working directory the user chose: a picked workspace/worktree, or the custom path.
    const chosenDir = f.dir === CUSTOM ? val(f.cwd) : f.dir;
    try {
      if (f.worktree) {
        // Branch a new worktree from the chosen directory's repo and launch the agent
        // in it — one atomic request (the bridge rolls the worktree back if the agent
        // fails to start).
        if (!chosenDir) {
          setError('Pick a working directory (or a custom path) to branch the worktree from.');
          setBusy(false);
          return;
        }
        body.worktree = {
          repo: chosenDir,
          ...(val(f.branch) ? { branch: val(f.branch) } : {}),
          ...(val(f.base) ? { base: val(f.base) } : {}),
        };
      } else if (chosenDir) {
        body.cwd = chosenDir;
        // Pin a picked selection to its workspace (not the focused one) so the agent
        // lands under the right group, not just at a matching cwd.
        if (f.dir !== CUSTOM) {
          const wsId = dirs.find((d) => d.path === f.dir)?.workspaceId;
          if (wsId) body.workspace = wsId;
        }
      }
      const res = await apiPost<AgentStartResponse>('/api/agents', body);
      close();
      const started = res.name ? `Started ${res.name}` : 'Agent started';
      // the agent never became ready for its task (e.g. waiting on a startup dialog):
      // keep the task in the new pane's composer instead of losing it
      const kept = taskToKeep(res, task);
      if (kept) keptTasks.keep(kept.paneId, kept.text);
      showToast('Agent started', kept ? `${started}. The task wasn't sent yet — it's in the composer, tap Send when the agent is ready` : started);
      if (res.paneId) location.hash = `#/pane/${encodeURIComponent(res.paneId)}`;
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };

  return (
    <>
      <div className="modal-title">New agent</div>
      <label className="modal-field"><span>Profile</span><select id="na-profile" {...field('profile')}>
        {profiles.map((p) => <option key={p.name} value={p.name}>{p.label}</option>)}
      </select></label>
      <label className="modal-field"><span>Working directory</span><select id="na-dir" {...field('dir')}>
        {dirs.map((d) => <option key={d.path} value={d.path}>{d.label}</option>)}
        <option value={CUSTOM}>Custom path…</option>
      </select></label>
      <label className="modal-field" id="na-cwd-wrap" style={f.dir === CUSTOM ? undefined : { display: 'none' }}>
        <span>Custom path</span><input id="na-cwd" placeholder="/path/to/repo" {...textInput} {...field('cwd')} />
      </label>
      <div className="modal-field modal-toggle-row">
        <span>Create a new worktree</span>
        <label className="toggle"><input type="checkbox" id="na-wt-toggle" checked={f.worktree} onChange={(e) => { const v = e.target.checked; setF((p) => ({ ...p, worktree: v })); }} /><span className="toggle-track"></span></label>
      </div>
      <div id="na-wt-wrap" style={f.worktree ? undefined : { display: 'none' }}>
        <div className="modal-hint">A new branch is checked out from the working directory above, and the agent runs there.</div>
        <label className="modal-field"><span>New branch <em>(optional)</em></span><input id="na-wt-branch" placeholder="auto (worktree/…)" {...textInput} {...field('branch')} /></label>
        <label className="modal-field"><span>Base <em>(optional)</em></span><input id="na-wt-base" placeholder="e.g. origin/main" {...textInput} {...field('base')} /></label>
      </div>
      <label className="modal-field"><span>Name <em>(optional)</em></span><input id="na-name" placeholder="auto" {...textInput} {...field('name')} /></label>
      <label className="modal-field"><span>First task <em>(optional)</em></span><textarea id="na-task" rows={2} placeholder="e.g. review the diff" {...field('task')}></textarea></label>
      <div className="modal-error" id="na-error">{error}</div>
      <div className="modal-actions">
        <button className="btn-secondary" id="na-cancel" onClick={close}>Cancel</button>
        <button className="btn-primary" id="na-start" style={{ width: 'auto' }} disabled={busy} onClick={() => { void start(); }}>Start</button>
      </div>
    </>
  );
}
