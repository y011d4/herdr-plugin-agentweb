// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { getToken, setToken } from '../src/api.ts';
import { setAppState, store } from '../src/store.ts';
import type { AppState } from '../src/types.ts';
import { Settings } from '../src/ui/Settings.tsx';
import { fire, render } from './render.ts';

const state = (version: string) => ({ connected: true, herdr: { version, protocol: 22 }, workspaces: [] }) as unknown as AppState;
const value = (c: HTMLElement, label: string) =>
  [...c.querySelectorAll('.settings-row')].find((r) => r.querySelector('.settings-row-label')?.textContent === label)
    ?.querySelector('.settings-row-value')?.textContent;

describe('Settings', () => {
  beforeEach(() => { localStorage.clear(); setAppState(null); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('saves the notification toggle', async () => {
    const { container, unmount } = await render(<Settings toast={() => {}} onSignedOut={() => {}} />);
    const toggle = container.querySelector<HTMLInputElement>('#toggle-notif')!;
    assert.equal(toggle.checked, false);
    await fire(() => toggle.click());
    assert.equal(localStorage.getItem('herdr_notifications'), 'true');
    assert.equal(toggle.checked, true);
    await fire(() => toggle.click());
    assert.equal(localStorage.getItem('herdr_notifications'), 'false');
    await unmount();
  });

  it('signs out: drops the token and the State, then hands over once', async () => {
    setToken('tok');
    setAppState(state('0.9.5'));
    const onSignedOut = vi.fn();
    const { container, unmount } = await render(<Settings toast={() => {}} onSignedOut={onSignedOut} />);
    await fire(() => container.querySelector<HTMLElement>('#btn-clear-token')!.click());
    assert.equal(getToken(), null);
    assert.equal(localStorage.getItem('herdr_token'), null);
    assert.equal(store.appState, null);
    assert.equal(onSignedOut.mock.calls.length, 1);
    await unmount();
  });

  it('re-renders on a new State', async () => {
    setAppState(state('0.9.5'));
    const { container, unmount } = await render(<Settings toast={() => {}} onSignedOut={() => {}} />);
    assert.equal(value(container, 'herdr version'), '0.9.5');
    await fire(() => setAppState(state('0.9.6')));
    assert.equal(value(container, 'herdr version'), '0.9.6');
    await unmount();
  });

  it("shows the newest SW cache, again when a new SW takes over", async () => {
    let keys = ['herdr-yoicks-aaaaaaaa', 'other', 'herdr-yoicks-bbbbbbbb'];
    vi.stubGlobal('caches', { keys: async () => keys });
    const sw = new EventTarget();
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    const { container, unmount } = await render(<Settings toast={() => {}} onSignedOut={() => {}} />);
    const shown = () => container.querySelector('#app-version')!.textContent;
    assert.match(shown()!, /^0\.1\.0 \(dev\) cache bbbbbbbb$/);
    keys = ['herdr-yoicks-bbbbbbbb'];
    await fire(() => sw.dispatchEvent(new Event('controllerchange')));
    assert.match(shown()!, /^0\.1\.0 \(dev\) cache bbbbbbbb$/);
    keys = ['herdr-yoicks-cccccccc'];
    await fire(() => sw.dispatchEvent(new Event('controllerchange')));
    assert.match(shown()!, /cache cccccccc$/);
    await unmount();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  });
});
