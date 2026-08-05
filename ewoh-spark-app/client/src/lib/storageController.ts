import type { SimpleStore } from './offlineDb';

/**
 * Storage controller for the offline IndexedDB vault.
 *
 * Wave W6 "PWA 与离线队列生产化" — production hardening for the offline store:
 *  - schema versioning + ordered migrations   (`migrate`)
 *  - capacity / quota-warning                  (`isQuotaLow`)
 *  - TTL expiry cleanup                        (`purgeExpired`)
 *  - corruption detection + recovery           (`recover`)
 *
 * The controller is functional and injectable: every store is passed in as a
 * `SimpleStore`, so the pure logic is unit-testable with in-memory stores
 * (IndexedDB is not available in the Jest node environment). The live
 * controller is wired into `useOfflineWorkbench` against the real offline DB.
 */

/** Declared schema version of the offline vault. Bump on the next breaking
 *  store change and add a corresponding  (from, to) migration. */
export const SCHEMA_VERSION = 1;

/** Key under which the current schema version is persisted. */
export const SCHEMA_VERSION_KEY = 'schema-version';

/** Default total capacity budget for non-attachment offline data (bytes). */
export const DEFAULT_CAPACITY_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Fraction of capacity at/beyond which we surface a quota warning. */
export const QUOTA_WARNING_THRESHOLD = 0.8;

/** Default retention for append-only audit log entries (30 days). */
export const DEFAULT_AUDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Default retention for unsynced attachments (7 days). */
export const DEFAULT_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface VersionRecord {
  key: string; // SCHEMA_VERSION_KEY
  value: unknown;
  updatedAt: string;
}

/**
 * Whether current usage has reached the quota-warning threshold. Pure.
 */
export function isQuotaLow(
  usageBytes: number,
  capacityBytes: number = DEFAULT_CAPACITY_BYTES,
  threshold: number = QUOTA_WARNING_THRESHOLD,
): boolean {
  if (capacityBytes <= 0) {
    return false;
  }
  return usageBytes / capacityBytes >= threshold;
}

/**
 * Whether a timestamp is older than `ttlMs` relative to `now`. Pure.
 */
export function isExpired(
  timestampMs: number,
  now: number,
  ttlMs: number,
): boolean {
  return now - timestampMs > ttlMs;
}

/**
 * Deletes every entry in `store` whose timestamp is older than `ttlMs`.
 * Returns the number of purged entries. Entries without a parseable timestamp
 * are left untouched (conservative — we never drop data we can't date).
 */
export async function purgeExpiredEntries<T extends { key: string }>(
  store: SimpleStore<T>,
  timestampOf: (item: T) => number | undefined,
  opts: { ttlMs: number; now?: number },
): Promise<number> {
  const now = opts.now ?? Date.now();
  const items = await store.getAll();
  let purged = 0;
  for (const item of items) {
    const ts = timestampOf(item);
    if (ts === undefined || Number.isNaN(ts)) {
      continue;
    }
    if (isExpired(ts, now, opts.ttlMs)) {
      await store.delete(item.key);
      purged += 1;
    }
  }
  return purged;
}

export interface SchemaMigration {
  from: number;
  to: number;
  migrate: () => Promise<void>;
}

/**
 * Applies pending schema migrations in dependency order. Reads the persisted
 * schema version, then runs every migration whose `from` matches the current
 * version and advances to `to`. Returns the final schema version.
 */
export async function runMigrations(
  versionStore: SimpleStore<VersionRecord>,
  migrations: SchemaMigration[],
): Promise<number> {
  const record = await versionStore.get(SCHEMA_VERSION_KEY);
  let current = typeof record?.value === 'number' ? record.value : 0;
  const sorted = [...migrations].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  );
  for (const migration of sorted) {
    if (migration.from !== current || migration.to <= current) {
      continue;
    }
    await migration.migrate();
    current = migration.to;
    await versionStore.put({
      key: SCHEMA_VERSION_KEY,
      value: current,
      updatedAt: new Date().toISOString(),
    });
  }
  return current;
}

