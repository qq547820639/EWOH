import { ewohWorldSnapshotCursor, ewohWorldDeltaLog } from '@server/database/schema';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { createHash } from 'node:crypto';
import { sql, asc, desc, gt, type SQL } from 'drizzle-orm';

export interface WorldEntity {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface WorldSnapshot {
  snapshotVersion: number;
  cursor: string;
  entities: WorldEntity[];
  generatedAt: string;
}

export interface WorldDelta {
  nextCursor: string;
  upserts: WorldEntity[];
  removals: string[];
  hasMore: boolean;
  etag: string;
}

export class CursorExpiredError extends Error {
  constructor(message = 'CURSOR_EXPIRED') {
    super(message);
    this.name = 'CursorExpiredError';
  }
}

interface WorldSnapshotRow {
  snapshot_version: number;
  payload: unknown;
  entity_count: number;
}

interface WorldDeltaRow {
  seq: number;
  entity_id: string;
  delta_type: string;
  payload: unknown;
}

interface SnapshotPayload {
  entities: WorldEntity[];
  lastSeq: number;
  generatedAt: string;
}

function encodeCursor(snapshotVersion: number, lastSeq: number): string {
  return Buffer.from(`${snapshotVersion}:${lastSeq}`).toString('base64');
}

function decodeCursor(cursor: string): { snapshotVersion: number; lastSeq: number } {
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  const [snapshotVersion, lastSeq] = raw.split(':').map(Number);
  if (!Number.isInteger(snapshotVersion) || !Number.isInteger(lastSeq)) {
    throw new BadRequestException('Invalid cursor');
  }
  return { snapshotVersion, lastSeq };
}

@Injectable()
export class WorldCursorService {
  private readonly logger = new Logger(WorldCursorService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async applyUpsert(entity: WorldEntity): Promise<void> {
    if (!entity?.id) {
      throw new BadRequestException('entity id is required');
    }
    // ADR-079：drizzle 类型安全（raw SQL 完整清零）。
    await this.safeExecute('persist world upsert', this.db.insert(ewohWorldDeltaLog).values({
      snapshotVersion: sql`coalesce((select max(snapshot_version) from ${ewohWorldSnapshotCursor}), 0)`,
      entityType: entity.type ?? 'entity',
      entityId: entity.id,
      deltaType: 'upsert',
      payload: entity as unknown as Record<string, unknown>,
      sourceType: 'service',
    }));
  }

  async applyRemoval(id: string): Promise<void> {
    if (!id?.trim()) {
      throw new BadRequestException('entity id is required');
    }
    await this.safeExecute('persist world removal', this.db.insert(ewohWorldDeltaLog).values({
      snapshotVersion: sql`coalesce((select max(snapshot_version) from ${ewohWorldSnapshotCursor}), 0)`,
      entityType: 'entity',
      entityId: id,
      deltaType: 'removal',
      payload: null,
      sourceType: 'service',
    }));
  }

  async getSnapshot(): Promise<WorldSnapshot> {
    const [latest] = await this.safeExecute<WorldSnapshotRow>('read latest world snapshot', this.db
      .select({
        snapshot_version: ewohWorldSnapshotCursor.snapshotVersion,
        payload: ewohWorldSnapshotCursor.payload,
        entity_count: ewohWorldSnapshotCursor.entityCount,
      })
      .from(ewohWorldSnapshotCursor)
      .orderBy(desc(ewohWorldSnapshotCursor.snapshotVersion))
      .limit(1));
    const currentVersion = latest ? Number(latest.snapshot_version) : 0;
    let entities: WorldEntity[] = [];
    let lastSeq = 0;
    if (latest) {
      const payload = this.parseSnapshotPayload(latest.payload);
      entities = payload.entities;
      lastSeq = payload.lastSeq;
    }

    const changes = await this.safeExecute<WorldDeltaRow>('read world deltas for snapshot', this.db
      .select({
        seq: ewohWorldDeltaLog.seq,
        entity_id: ewohWorldDeltaLog.entityId,
        delta_type: ewohWorldDeltaLog.deltaType,
        payload: ewohWorldDeltaLog.payload,
      })
      .from(ewohWorldDeltaLog)
      .where(gt(ewohWorldDeltaLog.seq, lastSeq))
      .orderBy(asc(ewohWorldDeltaLog.seq)));
    const entityMap = new Map(entities.map((entity) => [entity.id, entity]));
    for (const change of changes) {
      const seq = Number(change.seq);
      if (change.delta_type === 'upsert') {
        const entity = this.parseWorldEntity(change.payload);
        entityMap.set(change.entity_id, entity);
      } else if (change.delta_type === 'removal') {
        entityMap.delete(change.entity_id);
      }
      lastSeq = seq;
    }

    const snapshotVersion = currentVersion + 1;
    const generatedAt = new Date().toISOString();
    const nextEntities = Array.from(entityMap.values());
    const payloadJson = JSON.stringify({
      entities: nextEntities,
      lastSeq,
      generatedAt,
    } satisfies SnapshotPayload);
    const checksum = createHash('sha256').update(payloadJson).digest('hex');
    await this.safeExecute('persist world snapshot', this.db.insert(ewohWorldSnapshotCursor).values({
      snapshotVersion,
      snapshotType: 'full',
      payload: JSON.parse(payloadJson) as Record<string, unknown>,
      entityCount: nextEntities.length,
      checksum,
      sourceType: 'service',
    }));
    return {
      snapshotVersion,
      cursor: encodeCursor(snapshotVersion, lastSeq),
      entities: nextEntities,
      generatedAt,
    };
  }

  async getDelta(cursor: string, limit = 200): Promise<WorldDelta> {
    const decoded = decodeCursor(cursor);
    const [latest] = await this.safeExecute<{ snapshot_version: number }>(
      'read current world snapshot version',
      this.db
        .select({ snapshot_version: ewohWorldSnapshotCursor.snapshotVersion })
        .from(ewohWorldSnapshotCursor)
        .orderBy(desc(ewohWorldSnapshotCursor.snapshotVersion))
        .limit(1),
    );
    const currentVersion = latest ? Number(latest.snapshot_version) : 0;
    if (decoded.snapshotVersion !== currentVersion) {
      throw new CursorExpiredError();
    }
    const safeLimit = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 200;
    const rows = await this.safeExecute<WorldDeltaRow>('read world delta page', this.db
      .select({
        seq: ewohWorldDeltaLog.seq,
        entity_id: ewohWorldDeltaLog.entityId,
        delta_type: ewohWorldDeltaLog.deltaType,
        payload: ewohWorldDeltaLog.payload,
      })
      .from(ewohWorldDeltaLog)
      .where(gt(ewohWorldDeltaLog.seq, decoded.lastSeq))
      .orderBy(asc(ewohWorldDeltaLog.seq))
      .limit(safeLimit + 1));
    const page = rows.slice(0, safeLimit);
    const upserts = page
      .filter((change) => change.delta_type === 'upsert')
      .map((change) => this.parseWorldEntity(change.payload));
    const removals = page
      .filter((change) => change.delta_type === 'removal')
      .map((change) => change.entity_id);
    const lastSeq = page.length > 0 ? Number(page[page.length - 1].seq) : decoded.lastSeq;
    return {
      nextCursor: encodeCursor(currentVersion, lastSeq),
      upserts,
      removals,
      hasMore: rows.length > safeLimit,
      etag: `${currentVersion}-${lastSeq}`,
    };
  }

  private parseSnapshotPayload(value: unknown): SnapshotPayload {
    const parsed = this.parseJson(value) as Partial<SnapshotPayload> | null;
    return {
      entities: Array.isArray(parsed?.entities) ? parsed.entities : [],
      lastSeq: Number(parsed?.lastSeq ?? 0),
      generatedAt:
        typeof parsed?.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString(),
    };
  }

  private parseWorldEntity(value: unknown): WorldEntity {
    const parsed = this.parseJson(value);
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed)) {
      throw new InternalServerErrorException('World delta payload is not an entity');
    }
    return parsed as WorldEntity;
  }

  private parseJson(value: unknown): unknown {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  private async safeExecute<T>(context: string, query: Promise<T[]> | SQL): Promise<T[]> {
    try {
      return (await query) as T[];
    } catch (error) {
      this.logger.error(
        `${context} failed`,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw new InternalServerErrorException(`${context} failed`);
    }
  }
}
