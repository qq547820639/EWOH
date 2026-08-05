/**
 * Pure helpers for the service-worker cache versioning scheme.
 *
 * The service worker (`public/sw.js`) uses this naming scheme to version its
 * shell cache and to delete stale caches on `activate`. The helpers are pure so
 * they can be unit-tested; the SW keeps an inline, equivalent copy because a
 * service worker is a standalone script (not a bundled module).
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