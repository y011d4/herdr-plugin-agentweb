// @vitest-environment happy-dom
// The shell (app.ts) routing between panes, over the real screens, a fake bridge and socket.
import { it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { act } from 'react';
import { store } from '../src/store.ts';
import type { WsMessage } from '../src/types.ts';
import { read, state, transcript } from './contract.gen.ts';
import './render.ts'; // the act environment

// The socket: each watch sent records the pane and the mode it was sent for.
const watches: string[] = [];
vi.mock('../src/ws.ts', () => ({
  onWsMessage: (_fn: (msg: WsMessage) => void) => () => {},
  wsConnect: () => {},
  wsSendWatch: () => { watches.push(`${store.view.activePaneId}:${store.view.paneViewMode}`); },
}));

// The bridge: every request waits until the test answers it.
interface Req { url: string; answered: boolean; answer: (body: unknown) => void }
const reqs: Req[] = [];
vi.stubGlobal('fetch', (url: string) => new Promise((res) => {
  reqs.push({ url, answered: false, answer: (body) => res({ ok: true, status: 200, json: async () => body }) });
}));
/** Answers every open request whose URL contains `match` (StrictMode starts a screen's view twice). */
async function answer(match: string, body: unknown): Promise<void> {
  const open = reqs.filter((q) => !q.answered && q.url.includes(match));
  assert.ok(open.length, `no open request ${match}`);
  await act(async () => {
    for (const r of open) { r.answered = true; r.answer(body); }
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

it('a pane opened from a chat pane has its terminal watched from the start', async () => {
  document.body.innerHTML = '<div id="app"><header id="topbar"><div id="topbar-left"></div><div id="topbar-title"></div><div id="conn-dot"></div>' +
    '<div id="topbar-right"></div></header><div id="reconnect-banner"></div><main id="screen"></main><div id="toast-container"></div></div><div id="modal-root"></div>';
  localStorage.setItem('herdr_token', 't');
  location.hash = '#/pane/p1';
  await import('../src/app.ts');
  await act(async () => { document.dispatchEvent(new Event('DOMContentLoaded')); });
  await answer('/api/state', state);
  await answer('/api/panes/p1/read?source=visible', read[1]);
  await answer('/api/panes/p1/transcript', transcript[0]); // claude's transcript: chat
  assert.equal(watches.at(-1), 'p1:chat');

  await act(async () => { location.hash = '#/pane/p2'; await new Promise((r) => setTimeout(r, 20)); }); // a shell: terminal only
  await answer('/api/panes/p2/read?source=visible', read[1]);
  await answer('/api/panes/p2/transcript', { available: false });
  assert.ok(document.getElementById('terminal-output')!.style.display !== 'none', 'the terminal is shown');
  assert.deepEqual(watches.filter((w) => w.startsWith('p2:')), ['p2:terminal']);
});