export interface CorruptionReport {
  corruptKeys: string[];
  recoveredKeys: string[];
  failedKeys: string[];
}

/**
 * Scans a store for structurally-invalid entries and repairs them. An entry is
 * "corrupt" when `isValid` returns false. `repair` returns a fixed entry to
 * write back, or `null` to drop the entry (treated as unrecoverable). Returns a
 * per-key report. Never throws for a single bad entry — failures are collected.
 */
export async function healStore<T extends { key: string }>(
  store: SimpleStore<T>,
  isValid: (item: T) => boolean,
  repair: (item: T) => T | null,
): Promise<CorruptionReport> {
  const report: CorruptionReport = {
    corruptKeys: [],
    recoveredKeys: [],
    failedKeys: [],
  };
  const items = await store.getAll();
  for (const item of items) {
    if (isValid(item)) {
      continue;
    }
    report.corruptKeys.push(item.key);
    try {
      const repaired = repair(item);
      if (repaired) {
        await store.put(repaired);
        report.recoveredKeys.push(item.key);
      } else {
        await store.delete(item.key);
        report.failedKeys.push(item.key);
      }
    } catch {
      report.failedKeys.push(item.key);
    }
  }
  return report;
}

export interface ExpiryTarget {
  store: SimpleStore<{ key: string }>;
  timestampOf: (item: { key: string }) => number | undefined;
  ttlMs: number;
}

export interface RecoveryTarget {
  store: SimpleStore<{ key: string }>;
  isValid: (item: { key: string }) => boolean;
  repair: (item: { key: string }) => { key: string } | null;
}

export interface StorageControllerOptions {
  versionStore: SimpleStore<VersionRecord>;
  migrations?: SchemaMigration[];
  capacityBytes?: number;
  quotaThreshold?: number;
  usageBytes?: () => Promise<number>;
  expiryTargets?: ExpiryTarget[];
  recoveryTargets?: RecoveryTarget[];
  now?: () => number;
}

export interface StorageController {
  schemaVersion: number;
  capacityBytes: number;
  migrate(): Promise<number>;
  isQuotaLow(): Promise<boolean>;
  purgeExpired(): Promise<number>;
  recover(): Promise<CorruptionReport>;
}

/**
 * Builds a storage controller bound to concrete (injected) stores. Pure logic
 * is delegated to the functions above so it stays unit-testable.
 */
export function createStorageController(
  options: StorageControllerOptions,
): StorageController {
  const capacityBytes = options.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
  const quotaThreshold = options.quotaThreshold ?? QUOTA_WARNING_THRESHOLD;
  return {
    schemaVersion: SCHEMA_VERSION,
    capacityBytes,
    async migrate() {
      return runMigrations(options.versionStore, options.migrations ?? []);
    },
    async isQuotaLow() {
      if (!options.usageBytes) {
        return false;
      }
      const usage = await options.usageBytes();
      return isQuotaLow(usage, capacityBytes, quotaThreshold);
    },
    async purgeExpired() {
      let purged = 0;
      for (const target of options.expiryTargets ?? []) {
        purged += await purgeExpiredEntries(
          target.store,
          target.timestampOf,
          { ttlMs: target.ttlMs, now: options.now ? options.now() : undefined },
        );
      }
      return purged;
    },
    async recover() {
      const combined: CorruptionReport = {
        corruptKeys: [],
        recoveredKeys: [],
        failedKeys: [],
      };
      for (const target of options.recoveryTargets ?? []) {
        const result = await healStore(
          target.store,
          target.isValid,
          target.repair,
        );
        combined.corruptKeys.push(...result.corruptKeys);
        combined.recoveredKeys.push(...result.recoveredKeys);
        combined.failedKeys.push(...result.failedKeys);
      }
      return combined;
    },
  };
}