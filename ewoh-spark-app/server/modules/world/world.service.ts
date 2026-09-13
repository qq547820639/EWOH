import {
  BadRequestException,
  Injectable,
  Inject,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSpatialEntity,
  ewohWorldState,
  ewohEvent,
  ewohEventChain,
  ewohScheduleTask,
  ewohScheduleTaskStep,
  ewohResourceBinding,
} from '@server/database/schema';
import { eq, desc, and, gte, lte, sql, or, asc, inArray, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CurrentWorldState, EventChainNode, ReplaySnapshot } from '@shared/api.interface';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

type SpatialEntityRow = typeof ewohSpatialEntity.$inferSelect;
type WorldStateRow = typeof ewohWorldState.$inferSelect;

function laneForEventType(eventType?: string | null): string {
  const value = String(eventType || '').toLowerCase();
  if (value.includes('quality')) return 'quality';
  if (value.includes('approval')) return 'approval';
  if (value.includes('control')) return 'control';
  if (value.includes('rollback')) return 'rollback';
  if (value.includes('material')) return 'material';
  if (value.includes('task') || value.includes('work_order')) return 'task';
  return 'alert';
}

@Injectable()
export class WorldService {
  private readonly logger = new Logger(WorldService.name);

  /**
   * NEST-PERF（2026-08-23 性能收尾）：/api/world/state 5 秒进程内缓存。
   * 根因：getCurrentState 的 LATERAL JOIN（每实体取最新 world_state）+ 事件表在
   * RLS 下扫描，单次约 1.1s；CommandMap 高频轮询放大该开销。加 5s TTL 缓存后，
   * 命中请求≈毫秒级（与 dashboard 同策略），满足 <300ms 目标。缓存键含租户维度
   * （orgId / global_admin），避免跨租户数据串扰。注意：5s 延迟对近实时地图可接受。
   */
  private readonly STATE_CACHE_TTL_MS = 5000;
  private stateCache = new Map<string, { data: CurrentWorldState; ts: number }>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  /**
   * NEST-605/606/607/640（2026-08-17 审计整改）：world 查询/写入全部带 org
   * 谓词；global_admin 显式放行（与 RLS 例外路径一致）。
   */
  private orgCondition(
    column:
      | typeof ewohSpatialEntity.orgId
      | typeof ewohWorldState.orgId
      | typeof ewohEvent.orgId
      | typeof ewohEventChain.orgId
      | typeof ewohScheduleTask.orgId
      | typeof ewohScheduleTaskStep.orgId
      | typeof ewohResourceBinding.orgId,
    actor?: OrgContext,
  ): SQL | undefined {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: world operations require tenant context',
      );
    }
    return eq(column, orgId) as SQL;
  }

  /**
   * 聚合当前世界状态快照：人员 / 设备 / 工位 / 最近事件
   */
  async getCurrentState(
    actor?: OrgContext,
    page?: number,
    pageSize?: number,
  ): Promise<CurrentWorldState> {
    const cacheKey = this.stateCacheKey(actor);
    const cached = this.stateCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.STATE_CACHE_TTL_MS) {
      return this.paginateWorldState(cached.data, page, pageSize);
    }
    try {
      const entityOrg = this.orgCondition(ewohSpatialEntity.orgId, actor);
      const eventOrg = this.orgCondition(ewohEvent.orgId, actor);
      // NEST-640：recentEvents 带 org 过滤（原先跨租户可见）。
      const [personEntities, deviceEntities, workstationEntities, recentEvents] = await Promise.all([
        this.db
          .select()
          .from(ewohSpatialEntity)
          .where(
            entityOrg
              ? and(eq(ewohSpatialEntity.entityType, 'person'), entityOrg)
              : eq(ewohSpatialEntity.entityType, 'person'),
          ),
        this.db
          .select()
          .from(ewohSpatialEntity)
          .where(
            entityOrg
              ? and(eq(ewohSpatialEntity.entityType, 'device'), entityOrg)
              : eq(ewohSpatialEntity.entityType, 'device'),
          ),
        this.db
          .select()
          .from(ewohSpatialEntity)
          .where(
            entityOrg
              ? and(eq(ewohSpatialEntity.entityType, 'workstation'), entityOrg)
              : eq(ewohSpatialEntity.entityType, 'workstation'),
          ),
        this.db
          .select()
          .from(ewohEvent)
          .where(eventOrg)
          .orderBy(desc(ewohEvent.createdAt))
          .limit(20),
      ]);

      const allEntityIds = [
        ...personEntities.map((p) => p.entityId),
        ...deviceEntities.map((d) => d.entityId),
        ...workstationEntities.map((w) => w.entityId),
      ];

      // 取每个 entity 的最新 world_state：优先在数据库内用 DISTINCT ON 完成
      // （P1-WORLD-001：避免把全部历史拉回 Node 去重）。
      // PostgreSQL 支持 DISTINCT ON(entity_id) + ORDER BY entity_id, ts DESC。
      const latestStatesMap = new Map<string, WorldStateRow>();
      if (allEntityIds.length > 0) {
        const stateOrg = this.orgCondition(ewohWorldState.orgId, actor);
        // 性能修复（2026-08-19）：原 DISTINCT ON + IN(48) 在 ewoh_world_state 37 万行上
        // 被 planner 降级为 Seq Scan + Sort（实测 37s）→ 前端 20s 超时 → 指挥地图无数据。
        // 改 LATERAL JOIN：每个 entity 走 idx_ewoh_world_state_entity_ts 索引取 ts 最新行（毫秒级）。
        // 注意：drizzle sql 模板会把 JS 数组展开为行值列表 ($1,...)，不能直接用于
        // unnest/ARRAY 构造器 → 用 sql.raw 内联转义后的 id 字面量（id 源自 DB，转义单引号可控）。
        const idLiteral = allEntityIds
          .map((id) => `'${String(id).replace(/'/g, "''")}'`)
          .join(', ');
        const states = (await this.db.execute(sql`
            SELECT ws."id" AS "id", ws."entity_id" AS "entityId", ws."state_json" AS "stateJson",
                   ws."ts" AS "ts", ws."org_id" AS "orgId",
                   ws."_created_at" AS "_createdAt", ws."_updated_at" AS "_updatedAt"
            FROM unnest(ARRAY[${sql.raw(idLiteral)}]::text[]) AS ids(e)
            JOIN LATERAL (
              SELECT "id", "entity_id", "state_json", "ts", "org_id", "_created_at", "_updated_at"
              FROM ${ewohWorldState}
              WHERE "entity_id" = ids.e
                ${stateOrg ? sql`AND ${stateOrg}` : sql``}
              ORDER BY "ts" DESC
              LIMIT 1
            ) ws ON true
          `)) as WorldStateRow[];
        for (const s of states) {
          latestStatesMap.set(s.entityId, s);
        }
      }

      const persons = personEntities.map((p: SpatialEntityRow) => {
        const extra = (p.extra ?? {}) as Record<string, unknown>;
        const latest = latestStatesMap.get(p.entityId);
        const stateJson = latest ? (latest.stateJson as Record<string, unknown>) : null;
        return {
          entityId: p.entityId,
          name: p.name,
          x: stateJson && stateJson.x != null ? Number(stateJson.x) : (p.x ?? 0),
          y: stateJson && stateJson.y != null ? Number(stateJson.y) : (p.y ?? 0),
          status:
            stateJson && stateJson.status != null
              ? String(stateJson.status)
              : (p.status ?? 'active'),
          confidence: p.confidence ?? 1.0,
          deviceId: extra.device_id != null ? String(extra.device_id) : undefined,
          task: extra.task != null ? String(extra.task) : undefined,
          loadScore: extra.load_score != null ? Number(extra.load_score) : undefined,
        };
      });

      const devices = deviceEntities.map((d: SpatialEntityRow) => {
        const extra = (d.extra ?? {}) as Record<string, unknown>;
        const latest = latestStatesMap.get(d.entityId);
        const stateJson = latest ? (latest.stateJson as Record<string, unknown>) : null;
        return {
          entityId: d.entityId,
          name: d.name,
          x: stateJson && stateJson.x != null ? Number(stateJson.x) : (d.x ?? 0),
          y: stateJson && stateJson.y != null ? Number(stateJson.y) : (d.y ?? 0),
          status:
            stateJson && stateJson.status != null
              ? String(stateJson.status)
              : (d.status ?? 'active'),
          deviceId: d.entityId,
          workerId: extra.worker_id != null ? String(extra.worker_id) : undefined,
        };
      });

      const workstations = workstationEntities.map((w: SpatialEntityRow) => {
        const latest = latestStatesMap.get(w.entityId);
        const stateJson = latest ? (latest.stateJson as Record<string, unknown>) : null;
        const occupancy =
          stateJson && stateJson.occupancy != null ? Number(stateJson.occupancy) : 0;
        return {
          entityId: w.entityId,
          name: w.name,
          x: w.x ?? 0,
          y: w.y ?? 0,
          status: w.status ?? 'active',
          occupancy,
        };
      });

      const events = recentEvents.map((e) => ({
        eventId: e.eventId,
        title: e.title ?? '',
        severity: e.severity ?? '',
        status: e.status ?? 'open',
        createdAt: e.createdAt ? e.createdAt.toISOString() : null,
      }));

      const result: CurrentWorldState = {
        persons,
        devices,
        workstations,
        events,
        ts: new Date().toISOString(),
      };
      this.stateCache.set(cacheKey, { data: result, ts: Date.now() });
      return this.paginateWorldState(result, page, pageSize);
    } catch (error) {
      this.logger.error('getCurrentState 失败', error);
      throw error;
    }
  }

  private stateCacheKey(actor?: OrgContext): string {
    if (actor?.isGlobalAdmin) return 'global';
    const orgId = actor?.primaryOrgId?.trim();
    return orgId ? `org:${orgId}` : 'no-org';
  }

  private paginateWorldState(
    data: CurrentWorldState,
    page?: number,
    pageSize?: number,
  ): CurrentWorldState {
    if (!page || !pageSize || page < 1 || pageSize < 1) return data;
    const start = (page - 1) * pageSize;
    return {
      ...data,
      persons: data.persons.slice(start, start + pageSize),
      devices: data.devices.slice(start, start + pageSize),
      workstations: data.workstations.slice(start, start + pageSize),
      events: data.events.slice(start, start + pageSize),
    };
  }

  /**
   * 查询事件的因果链节点：包括自己作为 event_id 的、作为 parent_event_id 的
   * R2-SNZ-001：补 org 谓词（原先任何认证用户持他租户 eventId 即可枚举因果链）。
   */
  async getEventChain(eventId: string, actor?: OrgContext): Promise<EventChainNode[]> {
    try {
      const orgCond = this.orgCondition(ewohEventChain.orgId, actor);
      const chainCond = or(
        eq(ewohEventChain.eventId, eventId),
        eq(ewohEventChain.parentEventId, eventId),
      );
      const rows = await this.db
        .select()
        .from(ewohEventChain)
        .where(orgCond ? and(chainCond, orgCond) : chainCond)
        .orderBy(asc(ewohEventChain.createdAt));
      return rows.map((r) => ({
        id: r.id,
        eventId: r.eventId,
        parentEventId: r.parentEventId ?? null,
        causalType: r.causalType ?? 'triggered',
        description: r.description ?? null,
        createdAt: r.createdAt ? r.createdAt.toISOString() : '',
      }));
    } catch (error) {
      this.logger.error('getEventChain 失败', error);
      throw error;
    }
  }

  /**
   * 时间轴回放：合并世界状态、事件、任务、工序与物料变化的统一时间轴
   */
  async getReplay(
    from?: string,
    to?: string,
    limit = 100,
    actor?: OrgContext,
  ): Promise<ReplaySnapshot[]> {
    try {
      const now = new Date();
      const toTime = to ? new Date(to) : now;
      const fromTime = from ? new Date(from) : new Date(toTime.getTime() - 60 * 60 * 1000);
      const safeLimit = Math.min(Math.max(limit, 1), 1000);

      if (
        Number.isNaN(fromTime.getTime()) ||
        Number.isNaN(toTime.getTime()) ||
        fromTime.getTime() > toTime.getTime()
      ) {
        return [];
      }

      // NEST-606：五张表查询全部带 org 过滤（原先跨租户）。
      const stateOrg = this.orgCondition(ewohWorldState.orgId, actor);
      const eventOrg = this.orgCondition(ewohEvent.orgId, actor);
      const taskOrg = this.orgCondition(ewohScheduleTask.orgId, actor);
      const stepOrg = this.orgCondition(ewohScheduleTaskStep.orgId, actor);
      const materialOrg = this.orgCondition(ewohResourceBinding.orgId, actor);

      const states = await this.db
        .select()
        .from(ewohWorldState)
        .where(
          stateOrg
            ? and(gte(ewohWorldState.ts, fromTime), lte(ewohWorldState.ts, toTime), stateOrg)
            : and(gte(ewohWorldState.ts, fromTime), lte(ewohWorldState.ts, toTime)),
        )
        .orderBy(desc(ewohWorldState.ts))
        .limit(safeLimit * 10);

      const events = await this.db
        .select()
        .from(ewohEvent)
        .where(
          eventOrg
            ? and(gte(ewohEvent.createdAt, fromTime), lte(ewohEvent.createdAt, toTime), eventOrg)
            : and(gte(ewohEvent.createdAt, fromTime), lte(ewohEvent.createdAt, toTime)),
        )
        // R2-SNZ-014：补行数上限（原先唯一无 limit 的查询，宽窗口下全量拉取可致内存膨胀）。
        .orderBy(desc(ewohEvent.createdAt))
        .limit(5000);

      const tasks = await this.db
        .select()
        .from(ewohScheduleTask)
        .where(
          taskOrg
            ? and(
                gte(ewohScheduleTask.updatedAt, fromTime),
                lte(ewohScheduleTask.updatedAt, toTime),
                taskOrg,
              )
            : and(
                gte(ewohScheduleTask.updatedAt, fromTime),
                lte(ewohScheduleTask.updatedAt, toTime),
              ),
        )
        .limit(2000);

      const steps = await this.db
        .select()
        .from(ewohScheduleTaskStep)
        .where(
          stepOrg
            ? and(
                gte(ewohScheduleTaskStep.updatedAt, fromTime),
                lte(ewohScheduleTaskStep.updatedAt, toTime),
                stepOrg,
              )
            : and(
                gte(ewohScheduleTaskStep.updatedAt, fromTime),
                lte(ewohScheduleTaskStep.updatedAt, toTime),
              ),
        )
        .limit(4000);

      const materials = await this.db
        .select()
        .from(ewohResourceBinding)
        .where(
          materialOrg
            ? and(
                gte(ewohResourceBinding.startTime, fromTime),
                lte(ewohResourceBinding.startTime, toTime),
                materialOrg,
              )
            : and(
                gte(ewohResourceBinding.startTime, fromTime),
                lte(ewohResourceBinding.startTime, toTime),
              ),
        )
        .limit(2000);

      const byMinute = new Map<string, WorldStateRow[]>();
      for (const s of states) {
        const key = s.ts.toISOString().slice(0, 16);
        if (!byMinute.has(key)) byMinute.set(key, []);
        byMinute.get(key)!.push(s);
      }

      type TimelineEvent = ReplaySnapshot['events'][number];
      const eventByMinute = new Map<string, TimelineEvent[]>();
      const addTimelineEvent = (ts: Date, event: TimelineEvent) => {
        const key = ts.toISOString().slice(0, 16);
        const list = eventByMinute.get(key) ?? [];
        list.push(event);
        eventByMinute.set(key, list);
      };

      for (const e of events) {
        const ts = e.createdAt ?? e.updatedAt;
        if (!ts) continue;
        addTimelineEvent(ts, {
          eventId: e.eventId,
          severity: e.severity ?? '',
          title: e.title ?? '',
          lane: laneForEventType(e.eventType),
          entityId: e.deviceId ?? undefined,
          sourceType: e.sourceType ?? 'simulated',
          status: e.status ?? undefined,
          eventCode: e.eventCode ?? undefined,
        });
      }

      for (const task of tasks) {
        const ts = task.updatedAt ?? task.createdAt;
        if (!ts) continue;
        addTimelineEvent(ts, {
          eventId: `TSK-${task.scheduleTaskId}`,
          severity: 'low',
          title: `工单 ${task.scheduleTaskId} ${task.status}`,
          lane: 'task',
          entityId: task.scheduleTaskId,
          sourceType: 'real',
          status: task.status,
          eventCode: 'WORK_ORDER',
        });
      }

      for (const step of steps) {
        const ts = step.updatedAt ?? step.createdAt;
        if (!ts) continue;
        addTimelineEvent(ts, {
          eventId: `STP-${step.stepId}`,
          severity: 'low',
          title: `工序 ${step.stepId} ${step.status}`,
          lane: 'task',
          entityId: step.stepId,
          sourceType: 'real',
          status: step.status,
          eventCode: 'TASK_STEP',
        });
      }

      for (const binding of materials) {
        const ts = binding.startTime;
        if (!ts) continue;
        addTimelineEvent(ts, {
          eventId: `MAT-${binding.bindingId}`,
          severity: 'low',
          title: `物料 ${binding.resourceId} ${binding.bindingType}`,
          lane: 'material',
          entityId: binding.targetId,
          sourceType: 'real',
          status: binding.status,
          eventCode: 'MATERIAL',
        });
      }

      const minuteKeys = Array.from(
        new Set([...byMinute.keys(), ...eventByMinute.keys()]),
      )
        .sort()
        .reverse()
        .slice(0, safeLimit);
      // 回放分类修复（2026-08-20）：state_json 实际键为 loadScore（无下划线），
      // 且不含 entity_type 键（原分类恒落空 → 回放 persons/devices 全空，
      // 地图回放看不到任何实体）。实体类型改由空间实体表映射（entityId →
      // entityType，批量一次）；负载键名兼容 load_score / loadScore 双写。
      const stateEntityIds = Array.from(
        new Set(states.map((s) => s.entityId)),
      );
      const entityTypeById = new Map<string, string>();
      if (stateEntityIds.length > 0) {
        // NEST-606 同口径补 org 谓词：entityId 只在租户内唯一（uq (org_id,
        // entity_id)），跨租户同号实体的类型可能不同——无谓词查询会把**他租户**
        // 的登记读进来，把本租户实体错分进 persons/devices（同时也是一次跨租户读）。
        const typeOrg = this.orgCondition(ewohSpatialEntity.orgId, actor);
        const typeRows = await this.db
          .select({ entityId: ewohSpatialEntity.entityId, entityType: ewohSpatialEntity.entityType })
          .from(ewohSpatialEntity)
          .where(
            typeOrg
              ? and(inArray(ewohSpatialEntity.entityId, stateEntityIds), typeOrg)
              : inArray(ewohSpatialEntity.entityId, stateEntityIds),
          );
        for (const r of typeRows)
          entityTypeById.set(r.entityId, r.entityType ?? '');
      }
      const snapshots: ReplaySnapshot[] = [];
      for (const key of minuteKeys) {
        const groupStates = byMinute.get(key) ?? [];
        const persons: ReplaySnapshot['persons'] = [];
        const devices: ReplaySnapshot['devices'] = [];
        for (const s of groupStates) {
          const state = (s.stateJson ?? {}) as Record<string, unknown>;
          const entityType =
            (state.entity_type as string | undefined) ??
            entityTypeById.get(s.entityId);
          const rawLoad = state.load_score ?? state.loadScore;
          const entry = {
            entityId: s.entityId,
            x: state.x != null ? Number(state.x) : 0,
            y: state.y != null ? Number(state.y) : 0,
            status: state.status != null ? String(state.status) : 'active',
          };
          if (entityType === 'person') {
            persons.push({
              ...entry,
              loadScore: rawLoad != null ? Number(rawLoad) : undefined,
            });
          } else if (entityType === 'device') {
            devices.push(entry);
          }
        }
        snapshots.push({
          ts: new Date(key + ':00Z').toISOString(),
          persons,
          devices,
          events: eventByMinute.get(key) ?? [],
        });
      }
      return snapshots;
    } catch (error) {
      this.logger.error('getReplay 失败', error);
      throw error;
    }
  }

  async getEventContext(eventId: string, windowMinutes = 10, actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohEvent.orgId, actor);
    const [source] = await this.db
      .select()
      .from(ewohEvent)
      .where(orgCond ? and(eq(ewohEvent.eventId, eventId), orgCond) : eq(ewohEvent.eventId, eventId));
    if (!source) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }
    const base = source.createdAt ?? source.updatedAt;
    if (!base) {
      throw new NotFoundException(`Event ${eventId} has no timestamp`);
    }
    const fromTime = new Date(base.getTime() - windowMinutes * 60 * 1000);
    const toTime = new Date(base.getTime() + windowMinutes * 60 * 1000);
    const snapshots = await this.getReplay(
      fromTime.toISOString(),
      toTime.toISOString(),
      200,
      actor,
    );
    const chronological = [...snapshots].sort(
      (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
    );
    const baseMs = base.getTime();
    const before = chronological
      .filter((snap) => Date.parse(snap.ts) < baseMs)
      .at(-1);
    const during = chronological.find(
      (snap) => Math.abs(Date.parse(snap.ts) - baseMs) <= 60 * 1000,
    );
    const after = chronological.find((snap) => Date.parse(snap.ts) > baseMs);
    return {
      eventId,
      occurredAt: base.toISOString(),
      windowMinutes,
      before: before ?? null,
      during: during ?? null,
      after: after ?? null,
      timelineCount: snapshots.reduce(
        (count, snap) => count + snap.events.length,
        0,
      ),
    };
  }

  async createReplayItem(
    body: {
      eventId: string;
      kind: 'issue' | 'task' | 'evidence';
      title?: string;
      note?: string;
      replayTime?: string;
    },
    actor?: { userId: string; primaryOrgId: string },
  ) {
    if (!body.eventId?.trim()) {
      throw new BadRequestException('eventId is required');
    }
    if (!['issue', 'task', 'evidence'].includes(body.kind)) {
      throw new BadRequestException('kind must be issue, task, or evidence');
    }
    // NEST-607：源事件按 (orgId, eventId) 定位 + 新事件显式 orgId。
    const orgCond = this.orgCondition(ewohEvent.orgId, actor);
    const [source] = await this.db
      .select()
      .from(ewohEvent)
      .where(
        orgCond
          ? and(eq(ewohEvent.eventId, body.eventId), orgCond)
          : eq(ewohEvent.eventId, body.eventId),
      );
    if (!source) {
      throw new NotFoundException(`Event ${body.eventId} not found`);
    }
    // 派生事实跟随**源事件**的租户归属：global_admin 跨租户检索时操作者
    // primaryOrgId 与源事件 org 可以不同——若按操作者 org 落 REPLAY_* 事件与
    // 因果链行，源租户用户看不到本方事件的标注，getEventChain（源租户谓词）
    // 也枚举不到这条 derived_from_replay 链节点（派生事实与源事实跨租户脱钩）。
    // 非 admin 路径源事件已被 org 谓词过滤，source.orgId 恒等于操作者 org，
    // 行为不变；存量 NULL-org 源事件回退操作者 org（保持旧行为）。
    const orgId = source.orgId ?? actor?.primaryOrgId ?? null;
    const newEventId = `RPL-${randomUUID().slice(0, 8)}`;
    const createdAt = new Date();
    await this.db.insert(ewohEvent).values({
      eventId: newEventId,
      deviceId: source.deviceId ?? null,
      eventCode: `REPLAY_${body.kind.toUpperCase()}`,
      eventType: body.kind,
      // B7（2026-08-19 审计）：事件严重度统一 canonical（原 legacy L1/L2）。
      severity: body.kind === 'issue' ? 'high' : 'low',
      title: body.title?.trim() || `回放${body.kind}：${source.title ?? source.eventId}`,
      status: 'open',
      createdAt,
      sourceType: 'replayed',
      // ADR-009 / standalone_066: Event Envelope fields.
      occurredAt: createdAt,
      receivedAt: new Date(),
      schemaVersion: '1.0.0',
      correlationId: null,
      causationId: null,
      confidence: null,
      orgId,
      evidenceJson: {
        sourceEventId: body.eventId,
        sourceTitle: source.title ?? null,
        note: body.note?.trim() ?? null,
        replayTime: body.replayTime ?? null,
        originalSeverity: source.severity ?? null,
      },
    });
    await this.db.insert(ewohEventChain).values({
      eventId: newEventId,
      parentEventId: body.eventId,
      causalType: 'derived_from_replay',
      description: `${body.kind} created from replay context`,
      createdAt,
      orgId,
    });
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: orgId ?? '',
      action: 'world.replay.item.create',
      entityType: 'event',
      entityId: newEventId,
      before: null,
      after: {
        sourceEventId: body.eventId,
        kind: body.kind,
        title: body.title?.trim() ?? null,
      },
    });
    return {
      eventId: newEventId,
      kind: body.kind,
      title: body.title?.trim() || source.title,
      createdAt: createdAt.toISOString(),
    };
  }
}
