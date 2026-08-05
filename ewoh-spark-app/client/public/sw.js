// EWOH standalone service worker.
//
// Cache versioning: bump SW_CACHE_VERSION on any breaking change to the shell
// asset set or the fetch strategy. This mirrors the pure helpers in
// client/src/lib/swCache.ts (unit-tested); the SW keeps an inline equivalent
// because a service worker is a standalone script rather than a bundled module.
const SW_CACHE_BASE = 'ewoh-shell';
const SW_CACHE_VERSION = 'v2';

function currentCacheName() {
  return `${SW_CACHE_BASE}-${SW_CACHE_VERSION}`;
}

function isManagedCache(name) {
  return name.startsWith(`${SW_CACHE_BASE}-`);
}

// Safe update strategy: install the new version immediately, then in `activate`
// claim clients and delete stale caches from older versions. Requests served by
// the previous cache keep working until the new version is activated, so a
// broken update can still serve the last-good shell.
const CACHE_NAME = currentCacheName();

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        cache
          .addAll(['/index.standalone.html', '/manifest.webmanifest'])
          .catch(() => undefined),
      ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      // Remove stale caches from older versions to avoid unbounded growth.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((name) => isManagedCache(name) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      const fetched = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached || fetched;
    })(),
  );
});