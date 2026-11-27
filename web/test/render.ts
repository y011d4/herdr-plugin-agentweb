// Component tests without Testing Library: React 19's act + createRoot (happy-dom).
import { MantineProvider } from '@mantine/core';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { theme } from '../src/theme.ts';

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
