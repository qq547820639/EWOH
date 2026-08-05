/**
 * Pure helpers for the service-worker caching + update experience.
 *
 * The service worker (`public/sw.js`) uses this naming scheme to version its
 * shell cache, classify requests, choose a fetch strategy, bound the cache with
 * LRU + expiry, fail closed on contract-version mismatch, and roll back to the
 * last-good shell. The helpers are pure so they can be unit-tested; the SW keeps
 * an inline, equivalent copy because a service worker is a standalone script
 * (not a bundled module).
 */

export const SW_CACHE_BASE = 'ewoh-shell';
export const SW_CACHE_VERSION = 'v2';

/** Joins base + version into a cache name, e.g. `ewoh-shell-v2`. */
export function cacheName(
  base: string = SW_CACHE_BASE,
  version: string = SW_CACHE_VERSION,
): string {
  return `${base}-${version}`;
}

/** The cache name for the current version. */
export function currentCacheName(
  base: string = SW_CACHE_BASE,
  version: string = SW_CACHE_VERSION,
): string {
  return cacheName(base, version);
}

/** Whether a cache name belongs to this managed scheme. */
export function isManagedCache(
  name: string,
  base: string = SW_CACHE_BASE,
): boolean {
  return name.startsWith(`${base}-`);
}

/** Names of managed caches that are NOT the current version (stale). */
export function staleCacheNames(
  keys: string[],
  base: string = SW_CACHE_BASE,
  version: string = SW_CACHE_VERSION,
): string[] {
  const current = cacheName(base, version);
  return keys.filter((name) => isManagedCache(name, base) && name !== current);
}

/**
 * Managed cache names to prune during activation. The current version and the
 * previous stable shell (rollback target) are retained; only versions older
 * than the previous one are removed. Mirrors the SW `activate` cleanup so the
 * multi-version upgrade policy is pure and unit-testable.
 */
export function pruneCacheNames(
  keys: string[],
  base: string = SW_CACHE_BASE,
  version: string = SW_CACHE_VERSION,
): string[] {
  const current = cacheName(base, version);
  const rollback = rollbackCacheName(keys, current, base);
  const keep = new Set([current]);
  if (rollback) {
    keep.add(rollback);
  }
  return keys.filter((name) => isManagedCache(name, base) && !keep.has(name));
}

// ---------------------------------------------------------------------------
// Request classification
// ---------------------------------------------------------------------------

/**
 * The semantic class of a same-origin request. Drives the caching strategy:
 *  - app-shell:      the HTML shell + manifest (cache-first)
 *  - hashed-asset:   static asset whose filename carries a content hash
 *                    (cache-first, effectively immutable)
 *  - document:       navigation HTML without a content hash (network-first)
 *  - api:            backend business endpoints under /api/** (network-only)
 *  - user-file:      user-uploaded/downloaded files (network-only)
 *  - sensitive:      responses carrying PII / tokens / secrets (network-only)
 *  - auth:           authentication endpoints (login/refresh/logout) (network-only)
 */
export type CacheClass =
  | 'app-shell'
  | 'hashed-asset'
  | 'document'
  | 'api'
  | 'user-file'
  | 'sensitive'
  | 'auth';

/** Paths that are always treated as auth/sensitive and never cached. */
const AUTH_PATH_PATTERNS: RegExp[] = [
  /^\/api\/auth\/login(?:\/|$)/,
  /^\/api\/auth\/refresh(?:\/|$)/,
  /^\/api\/auth\/logout(?:\/|$)/,
  /^\/api\/auth\/me(?:\/|$)/,
];

/** Query params that mark a request as sensitive (token/key/secret/credential). */
const SENSITIVE_PARAM_PATTERN = /(token|secret|credential|password|passwd|apikey|api_key|access_key|refresh_token|authorization)/i;

/** User-file endpoints (upload/download) are never cached. */
const USER_FILE_PATH_PATTERNS: RegExp[] = [
  /^\/api\/files(?:\/|$)/,
  /^\/api\/attachments(?:\/|$)/,
];

export function isApiUrl(url: string): boolean {
  return /^\/api\//.test(new URL(url, 'http://x').pathname);
}

export function isAuthUrl(pathname: string): boolean {
  return AUTH_PATH_PATTERNS.some((re) => re.test(pathname));
}

export function isSensitiveUrl(url: string): boolean {
  const u = new URL(url, 'http://x');
  if (isAuthUrl(u.pathname)) {
    return true;
  }
  return SENSITIVE_PARAM_PATTERN.test(u.search);
}

export function isUserFileUrl(pathname: string): boolean {
  return USER_FILE_PATH_PATTERNS.some((re) => re.test(pathname));
}

/** Whether the asset filename carries a content hash (e.g. `index-H2k3x9.js`). */
export function hasContentHash(url: string): boolean {
  const u = new URL(url, 'http://x');
  const file = u.pathname.split('/').pop() ?? '';
  // Common hashed-filename shapes: `name.<hash>.ext`, `name-<hash>.ext`
  return /[._-][A-Za-z0-9_-]{8,}\.(?:js|css|json|svg|png|woff2?|wasm)$/.test(file);
}

export function isAppShellUrl(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/index.standalone.html' ||
    pathname === '/manifest.webmanifest'
  );
}

