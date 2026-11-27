/**
 * notify.ts — the toasts (a store; ui/Toasts.tsx draws it): short-lived results of what the user
 * did ("Send failed", "Renamed", …), and the OS notifications: a blocked/done status push raises
 * one while the page is hidden, notifications are on and permitted. Opening a pane clears its
 * notifications (the shell calls dismissNotificationsForPane). A headless orchestrator's warning
 * (orchestrator_alert) is told the same way, as its pane hl:<name>, so opening its Home clears it too.
 * Neither push toasts: a worker's progress shows on the Home, a warning on its status bar.
 */
import { go } from './nav.ts';
import { paneRoute } from './routes.ts';
import { store } from './store.ts';
import type { WsAgentStatusMessage, WsOrchestratorAlertMessage } from './types.ts';

export const STORAGE_NOTIF = 'herdr_notifications'; // 'true': OS notifications on (Settings)

// ── Toasts ────────────────────────────────────────────────────────────────────

export interface Toast {
  id: number;
  title: string;
  body: string;
  /** on its way out (the toast-out animation) */
  fading: boolean;
}

export const TOAST_MAX = 10;
const FADE_MS = 300;

let toasts: readonly Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();

function setToasts(next: readonly Toast[]): void {
  toasts = next;
  for (const fn of listeners) fn();
}

export const getToasts = (): readonly Toast[] => toasts;

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** A toast, gone after 4s; the stack keeps the newest TOAST_MAX (fading ones count). */
export function showToast(title: string, body: string): void {
  const id = ++seq;
  setToasts([...toasts, { id, title, body, fading: false }].slice(-TOAST_MAX));
  setTimeout(() => dismissToast(id), 4_000);
}

/** Removes a toast at once. */
export function removeToast(id: number): void {
  if (toasts.some((t) => t.id === id)) setToasts(toasts.filter((t) => t.id !== id));
}

/** Fades a toast out, then removes it. */
export function dismissToast(id: number): void {
  if (!toasts.some((t) => t.id === id)) return;
  setToasts(toasts.map((t) => (t.id === id ? { ...t, fading: true } : t)));
  setTimeout(() => removeToast(id), FADE_MS);
}

/** Every toast, at once (the tests' reset). */
export const clearToasts = (): void => setToasts([]);

// ── A status push ─────────────────────────────────────────────────────────────

/** An agent_status push: for blocked/done an OS notification while the page is hidden,
 *  notifications are on and permitted. */
export function notifyAgentStatus({ paneId, agent, to, workspaceLabel, tabLabel }: WsAgentStatusMessage): void {
  if (to !== 'blocked' && to !== 'done') return;
  const body = [workspaceLabel, tabLabel].filter(Boolean).join(' / '); // a headless orchestrator has no tab
  osNotify(`${agent ?? 'Agent'} ${to}`, body, paneId);
}

/** An orchestrator_alert push: a headless orchestrator's new warning (once per kind and session), or with
 *  no name a failed Claude Code check. While hidden, an OS notification whose tap opens its Home (the
 *  check's: Settings, where it is shown). Its Home shows it as a warning line meanwhile. */
export function notifyOrchestratorAlert({ name, kind, message }: WsOrchestratorAlertMessage): void {
  const o = store.appState?.orchestrators?.find((x) => x.name === name);
  const title = name ? `${o?.label || name}: ${kind}` : 'Claude Code check failed';
  osNotify(title, message, name ? `hl:${name}` : '#/settings'); // a tag that is a hash opens there (sw.ts)
}

// An OS notification while the page is hidden, notifications are on and permitted.
function osNotify(title: string, body: string, paneId: string): void {
  if (
    document.hidden &&
    localStorage.getItem(STORAGE_NOTIF) === 'true' &&
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    showSystemNotification(title, body, paneId);
  }
}

// ── System (OS) notifications ─────────────────────────────────────────────────

// Notifications are shown through the service-worker registration rather than the
// page `new Notification()` constructor: the constructor throws on mobile (Android
// requires SW notifications), and only SW-shown notifications are reachable via
// getNotifications() for later auto-dismissal. Desktop without an active
// registration falls back to the page constructor.
//
// tag === paneId is intentional: successive status pings for one pane coalesce to a
// single OS entry (latest status wins) instead of stacking stale ones, and it is the
// key dismissNotificationsForPane() matches on.

function showSystemNotification(title: string, body: string, paneId: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration()
      .then((reg) => {
        // The app may have become visible while getRegistration() resolved; a
        // return-to-visible dismiss would then run before this notification exists.
        // Re-check the same document.hidden gate so a now-visible pane is never
        // left with a stale OS notification.
        if (!document.hidden) return;
        if (!reg) { pageNotification(title, body, paneId); return; }
        // showNotification() is itself async: the app can become visible between the
        // check above and when the notification is registered, so a visibilitychange
        // dismiss can run too early and miss it. Once it provably exists, dismiss it
        // if the user is now looking at this very pane.
        return reg.showNotification(title, notificationOptions(body, paneId)).then(() => {
          if (!document.hidden && store.view.activePaneId === paneId) dismissNotificationsForPane(paneId);
        });
      })
      .catch(() => { if (document.hidden) pageNotification(title, body, paneId); });
  } else {
    pageNotification(title, body, paneId);
  }
}

// One notification per pane (tag), and renotify: a new one replacing the pane's older one still in
// the notification center alerts again; without it the replacement is silent (the "first one never
// arrives" report). TypeScript's DOM lib dropped renotify, browsers didn't.
const notificationOptions = (body: string, paneId: string): NotificationOptions =>
  ({ body, tag: paneId, renotify: true }) as NotificationOptions;

// Page-constructor notifications are not reachable via getNotifications(), so track
// them per pane to close on pane open.
const pageNotifications = new Map<string, Notification[]>();

function pageNotification(title: string, body: string, paneId: string): void {
  try {
    const n = new Notification(title, notificationOptions(body, paneId));
    n.onclick = () => {
      window.focus();
      go(paneId.startsWith('#/') ? paneId : paneRoute(store.appState, paneId));
    };
    const list = pageNotifications.get(paneId) ?? [];
    list.push(n);
    pageNotifications.set(paneId, list);
    n.addEventListener('close', () => {
      const cur = pageNotifications.get(paneId);
      if (!cur) return;
      const rest = cur.filter((x) => x !== n);
      if (rest.length) pageNotifications.set(paneId, rest);
      else pageNotifications.delete(paneId);
    });
  } catch {
    // `new Notification()` is an illegal constructor on some platforms — ignore
  }
}

/** Close any OS notifications for a pane once its page is opened. */
export function dismissNotificationsForPane(paneId: string): void {
  // page-constructor fallbacks: closed via the tracked references
  const tracked = pageNotifications.get(paneId);
  if (tracked) {
    for (const n of tracked) n.close();
    pageNotifications.delete(paneId);
  }
  // SW-shown notifications: reachable via the registration
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistration()
    .then((reg) => reg?.getNotifications({ tag: paneId }).then((ns) => ns.forEach((n) => n.close())))
    .catch(() => {});
}
