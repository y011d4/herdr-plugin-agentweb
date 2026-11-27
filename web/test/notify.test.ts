// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, dismissNotificationsForPane, getToasts, notifyAgentStatus, notifyOrchestratorAlert } from '../src/notify.ts';
import { store } from '../src/store.ts';
import type { WsAgentStatusMessage } from '../src/types.ts';
import { messages } from './contract.gen.ts';

// the bridge's agent_status pushes: p3 working → done (labelled), p9 unknown → blocked (no labels)
const [done, blocked] = messages.filter((m): m is WsAgentStatusMessage => m.type === 'agent_status');
const working: WsAgentStatusMessage = { ...done, from: 'idle', to: 'working' };

let hidden: boolean;
let shown: Array<{ title: string; body?: string; tag?: string; renotify?: boolean }>;
let closed: string[];
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('notify', () => {
  beforeEach(() => {
    clearToasts();
    store.view.activePaneId = null;
    hidden = true;
    shown = [];
    closed = [];
    localStorage.setItem('herdr_notifications', 'true');
    vi.stubGlobal('Notification', { permission: 'granted' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    const reg = {
      showNotification: async (title: string, o: NotificationOptions & { renotify?: boolean }) => { shown.push({ title, body: o.body, tag: o.tag, renotify: o.renotify }); },
      getNotifications: async ({ tag }: { tag: string }) => [{ close: () => closed.push(tag) }],
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => reg } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as { hidden?: boolean }).hidden;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it('blocked/done while hidden, on and permitted: an OS notification tagged with the pane, alerting again', async () => {
    notifyAgentStatus(done);
    notifyAgentStatus(blocked);
    await settle();
    // renotify: replacing the pane's older notification still alerts
    assert.deepEqual(shown, [
      { title: 'Claude Code done', body: 'repo-wt-feat / feat', tag: 'p3', renotify: true },
      { title: 'Agent blocked', body: '', tag: 'p9', renotify: true },
    ]);
  });

  it("an orchestrator_alert while hidden: tagged with its Home's pane, a failed check's with #/settings (opened there)", async () => {
    notifyOrchestratorAlert({ type: 'orchestrator_alert', name: 'pilot', kind: 'silent', message: 'no event' });
    notifyOrchestratorAlert({ type: 'orchestrator_alert', name: '', kind: 'canary', message: 'interrupt failed' });
    await settle();
    assert.deepEqual(shown.map((n) => `${n.title}|${n.tag}`), ['pilot: silent|hl:pilot', 'Claude Code check failed|#/settings']);
  });

  it("without a SW registration, a failed check's page notification opens Settings when clicked", async () => {
    const made: Array<{ onclick: () => void }> = [];
    vi.stubGlobal('Notification', Object.assign(function (this: { onclick: () => void; addEventListener: () => void }) {
      this.addEventListener = () => {};
      made.push(this);
    }, { permission: 'granted' }));
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => undefined } });
    vi.stubGlobal('focus', () => {});
    location.hash = '#/agents';
    notifyOrchestratorAlert({ type: 'orchestrator_alert', name: '', kind: 'canary', message: 'interrupt failed' });
    await settle();
    made[0].onclick();
    assert.equal(location.hash, '#/settings');
  });

  it('none while visible, turned off, not permitted, or for another status', async () => {
    const cases: Array<() => void> = [
      () => { hidden = false; },
      () => { localStorage.setItem('herdr_notifications', 'false'); },
      () => { vi.stubGlobal('Notification', { permission: 'default' }); },
    ];
    for (const set of cases) {
      hidden = true;
      localStorage.setItem('herdr_notifications', 'true');
      vi.stubGlobal('Notification', { permission: 'granted' });
      set();
      notifyAgentStatus(done);
    }
    notifyAgentStatus(working);
    await settle();
    assert.deepEqual(shown, []);
  });

  it('no toast for a status push or an alert, the page visible or not', () => {
    for (const h of [false, true]) {
      hidden = h;
      notifyAgentStatus(working);
      notifyAgentStatus(done);
      notifyOrchestratorAlert({ type: 'orchestrator_alert', name: 'pilot', kind: 'silent', message: 'no event' });
    }
    assert.deepEqual(getToasts(), []);
  });

  it('a notification registered as the page shows its pane is closed at once; not while Settings covers that pane', async () => {
    const reg = { showNotification: async () => { hidden = false; }, getNotifications: async ({ tag }: { tag: string }) => [{ close: () => closed.push(tag) }] };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => reg } });
    store.view.activePaneId = 'p3';
    store.view.settingsOpen = true;
    notifyAgentStatus(done);
    await settle();
    await settle();
    assert.deepEqual(closed, [], 'out of sight under Settings');
    hidden = true;
    store.view.settingsOpen = false;
    notifyAgentStatus(done);
    await settle();
    await settle();
    assert.deepEqual(closed, ['p3']);
  });

  it('a notification for the pane Settings covers is shown even when the page shows meanwhile', async () => {
    const shown: string[] = [];
    const reg = { showNotification: async (_t: string, o: NotificationOptions) => { shown.push(o.tag!); }, getNotifications: async () => [] };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => { hidden = false; return reg; } } });
    store.view.activePaneId = 'p3';
    store.view.settingsOpen = true;
    notifyAgentStatus(done);
    await settle();
    await settle();
    assert.deepEqual(shown, ['p3'], 'out of sight under Settings: shown');
    hidden = true;
    store.view.settingsOpen = false;
  });

  it("opening a pane closes its OS notifications", async () => {
    dismissNotificationsForPane('p3');
    await settle();
    assert.deepEqual(closed, ['p3']);
  });
});
