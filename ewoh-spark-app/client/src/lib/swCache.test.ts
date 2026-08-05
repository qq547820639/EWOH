import {
  cacheName,
  currentCacheName,
  isManagedCache,
  staleCacheNames,
  SW_CACHE_BASE,
  SW_CACHE_VERSION,
  classifyRequest,
  strategyForClass,
  shouldCacheResponse,
  type CacheClass,
  isRecordExpired,
  evictionCandidates,
  type CacheRecord,
  parseVersion,
  isContractCompatible,
  shouldServeContract,
  cacheVersionNumber,
  rollbackCacheName,
  API_CONTRACT_VERSION,
  isApiUrl,
  isSensitiveUrl,
  pruneCacheNames,
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

describe('swCache request classification', () => {
  it.each<[string, CacheClass]>([
    // app shell
    ['http://x/', 'app-shell'],
    ['http://x/index.html', 'app-shell'],
    ['http://x/index.standalone.html', 'app-shell'],
    ['http://x/manifest.webmanifest', 'app-shell'],
    // hashed assets
    ['http://x/assets/index-H2k3x9AbCdEf.js', 'hashed-asset'],
    ['http://x/assets/App-9f8a7b6c5d4e3f.css', 'hashed-asset'],
    // plain documents
    ['http://x/login', 'document'],
    ['http://x/static/about.html', 'document'],
    // business API (network-only)
    ['http://x/api/dashboard/overview', 'api'],
    // user files (network-only)
    ['http://x/api/files/download/abc', 'user-file'],
    ['http://x/api/attachments/xyz', 'user-file'],
    // auth endpoints (network-only)
    ['http://x/api/auth/login', 'auth'],
    ['http://x/api/auth/refresh', 'auth'],
    ['http://x/api/auth/me', 'auth'],
    // sensitive (query param hint)
    ['http://x/api/secrets?token=abc', 'sensitive'],
  ])('classifies %s as %s', (url, expected) => {
    expect(classifyRequest(url)).toBe(expected);
  });

  it('isApiUrl only matches /api/ paths', () => {
    expect(isApiUrl('/api/work/gates')).toBe(true);
    expect(isApiUrl('/command-center')).toBe(false);
  });

  it('isSensitiveUrl flags auth paths and token-bearing queries', () => {
    expect(isSensitiveUrl('/api/auth/refresh')).toBe(true);
    expect(isSensitiveUrl('/api/foo?access_token=abc')).toBe(true);
    expect(isSensitiveUrl('/api/dashboard/overview')).toBe(false);
  });
});

describe('swCache strategy (API & sensitive are network-only by default)', () => {
  it('keeps API/user-file/sensitive/auth network-only regardless of connectivity', () => {
    for (const cls of ['api', 'user-file', 'sensitive', 'auth'] as CacheClass[]) {
      expect(strategyForClass(cls, true)).toBe('network-only');
      expect(strategyForClass(cls, false)).toBe('network-only');
    }
  });

  it('app shell is network-first online and cache-first offline', () => {
    expect(strategyForClass('app-shell', true)).toBe('network-first');
    expect(strategyForClass('app-shell', false)).toBe('cache-first');
  });

  it('hashed assets are cache-first (immutable)', () => {
    expect(strategyForClass('hashed-asset', true)).toBe('cache-first');
    expect(strategyForClass('hashed-asset', false)).toBe('cache-first');
  });

  it('documents are network-first online so reloads pick up a newer shell', () => {
    expect(strategyForClass('document', true)).toBe('network-first');
    expect(strategyForClass('document', false)).toBe('cache-first');
  });

  it('never writes API/sensitive/auth/user-file responses into the cache', () => {
    for (const cls of ['api', 'user-file', 'sensitive', 'auth'] as CacheClass[]) {
      expect(shouldCacheResponse(cls, 200)).toBe(false);
    }
  });

  it('caches shell/hashed-asset/document 2xx without Set-Cookie, drops others', () => {
    expect(shouldCacheResponse('app-shell', 200)).toBe(true);
    expect(shouldCacheResponse('hashed-asset', 200)).toBe(true);
    expect(shouldCacheResponse('hashed-asset', 404)).toBe(false);
    expect(shouldCacheResponse('document', 500)).toBe(false);
    expect(shouldCacheResponse('app-shell', 200, true)).toBe(false);
  });
});

describe('swCache capacity / expiry (LRU bound + TTL)', () => {
  const now = 1_000_000;
  const rec = (
    key: string,
    storedAt: number,
    lastUsedAt: number,
  ): CacheRecord => ({ key, storedAt, lastUsedAt });

  it('flags records past their TTL as expired', () => {
    expect(isRecordExpired(rec('a', now - 1000, now), now, 500)).toBe(true);
    expect(isRecordExpired(rec('a', now - 100, now), now, 500)).toBe(false);
  });

  it('evicts expired records first, oldest-first', () => {
    const records = [
      rec('expired-a', now - 1000, now - 1000),
      rec('expired-b', now - 900, now - 900),
      rec('fresh', now - 100, now - 100),
    ];
    expect(evictionCandidates(records, { now, ttlMs: 500, maxEntries: 10 })).toEqual([
      'expired-a',
      'expired-b',
    ]);
  });

  it('evicts the least-recently-used tail beyond the capacity cap', () => {
    const records = [
      rec('r1', now - 100, now - 100),
      rec('r2', now - 100, now - 80),
      rec('r3', now - 100, now - 60),
      rec('r4', now - 100, now - 40),
    ];
    expect(evictionCandidates(records, { now, maxEntries: 2, ttlMs: 100_000 })).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('keeps everything when under both the TTL and the cap', () => {
    const records = [rec('a', now - 10, now - 10), rec('b', now - 5, now - 5)];
    expect(evictionCandidates(records, { now, maxEntries: 10, ttlMs: 1000 })).toEqual([]);
  });
});

describe('swCache contract-version compatibility (fail-closed)', () => {
  it('parses semantic versions', () => {
    expect(parseVersion('1.0.0')).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseVersion('2.3.4-rc.1')).toEqual({ major: 2, minor: 3, patch: 4 });
    expect(parseVersion('nope')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('is compatible within the same major version', () => {
    expect(isContractCompatible('1.0.0', '1.2.5')).toBe(true);
    expect(isContractCompatible('1.0.0', '1.0.0')).toBe(true);
  });

  it('fails closed on major-version mismatch or malformed input', () => {
    expect(isContractCompatible('1.0.0', '2.0.0')).toBe(false);
    expect(isContractCompatible('1.0.0', 'garbage')).toBe(false);
    expect(isContractCompatible('1.0.0', '')).toBe(false);
  });

  it('shouldServeContract fails closed when the server version is absent', () => {
    expect(shouldServeContract('1.0.0', '1.0.0')).toBe(true);
    expect(shouldServeContract('1.0.0', null)).toBe(false);
    expect(shouldServeContract('1.0.0', undefined)).toBe(false);
    expect(shouldServeContract('1.0.0', '2.0.0')).toBe(false);
    expect(shouldServeContract('1.0.0', '')).toBe(false);
  });

  it('exposes the current client contract version', () => {
    expect(parseVersion(API_CONTRACT_VERSION)).toEqual({ major: 1, minor: 0, patch: 0 });
  });
});

describe('swCache rollback to last-good shell', () => {
  it('extracts the version number from a managed cache name', () => {
    expect(cacheVersionNumber('ewoh-shell-v3')).toBe(3);
    expect(cacheVersionNumber('ewoh-shell-v2')).toBe(2);
    expect(cacheVersionNumber('other-app-v9')).toBeNull();
    expect(cacheVersionNumber('index')).toBeNull();
  });

  it('rolls back to the closest older managed cache', () => {
    const keys = ['ewoh-shell-v1', 'ewoh-shell-v2', 'ewoh-shell-v3', 'other-app-v9'];
    expect(rollbackCacheName(keys, 'ewoh-shell-v3')).toBe('ewoh-shell-v2');
  });

  it('returns null when no older managed cache exists', () => {
    expect(rollbackCacheName(['ewoh-shell-v2', 'other-app-v9'], 'ewoh-shell-v2')).toBeNull();
    expect(rollbackCacheName([], 'ewoh-shell-v2')).toBeNull();
  });

  it('prunes caches older than the previous version across a multi-version upgrade (C6-8)', () => {
    // v0 / v1 / v2 all present, current is v2: activate keeps v2 (current) and
    // v1 (rollback target), and prunes only v0. Mirrors sw.js activate cleanup.
    const keys = ['ewoh-shell-v0', 'ewoh-shell-v1', 'ewoh-shell-v2', 'other-app-v9'];
    expect(pruneCacheNames(keys, 'ewoh-shell', 'v2')).toEqual(['ewoh-shell-v0']);
  });

  it('keeps the immediate previous version and prunes nothing older than it', () => {
    // v1 -> v2 upgrade: only v1 exists as older, it is the rollback target, so
    // nothing is pruned.
    expect(pruneCacheNames(['ewoh-shell-v1', 'ewoh-shell-v2'], 'ewoh-shell', 'v2')).toEqual([]);
  });

  it('prunes nothing when only the current version exists', () => {
    expect(pruneCacheNames(['ewoh-shell-v2'], 'ewoh-shell', 'v2')).toEqual([]);
    expect(pruneCacheNames([], 'ewoh-shell', 'v2')).toEqual([]);
  });
});