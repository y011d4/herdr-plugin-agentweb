// @vitest-environment happy-dom
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { act, useEffect } from 'react';
import { store } from '../src/store.ts';
import { mountScreen, setConnIndicator, setLegacyScreen } from '../src/ui/mount.tsx';
import './render.ts'; // act environment

const shell = () => {
  document.body.innerHTML = '<header id="topbar"><div id="topbar-left"></div><div id="topbar-title"></div>' +
    '<div id="conn-dot"></div><div id="topbar-right"></div></header><div id="reconnect-banner"></div><main id="screen"></main>';
};
const bannerShown = () => document.getElementById('reconnect-banner')!.classList.contains('visible');

describe('mount', () => {
  it('shows the reconnect banner on leaving the token screen while the link is down', async () => {
    shell();
    await act(async () => mountScreen('token', <p />));
    setConnIndicator(false); // the sign-in's first state: herdr or the WS is down
    assert.equal(bannerShown(), false);
    act(() => setLegacyScreen('agents', ''));
    assert.equal(bannerShown(), true);
    await act(async () => mountScreen('token', <p />));
    assert.equal(bannerShown(), false);
    await act(async () => mountScreen('settings', <p />));
    assert.equal(bannerShown(), true);
    setConnIndicator(true);
    assert.equal(bannerShown(), false);
  });

  it('setLegacyScreen unmounts a mounted React screen: its effect cleanup runs once', async () => {
    shell();
    let effects = 0;
    let cleanups = 0;
    function Probe() {
      useEffect(() => { effects++; return () => { cleanups++; }; }, []);
      return <p id="probe">react</p>;
    }
    await act(async () => mountScreen('settings', <Probe />, { topbar: { title: 'Title', left: <button id="back">B</button> } }));
    assert.ok(document.querySelector('#screen #probe'));
    assert.equal(document.getElementById('topbar-title')!.textContent, 'Title');
    assert.ok(document.querySelector('#topbar-left #back'));
    assert.equal(store.view.screen, 'settings');
    assert.equal(effects - cleanups, 1); // StrictMode runs it twice in dev: one is live
    const before = cleanups;

    act(() => setLegacyScreen('agents', '<div id="legacy"></div>'));
    assert.equal(cleanups - before, 1);
    assert.equal(effects - cleanups, 0);
    assert.equal(document.getElementById('screen')!.innerHTML, '<div id="legacy"></div>');
    assert.equal(store.view.screen, 'agents');
  });
});
