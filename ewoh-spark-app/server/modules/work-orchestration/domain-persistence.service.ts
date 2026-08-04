import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  ewohEvidenceMetadata,
  ewohFactoryReplicationSessions,
  ewohGitSyncState,
  ewohHandoffs,
  ewohIdempotencyKeys,
  ewohResourceLocks,
} from '@server/database/schema';
import { STANDALONE_ROOT_DATABASE } from '@server/database/request-database-context';

export interface ResourceLockRecord {
  resourceId: string;
  holder: string;
  purpose?: string;
  acquiredAt: string;
  expiresAt?: string;
  active: boolean;
  renewedAt?: string;
  version?: number;
}

export interface HandoffRecord {
  handoffId: string;
  fromActor: string;
  toActor: string;
  scope: string;
  contextPack?: string;
  acceptance?: string;
  openQuestions?: string[];
  state: string;
  createdAt: string;
  acceptedAt?: string;
  closedAt?: string;
}

export interface GitSyncStateRecord {
  syncId: string;
  lastSyncAt?: string;
  lastSyncSha?: string;
  lastSyncStatus?: string;
  conflicts?: unknown;
}

export interface EvidenceMetadataRecord {
  evidenceId: string;
  workItemId?: string;
  commitSha?: string;
  envFingerprint?: string;
  verifier?: string;
  producedAt?: string;
  expiresAt?: string;
  result?: string;
  checksum?: string;
}

export interface FactoryReplicationSessionRecord {
  sessionId: string;
  orgId?: string;
  factoryId: string;
  step?: string;
  status: string;
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  outputEvidenceId?: string;
}

/**
 * DB-backed persistence for EWOH domain state (resource locks, idempotency keys,
 * handoffs, git-sync state, evidence metadata, factory replication sessions).
 *
 * Provides: optimistic-lock version columns, unique constraints, idempotency keys,
 * transaction atomicity, and lock expiry / lease / release / holder-recovery.
 * This is the F61-02 durable source of truth; in-process Maps must not replace it.
 */
@Injectable()
export class DomainPersistenceService {
  constructor(
    @Inject(STANDALONE_ROOT_DATABASE)
    private readonly db: PostgresJsDatabase<Record<string, never>>,
  ) {}

  // ---------------------------------------------------------------------------
  // Resource locks
  // ---------------------------------------------------------------------------

  /**
   * Atomically acquire a lock against a (orgId, resourceKey) unique key.
   * Throws ConflictException when an active, non-expired lock is held.
   */
  async acquireLock(input: {
    orgId: string;
    resourceKey: string;
    resourceId: string;
    holder: string;
    purpose?: string;
    expiresAt?: string;
  }): Promise<ResourceLockRecord> {
    const now = new Date();
    const existing = await this.db
      .select()
      .from(ewohResourceLocks)
      .where(
        and(
          eq(ewohResourceLocks.orgId, input.orgId),
          eq(ewohResourceLocks.resourceKey, input.resourceKey),
        ),
      );

    const active = existing.find(
      (row) => row.active && !this.isExpired(row.expiresAt),
    );
    if (active) {
      throw new ConflictException(
        `Resource ${input.resourceKey} is locked by ${active.holder}`,
      );
    }

    // Reuse the row when a stale/expired lock exists (holder recovery), else insert.
    if (existing.length > 0) {
      const target = existing[0];
      const [updated] = await this.db
        .update(ewohResourceLocks)
        .set({
          holder: input.holder,
          purpose: input.purpose,
          resourceId: input.resourceId,
          acquiredAt: now,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          renewedAt: now,
          active: true,
          version: sql`${ewohResourceLocks.version} + 1`,
        })
        .where(
          and(
            eq(ewohResourceLocks.id, target.id),
            eq(ewohResourceLocks.version, target.version),
          ),
        )
        .returning();
      if (!updated) {
        throw new ConflictException(
          `Resource ${input.resourceKey} lock changed concurrently`,
        );
      }
      return this.toLockRecord(updated);
    }

    const [inserted] = await this.db
      .insert(ewohResourceLocks)
      .values({
        orgId: input.orgId,
        resourceKey: input.resourceKey,
        resourceId: input.resourceId,
        holder: input.holder,
        purpose: input.purpose,
        acquiredAt: now,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        renewedAt: now,
        active: true,
        version: 1,
      })
      .returning();
    if (!inserted) {
      throw new ConflictException(`Resource ${input.resourceKey} locked concurrently`);
    }
    return this.toLockRecord(inserted);
  }

