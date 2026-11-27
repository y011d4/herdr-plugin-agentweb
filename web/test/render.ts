// Component tests without Testing Library: React 19's act + createRoot (happy-dom).
import { MantineProvider } from '@mantine/core';
import { Fragment, act, createElement, type ReactElement, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { theme } from '../src/theme.ts';
import type { TimelineItem } from '../src/transcript.ts';
import { ChatItem } from '../src/ui/ChatLog.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** node under Mantine's provider, as main.tsx has it, with env="test": no transitions, and a
 *  Mantine portal (a modal, a menu's dropdown) renders in place rather than into #modal-root. No
 *  <style> tags of its CSS variables and classes beside the app: happy-dom applies no CSS anyway. */
export const mantine = (node: ReactNode): ReactNode => createElement(MantineProvider,
  { theme, forceColorScheme: 'dark', env: 'test', withCssVariables: false, withGlobalClasses: false }, node);

export async function render(node: ReactNode): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => root.render(mantine(node)));
  return { container, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

/** Runs fn (a click, a submit…) and lets React finish what it set off. */
export const fire = (fn: () => void): Promise<void> => act(async () => fn());

/** matchMedia answering `query` as the test says (the returned function changes it and tells its
 *  listeners, as Mantine's useMediaQuery listens), every other query as before. happy-dom's own
 *  doesn't always tell a change. */
export function fakeMedia(query: string, matches: boolean): (on: boolean) => Promise<void> {
  const real = window.matchMedia.bind(window);
  const fns = new Set<(e: { matches: boolean }) => void>();
  vi.stubGlobal('matchMedia', (q: string) => (q !== query ? real(q) : {
    media: q,
    get matches() { return matches; },
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { fns.add(fn); },
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => { fns.delete(fn); },
  }));
  return (on) => act(async () => {
    matches = on;
    for (const fn of fns) fn({ matches: on });
  });
}

const happyDOM = (globalThis as unknown as { happyDOM: { waitUntilComplete(): Promise<void> } }).happyDOM;

/** With the test's fake timers (vi.useFakeTimers): lets the promises run, then happy-dom's own tasks
 *  (a hash change comes on a timer of its own, out of the fakes' reach), then ms pass on the app's
 *  timers; again, with no more time, while that changed the location (a route replacing its hash). */
export const settle = (ms = 20): Promise<void> => act(async () => {
  for (let href = '', first = true; href !== location.href; first = false) {
    href = location.href;
    await vi.advanceTimersByTimeAsync(0);
    await happyDOM.waitUntilComplete();
    await vi.advanceTimersByTimeAsync(first ? ms : 0);
  }
});

/** What `node` draws under Mantine's provider, as a node of its own to query (React, synchronously). */
export function drawn(node: ReactElement): HTMLElement {
  const el = document.createElement('div');
  flushSync(() => createRoot(el).render(mantine(node)));
  return el;
}

/** What a chat log (ui/ChatLog.tsx) draws for `items` (`home`: a Home's log). */
export const chatDom = (items: TimelineItem[], home = false): HTMLElement =>
  drawn(createElement(Fragment, null, ...items.map((item, i) => createElement(ChatItem, { key: i, item, home }))));
