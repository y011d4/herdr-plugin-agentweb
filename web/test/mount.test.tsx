// @vitest-environment happy-dom
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { act, useEffect } from 'react';
import { store } from '../src/store.ts';
import { mountScreen, setLegacyScreen } from '../src/ui/mount.tsx';
import './render.ts'; // act environment

describe('mount', () => {
  it('setLegacyScreen unmounts a mounted React screen: its effect cleanup runs once', async () => {
    document.body.innerHTML = '<header id="topbar"><div id="topbar-left"></div><div id="topbar-title"></div>' +
      '<div id="conn-dot"></div><div id="topbar-right"></div></header><div id="reconnect-banner"></div><main id="screen"></main>';
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
