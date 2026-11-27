/** main.tsx — the entry (index.html): starts the shell and draws it into #app, over index.html's
 *  static first paint, under Mantine's provider (theme.ts; dark only); registers the service
 *  worker (only a build has a sw.js). */
import { MantineProvider } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { theme } from './theme.ts';
import { App, start } from './ui/App.tsx';

start();
createRoot(document.getElementById('app')!).render(
  <StrictMode><MantineProvider theme={theme} forceColorScheme="dark"><App /></MantineProvider></StrictMode>,
);

if (import.meta.env.PROD && window.isSecureContext && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW registration failure is non-fatal
  });
}
