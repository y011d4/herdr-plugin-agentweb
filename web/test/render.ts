// Component tests without Testing Library: React 19's act + createRoot (happy-dom).
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export async function render(node: ReactNode): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, unmount: () => act(async () => { root.unmount(); container.remove(); }) };
}

/** Runs fn (a click, a submit…) and lets React finish what it set off. */
export const fire = (fn: () => void): Promise<void> => act(async () => fn());
