import { Injectable, Inject, Logger, ConflictException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohPersonnel,
  ewohDevice,
  ewohProductionTask,
  ewohSpatialEntity,
  ewohEvent,
  ewohRouteNode,
  ewohRouteEdge,
  ewohWorldStateSnapshot,
} from '@server/database/schema';
import { eq, desc, like } from 'drizzle-orm';
import type { WorldStateSnapshot } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';

/** 世界状态快照服务：构建/持久化/新鲜度校验。 */
@Injectable()
export class WorldStateSnapshotService {
  private readonly logger = new Logger(WorldStateSnapshotService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  /**
   * 基于实时的 ewoh 表状态构建并持久化一个世界状态快照。
   * 快照版本形如 WS-YYYYMMDD-NNNN（按天递增）。
   */
  async buildSnapshot(ctx: OrgContext): Promise<WorldStateSnapshot> {
    const state = await this.collectState();
    const snapshotVersion = await this.nextSnapshotVersion();
    const snapshot: WorldStateSnapshot = {
      ...state,
      snapshotVersion,
      ts: new Date().toISOString(),
    };

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db.insert(ewohWorldStateSnapshot).values({
          snapshotVersion,
          snapshotJson: snapshot as unknown as Record<string, unknown>,
          createdAt: new Date(),
        });
      },
    );
    this.logger.log(`world state snapshot built: ${snapshotVersion}`);
    return snapshot;
  }

  async getSnapshot(
    snapshotVersion: string,
  ): Promise<WorldStateSnapshot | null> {
    const [row] = await this.db
      .select()
      .from(ewohWorldStateSnapshot)
      .where(eq(ewohWorldStateSnapshot.snapshotVersion, snapshotVersion))
      .limit(1);
    return row
      ? (row.snapshotJson as unknown as WorldStateSnapshot)
      : null;
  }

  /**
   * 判断给定快照是否仍然新鲜：若自快照以来没有重大状态变化则返回 true。
   */
  async isSnapshotFresh(snapshotVersion: string): Promise<boolean> {
    const snapshot = await this.getSnapshot(snapshotVersion);
    if (!snapshot) return false;
    const current = await this.collectState();
    return this.fingerprintEqual(
      this.fingerprint(snapshot),
      this.fingerprint(current),
    );
  }

  /**
   * 审批前的快照新鲜度强校验；过期时抛出 PLAN_STALE 冲突。
   */
  async assertFreshForApprove(snapshotVersion: string): Promise<void> {
    const fresh = await this.isSnapshotFresh(snapshotVersion);
    if (!fresh) {
      throw new ConflictException('PLAN_STALE');
    }
  }

  /** 汇总当前世界状态（不持久化）。 */
  private async collectState(): Promise<
    Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>
  > {
    const [personnel, devices, tasks, spatialEntities, events, routeNodes, routeEdges] =
      await Promise.all([
        this.db.select().from(ewohPersonnel),
        this.db.select().from(ewohDevice),
        this.db.select().from(ewohProductionTask),
        this.db.select().from(ewohSpatialEntity),
        this.db.select().from(ewohEvent),
        this.db.select().from(ewohRouteNode),
        this.db.select().from(ewohRouteEdge),
      ]);

    const spatialByEntityId = new Map<string, (typeof spatialEntities)[number]>();
    for (const se of spatialEntities) spatialByEntityId.set(se.entityId, se);

    const persons = personnel.map((p) => {
      const se = p.spatialEntityId
        ? spatialByEntityId.get(p.spatialEntityId)
        : undefined;
      const load = (p.currentLoad as { loadLevel?: number } | null) ?? {};
      const fatigue = (p.currentLoad as { fatigueLevel?: number } | null) ?? {};
      return {
        id: p.id,
        name: p.name,
        status: p.status ?? 'available',
        healthStatus: p.healthStatus ?? 'normal',
        skills: Array.isArray(p.skills) ? (p.skills as string[]) : [],
        loadLevel: load.loadLevel ?? 0,
        fatigueLevel: fatigue.fatigueLevel ?? 0,
        stationId: p.spatialEntityId ?? null,
        zoneId: se ? (se.parentId ?? null) : null,
        x: se ? (se.x ?? 0) : 0,
        y: se ? (se.y ?? 0) : 0,
      };
    });

    const taskList = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      taskType: t.taskType,
      priority: t.priority,
      status: t.status,
      assigneeId: t.assigneeId ?? null,
      deviceId: t.deviceId ?? null,
      stationId: t.spatialEntityId ?? null,
      zoneId: t.spatialEntityId
        ? (spatialByEntityId.get(t.spatialEntityId)?.parentId ?? null)
        : null,
      planStart: t.planStart ? t.planStart.toISOString() : null,
      planEnd: t.planEnd ? t.planEnd.toISOString() : null,
      progress: t.progress ?? 0,
      predecessorIds: [],
    }));

    const stations = spatialEntities
      .filter((se) => ['workstation', 'station'].includes(se.entityType))
      .map((se) => ({
        id: se.entityId,
        name: se.name,
        x: se.x ?? 0,
        y: se.y ?? 0,
      }));

    const stationCounts = new Map<string, number>();
    for (const t of taskList) {
      if (t.stationId) {
        stationCounts.set(t.stationId, (stationCounts.get(t.stationId) ?? 0) + 1);
      }
    }
    const backlog = Array.from(stationCounts.entries()).map(([taskId, count]) => ({
      taskId,
      count,
    }));

    const eventList = events.map((e) => ({
      eventId: e.eventId,
      severity: e.severity ?? 'L1',
      status: e.status ?? 'open',
      eventType: e.eventType ?? null,
    }));

    const routeStatus = routeEdges.map((e) => ({
      edgeId: e.edgeId,
      status: e.status ?? 'open',
      riskLevel: e.riskLevel ?? null,
    }));

    const forbiddenZones = spatialEntities
      .filter((se) => se.entityType === 'restricted_zone')
      .map((se) => ({ zoneId: se.entityId, reason: 'restricted_zone' }));

    const lockedAssignments = taskList
      .filter((t) =>
        ['executing', 'dispatched', 'in_progress'].includes(t.status),
      )
      .map((t) => ({
        taskId: t.id,
        personId: t.assigneeId,
        deviceId: t.deviceId,
        stationId: t.stationId,
      }));

    return {
      persons,
      tasks: taskList,
      devices: devices.map((d) => ({
        id: d.id,
        workerName: d.workerName ?? null,
        deviceModel: d.deviceModel ?? null,
        batteryPct: d.batteryPct ?? 100,
        online: d.online ?? false,
        status: d.faultCode ? 'fault' : 'online',
      })),
      stations,
      backlog,
      events: eventList,
      routeStatus,
      forbiddenZones,
      lockedAssignments,
    };
  }

  /** 生成形如 WS-YYYYMMDD-NNNN 的递增快照版本。 */
  private async nextSnapshotVersion(): Promise<string> {
    const prefix = `WS-${this.dateStamp(new Date())}`;
    const rows = await this.db
      .select({ snapshotVersion: ewohWorldStateSnapshot.snapshotVersion })
      .from(ewohWorldStateSnapshot)
      .where(like(ewohWorldStateSnapshot.snapshotVersion, `${prefix}-%`))
      .orderBy(desc(ewohWorldStateSnapshot.snapshotVersion))
      .limit(1);
    const last = rows[0]?.snapshotVersion;
    const lastSeq = last ? Number(last.split('-').pop()) || 0 : 0;
    return `${prefix}-${String(lastSeq + 1).padStart(4, '0')}`;
  }

  private dateStamp(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  /** 计算状态指纹（用于快照新鲜度比较）。 */
  private fingerprint(
    s: Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>,
  ): Record<string, number> {
    return {
      openEvents: s.events.filter((e) => e.status === 'open').length,
      unavailablePersons: s.persons.filter((p) => p.status !== 'available').length,
      lowBatteryDevices: s.devices.filter((d) => d.batteryPct < 20).length,
      pendingTasks: s.tasks.filter((t) =>
        ['draft', 'pending', 'queued'].includes(t.status),
      ).length,
      forbiddenZones: s.forbiddenZones.length,
    };
  }

  private fingerprintEqual(
    a: Record<string, number>,
    b: Record<string, number>,
  ): boolean {
    return Object.keys(a).every((k) => a[k] === b[k]);
  }
}