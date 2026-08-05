import {
  createStorageController,
  DEFAULT_CAPACITY_BYTES,
  DEFAULT_AUDIT_TTL_MS,
  healStore,
  isExpired,
  isQuotaLow,
  purgeExpiredEntries,
  runMigrations,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  type VersionRecord,
} from './storageController';
import type { SimpleStore } from './offlineDb';

function createMemoryStore<T extends { key: string }>(): SimpleStore<T> & {
  values: Map<string, T>;
} {
  const values = new Map<string, T>();
  return {
    values,
    async getAll() {
      return Array.from(values.values());
    },
    async get(key) {
      return values.get(key);
    },
    async put(value) {
      values.set(value.key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async clear() {
      values.clear();
    },
    async count() {
      return values.size;
    },
  };
}

interface AuditItem {
  key: string;
  at: string;
}

describe('storageController', () => {
  describe('schema versioning + migrations', () => {
    it('exposes the declared schema version', () => {
      const controller = createStorageController({
        versionStore: createMemoryStore<VersionRecord>(),
      });
      expect(controller.schemaVersion).toBe(SCHEMA_VERSION);
      expect(controller.capacityBytes).toBe(DEFAULT_CAPACITY_BYTES);
    });

    it('runs migrations in order and persists the version', async () => {
      const version = createMemoryStore<VersionRecord>();
      const ran: string[] = [];
      const versionAfter = await runMigrations(version, [
        { from: 0, to: 1, migrate: async () => { ran.push('0->1'); } },
        { from: 1, to: 2, migrate: async () => { ran.push('1->2'); } },
      ]);
      expect(versionAfter).toBe(2);
      expect(ran).toEqual(['0->1', '1->2']);
      expect(version.values.get(SCHEMA_VERSION_KEY)?.value).toBe(2);
    });

    it('skips already-applied migrations on a following run', async () => {
      const version = createMemoryStore<VersionRecord>();
      const ran: string[] = [];
      const first = await runMigrations(version, [
        { from: 0, to: 1, migrate: async () => { ran.push('0->1'); } },
      ]);
      expect(first).toBe(1);
      const second = await runMigrations(version, [
        { from: 0, to: 1, migrate: async () => { ran.push('0->1'); } },
      ]);
      expect(second).toBe(1);
      expect(ran).toEqual(['0->1']);
    });

    it('does not run unrelated migrations out of order', async () => {
      const version = createMemoryStore<VersionRecord>();
      const ran: string[] = [];
      await runMigrations(version, [
        { from: 1, to: 2, migrate: async () => { ran.push('1->2'); } },
        { from: 0, to: 1, migrate: async () => { ran.push('0->1'); } },
      ]);
      expect(ran).toEqual(['0->1', '1->2']);
    });

    it('controller.migrate delegates to runMigrations', async () => {
      const version = createMemoryStore<VersionRecord>();
      let applied = false;
      const controller = createStorageController({
        versionStore: version,
        migrations: [
          { from: 0, to: SCHEMA_VERSION, migrate: async () => { applied = true; } },
        ],
      });
      expect(await controller.migrate()).toBe(SCHEMA_VERSION);
      expect(applied).toBe(true);
    });
  });

  describe('quota / capacity warning', () => {
    it('flags usage at or above the threshold', () => {
      expect(isQuotaLow(0, 1000)).toBe(false);
      expect(isQuotaLow(799, 1000)).toBe(false);
      expect(isQuotaLow(800, 1000)).toBe(true);
      expect(isQuotaLow(1000, 1000)).toBe(true);
    });

    it('guards against zero capacity', () => {
      expect(isQuotaLow(500, 0)).toBe(false);
    });

    it('controller.isQuotaLow uses the injected usage and capacity', async () => {
      const controller = createStorageController({
        versionStore: createMemoryStore<VersionRecord>(),
        capacityBytes: 1000,
        usageBytes: async () => 900,
      });
      expect(await controller.isQuotaLow()).toBe(true);
      const low = createStorageController({
        versionStore: createMemoryStore<VersionRecord>(),
        capacityBytes: 1000,
        usageBytes: async () => 100,
      });
      expect(await low.isQuotaLow()).toBe(false);
    });

    it('returns false when no usage source is provided', async () => {
      const controller = createStorageController({
        versionStore: createMemoryStore<VersionRecord>(),
      });
      expect(await controller.isQuotaLow()).toBe(false);
    });
  });

  describe('expiry cleanup', () => {
    it('isExpired is a pure time comparison', () => {
      expect(isExpired(1000, 2000, 500)).toBe(true);
      expect(isExpired(1500, 2000, 500)).toBe(false);
      expect(isExpired(1500, 2000, 600)).toBe(false);
    });

    it('purges only entries older than the TTL and leaves undated entries', async () => {
      const now = 1_000_000;
      const store = createMemoryStore<AuditItem>();
      await store.put({ key: 'old', at: new Date(now - 1000).toISOString() });
      await store.put({ key: 'recent', at: new Date(now - 100).toISOString() });
      await store.put({ key: 'undated', at: 'not-a-date' });

      const purged = await purgeExpiredEntries(store, (item) => {
        const ms = Date.parse(item.at);
        return Number.isNaN(ms) ? undefined : ms;
      }, { ttlMs: 500, now });

      expect(purged).toBe(1);
      expect(store.values.has('old')).toBe(false);
      expect(store.values.has('recent')).toBe(true);
      expect(store.values.has('undated')).toBe(true);
    });

    it('controller.purgeExpired aggregates across multiple targets', async () => {
      const audit = createMemoryStore<AuditItem>();
      await audit.put({ key: 'a1', at: new Date(0).toISOString() });
      const attachments = createMemoryStore<{ key: string; createdAt: string }>();
      await attachments.put({ key: 'x.png', createdAt: new Date(0).toISOString() });

      const controller = createStorageController({
        versionStore: createMemoryStore<VersionRecord>(),
        now: () => Date.now(),
        expiryTargets: [
          {
            store: audit,
            timestampOf: (item) => Date.parse((item as AuditItem).at),
            ttlMs: DEFAULT_AUDIT_TTL_MS,
          },
          {
            store: attachments,
            timestampOf: (item) =>
              Date.parse((item as unknown as { createdAt: string }).createdAt),
            ttlMs: 1,
          },
        ],
      });

      const purged = await controller.purgeExpired();
      expect(purged).toBe(2);
      expect(audit.values.size).toBe(0);
      expect(attachments.values.size).toBe(0);
    });
  });

  describe('corruption recovery', () => {
    it('repairs repairable entries and drops unrepairable ones', async () => {
      const store = createMemoryStore<{ key: string; status?: string }>();
      await store.put({ key: 'ok', status: 'local' });
      await store.put({ key: 'bad-status', status: 'not-a-real-status' });
      await store.put({ key: 'beyond-repair' });

      const report = await healStore(
        store,
        (item) => item.status === 'local' || item.status === 'synced',
        (item) => {
          if (item.key === 'bad-status') {
            return { ...item, status: 'local' };
          }
          return null; // drop
        },
      );

      expect(report.corruptKeys).toEqual(['bad-status', 'beyond-repair']);
      expect(report.recoveredKeys).toEqual(['bad-status']);
      expect(report.failedKeys).toEqual(['beyond-repair']);
      expect(store.values.get('bad-status')?.status).toBe('local');
      expect(store.values.has('beyond-repair')).toBe(false);
    });

    it('controller.recover aggregates recovery across targets', async () => {
      const pending = createMemoryStore<{ key: string; status?: string }>();
      await pending.put({ key: 'p1', status: 'local' });
      await pending.put({ key: 'p2', status: '???' });

      const controller = createStorageController({
        versionStore: createMemoryStore<VersionRecord>(),
        recoveryTargets: [
          {
            store: pending,
            isValid: (item: { key: string; status?: string }) =>
              item.status === 'local' || item.status === 'failed',
            repair: (item: { key: string; status?: string }) =>
              item.status === '???' ? { ...item, status: 'local' } : item,
          },
        ],
      });

      const report = await controller.recover();
      expect(report.recoveredKeys).toEqual(['p2']);
      expect(report.corruptKeys).toEqual(['p2']);
      expect(pending.values.get('p2')?.status).toBe('local');
    });
  });
});