  async releaseLock(input: {
    orgId: string;
    resourceKey: string;
    holder: string;
    isGlobalAdmin?: boolean;
  }): Promise<{ released: boolean; holder: string }> {
    const [row] = await this.db
      .select()
      .from(ewohResourceLocks)
      .where(
        and(
          eq(ewohResourceLocks.orgId, input.orgId),
          eq(ewohResourceLocks.resourceKey, input.resourceKey),
        ),
      );
    if (!row || !row.active) return { released: false, holder: '' };
    if (row.holder !== input.holder && !input.isGlobalAdmin) {
      throw new ConflictException(
        'only the lock holder or a global admin can release this lock',
      );
    }
    await this.db
      .update(ewohResourceLocks)
      .set({ active: false, version: sql`${ewohResourceLocks.version} + 1` })
      .where(
        and(
          eq(ewohResourceLocks.id, row.id),
          eq(ewohResourceLocks.version, row.version),
        ),
      );
    return { released: true, holder: row.holder };
  }

  async renewLock(input: {
    orgId: string;
    resourceKey: string;
    holder: string;
    expiresAt?: string;
  }): Promise<ResourceLockRecord | null> {
    const [row] = await this.db
      .select()
      .from(ewohResourceLocks)
      .where(
        and(
          eq(ewohResourceLocks.orgId, input.orgId),
          eq(ewohResourceLocks.resourceKey, input.resourceKey),
        ),
      );
    if (!row || !row.active || row.holder !== input.holder) return null;
    const now = new Date();
    const [updated] = await this.db
      .update(ewohResourceLocks)
      .set({
        renewedAt: now,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : row.expiresAt,
        version: sql`${ewohResourceLocks.version} + 1`,
      })
      .where(
        and(
          eq(ewohResourceLocks.id, row.id),
          eq(ewohResourceLocks.version, row.version),
        ),
      )
      .returning();
    return updated ? this.toLockRecord(updated) : null;
  }

  async getLock(orgId: string, resourceKey: string): Promise<ResourceLockRecord | null> {
    const [row] = await this.db
      .select()
      .from(ewohResourceLocks)
      .where(
        and(
          eq(ewohResourceLocks.orgId, orgId),
          eq(ewohResourceLocks.resourceKey, resourceKey),
        ),
      );
    return row ? this.toLockRecord(row) : null;
  }

  async listActiveLocks(orgId: string): Promise<ResourceLockRecord[]> {
    const rows = await this.db
      .select()
      .from(ewohResourceLocks)
      .where(
        and(eq(ewohResourceLocks.orgId, orgId), eq(ewohResourceLocks.active, true)),
      )
      .orderBy(desc(ewohResourceLocks.acquiredAt));
    return rows.map((row) => this.toLockRecord(row));
  }

  /**
   * Release all locks whose expiresAt has passed (holder crashed / lease expired).
   * Returns the number of recovered locks.
   */
  async recoverExpiredLocks(orgId: string): Promise<number> {
    const result = await this.db
      .update(ewohResourceLocks)
      .set({ active: false, version: sql`${ewohResourceLocks.version} + 1` })
      .where(
        and(
          eq(ewohResourceLocks.orgId, orgId),
          eq(ewohResourceLocks.active, true),
          gte(ewohResourceLocks.expiresAt, new Date(0)),
          sql`${ewohResourceLocks.expiresAt} <= now()`,
        ),
      )
      .returning({ id: ewohResourceLocks.id });
    return result.length;
  }

  // ---------------------------------------------------------------------------
  // Idempotency keys
  // ---------------------------------------------------------------------------

  async getIdempotency<T>(scope: string, key: string): Promise<T | undefined> {
    const [row] = await this.db
      .select()
      .from(ewohIdempotencyKeys)
      .where(
        and(
          eq(ewohIdempotencyKeys.scope, scope),
          eq(ewohIdempotencyKeys.idempotencyKey, key),
        ),
      );
    return row?.response as T | undefined;
  }