/** Semantic classification of a same-origin request URL. */
export function classifyRequest(
  url: string,
  isNavigation: boolean = false,
): CacheClass {
  const u = new URL(url, 'http://x');
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
  if (!isNavigation && /\.(?:html|htm)$/.test(pathname)) {
    return 'document';
  }
  return 'document';
}

// ---------------------------------------------------------------------------
// Cache strategy
// ---------------------------------------------------------------------------

export type CacheStrategy =
  | 'cache-first'
  | 'network-first'
  | 'network-only'
  | 'stale-while-revalidate';

/**
 * Strategy per request class. API, user files, sensitive and auth responses are
 * network-only by default (never served from or written to the cache). The
 * app shell is cache-first; hashed assets are cache-first (immutable); plain
 * documents are network-first so a reload can pick up a newer shell offline.
 */
export function strategyForClass(
  cls: CacheClass,
  online: boolean = true,
): CacheStrategy {
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

/**
 * Whether a network response may be written into the cache for the given class.
 * API/sensitive/auth/user-file responses are never cached. Non-2xx and
 * Set-Cookie (auth) responses are never cached either.
 */
export function shouldCacheResponse(
  cls: CacheClass,
  status: number,
  setCookie: boolean = false,
): boolean {
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

// ---------------------------------------------------------------------------
// Capacity / expiry (LRU bound + TTL)
// ---------------------------------------------------------------------------

export interface CacheRecord {
  key: string;
  storedAt: number;
  lastUsedAt: number;
  size?: number;
}

/** Default max entries in the shell cache (bounded, not unbounded). */
export const DEFAULT_MAX_ENTRIES = 200;
/** Default TTL for the app shell (14 days). */
export const DEFAULT_SHELL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Whether a record is past its TTL. */
export function isRecordExpired(
  record: CacheRecord,
  now: number,
  ttlMs: number = DEFAULT_SHELL_TTL_MS,
): boolean {
  return now - record.storedAt > ttlMs;
}

/**
 * Computes the record keys to evict to keep the cache bounded:
 *  - every expired record first (LRU tie-break on lastUsedAt), then
 *  - the least-recently-used records beyond `maxEntries`.
 * Never evicts the most-recently-used records while under the cap. Returns keys
 * in eviction order (oldest-first).
 */
export function evictionCandidates(
  records: CacheRecord[],
  opts: { maxEntries?: number; now?: number; ttlMs?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = opts.ttlMs ?? DEFAULT_SHELL_TTL_MS;
  const sorted = [...records].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const toEvict: string[] = [];
  const kept: CacheRecord[] = [];
  for (const record of sorted) {
    if (isRecordExpired(record, now, ttlMs)) {
      toEvict.push(record.key);
    } else {
      kept.push(record);
    }
  }
  // Keep the most-recently-used within the cap; evict the LRU tail beyond it.
  const keep = kept.slice(-Math.max(0, maxEntries));
  const evictedFromCap = kept
    .slice(0, Math.max(0, kept.length - maxEntries))
    .map((record) => record.key);
  return [...toEvict, ...evictedFromCap];
}

// ---------------------------------------------------------------------------
// Contract-version compatibility (fail-closed)
// ---------------------------------------------------------------------------

/** The API contract version the current client/SW is built against. */
export const API_CONTRACT_VERSION = '1.0.0';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Parses a semantic version string; returns null when malformed. */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(raw.trim());
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/**
 * Whether the server contract version is compatible with this client. Backward
 * compatible within the same major version; a major bump is treated as
 * incompatible (fail-closed). Malformed == incompatible.
 */
export function isContractCompatible(
  client: string,
  server: string,
): boolean {
  const c = parseVersion(client);
  const s = parseVersion(server);
  if (!c || !s) {
    return false;
  }
  return c.major === s.major;
}

/**
 * Fail-closed gate: should the SW/UI proceed with the cached shell when the
 * server contract version is unknown/absent? Returns true only when the server
 * version is explicitly compatible. Unknown/absent/mismatched => false.
 */
export function shouldServeContract(
  client: string,
  server: string | null | undefined,
): boolean {
  if (!server) {
    return false;
  }
  return isContractCompatible(client, server);
}

// ---------------------------------------------------------------------------
// Rollback to last-good shell
// ---------------------------------------------------------------------------

/** Extracts the raw version tail from a managed cache name, e.g. `v2` -> 2. */
export function cacheVersionNumber(
  name: string,
  base: string = SW_CACHE_BASE,
): number | null {
  if (!isManagedCache(name, base)) {
    return null;
  }
  const tail = name.slice(base.length + 1);
  const m = /^v(\d+)$/.exec(tail);
  return m ? Number(m[1]) : null;
}

/**
 * Returns the name of the previous managed cache (the "last-good shell") to roll
 * back to, or null when none exists. The closest older version is preferred.
 */
export function rollbackCacheName(
  keys: string[],
  current: string,
  base: string = SW_CACHE_BASE,
): string | null {
  const currentNum = cacheVersionNumber(current, base);
  const older = keys
    .map((name) => ({ name, num: cacheVersionNumber(name, base) }))
    .filter(
      (entry): entry is { name: string; num: number } =>
        entry.num !== null && (currentNum === null || entry.num < currentNum),
    )
    .sort((a, b) => b.num - a.num);
  return older[0]?.name ?? null;
}