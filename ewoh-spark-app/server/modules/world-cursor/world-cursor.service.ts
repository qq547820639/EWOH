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
import { sql, asc, desc, gt, eq, and, type SQL } from 'drizzle-orm';

/**
 * NEST-648（2026-08-17 审计裁决，按 spec 维持 2026-08-04 已有裁决）：
 * world 与 world-cursor 是两条**有意并存**的世界状态读路径——
 *   - world（/api/world/state|replay）：业务回放视图，读
 *     ewoh_spatial_entity + ewoh_world_state + ewoh_event 等业务事实表；
 *   - world-cursor（/api/world/snapshot|delta）：增量同步协议面，读
 *     ewoh_world_snapshot + ewoh_world_delta_log（原生 SQL 游标协议，
 *     snapshotVersion/seq 为全局版本键，ADR-004 GLOBAL_SHARED 语义）。
 * 收敛到单一数据源会破坏游标协议的版本语义；本裁决仅以本注释文档化边界，
 * 两条路径各自带 org 作用域（NEST-609 已修），不合并。
 */

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

  /**
   * NEST-609（2026-08-17 审计整改）：snapshot/delta 读写按 org 作用域。
   * ewoh_world_snapshot / ewoh_world_delta_log 的 org_id 为 uuid 列
   * （GUC 默认）；读路径显式 eq(orgId)，写路径（delta 追加）显式携带。
   *
   * B9（2026-08-19 审计）：org_id 为 uuid 列而系统其余表多为 varchar——
   * 非 UUID org（legacy/测试值）此前要么深处 22P02、要么 eq 比较静默落空
   * （表现为 404）。入口显式 UUID 校验：非法值 400 fail-fast，不再静默。
   */
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  private requireOrgId(orgId?: string): string {
    const trimmed = orgId?.trim();
    if (!trimmed) {
      throw new BadRequestException(
        'org context missing: world cursor operations require tenant context',
      );
    }
    if (!WorldCursorService.UUID_RE.test(trimmed)) {
      throw new BadRequestException(
        `org context invalid: org id must be a UUID (got ${JSON.stringify(trimmed)})`,
      );
    }
    return trimmed;
  }

  async applyUpsert(entity: WorldEntity, orgId?: string): Promise<void> {
    if (!entity?.id) {
      throw new BadRequestException('entity id is required');
    }
    const scope = orgId ? this.requireOrgId(orgId) : null;
    // ADR-079：drizzle 类型安全（raw SQL 完整清零）。
    await this.safeExecute('persist world upsert', this.db.insert(ewohWorldDeltaLog).values({
      snapshotVersion: sql`coalesce((select max(snapshot_version) from ${ewohWorldSnapshotCursor}), 0)`,
      entityType: entity.type ?? 'entity',
      entityId: entity.id,
      deltaType: 'upsert',
      payload: entity as unknown as Record<string, unknown>,
      sourceType: 'service',
      ...(scope ? { orgId: scope } : {}),
    }));
  }

  async applyRemoval(id: string, orgId?: string): Promise<void> {
    if (!id?.trim()) {
      throw new BadRequestException('entity id is required');
    }
    const scope = orgId ? this.requireOrgId(orgId) : null;
    await this.safeExecute('persist world removal', this.db.insert(ewohWorldDeltaLog).values({
      snapshotVersion: sql`coalesce((select max(snapshot_version) from ${ewohWorldSnapshotCursor}), 0)`,
      entityType: 'entity',
      entityId: id,
      deltaType: 'removal',
      payload: null,
      sourceType: 'service',
      ...(scope ? { orgId: scope } : {}),
    }));
  }

  async getSnapshot(orgId?: string): Promise<WorldSnapshot> {
    const scope = this.requireOrgId(orgId);
    const [latest] = await this.safeExecute<WorldSnapshotRow>('read latest world snapshot', this.db
      .select({
        snapshot_version: ewohWorldSnapshotCursor.snapshotVersion,
        payload: ewohWorldSnapshotCursor.payload,
        entity_count: ewohWorldSnapshotCursor.entityCount,
      })
      .from(ewohWorldSnapshotCursor)
      .where(eq(ewohWorldSnapshotCursor.orgId, scope))
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
      .where(
        and(
          eq(ewohWorldDeltaLog.orgId, scope),
          gt(ewohWorldDeltaLog.seq, lastSeq),
        ),
      )
      .orderBy(asc(ewohWorldDeltaLog.seq)));

    // NEST-638：仅当有新 delta（或首拍无快照）才落新 snapshot 行——
    // 无变化重复读不再膨胀 ewoh_world_snapshot。
    if (changes.length === 0 && latest) {
      return {
        snapshotVersion: currentVersion,
        cursor: encodeCursor(currentVersion, lastSeq),
        entities,
        generatedAt: this.parseSnapshotPayload(latest.payload).generatedAt,
      };
    }

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
      orgId: scope,
    }));
    return {
      snapshotVersion,
      cursor: encodeCursor(snapshotVersion, lastSeq),
      entities: nextEntities,
      generatedAt,
    };
  }

  async getDelta(cursor: string, limit = 200, orgId?: string): Promise<WorldDelta> {
    const scope = this.requireOrgId(orgId);
    const decoded = decodeCursor(cursor);
    const [latest] = await this.safeExecute<{ snapshot_version: number }>(
      'read current world snapshot version',
      this.db
        .select({ snapshot_version: ewohWorldSnapshotCursor.snapshotVersion })
        .from(ewohWorldSnapshotCursor)
        .where(eq(ewohWorldSnapshotCursor.orgId, scope))
        .orderBy(desc(ewohWorldSnapshotCursor.snapshotVersion))
        .limit(1),
    );
    const currentVersion = latest ? Number(latest.snapshot_version) : 0;
    if (decoded.snapshotVersion !== currentVersion) {
      throw new CursorExpiredError();
    }
    // NEST-639：delta limit 上限（防极大值一次拉全量 delta log）。
    const safeLimit = Math.min(
      Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : 200,
      1000,
    );
    const rows = await this.safeExecute<WorldDeltaRow>('read world delta page', this.db
      .select({
        seq: ewohWorldDeltaLog.seq,
        entity_id: ewohWorldDeltaLog.entityId,
        delta_type: ewohWorldDeltaLog.deltaType,
        payload: ewohWorldDeltaLog.payload,
      })
      .from(ewohWorldDeltaLog)
      .where(
        and(
          eq(ewohWorldDeltaLog.orgId, scope),
          gt(ewohWorldDeltaLog.seq, decoded.lastSeq),
        ),
      )
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