  /**
   * Atomically record an idempotency key. Returns the stored response if the key
   * already exists (dedup), otherwise the provided response.
   */
  async setIdempotency<T>(scope: string, key: string, response: T): Promise<T> {
    const existing = await this.getIdempotency<T>(scope, key);
    if (existing !== undefined) return existing;
    await this.db
      .insert(ewohIdempotencyKeys)
      .values({ scope, idempotencyKey: key, response: response as unknown })
      .onConflictDoNothing();
    const stored = await this.getIdempotency<T>(scope, key);
    return stored as T;
  }

  // ---------------------------------------------------------------------------
  // Handoffs
  // ---------------------------------------------------------------------------

  async createHandoff(record: {
    handoffId: string;
    fromActor: string;
    toActor: string;
    scope: string;
    contextPack?: string;
    acceptance?: string;
    openQuestions?: string[];
  }): Promise<HandoffRecord> {
    const now = new Date();
    await this.db.insert(ewohHandoffs).values({
      handoffId: record.handoffId,
      fromActor: record.fromActor,
      toActor: record.toActor,
      scope: record.scope,
      contextPack: record.contextPack,
      acceptance: record.acceptance,
      openQuestions: record.openQuestions ?? [],
      state: 'open',
      createdAt: now,
    });
    return {
      handoffId: record.handoffId,
      fromActor: record.fromActor,
      toActor: record.toActor,
      scope: record.scope,
      contextPack: record.contextPack,
      acceptance: record.acceptance,
      openQuestions: record.openQuestions ?? [],
      state: 'open',
      createdAt: now.toISOString(),
    };
  }

  async updateHandoffStatus(
    handoffId: string,
    state: 'accepted' | 'rejected' | 'closed',
  ): Promise<HandoffRecord | null> {
    const now = new Date();
    const update: Record<string, unknown> = { state };
    if (state === 'accepted') update.acceptedAt = now;
    if (state === 'closed') update.closedAt = now;
    const [updated] = await this.db
      .update(ewohHandoffs)
      .set(update)
      .where(eq(ewohHandoffs.handoffId, handoffId))
      .returning();
    return updated ? this.toHandoffRecord(updated) : null;
  }

