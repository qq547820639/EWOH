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

export interface AuditEntry {
  orgId?: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  risk?: boolean;
}

type DbOrTx = PostgresJsDatabase<Record<string, never>>;

/**
 * DB-backed persistence for EWOH domain state (resource locks, idempotency keys,
 * handoffs, git-sync state, evidence metadata, factory replication sessions).
 *
 * Provides: optimistic-lock version columns, unique constraints, idempotency keys,
 * transaction atomicity, and lock expiry / lease / release / holder-recovery.
 * This is the F61-02 durable source of truth; in-process Maps must not replace it.
 *
 * Multi-instance correctness (2.D): timestamp writes use database time (`now()`)
 * instead of the application clock, so concurrent instances share one time source.
 * Composite operations (2.C) run inside explicit `db.transaction()` boundaries so a
 * mid-failure never leaves a partial write (e.g. a lock acquired without its audit).
 */
@Injectable()
export class DomainPersistenceService {
  /** Database time; used instead of the application clock to avoid instance drift. */
  private readonly dbNow = sql`now()` as unknown as Date;

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
    return this.acquireLockOn(this.db, input);
  }

  /**
   * 2.C composite: acquire a resource lock and register an audit event in a single
   * transaction, so a mid-failure cannot leave a lock without its audit trail.
   */
  async acquireLockWithAudit(
    input: {
      orgId: string;
      resourceKey: string;
      resourceId: string;
      holder: string;
      purpose?: string;
      expiresAt?: string;
    },
    audit?: AuditEntry,
  ): Promise<ResourceLockRecord> {
    return this.db.transaction(async (tx) => {
      const record = await this.acquireLockOn(tx, input);
      if (audit) await this.appendAudit(tx, audit);
      return record;
    });
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
    const [updated] = await this.db
      .update(ewohResourceLocks)
      .set({
        renewedAt: this.dbNow,
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
   * Returns the number of recovered locks. The expiry comparison uses database time.
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

  /**
   * 2.C / 2.D composite: register an idempotency key AND create the business object
   * inside one transaction. A replay of the same key returns the single stored
   * result (no duplicate business object); a concurrent duplicate request races on
   * the unique (scope, key) constraint and coalesces to one result.
   */
  async setIdempotencyAndCreate<T>(
    scope: string,
    key: string,
    creator: (tx: DbOrTx) => Promise<T>,
  ): Promise<{ created: boolean; result: T }> {
    return this.db.transaction(async (tx) => {
      const existing = (await this.getIdempotencyOn(tx, scope, key)) as T | undefined;
      if (existing !== undefined) return { created: false, result: existing };
      const result = await creator(tx);
      await tx
        .insert(ewohIdempotencyKeys)
        .values({ scope, idempotencyKey: key, response: result as unknown })
        .onConflictDoNothing();
      const stored = (await this.getIdempotencyOn(tx, scope, key)) as T | undefined;
      return { created: true, result: (stored ?? result) as T };
    });
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
    return this.createHandoffOn(this.db, record);
  }

  /**
   * 2.C composite: create a handoff (transferring responsibility) and register the
   * handoff as evidence in a single transaction, so a mid-failure cannot leave a
   * handoff whose responsibility transfer is unrecorded.
   */
  async createHandoffWithTransfer(
    record: {
      handoffId: string;
      fromActor: string;
      toActor: string;
      scope: string;
      contextPack?: string;
      acceptance?: string;
      openQuestions?: string[];
    },
    evidence?: EvidenceMetadataRecord,
  ): Promise<HandoffRecord> {
    return this.db.transaction(async (tx) => {
      const handoff = await this.createHandoffOn(tx, record);
      if (evidence) await this.upsertEvidenceOn(tx, evidence);
      return handoff;
    });
  }

  /**
   * 2.C composite: accept a handoff (transferring responsibility) and register the
   * transfer as evidence atomically, so a mid-failure cannot leave the handoff
   * accepted without the responsibility-transfer evidence.
   */
  async acceptHandoffWithTaskUpdate(
    handoffId: string,
    evidence?: EvidenceMetadataRecord,
  ): Promise<HandoffRecord | null> {
    return this.db.transaction(async (tx) => {
      const handoff = await this.updateHandoffStatusOn(tx, handoffId, 'accepted');
      if (evidence) await this.upsertEvidenceOn(tx, evidence);
      return handoff;
    });
  }

  async updateHandoffStatus(
    handoffId: string,
    state: 'accepted' | 'rejected' | 'closed',
  ): Promise<HandoffRecord | null> {
    return this.updateHandoffStatusOn(this.db, handoffId, state);
  }

  async getHandoff(handoffId: string): Promise<HandoffRecord | null> {
    const [row] = await this.db
      .select()
      .from(ewohHandoffs)
      .where(eq(ewohHandoffs.handoffId, handoffId));
    return row ? this.toHandoffRecord(row) : null;
  }

  async listHandoffs(): Promise<HandoffRecord[]> {
    const rows = await this.db
      .select()
      .from(ewohHandoffs)
      .orderBy(desc(ewohHandoffs.createdAt));
    return rows.map((row) => this.toHandoffRecord(row));
  }

  // ---------------------------------------------------------------------------
  // Git sync state
  // ---------------------------------------------------------------------------

  async upsertGitSyncState(record: GitSyncStateRecord): Promise<void> {
    await this.upsertGitSyncOn(this.db, record);
  }

  /**
   * Read the persisted git-sync state for a sync id, returning null when no row
   * has been recorded yet. This makes the durable git-sync state the fact source
   * for the read path (2.B), instead of recomputing a plan from process memory.
   */
  async getGitSyncState(syncId: string): Promise<GitSyncStateRecord | null> {
    const [row] = await this.db
      .select()
      .from(ewohGitSyncState)
      .where(eq(ewohGitSyncState.syncId, syncId));
    if (!row) return null;
    return {
      syncId: row.syncId,
      lastSyncAt: this.toIso(row.lastSyncAt),
      lastSyncSha: row.lastSyncSha ?? undefined,
      lastSyncStatus: row.lastSyncStatus ?? undefined,
      conflicts: row.conflicts ?? undefined,
    };
  }

  /**
   * 2.C composite: advance git-sync state and register the produced evidence in a
   * single transaction, so a mid-failure cannot leave the sync cursor advanced
   * without its evidence (or vice-versa).
   */
  async updateGitSyncWithEvidence(
    record: GitSyncStateRecord,
    evidence: EvidenceMetadataRecord,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await this.upsertGitSyncOn(tx, record);
      await this.upsertEvidenceOn(tx, evidence);
    });
  }

  // ---------------------------------------------------------------------------
  // Evidence metadata
  // ---------------------------------------------------------------------------

  async upsertEvidenceMetadata(record: EvidenceMetadataRecord): Promise<void> {
    await this.upsertEvidenceOn(this.db, record);
  }

  async getEvidenceMetadata(evidenceId: string): Promise<EvidenceMetadataRecord | null> {
    const [row] = await this.db
      .select()
      .from(ewohEvidenceMetadata)
      .where(eq(ewohEvidenceMetadata.evidenceId, evidenceId));
    if (!row) return null;
    return {
      evidenceId: row.evidenceId,
      workItemId: row.workItemId ?? undefined,
      commitSha: row.commitSha ?? undefined,
      envFingerprint: row.envFingerprint ?? undefined,
      verifier: row.verifier ?? undefined,
      producedAt: this.toIso(row.producedAt),
      expiresAt: this.toIso(row.expiresAt),
      result: row.result ?? undefined,
      checksum: row.checksum ?? undefined,
    };
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
    return this.createReplicationSessionOn(this.db, input);
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
    return this.updateReplicationSessionOn(this.db, sessionId, patch);
  }

  /**
   * 2.C composite: advance a replication session step and generate its output
   * evidence in a single transaction, so a mid-failure cannot leave the step
   * advanced without the output evidence (or vice-versa).
   */
  async advanceReplicationWithEvidence(
    sessionId: string,
    patch: {
      step?: string;
      status?: string;
      progress?: number;
      finishedAt?: string;
      outputEvidenceId?: string;
    },
    evidence: EvidenceMetadataRecord,
  ): Promise<FactoryReplicationSessionRecord | null> {
    return this.db.transaction(async (tx) => {
      const session = await this.updateReplicationSessionOn(tx, sessionId, patch);
      await this.upsertEvidenceOn(tx, evidence);
      return session;
    });
  }

  // ---------------------------------------------------------------------------
  // Transaction-aware internals
  // ---------------------------------------------------------------------------

  private async acquireLockOn(
    db: DbOrTx,
    input: {
      orgId: string;
      resourceKey: string;
      resourceId: string;
      holder: string;
      purpose?: string;
      expiresAt?: string;
    },
  ): Promise<ResourceLockRecord> {
    const existing = await db
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
      const [updated] = await db
        .update(ewohResourceLocks)
        .set({
          holder: input.holder,
          purpose: input.purpose,
          resourceId: input.resourceId,
          acquiredAt: this.dbNow,
          expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
          renewedAt: this.dbNow,
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

    const [inserted] = await db
      .insert(ewohResourceLocks)
      .values({
        orgId: input.orgId,
        resourceKey: input.resourceKey,
        resourceId: input.resourceId,
        holder: input.holder,
        purpose: input.purpose,
        acquiredAt: this.dbNow,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        renewedAt: this.dbNow,
        active: true,
        version: 1,
      })
      .returning();
    if (!inserted) {
      throw new ConflictException(`Resource ${input.resourceKey} locked concurrently`);
    }
    return this.toLockRecord(inserted);
  }

  private async createHandoffOn(
    db: DbOrTx,
    record: {
      handoffId: string;
      fromActor: string;
      toActor: string;
      scope: string;
      contextPack?: string;
      acceptance?: string;
      openQuestions?: string[];
    },
  ): Promise<HandoffRecord> {
    await db.insert(ewohHandoffs).values({
      handoffId: record.handoffId,
      fromActor: record.fromActor,
      toActor: record.toActor,
      scope: record.scope,
      contextPack: record.contextPack,
      acceptance: record.acceptance,
      openQuestions: record.openQuestions ?? [],
      state: 'open',
      createdAt: this.dbNow,
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
      createdAt: new Date().toISOString(),
    };
  }

  private async updateHandoffStatusOn(
    db: DbOrTx,
    handoffId: string,
    state: 'accepted' | 'rejected' | 'closed',
  ): Promise<HandoffRecord | null> {
    const update: Record<string, unknown> = { state };
    if (state === 'accepted') update.acceptedAt = this.dbNow;
    if (state === 'closed') update.closedAt = this.dbNow;
    const [updated] = await db
      .update(ewohHandoffs)
      .set(update)
      .where(eq(ewohHandoffs.handoffId, handoffId))
      .returning();
    return updated ? this.toHandoffRecord(updated) : null;
  }

  private async upsertGitSyncOn(
    db: DbOrTx,
    record: GitSyncStateRecord,
  ): Promise<void> {
    await db
      .insert(ewohGitSyncState)
      .values({
        syncId: record.syncId,
        lastSyncAt: record.lastSyncAt ? new Date(record.lastSyncAt) : this.dbNow,
        lastSyncSha: record.lastSyncSha,
        lastSyncStatus: record.lastSyncStatus,
        conflicts: record.conflicts ?? null,
        createdAt: this.dbNow,
        updatedAt: this.dbNow,
      })
      .onConflictDoUpdate({
        target: ewohGitSyncState.syncId,
        set: {
          lastSyncAt: record.lastSyncAt ? new Date(record.lastSyncAt) : this.dbNow,
          lastSyncSha: record.lastSyncSha,
          lastSyncStatus: record.lastSyncStatus,
          conflicts: record.conflicts ?? null,
          updatedAt: this.dbNow,
        },
      });
  }

  private async upsertEvidenceOn(
    db: DbOrTx,
    record: EvidenceMetadataRecord,
  ): Promise<void> {
    await db
      .insert(ewohEvidenceMetadata)
      .values({
        evidenceId: record.evidenceId,
        workItemId: record.workItemId,
        commitSha: record.commitSha,
        envFingerprint: record.envFingerprint,
        verifier: record.verifier,
        producedAt: record.producedAt ? new Date(record.producedAt) : this.dbNow,
        expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
        result: record.result,
        checksum: record.checksum,
        createdAt: this.dbNow,
        updatedAt: this.dbNow,
      })
      .onConflictDoUpdate({
        target: ewohEvidenceMetadata.evidenceId,
        set: {
          workItemId: record.workItemId,
          commitSha: record.commitSha,
          envFingerprint: record.envFingerprint,
          verifier: record.verifier,
          producedAt: record.producedAt ? new Date(record.producedAt) : this.dbNow,
          expiresAt: record.expiresAt ? new Date(record.expiresAt) : null,
          result: record.result,
          checksum: record.checksum,
          updatedAt: this.dbNow,
        },
      });
  }

  private async createReplicationSessionOn(
    db: DbOrTx,
    input: {
      sessionId: string;
      orgId?: string;
      factoryId: string;
      step?: string;
    },
  ): Promise<FactoryReplicationSessionRecord> {
    await db.insert(ewohFactoryReplicationSessions).values({
      sessionId: input.sessionId,
      orgId: input.orgId,
      factoryId: input.factoryId,
      step: input.step,
      status: 'running',
      progress: 0,
      startedAt: this.dbNow,
      createdAt: this.dbNow,
    });
    return {
      sessionId: input.sessionId,
      orgId: input.orgId,
      factoryId: input.factoryId,
      step: input.step,
      status: 'running',
      progress: 0,
      startedAt: new Date().toISOString(),
    };
  }

  private async updateReplicationSessionOn(
    db: DbOrTx,
    sessionId: string,
    patch: {
      step?: string;
      status?: string;
      progress?: number;
      finishedAt?: string;
      outputEvidenceId?: string;
    },
  ): Promise<FactoryReplicationSessionRecord | null> {
    const [updated] = await db
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

  private async getIdempotencyOn<T>(
    db: DbOrTx,
    scope: string,
    key: string,
  ): Promise<T | undefined> {
    const [row] = await db
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

  private async appendAudit(tx: DbOrTx, entry: AuditEntry): Promise<void> {
    await tx.execute(sql`
      select public.ewoh_append_audit_log(
        ${entry.orgId || null}::uuid,
        ${entry.actorId},
        ${entry.action},
        ${entry.entityType},
        ${entry.entityId || ''},
        ${entry.before === undefined ? null : JSON.stringify(entry.before)}::jsonb,
        ${entry.after === undefined ? null : JSON.stringify(entry.after)}::jsonb,
        ${entry.reason || null},
        null,
        null,
        ${entry.risk === true},
        ${entry.risk === true ? 'high' : 'normal'}
      )
    `);
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

  private toIso(value: Date | string | null | undefined): string | undefined {
    if (!value) return undefined;
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  private toLockRecord(row: Record<string, any>): ResourceLockRecord {
    return {
      resourceId: row.resourceId,
      holder: row.holder,
      purpose: row.purpose ?? undefined,
      acquiredAt: this.toIso(row.acquiredAt) ?? new Date().toISOString(),
      expiresAt: this.toIso(row.expiresAt),
      renewedAt: this.toIso(row.renewedAt),
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
      createdAt: this.toIso(row.createdAt) ?? new Date().toISOString(),
      acceptedAt: this.toIso(row.acceptedAt),
      closedAt: this.toIso(row.closedAt),
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
      startedAt: this.toIso(row.startedAt),
      finishedAt: this.toIso(row.finishedAt),
      outputEvidenceId: row.outputEvidenceId ?? undefined,
    };
  }
}
