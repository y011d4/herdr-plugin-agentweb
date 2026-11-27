/**
 * ui/Modals.tsx — the modal dialogs, one at a time, on Mantine's Modal in #modal-root: Confirm, Rename,
 * New agent and the image preview (full screen). A modal closes on a backdrop tap, Escape or its
 * buttons; its close() is idempotent and fires the opener's onClose exactly once (so a
 * confirm resolves on dismiss). Opening one closes the one before.
 */
import { Button, CloseButton, Group, Modal, NativeSelect, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { apiGet, apiPost } from '../api.ts';
import { taskToKeep } from '../kept-tasks.ts';
import { back, openAgent } from '../nav.ts';
import { showToast } from '../notify.ts';
import { keptTasks, store } from '../store.ts';
import type { AgentStartResponse, ProfilesResponse, RenameResponse } from '../types.ts';

// preview: the image preview's full-screen look. opener: where the focus goes back on close.
interface Open { id: number; render: (close: () => void) => ReactNode; close: () => void; preview: boolean; opener: HTMLElement | null }

let current: Open | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const changed = (): void => { for (const fn of listeners) fn(); };
const subscribe = (fn: () => void): (() => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

/** What has the focus, but for a Mantine menu's item (gone once picked): that menu's button. */
function focused(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  const menu = active?.closest('[data-menu-dropdown]');
  return menu ? document.getElementById(menu.getAttribute('aria-labelledby') ?? '') : active;
}

/** Shows a modal (closing the one on show); returns its close(). On close the focus goes back to what
 *  had it on open; a modal that takes another's place takes over that one's opener instead (the one
 *  before gives it back first, and the new one takes it as it mounts). */
function showModal(render: (close: () => void) => ReactNode, onClose?: () => void, preview = false): () => void {
  const opener = current ? current.opener : focused();
  current?.close();
  const id = ++seq;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (current?.id === id) { current = null; changed(); }
    onClose?.();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  current = { id, render, close, preview, opener };
  changed();
  return close;
}

export function Modals() {
  const open = useSyncExternalStore(subscribe, () => current);
  if (!open) return null;
  return <Dialog key={open.id} close={open.close} preview={open.preview}>{open.render(open.close)}</Dialog>;
}

// 16px clear of the screen's edges and of its notch or home bar (safe areas): Mantine's offset is the
// same at the top and the bottom (and caps the dialog's height), so it takes the larger inset
const Y_OFFSET = 'calc(max(var(--safe-top), var(--safe-bottom)) + 16px)';

// Mantine's Modal, above the toasts (z 1000): a dialog 420px wide at most, or the image preview over
// the whole screen. Mantine closes it on Escape and a backdrop tap and traps the focus. (Its own focus
// return needs `opened` to turn false; this one unmounts, and showModal gives the focus back.)
function Dialog({ close, preview, children }: { close: () => void; preview: boolean; children: ReactNode }) {
  return (
    <Modal.Root opened onClose={close} centered zIndex={2000} xOffset={16} yOffset={Y_OFFSET} radius={14}
      transitionProps={{ transition: 'fade', duration: 150 }} {...(preview
        ? { fullScreen: true, classNames: { content: 'image-preview bg-transparent' } }
        : { size: 'min(92vw, 420px)', classNames: { content: 'border border-(--color-border)' } })}>
      <Modal.Overlay color="#000" backgroundOpacity={preview ? 0.9 : 0.55} data-modal-backdrop />
      {/* the preview: a tap anywhere closes it */}
      <Modal.Content onClick={preview ? close : undefined}>{preview ? children : <Modal.Body p={18}>{children}</Modal.Body>}</Modal.Content>
    </Modal.Root>
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
  const close = showModal((close) => (
    <>
      <img className="block size-full object-contain" src={src} alt={alt} />
      <CloseButton className="image-preview-close fixed top-[calc(var(--safe-top)+8px)] right-3" size={40} radius="xl" iconSize={22}
        variant="filled" bg="rgba(0, 0, 0, 0.6)" c="white" aria-label="Close" autoFocus data-autofocus />
    </>
  ), () => {
    removeEventListener('popstate', close);
    if (history.state?.imagePreview === mark) back();
  }, true);
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

const textInput = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

const Title = ({ children }: { children: string }) => <Text fz={16} fw={600} mb={14}>{children}</Text>;
const Optional = ({ children }: { children: string }) => <>{children} <Text span c="dimmed" inherit>(optional)</Text></>;
// a dialog's error (none: no line)
const ErrorLine = ({ id, children }: { id: string; children: string }) => <Text id={id} c="blocked" fz={13} mb={children ? 10 : 0}>{children}</Text>;

/** A dialog's Cancel (`<ids[0]>`) and its action (`<ids[1]>`), at the right; `danger`: a destructive one. */
function Actions({ ids, label, onAction, busy = false, danger = false, close }: { ids: [string, string]; label: string; onAction: () => void; busy?: boolean; danger?: boolean; close: () => void }) {
  return (
    <Group justify="flex-end" gap={10} mt={8}>
      <Button variant="default" id={ids[0]} px={20} onClick={close}>Cancel</Button>
      <Button id={ids[1]} px={20} color={danger ? 'blocked' : undefined} disabled={busy} onClick={onAction}>{label}</Button>
    </Group>
  );
}

// ── Confirm ───────────────────────────────────────────────────────────────────

/** Yes/no; resolves false on cancel or dismiss. `danger` styles the confirm button as destructive. */
export function confirmModal(title: string, message: string, confirmLabel: string, danger: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    showModal((close) => (
      <>
        <Title>{title}</Title>
        <Text fz={14} c="dimmed" mb={18}>{message}</Text>
        <Actions ids={['cf-cancel', 'cf-ok']} label={confirmLabel} danger={danger} close={close} onAction={() => { result = true; close(); }} />
      </>
    ), () => resolve(result));
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
      <Title>Rename agent</Title>
      <TextInput label="Name" id="rn-name" ref={input} defaultValue={current} mb={14} {...textInput} />
      <ErrorLine id="rn-error">{error}</ErrorLine>
      <Actions ids={['rn-cancel', 'rn-save']} label="Save" busy={busy} close={close} onAction={() => { void save(); }} />
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
    id: `na-${{ profile: 'profile', dir: 'dir', cwd: 'cwd', branch: 'wt-branch', base: 'wt-base', name: 'name', task: 'task' }[k]}`,
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
      if (res.paneId) openAgent(res.paneId);
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };

  return (
    <>
      <Title>New agent</Title>
      <Stack gap={14} mb={14}>
        <NativeSelect label="Profile" {...field('profile')} data={profiles.map((p) => ({ value: p.name, label: p.label }))} />
        <NativeSelect label="Working directory" {...field('dir')}
          data={[...dirs.map((d) => ({ value: d.path, label: d.label })), { value: CUSTOM, label: 'Custom path…' }]} />
        <div id="na-cwd-wrap" style={f.dir === CUSTOM ? undefined : { display: 'none' }}>
          <TextInput label="Custom path" placeholder="/path/to/repo" {...textInput} {...field('cwd')} />
        </div>
        <Switch id="na-wt-toggle" label="Create a new worktree" labelPosition="left" size="md" checked={f.worktree}
          styles={{ body: { justifyContent: 'space-between' } }} onChange={(e) => { const v = e.currentTarget.checked; setF((p) => ({ ...p, worktree: v })); }} />
        <Stack id="na-wt-wrap" gap={14} style={f.worktree ? undefined : { display: 'none' }}>
          <Text fz={12} c="dimmed">A new branch is checked out from the working directory above, and the agent runs there.</Text>
          <TextInput label={<Optional>New branch</Optional>} placeholder="auto (worktree/…)" {...textInput} {...field('branch')} />
          <TextInput label={<Optional>Base</Optional>} placeholder="e.g. origin/main" {...textInput} {...field('base')} />
        </Stack>
        <TextInput label={<Optional>Name</Optional>} placeholder="auto" {...textInput} {...field('name')} />
        <Textarea label={<Optional>First task</Optional>} rows={2} resize="vertical" placeholder="e.g. review the diff" {...field('task')} />
      </Stack>
      <ErrorLine id="na-error">{error}</ErrorLine>
      <Actions ids={['na-cancel', 'na-start']} label="Start" busy={busy} close={close} onAction={() => { void start(); }} />
    </>
  );
}
