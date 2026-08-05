import {
  cacheName,
  currentCacheName,
  isManagedCache,
  staleCacheNames,
  SW_CACHE_BASE,
  SW_CACHE_VERSION,
} from './swCache';

describe('swCache (pure cache-versioning helpers)', () => {
  it('builds versioned cache names', () => {
    expect(cacheName('ewoh-shell', 'v2')).toBe('ewoh-shell-v2');
    expect(currentCacheName()).toBe(`${SW_CACHE_BASE}-${SW_CACHE_VERSION}`);
  });

  it('recognizes managed cache names only under the base prefix', () => {
    expect(isManagedCache('ewoh-shell-v1')).toBe(true);
    expect(isManagedCache('ewoh-shell-v2')).toBe(true);
    expect(isManagedCache('other-v1')).toBe(false);
    expect(isManagedCache('index')).toBe(false);
  });

  it('extracts stale (non-current) managed caches while ignoring foreign ones', () => {
    const keys = [
      'ewoh-shell-v1',
      'ewoh-shell-v2',
      'other-app-v9',
      'index',
    ];
    expect(staleCacheNames(keys)).toEqual(['ewoh-shell-v1']);
  });

  it('returns no stale caches when only the current version exists', () => {
    expect(staleCacheNames([currentCacheName()])).toEqual([]);
    expect(staleCacheNames([])).toEqual([]);
  });
});