// @vitest-environment happy-dom
// The shell (ui/App.tsx) opened without a token: the token screen, signing in, and the reconnect
// banner, which never shows over the token screen. The tests run in order on one started app.
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { emit, store } from '../src/store.ts';
import { App, start } from '../src/ui/App.tsx';
import { state } from './contract.gen.ts';
import { mantine } from './render.ts'; // and the act environment

vi.mock('../src/ws.ts', () => ({ onWsMessage: () => () => {}, wsConnect: () => {}, wsSendWatch: () => {} }));

// The bridge: every request waits until the test answers it.
interface Req { url: string; answered: boolean; answer: (status: number, body: unknown) => void }
const reqs: Req[] = [];
vi.stubGlobal('fetch', (url: string) => new Promise((res) => {
  reqs.push({ url, answered: false, answer: (status, body) => res({ ok: status < 400, status, json: async () => body }) });
}));
async function answer(url: string, body: unknown, status = 200): Promise<void> {
  const r = reqs.find((q) => !q.answered && q.url === url);
  assert.ok(r, `no open request ${url}`);
  r.answered = true;
  await act(async () => { r.answer(status, body); await new Promise((res) => setTimeout(res, 20)); });
}
const $ = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
const banner = (): boolean => $('#reconnect-banner')!.classList.contains('visible');
async function signIn(token: string): Promise<void> {
  ($('#token-input') as HTMLInputElement).value = token;
  await act(async () => { ($('#token-form') as HTMLFormElement).requestSubmit(); });
}

describe('App without a token', () => {
  it('shows the token screen without the topbar, and no banner over it while the link is down', async () => {
    document.body.innerHTML = '<div id="app"></div><div id="modal-root"></div>';
    location.hash = '#/agents';
    start();
    await act(async () => { createRoot(document.getElementById('app')!).render(<StrictMode>{mantine(<App />)}</StrictMode>); });
    assert.ok($('#screen #screen-login'));
    assert.match($('.login-subtitle')!.textContent!, /Enter the access token/);
    assert.equal($('#topbar')!.style.display, 'none');
    await act(async () => emit()); // the link is down
    assert.equal(banner(), false);
  });

  it('a sign-in that fails, not with a 401, says so on the token screen', async () => {
    await signIn('tok-0');
    await answer('/api/state', {}, 500);
    assert.equal($('.login-subtitle')!.textContent, 'Could not connect. Check the token and try again.');
    assert.equal(banner(), false);
  });

  it('signing in routes off the token screen, and the banner shows there while the link is down', async () => {
    await signIn('tok-1');
    assert.equal(localStorage.getItem('herdr_token'), 'tok-1');
    await answer('/api/state', state);
    assert.ok($('#screen #screen-agents[data-ready]'));
    assert.equal($('#topbar')!.style.display, '');
    assert.equal(store.view.screen, 'agents');
    assert.equal(banner(), true);
  });
});
