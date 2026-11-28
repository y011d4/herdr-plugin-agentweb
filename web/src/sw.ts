/**
 * sw.ts — Service Worker for Yoicks PWA
 *
 * Strategy:
 *   - Static assets (index.html, the hashed JS and CSS, manifest, icons):
 *     network-first; a versioned cache answers offline, and for an error response
 *     when it has the URL (an old build's asset, asked for mid-deploy).
 *   - /api/* and /ws*: network passthrough, never cached.
 *   - On activate: delete caches from previous versions.
 */

// The webworker lib declares `self` as WorkerGlobalScope; cast to the narrower
// service-worker type so service-worker-specific APIs type-check correctly.
const sw = self as unknown as ServiceWorkerGlobalScope;

// Filled in by the build (vite.config.ts, sw()): every file it produced, and a cache
// name hashed from their contents, so a change to any of them installs a new service
// worker and replaces the cached assets. Never edit or bump these by hand.
declare const __SW_VERSION__: string;
declare const __SW_ASSETS__: string[];
const CACHE_VERSION = __SW_VERSION__;
const STATIC_ASSETS = __SW_ASSETS__;

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
      if (response.ok) return response;
      // A page of the previous build can ask the new bridge for its old hashed asset
      // names (a 404) mid-deploy: serve the cached copy when there is one.
      return caches.match(event.request).then((cached) => cached ?? response);
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
  // "#/#/pane/…". A newly opened window needs the full path instead. A tag that
  // is a hash (a failed Claude Code check's: #/settings) is where it opens.
  const targetHash = !paneId ? '#/home' : paneId.startsWith('#/') ? paneId : `#/pane/${encodeURIComponent(paneId)}`;
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
