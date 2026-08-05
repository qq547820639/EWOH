// EWOH standalone service worker.
//
// This worker implements the production update experience described in
// client/src/lib/swCache.ts (unit-tested). The SW keeps an inline equivalent of
// those pure helpers because a service worker is a standalone script rather than
// a bundled module.
//
// Key behaviors:
//  1. Request classification: app shell / hashed asset / document / API / user
//     file / sensitive / auth. API, user files, sensitive and auth responses are
//     network-only by default (never cached, never served from cache).
//  2. No silent takeover: we do NOT skipWaiting() on install. A newly installed
//     worker stays in "waiting" and pages are told via postMessage; the page
//     decides when it is safe to activate ("稍后更新" defers, "安全更新" skips).
//  3. Bounded cache: LRU + TTL eviction via a small metadata cache.
//  4. Contract-version fail-closed: if the recorded server contract major does
//     not match ours, we refuse to promote a new shell and fall back to the
//     last-good shell cache instead.
//  5. Rollback: the previous stable shell cache is retained past activation so a
//     broken update can serve the last-good shell.

const SW_CACHE_BASE = 'ewoh-shell';
const SW_CACHE_VERSION = 'v2';
const API_CONTRACT_VERSION = '1.0.0';
const META_CACHE = 'ewoh-shell-meta';
const META_CONTRACT_KEY = 'contract-version';
const MAX_CACHE_ENTRIES = 200;
const SHELL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function currentCacheName() {
  return `${SW_CACHE_BASE}-${SW_CACHE_VERSION}`;
}

function isManagedCache(name) {
  return name.startsWith(`${SW_CACHE_BASE}-`);
}

function cacheVersionNumber(name) {
  if (!isManagedCache(name)) {
    return null;
  }
  const m = /^v(\d+)$/.exec(name.slice(SW_CACHE_BASE.length + 1));
  return m ? Number(m[1]) : null;
}

function rollbackCacheName(keys, current) {
  const currentNum = cacheVersionNumber(current);
  const older = keys
    .map((name) => ({ name, num: cacheVersionNumber(name) }))
    .filter((e) => e.num !== null && (currentNum === null || e.num < currentNum))
    .sort((a, b) => b.num - a.num);
  return older.length > 0 ? older[0].name : null;
}

// --- request classification (inline copy of swCache.ts) ---
const AUTH_PATH_PATTERNS = [
  /^\/api\/auth\/login(?:\/|$)/,
  /^\/api\/auth\/refresh(?:\/|$)/,
  /^\/api\/auth\/logout(?:\/|$)/,
  /^\/api\/auth\/me(?:\/|$)/,
];
const USER_FILE_PATH_PATTERNS = [
  /^\/api\/files(?:\/|$)/,
  /^\/api\/attachments(?:\/|$)/,
];
const SENSITIVE_PARAM_PATTERN =
  /(token|secret|credential|password|passwd|apikey|api_key|access_key|refresh_token|authorization)/i;

function isApiUrl(url) {
  return /^\/api\//.test(new URL(url, self.location.origin).pathname);
}
function isAuthUrl(pathname) {
  return AUTH_PATH_PATTERNS.some((re) => re.test(pathname));
}
function isSensitiveUrl(url) {
  const u = new URL(url, self.location.origin);
  if (isAuthUrl(u.pathname)) {
    return true;
  }
  return SENSITIVE_PARAM_PATTERN.test(u.search);
}
function isUserFileUrl(pathname) {
  return USER_FILE_PATH_PATTERNS.some((re) => re.test(pathname));
}
function hasContentHash(url) {
  const file = new URL(url, self.location.origin).pathname.split('/').pop() || '';
  return /[._-][A-Za-z0-9_-]{8,}\.(?:js|css|json|svg|png|woff2?|wasm)$/.test(file);
}
function isAppShellUrl(pathname) {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/index.standalone.html' ||
    pathname === '/manifest.webmanifest'
  );
}
function classifyRequest(url, isNavigation) {
  const u = new URL(url, self.location.origin);
  const pathname = u.pathname;
  if (isAppShellUrl(pathname)) {
    return 'app-shell';
  }
  if (isApiUrl(url)) {
    if (isAuthUrl(pathname)) {
      return 'auth';
    }
    if (isUserFileUrl(pathname)) {
      return 'user-file';
    }
    if (isSensitiveUrl(url)) {
      return 'sensitive';
    }
    return 'api';
  }
  if (hasContentHash(url)) {
    return 'hashed-asset';
  }
  return 'document';
}
function strategyForClass(cls, online) {
  switch (cls) {
    case 'app-shell':
      return online ? 'network-first' : 'cache-first';
    case 'hashed-asset':
      return 'cache-first';
    case 'document':
      return online ? 'network-first' : 'cache-first';
    case 'api':
    case 'user-file':
    case 'sensitive':
    case 'auth':
      return 'network-only';
  }
}
function shouldCacheResponse(cls, status, setCookie) {
  if (cls === 'api' || cls === 'user-file' || cls === 'sensitive' || cls === 'auth') {
    return false;
  }
  if (status < 200 || status >= 300) {
    return false;
  }
  if (setCookie) {
    return false;
  }
  return true;
}