  async getHandoff(handoffId: string): Promise<HandoffRecord | null> {
    const [row] = await this.db
      .select()
      .from(ewohHandoffs)
      .where(eq(ewohHandoffs.handoffId, handoffId));
    return row ? this.toHandoffRecord(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Git sync state
  // ---------------------------------------------------------------------------

  async upsertGitSyncState(record: GitSyncStateRecord): Promise<void> {
    const now = new Date();
    await this.db
      .insert(ewohGitSyncState)
      .values({
        syncId: record.syncId,
        lastSyncAt: record.lastSyncAt ? new Date(record.lastSyncAt) : now,
        lastSyncSha: record.lastSyncSha,
        lastSyncStatus: record.lastSyncStatus,
        conflicts: record.conflicts ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: ewohGitSyncState.syncId,
        set: {
          lastSyncAt: record.lastSyncAt ? new Date(record.lastSyncAt) : now,
          lastSyncSha: record.lastSyncSha,
          lastSyncStatus: record.lastSyncStatus,
          conflicts: record.conflicts ?? null,
          updatedAt: now,
        },
      });
  }

  // ---------------------------------------------------------------------------
  // Evidence metadata
  // ---------------------------------------------------------------------------

  async upsertEvidenceMetadata(record: EvidenceMetadataRecord): Promise<void> {
    const now = new Date();
    await this.db
      .insert(ewohEvidenceMetadata)
      .values({
        evidenceId: record.evidenceId,
        workItemId: record.workItemId,
        commitSha: record.commitSha,
        envFingerprint: record.envFingerprint,
        verifier: record.verifier,
        producedAt: record.producedAt ? new Date(record.producedAt) : null,
        expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
        result: record.result,
        checksum: record.checksum,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: ewohEvidenceMetadata.evidenceId,
        set: {
          workItemId: record.workItemId,
          commitSha: record.commitSha,
          envFingerprint: record.envFingerprint,
          verifier: record.verifier,
          producedAt: record.producedAt ? new Date(record.producedAt) : null,
          expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
          result: record.result,
          checksum: record.checksum,
          updatedAt: now,
        },
      });
  }

  // ---------------------------------------------------------------------------
  // Factory replication sessions
  // ---------------------------------------------------------------------------

  async createReplicationSession(input: {
    sessionId: string;
    orgId?: string;
    factoryId: string;
    step?: string;
  }): Promise<FactoryReplicationSessionRecord> {
    const now = new Date();
    await this.db.insert(ewohFactoryReplicationSessions).values({
      sessionId: input.sessionId,
      orgId: input.orgId,
      factoryId: input.factoryId,
      step: input.step,
      status: 'running',
      progress: 0,
      startedAt: now,
      createdAt: now,
    });
    return {
      sessionId: input.sessionId,
      orgId: input.orgId,
      factoryId: input.factoryId,
      step: input.step,
      status: 'running',
      progress: 0,
      startedAt: now.toISOString(),
    };
  }

  async updateReplicationSession(
    sessionId: string,
    patch: {
      step?: string;
      status?: string;
      progress?: number;
      finishedAt?: string;
      outputEvidenceId?: string;
    },
  ): Promise<FactoryReplicationSessionRecord | null> {
    const [updated] = await this.db
      .update(ewohFactoryReplicationSessions)
      .set({
        step: patch.step,
        status: patch.status,
        progress: patch.progress,
        finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : undefined,
        outputEvidenceId: patch.outputEvidenceId,
      })
      .where(eq(ewohFactoryReplicationSessions.sessionId, sessionId))
      .returning();
    return updated ? this.toReplicationSessionRecord(updated) : null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private isExpired(expiresAt: Date | string | null): boolean {
    if (!expiresAt) return false;
    const time =
      expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt);
    if (!Number.isFinite(time)) return false;
    return time <= Date.now();
  }

  private toLockRecord(row: Record<string, any>): ResourceLockRecord {
    return {
      resourceId: row.resourceId,
      holder: row.holder,
      purpose: row.purpose ?? undefined,
      acquiredAt:
        row.acquiredAt instanceof Date
          ? row.acquiredAt.toISOString()
          : new Date(row.acquiredAt).toISOString(),
      expiresAt: row.expiresAt
        ? row.expiresAt instanceof Date
          ? row.expiresAt.toISOString()
          : new Date(row.expiresAt).toISOString()
        : undefined,
      renewedAt: row.renewedAt
        ? row.renewedAt instanceof Date
          ? row.renewedAt.toISOString()
          : new Date(row.renewedAt).toISOString()
        : undefined,
      active: row.active,
      version: row.version,
    };
  }

  private toHandoffRecord(row: Record<string, any>): HandoffRecord {
    return {
      handoffId: row.handoffId,
      fromActor: row.fromActor,
      toActor: row.toActor,
      scope: row.scope,
      contextPack: row.contextPack ?? undefined,
      acceptance: row.acceptance ?? undefined,
      openQuestions: Array.isArray(row.openQuestions) ? row.openQuestions : undefined,
      state: row.state,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(row.createdAt).toISOString(),
      acceptedAt: row.acceptedAt
        ? row.acceptedAt instanceof Date
          ? row.acceptedAt.toISOString()
          : new Date(row.acceptedAt).toISOString()
        : undefined,
      closedAt: row.closedAt
        ? row.closedAt instanceof Date
          ? row.closedAt.toISOString()
          : new Date(row.closedAt).toISOString()
        : undefined,
    };
  }

  private toReplicationSessionRecord(
    row: Record<string, any>,
  ): FactoryReplicationSessionRecord {
    return {
      sessionId: row.sessionId,
      orgId: row.orgId ?? undefined,
      factoryId: row.factoryId,
      step: row.step ?? undefined,
      status: row.status,
      progress: row.progress,
      startedAt: row.startedAt
        ? row.startedAt instanceof Date
          ? row.startedAt.toISOString()
          : new Date(row.startedAt).toISOString()
        : undefined,
      finishedAt: row.finishedAt
        ? row.finishedAt instanceof Date
          ? row.finishedAt.toISOString()
          : new Date(row.finishedAt).toISOString()
        : undefined,
      outputEvidenceId: row.outputEvidenceId ?? undefined,
    };
  }
}