// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { clearToasts, dismissNotificationsForPane, getToasts, notifyAgentStatus } from '../src/notify.ts';
import { store } from '../src/store.ts';
import type { WsAgentStatusMessage } from '../src/types.ts';
import { messages } from './contract.gen.ts';

// the bridge's agent_status pushes: p3 working → done (labelled), p9 unknown → blocked (no labels)
const [done, blocked] = messages.filter((m): m is WsAgentStatusMessage => m.type === 'agent_status');
const working: WsAgentStatusMessage = { ...done, from: 'idle', to: 'working' };

let hidden: boolean;
let shown: Array<{ title: string; body?: string; tag?: string }>;
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
      showNotification: async (title: string, o: NotificationOptions) => { shown.push({ title, body: o.body, tag: o.tag }); },
      getNotifications: async ({ tag }: { tag: string }) => [{ close: () => closed.push(tag) }],
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => reg } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (document as { hidden?: boolean }).hidden;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });

  it('blocked/done while hidden, on and permitted: an OS notification tagged with the pane', async () => {
    notifyAgentStatus(done);
    notifyAgentStatus(blocked);
    await settle();
    assert.deepEqual(shown, [
      { title: 'Claude Code done', body: 'repo-wt-feat / feat', tag: 'p3' },
      { title: 'Agent blocked', body: ' / ', tag: 'p9' },
    ]);
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

  it('a sticky toast per push, not for the pane on screen', () => {
    store.view.activePaneId = 'p3';
    notifyAgentStatus(done);
    notifyAgentStatus(working);
    assert.deepEqual(getToasts(), []);
    store.view.activePaneId = null;
    notifyAgentStatus(working);
    notifyAgentStatus(done);
    assert.deepEqual(getToasts().map((t) => [t.title, t.body, t.paneId]), [
      ['Claude Code: idle → working', 'repo-wt-feat / feat', 'p3'],
      ['Claude Code done', 'repo-wt-feat / feat', 'p3'],
    ]);
    getToasts()[1].onclick!();
    assert.equal(location.hash, '#/pane/p3');
  });

  it("opening a pane closes its OS notifications", async () => {
    dismissNotificationsForPane('p3');
    await settle();
    assert.deepEqual(closed, ['p3']);
  });
});
