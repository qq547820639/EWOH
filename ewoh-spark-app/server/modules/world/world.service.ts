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
import { eq, desc, and, gte, lte, sql, or, asc, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { CurrentWorldState, EventChainNode, ReplaySnapshot } from '@shared/api.interface';
import { AuditService } from '../shared/audit.service';

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

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

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
   * 时间轴回放：合并世界状态、事件、任务、工序与物料变化的统一时间轴
   */
  async getReplay(from?: string, to?: string, limit = 100): Promise<ReplaySnapshot[]> {
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

      const states = await this.db
        .select()
        .from(ewohWorldState)
        .where(and(gte(ewohWorldState.ts, fromTime), lte(ewohWorldState.ts, toTime)))
        .orderBy(desc(ewohWorldState.ts))
        .limit(safeLimit * 10);

      const events = await this.db
        .select()
        .from(ewohEvent)
        .where(and(gte(ewohEvent.createdAt, fromTime), lte(ewohEvent.createdAt, toTime)))
        .orderBy(desc(ewohEvent.createdAt));

      const tasks = await this.db
        .select()
        .from(ewohScheduleTask)
        .where(
          and(
            gte(ewohScheduleTask.updatedAt, fromTime),
            lte(ewohScheduleTask.updatedAt, toTime),
          ),
        )
        .limit(2000);

      const steps = await this.db
        .select()
        .from(ewohScheduleTaskStep)
        .where(
          and(
            gte(ewohScheduleTaskStep.updatedAt, fromTime),
            lte(ewohScheduleTaskStep.updatedAt, toTime),
          ),
        )
        .limit(4000);

      const materials = await this.db
        .select()
        .from(ewohResourceBinding)
        .where(
          and(
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
          severity: 'L1',
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
          severity: 'L1',
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
          severity: 'L1',
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
      const snapshots: ReplaySnapshot[] = [];
      for (const key of minuteKeys) {
        const groupStates = byMinute.get(key) ?? [];
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

  async getEventContext(eventId: string, windowMinutes = 10) {
    const [source] = await this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.eventId, eventId));
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
    const [source] = await this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.eventId, body.eventId));
    if (!source) {
      throw new NotFoundException(`Event ${body.eventId} not found`);
    }
    const newEventId = `RPL-${randomUUID().slice(0, 8)}`;
    const createdAt = new Date();
    await this.db.insert(ewohEvent).values({
      eventId: newEventId,
      deviceId: source.deviceId ?? null,
      eventCode: `REPLAY_${body.kind.toUpperCase()}`,
      eventType: body.kind,
      severity: body.kind === 'issue' ? 'L2' : 'L1',
      title: body.title?.trim() || `回放${body.kind}：${source.title ?? source.eventId}`,
      status: 'open',
      createdAt,
      sourceType: 'replayed',
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
    });
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
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
