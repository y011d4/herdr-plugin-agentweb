/**
 * ui/mount.tsx — the shared DOM while app.ts and React screens live side by side (temporary
 * glue, deleted with app.ts): the only holder of #screen, the topbar and its slots, the
 * connection dot and the reconnect banner. Every write to them goes through here, and each
 * screen change sets store.view.screen.
 */
import { StrictMode, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { store, type View } from '../store.ts';

export interface Topbar { title?: ReactNode; left?: ReactNode; right?: ReactNode }

const el = (id: string): HTMLElement => document.getElementById(id)!;
let root: Root | null = null; // the React screen on show, if any

function unmountReact(): void {
  root?.unmount();
  root = null;
}

function takeScreen(kind: View['screen']): HTMLElement {
  unmountReact();
  store.view.screen = kind;
  if (kind === 'token') el('reconnect-banner').classList.remove('visible');
  return el('screen');
}

/** A legacy (app.ts) screen: a React one on show is unmounted first. */
export function setLegacyScreen(kind: View['screen'], html: string): void {
  takeScreen(kind).innerHTML = html;
}

/** Shows the topbar and writes its slots (one left out keeps its content); returns the
 *  slots, for the caller's listeners. The topbar belongs to a legacy screen from here on. */
export function setLegacyTopbar(t: { titleHtml?: string; leftHtml?: string; rightHtml?: string }): Record<'left' | 'title' | 'right', HTMLElement> {
  unmountReact();
  el('topbar').style.display = '';
  const slots = { left: el('topbar-left'), title: el('topbar-title'), right: el('topbar-right') };
  if (t.leftHtml !== undefined) slots.left.innerHTML = t.leftHtml;
  if (t.titleHtml !== undefined) slots.title.innerHTML = t.titleHtml;
  if (t.rightHtml !== undefined) slots.right.innerHTML = t.rightHtml;
  return slots;
}

/** The connection dot, and the reconnect banner (never over the token screen). */
export function setConnIndicator(connected: boolean): void {
  const dot = el('conn-dot');
  dot.classList.toggle('connected', connected);
  dot.title = connected ? 'Connected' : 'Reconnecting…';
  el('reconnect-banner').classList.toggle('visible', !connected && store.view.screen !== 'token');
}

/** A React screen, in a display:contents wrapper in #screen, its topbar portalled into
 *  spans in the slots (no topbar: hidden). */
export function mountScreen(kind: View['screen'], node: ReactNode, { topbar }: { topbar?: Topbar } = {}): void {
  const host = document.createElement('div');
  host.style.display = 'contents';
  takeScreen(kind).replaceChildren(host);
  el('topbar').style.display = topbar ? '' : 'none';
  const slot = (id: string, content: ReactNode): ReactNode => {
    const span = document.createElement('span');
    span.style.display = 'contents';
    el(id).replaceChildren(span);
    return createPortal(content, span);
  };
  root = createRoot(host);
  root.render(
    <StrictMode>
      {node}
      {slot('topbar-left', topbar?.left)}
      {slot('topbar-title', topbar?.title)}
      {slot('topbar-right', topbar?.right)}
    </StrictMode>,
  );
}
