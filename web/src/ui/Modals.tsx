/**
 * ui/Modals.tsx — the modal dialogs, one at a time, on Mantine's Modal in #modal-root: Confirm (and Stop agent…'s, stopAgentFlow), Rename,
 * a headless Home's Compact and its way back to the TUI, and the image preview (full screen). A modal closes on a backdrop tap, Escape or its
 * buttons; its close() is idempotent and fires the opener's onClose exactly once (so a
 * confirm resolves on dismiss). Opening one closes the one before.
 */
import { Button, CloseButton, Code, Group, List, Modal, Text, TextInput } from '@mantine/core';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { apiDelete, apiPost, headlessName, orchestratorPost } from '../api.ts';
import { back, closeAgent, drawerShows } from '../nav.ts';
import { showToast } from '../notify.ts';
import { store } from '../store.ts';
import type { RenameResponse } from '../types.ts';

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
        ? { fullScreen: true, classNames: { content: 'image-preview bg-transparent cursor-zoom-out' } }
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

/** Stop agent…, after a confirm: a pane's ⋮ (in its drawer, on a Home) and an agent row's menu (Dashboard.tsx's AgentRow). A
 *  pane is closed (herdr's pane.close: SIGHUP, then SIGTERM, then SIGKILL to what runs in it); a headless orchestrator
 *  (hl:<name>) is stopped by the bridge (Start resumes its session). */
export async function stopAgentFlow(paneId: string): Promise<void> {
  const hl = headlessName(paneId);
  const ok = await confirmModal('Stop agent?', hl ? 'Stops the orchestrator. Start resumes its session.' : 'Closes the pane and terminates the agent running in it.', 'Stop', true);
  if (!ok) return;
  try {
    await (hl ? orchestratorPost(hl, 'stop') : apiDelete(`/api/panes/${encodeURIComponent(paneId)}`));
    showToast('Stopped', hl ? 'The orchestrator stopped' : 'Agent pane closed');
    if (!store.view.homeMode && drawerShows(paneId)) closeAgent(); // a Home stays: the State shows it stopped; another pane opened meanwhile too
  } catch (err) {
    showToast('Stop failed', (err as Error).message);
  }
}

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

// ── Compact (a headless Home's, ui/Pane.tsx's CompactButton) ──────────────────

/** Compact…: the orchestrator's conversation summarized in place (its session kept), with what the summary
 *  should keep, if anything; the Home's "doing now" line follows it. */
export function openCompact(name: string): void {
  showModal((close) => <Compact name={name} close={close} />);
}

function Compact({ name, close }: { name: string; close: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (): Promise<void> => {
    setBusy(true);
    try {
      await orchestratorPost(name, 'compact', { focus: input.current!.value.trim() });
      close();
    } catch (err) {
      setBusy(false);
      setError((err as Error).message);
    }
  };
  return (
    <>
      <Title>Compact the conversation?</Title>
      <Text fz={14} c="dimmed" mb={14}>Claude Code summarizes it to free the context, and the session goes on from the summary.</Text>
      <TextInput label="Focus (optional)" id="cp-focus" ref={input} placeholder="What the summary should keep" mb={14} data-autofocus />
      <ErrorLine id="cp-error">{error}</ErrorLine>
      <Actions ids={['cp-cancel', 'cp-ok']} label="Compact" busy={busy} close={close} onAction={() => { void run(); }} />
    </>
  );
}

// ── Back to the TUI (a headless Home's ⋮ and its warnings, ui/Pane.tsx) ───────

const PLUGIN = 'y011d4.yoicks';

/** The way back from headless to the TUI for the orchestrator `name`, by hand: the app never writes the config. */
export function openTuiSteps(name: string): void {
  showModal((close) => (
    <>
      <Title>Back to the TUI</Title>
      <List type="ordered" className="tui-steps wrap-anywhere" fz={13} lh={1.5} pl={20} mb={14}>
        <List.Item>In the bridge's <Code fz={12}>config.json</Code> (its folder: <Code fz={12}>{`herdr plugin config-dir ${PLUGIN}`}</Code>), remove <Code fz={12}>"mode": "headless"</Code> from the orchestrator <Code fz={12}>{`"${name}"`}</Code>.</List.Item>
        <List.Item>Restart the bridge: <Code fz={12}>{`herdr plugin action invoke ${PLUGIN}.stop`}</Code>, wait until it has stopped, then <Code fz={12}>{`herdr plugin action invoke ${PLUGIN}.start`}</Code>.</List.Item>
        <List.Item>Open its Home and tap Start: it runs in a herdr pane again, in a fresh session.</List.Item>
      </List>
      <Group justify="flex-end"><Button id="tui-close" px={20} onClick={close} data-autofocus>Close</Button></Group>
    </>
  ));
}
