import { Injectable, Inject, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohSpatialEntity, ewohWorldState, ewohEvent, ewohEventChain } from '@server/database/schema';
import { eq, desc, and, gte, lte, sql, or, asc, inArray } from 'drizzle-orm';
import type { CurrentWorldState, EventChainNode, ReplaySnapshot } from '@shared/api.interface';

type SpatialEntityRow = typeof ewohSpatialEntity.$inferSelect;
type WorldStateRow = typeof ewohWorldState.$inferSelect;

@Injectable()
export class WorldService {
  private readonly logger = new Logger(WorldService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /**
   * 聚合当前世界状态快照：人员 / 设备 / 工位 / 最近事件
   */
  async getCurrentState(): Promise<CurrentWorldState> {
    try {
      const [personEntities, deviceEntities, workstationEntities, recentEvents] = await Promise.all([
        this.db.select().from(ewohSpatialEntity).where(eq(ewohSpatialEntity.entityType, 'person')),
        this.db.select().from(ewohSpatialEntity).where(eq(ewohSpatialEntity.entityType, 'device')),
        this.db.select().from(ewohSpatialEntity).where(eq(ewohSpatialEntity.entityType, 'workstation')),
        this.db.select().from(ewohEvent).orderBy(desc(ewohEvent.createdAt)).limit(20),
      ]);

      const allEntityIds = [
        ...personEntities.map((p) => p.entityId),
        ...deviceEntities.map((d) => d.entityId),
        ...workstationEntities.map((w) => w.entityId),
      ];

      // 取每个 entity 的最新 world_state（按 ts desc 取首条）
      const latestStatesMap = new Map<string, WorldStateRow>();
      if (allEntityIds.length > 0) {
        const states = await this.db
          .select()
          .from(ewohWorldState)
          .where(inArray(ewohWorldState.entityId, allEntityIds))
          .orderBy(desc(ewohWorldState.ts));
        for (const s of states) {
          if (!latestStatesMap.has(s.entityId)) {
            latestStatesMap.set(s.entityId, s);
          }
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

      return {
        persons,
        devices,
        workstations,
        events,
        ts: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('getCurrentState 失败', error);
      throw error;
    }
  }

  /**
   * 查询事件的因果链节点：包括自己作为 event_id 的、作为 parent_event_id 的
   */
  async getEventChain(eventId: string): Promise<EventChainNode[]> {
    try {
      const rows = await this.db
        .select()
        .from(ewohEventChain)
        .where(
          or(
            eq(ewohEventChain.eventId, eventId),
            eq(ewohEventChain.parentEventId, eventId),
          ),
        )
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
   * 时间轴回放：按分钟分组取代表记录，构建 ReplaySnapshot
   */
  async getReplay(from?: string, to?: string, limit = 100): Promise<ReplaySnapshot[]> {
    try {
      const now = new Date();
      const toTime = to ? new Date(to) : now;
      const fromTime = from ? new Date(from) : new Date(toTime.getTime() - 60 * 60 * 1000);
      const safeLimit = Math.min(Math.max(limit, 1), 1000);

      // 边界校验：非法时间或区间反向直接返回空
      if (
        Number.isNaN(fromTime.getTime()) ||
        Number.isNaN(toTime.getTime()) ||
        fromTime.getTime() > toTime.getTime()
      ) {
        return [];
      }

      const states = await this.db
        .select()
        .from(ewohWorldState)
        .where(and(gte(ewohWorldState.ts, fromTime), lte(ewohWorldState.ts, toTime)))
        .orderBy(desc(ewohWorldState.ts))
        .limit(safeLimit * 10);

      // 按 ts 分钟分组（YYYY-MM-DDTHH:MM）
      const byMinute = new Map<string, WorldStateRow[]>();
      for (const s of states) {
        const key = s.ts.toISOString().slice(0, 16);
        if (!byMinute.has(key)) byMinute.set(key, []);
        byMinute.get(key)!.push(s);
      }

      // 时间范围内的事件
      const events = await this.db
        .select()
        .from(ewohEvent)
        .where(and(gte(ewohEvent.createdAt, fromTime), lte(ewohEvent.createdAt, toTime)))
        .orderBy(desc(ewohEvent.createdAt));

      const sortedKeys = Array.from(byMinute.keys()).sort().reverse().slice(0, safeLimit);
      const snapshots: ReplaySnapshot[] = [];
      for (const key of sortedKeys) {
        const groupStates = byMinute.get(key)!;
        const persons: ReplaySnapshot['persons'] = [];
        const devices: ReplaySnapshot['devices'] = [];
        for (const s of groupStates) {
          const state = (s.stateJson ?? {}) as Record<string, unknown>;
          const entityType = state.entity_type as string | undefined;
          const entry = {
            entityId: s.entityId,
            x: state.x != null ? Number(state.x) : 0,
            y: state.y != null ? Number(state.y) : 0,
            status: state.status != null ? String(state.status) : 'active',
          };
          if (entityType === 'person') {
            persons.push({
              ...entry,
              loadScore:
                state.load_score != null ? Number(state.load_score) : undefined,
            });
          } else if (entityType === 'device') {
            devices.push(entry);
          }
        }
        const ts = new Date(key + ':00Z');
        const minuteEvents = events.filter(
          (e) => e.createdAt && Math.abs(e.createdAt.getTime() - ts.getTime()) < 60000,
        );
        snapshots.push({
          ts: ts.toISOString(),
          persons,
          devices,
          events: minuteEvents.map((e) => ({
            eventId: e.eventId,
            severity: e.severity ?? '',
            title: e.title ?? '',
          })),
        });
      }
      return snapshots;
    } catch (error) {
      this.logger.error('getReplay 失败', error);
      throw error;
    }
  }
}
