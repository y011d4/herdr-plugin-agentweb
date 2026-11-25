// @vitest-environment happy-dom
import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { apiGet, onUnauthorized, setToken } from '../src/api.ts';
import { mountScreen, setConnIndicator } from '../src/ui/mount.tsx';
import { Token } from '../src/ui/Token.tsx';
import { fire, render } from './render.ts';

describe('Token', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('submits the entered token, trimmed, and never a blank one', async () => {
    const onToken = vi.fn();
    const { container, unmount } = await render(<Token onToken={onToken} />);
    assert.match(container.querySelector('.login-subtitle')!.textContent!, /Enter the access token/);
    const input = container.querySelector<HTMLInputElement>('#token-input')!;
    const form = container.querySelector<HTMLFormElement>('#token-form')!;
    input.value = '   ';
    await fire(() => form.requestSubmit());
    assert.equal(onToken.mock.calls.length, 0);
    input.value = '  tok-1 ';
    await fire(() => form.requestSubmit());
    assert.deepEqual(onToken.mock.calls, [['tok-1']]);
    await unmount();
  });

  it('a 401 shows the token screen with its message, no topbar and no reconnect banner', async () => {
    document.body.innerHTML = '<header id="topbar"><div id="topbar-left"></div><div id="topbar-title"></div>' +
      '<div id="conn-dot"></div><div id="topbar-right"></div></header><div id="reconnect-banner"></div><main id="screen"></main>';
    const message = 'Session expired or token invalid. Please enter your token.';
    onUnauthorized(() => mountScreen('token', <Token message={message} onToken={() => {}} />));
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 401 }));
    setToken('stale');
    await act(async () => { await apiGet('/api/state').catch(() => {}); });
    assert.equal(document.querySelector('#screen #screen-login .login-subtitle')?.textContent, message);
    assert.equal(localStorage.getItem('herdr_token'), null);
    assert.equal(document.getElementById('topbar')!.style.display, 'none');
    setConnIndicator(false); // the socket drops after the 401
    assert.equal(document.getElementById('reconnect-banner')!.classList.contains('visible'), false);
  });
});
