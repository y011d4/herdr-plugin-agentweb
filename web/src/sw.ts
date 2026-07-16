/**
 * sw.ts — Service Worker for Herdr Agent Web PWA
 *
 * Strategy:
 *   - Static assets (index.html, app.js, ansi.js, style.css, manifest, icons):
 *     cache-first, served from versioned cache.
 *   - /api/* and /ws*: network passthrough, never cached.
 *   - On activate: delete caches from previous versions.
 */

// The webworker lib declares `self` as WorkerGlobalScope; cast to the narrower
// service-worker type so service-worker-specific APIs type-check correctly.
const sw = self as unknown as ServiceWorkerGlobalScope;

// Bump on every release that changes any static asset: cached assets are only
// refreshed when the service worker itself changes.
const CACHE_VERSION = 'herdr-agentweb-v61';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/ansi.js',
  '/transcript.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Activate immediately without waiting for old clients to unload
  sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  // Take control of all open clients immediately
  sw.clients.claim();
});

sw.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);

  // Pass through API and WebSocket upgrade requests — never cache
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname === '/healthz') {
    return; // let browser handle normally
  }

  // Network-first for static assets: always fetch the latest build when online
  // and only fall back to the cache offline. Cache-first (the previous strategy)
  // pinned stale code across reloads when the service worker itself didn't change
  // — the app then kept running an old bundle even after a new deploy.
  event.respondWith(
    fetch(event.request).then((response) => {
      // Cache successful GET responses for offline use. Never cache a URL that
      // carries a query string (e.g. /?token=…): the bearer token would be
      // persisted in Cache Storage and survive "clear token & sign out".
      if (response.ok && event.request.method === 'GET' && !url.search) {
        const responseClone = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, responseClone));
      }
      return response;
    }).catch(() => caches.match(event.request).then((cached) => {
      if (cached) return cached;
      throw new Error('offline and not cached');
    }))
  );
});

// Handle notification click: focus the app and navigate to the pane
sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const paneId = event.notification.tag;
  // navigate() in the app assigns the value to location.hash, so an existing
  // client needs the bare hash (#/pane/…) — passing "/#/pane/…" would yield
  // "#/#/pane/…". A newly opened window needs the full path instead.
  const targetHash = paneId ? `#/pane/${encodeURIComponent(paneId)}` : '#/agents';
  const targetUrl = `/${targetHash}`;

  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'navigate', url: targetHash });
          return;
        }
      }
      if (sw.clients.openWindow) {
        return sw.clients.openWindow(targetUrl);
      }
    })
  );
});