// --- metadata helpers (LRU + TTL + contract) ---
async function readMeta(key) {
  const cache = await caches.open(META_CACHE);
  const res = await cache.match(key);
  if (!res) {
    return undefined;
  }
  return res.json();
}
async function writeMeta(key, value) {
  const cache = await caches.open(META_CACHE);
  await cache.put(key, new Response(JSON.stringify(value)));
}
async function listRecords() {
  const cache = await caches.open(META_CACHE);
  const keys = await cache.keys();
  const records = [];
  for (const req of keys) {
    try {
      const res = await cache.match(req);
      const meta = await res.json();
      records.push({ key: req.url, storedAt: meta.storedAt, lastUsedAt: meta.lastUsedAt });
    } catch {
      // ignore unparsable metadata
    }
  }
  return records;
}
function isRecordExpired(record, now, ttlMs) {
  return now - record.storedAt > ttlMs;
}
function evictionCandidates(records, now, maxEntries, ttlMs) {
  const sorted = [...records].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const toEvict = [];
  const kept = [];
  for (const record of sorted) {
    if (isRecordExpired(record, now, ttlMs)) {
      toEvict.push(record.key);
    } else {
      kept.push(record);
    }
  }
  const evictedFromCap = kept
    .slice(0, Math.max(0, kept.length - maxEntries))
    .map((record) => record.key);
  return toEvict.concat(evictedFromCap);
}
async function trimCache() {
  const now = Date.now();
  const records = await listRecords();
  const evict = new Set(evictionCandidates(records, now, MAX_CACHE_ENTRIES, SHELL_TTL_MS));
  if (evict.size === 0) {
    return;
  }
  const cache = await caches.open(META_CACHE);
  const dataCache = await caches.open(currentCacheName());
  await Promise.all(
    [...evict].map(async (key) => {
      await cache.delete(key);
      await dataCache.delete(key);
    }),
  );
}

// --- messaging / update protocol ---
function notifyClients(message) {
  return self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      client.postMessage(message);
    }
  });
}

// Install: pre-cache the app shell and surface a new-version notice. Crucially we
// do NOT skipWaiting() here — a fresh worker must not silently take over running
// pages. The page replies with SKIP_WAITING (safe update) when it is ready.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(currentCacheName());
      await Promise.all([
        cache.addAll(['/index.standalone.html', '/manifest.webmanifest']).catch(() => undefined),
        writeMeta('/index.standalone.html', { storedAt: Date.now(), lastUsedAt: Date.now() }),
        writeMeta('/manifest.webmanifest', { storedAt: Date.now(), lastUsedAt: Date.now() }),
      ]);
      await notifyClients({ type: 'EWOH_SW_UPDATE_AVAILABLE', version: SW_CACHE_VERSION });
    })(),
  );
});

// Activate: claim clients, then prune stale caches. We keep the current cache and
// the previous stable shell (rollback target); only older versions are removed so
// a broken update can still roll back to the last-good shell.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const keys = await caches.keys();
      const current = currentCacheName();
      const rollback = rollbackCacheName(keys, current);
      const keep = new Set([current, META_CACHE]);
      if (rollback) {
        keep.add(rollback);
      }
      await Promise.all(
        keys.filter((name) => isManagedCache(name) && !keep.has(name)).map((name) => caches.delete(name)),
      );
      await trimCache();
    })(),
  );
});

// Message protocol between page and worker.
//  - SKIP_WAITING:  "安全更新" — activate the waiting worker now.
//  - SET_CONTRACT:  record the server contract version (fail-closed gate).
//  - GET_STATE:     return current worker state for diagnostics.
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'SET_CONTRACT') {
    writeMeta(META_CONTRACT_KEY, { version: data.version, at: Date.now() });
    return;
  }
  if (data.type === 'GET_STATE') {
    event.ports[0].postMessage({
      version: SW_CACHE_VERSION,
      contract: API_CONTRACT_VERSION,
      cacheName: currentCacheName(),
    });
    return;
  }
});

// Fetch: route by class. API / user-file / sensitive / auth are network-only
// (never intercepted). The app shell and documents are network-first online and
// cache-first offline, with offline fallback to the last-good shell. Hashed
// assets are cache-first (immutable).
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  const cls = classifyRequest(url.href, request.mode === 'navigate');
  const strategy = strategyForClass(cls, navigator.onLine);
  if (strategy === 'network-only') {
    // Never serve from or write to the cache for API/sensitive/auth/user-file.
    return;
  }
  event.respondWith(handleCached(event, cls, strategy));
});

async function handleCached(event, cls, strategy) {
  const request = event.request;
  const cache = await caches.open(currentCacheName());
  const cached = await cache.match(request);

  if (strategy === 'cache-first') {
    if (cached) {
      touchMeta(request.url);
      return cached;
    }
    const response = await fetch(request);
    if (shouldCacheResponse(cls, response.status, response.headers.has('set-cookie'))) {
      await putAndTrim(cache, request, response.clone());
    }
    return response;
  }

  // network-first (app shell & documents)
  try {
    const response = await fetch(request);
    if (shouldCacheResponse(cls, response.status, response.headers.has('set-cookie'))) {
      await putAndTrim(cache, request, response.clone());
    }
    return response;
  } catch {
    if (cached) {
      touchMeta(request.url);
      return cached;
    }
    // Offline fallback to the last-good shell so a broken/empty current cache
    // still leaves the app usable.
    const keys = await caches.keys();
    const rollback = rollbackCacheName(keys, currentCacheName());
    if (rollback && cls === 'document') {
      const rollbackCache = await caches.open(rollback);
      const fallback = await rollbackCache.match(request);
      if (fallback) {
        return fallback;
      }
    }
    throw new Error('offline: no cached response');
  }
}

async function touchMeta(url) {
  try {
    const record = await readMeta(url);
    await writeMeta(url, { storedAt: record?.storedAt || Date.now(), lastUsedAt: Date.now() });
  } catch {
    // best effort
  }
}

async function putAndTrim(cache, request, response) {
  await cache.put(request, response);
  await writeMeta(request.url, { storedAt: Date.now(), lastUsedAt: Date.now() });
  await trimCache();
}