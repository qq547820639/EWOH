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
  ewohResourceReservation,
  ewohDeviceBinding,
} from '@server/database/schema';
import { eq, desc, like, and, or } from 'drizzle-orm';
import type { WorldStateSnapshot } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';

/** 资源数据新鲜度阈值（ms）：sourceTs 距今超过该值则标 STALE。 */
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

/** 世界状态快照服务：构建/持久化/新鲜度校验。 */
@Injectable()
export class WorldStateSnapshotService {
  private readonly logger = new Logger(WorldStateSnapshotService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly freshnessMs: number = DEFAULT_FRESHNESS_MS,
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
   * 判断给定快照是否仍然新鲜：比较 entityVersions 映射与 reservations 列表，
   * 两者完全一致才视为新鲜（基于实体版本，而非粗略计数）。
   */
  async isSnapshotFresh(snapshotVersion: string): Promise<boolean> {
    const snapshot = await this.getSnapshot(snapshotVersion);
    if (!snapshot) return false;
    const current = await this.collectState();
    return (
      this.mapsEqual(snapshot.entityVersions, current.entityVersions) &&
      this.reservationsEqual(snapshot.reservations, current.reservations)
    );
  }

  /**
   * 判断给定快照版本是否已过期（关键状态发生变更）。
   * 返回 true 表示绑定到该快照的方案已过期，审批应拒绝。
   * 与 isSnapshotFresh 互为反义，语义上更贴近"方案过期"判定。
   */
  async isPlanStale(snapshotVersion: string): Promise<boolean> {
    return !(await this.isSnapshotFresh(snapshotVersion));
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
    const [
      personnel,
      devices,
      tasks,
      spatialEntities,
      events,
      routeNodes,
      routeEdges,
      reservations,
      deviceBindings,
    ] = await Promise.all([
      this.db.select().from(ewohPersonnel),
      this.db.select().from(ewohDevice),
      this.db.select().from(ewohProductionTask),
      this.db.select().from(ewohSpatialEntity),
      this.db.select().from(ewohEvent),
      this.db.select().from(ewohRouteNode),
      this.db.select().from(ewohRouteEdge),
      this.db
        .select()
        .from(ewohResourceReservation)
        .where(
          or(
            eq(ewohResourceReservation.status, 'reserved'),
            eq(ewohResourceReservation.status, 'active'),
          ),
        ),
      this.db
        .select()
        .from(ewohDeviceBinding)
        .where(
          and(
            eq(ewohDeviceBinding.targetType, 'person'),
            eq(ewohDeviceBinding.status, 'active'),
          ),
        ),
    ]);

    const spatialByEntityId = new Map<string, (typeof spatialEntities)[number]>();
    for (const se of spatialEntities) spatialByEntityId.set(se.entityId, se);

    const now = Date.now();

    const persons = personnel.map((p) => {
      const se = p.spatialEntityId
        ? spatialByEntityId.get(p.spatialEntityId)
        : undefined;
      const load = (p.currentLoad as { loadLevel?: number } | null) ?? {};
      const fatigue = (p.currentLoad as { fatigueLevel?: number } | null) ?? {};
      const sourceTs = p.updatedAt ? p.updatedAt.getTime() : null;
      const dataQuality = this.classifyFreshness(sourceTs, now);
      return {
        id: p.id,
        name: p.name,
        // STALE/UNKNOWN 数据不被视为可用（不透支决策）。
        status:
          dataQuality === 'FRESH' ? (p.status ?? 'available') : 'unavailable',
        healthStatus: p.healthStatus ?? 'normal',
        skills: this.asStringArray(p.skills),
        certifications: this.asStringArray(p.certifications),
        loadLevel: load.loadLevel ?? 0,
        fatigueLevel: fatigue.fatigueLevel ?? 0,
        stationId: p.spatialEntityId ?? null,
        zoneId: se ? (se.parentId ?? null) : null,
        x: se ? (se.x ?? 0) : 0,
        y: se ? (se.y ?? 0) : 0,
        sourceTs,
        freshnessMs: this.freshnessMs,
        dataQuality,
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
      predecessorIds: this.asStringArray(t.predecessorIds),
      requiredSkills: this.asStringArray(t.requiredSkills),
      requiredCertifications: this.asStringArray(t.requiredCertifications),
    }));

    const deviceList = devices.map((d) => {
      const sourceTs = d.lastTelemetryAt
        ? d.lastTelemetryAt.getTime()
        : d.updatedAt
          ? d.updatedAt.getTime()
          : null;
      const dataQuality = this.classifyFreshness(sourceTs, now);
      const stale = dataQuality !== 'FRESH';
      return {
        id: d.id,
        workerName: d.workerName ?? null,
        deviceModel: d.deviceModel ?? null,
        batteryPct: d.batteryPct ?? 100,
        // STALE/UNKNOWN 设备不视为可用（离线/不可派）。
        online: stale ? false : (d.online ?? false),
        status: d.faultCode ? 'fault' : stale ? 'offline' : 'online',
        sourceTs,
        freshnessMs: this.freshnessMs,
        dataQuality,
      };
    });

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

    // ---- 安全事件映射 ----
    // deviceId → 活跃人员 targetId（仅保留 targetType='person' 且 status='active'）
    const deviceBindingByDevice = new Map<string, string>();
    for (const db of deviceBindings) {
      if (!deviceBindingByDevice.has(db.deviceId)) {
        deviceBindingByDevice.set(db.deviceId, db.targetId);
      }
    }

    const safetyBlockedPersonIds = new Set<string>();
    const safetyBlockedDeviceIds = new Set<string>();
    const safetyForbiddenZones = new Set<string>();

    for (const e of events) {
      if (e.status !== 'open') continue;
      if (e.severity !== 'L2' && e.severity !== 'L3') continue;

      const reasons: string[] = [];
      const deviceId = e.deviceId ?? null;

      if (deviceId) {
        safetyBlockedDeviceIds.add(deviceId);
        const boundPersonId = deviceBindingByDevice.get(deviceId);
        if (boundPersonId) {
          safetyBlockedPersonIds.add(boundPersonId);
        } else {
          reasons.push(`device ${deviceId} has no active person binding`);
        }
        const affectedZoneId = spatialByEntityId.get(deviceId)?.parentId ?? null;
        if (affectedZoneId) {
          safetyForbiddenZones.add(affectedZoneId);
        } else {
          reasons.push(`device ${deviceId} has no spatial entity to resolve zone`);
        }
      } else {
        reasons.push('no deviceId');
      }

      // 证据链中可选的影响范围，合并进 blocked 集合
      const evidence = (e.evidenceJson ?? {}) as Record<string, unknown>;
      for (const pid of this.asStringArray(evidence.affectedPersonIds)) {
        safetyBlockedPersonIds.add(pid);
      }
      for (const did of this.asStringArray(evidence.affectedDeviceIds)) {
        safetyBlockedDeviceIds.add(did);
      }
      for (const zid of this.asStringArray(evidence.affectedZoneIds)) {
        safetyForbiddenZones.add(zid);
      }

      if (reasons.length > 0) {
        this.logger.warn(
          `safety event ${e.eventId} (${e.severity}) partially unresolved: ${reasons.join('; ')}`,
        );
      }
    }

    for (const zoneId of safetyForbiddenZones) {
      if (!forbiddenZones.some((z) => z.zoneId === zoneId)) {
        forbiddenZones.push({ zoneId, reason: 'safety_event' });
      }
    }

    const reservationList = reservations.map((r) => ({
      reservationId: r.reservationId,
      resourceId: r.resourceId,
      resourceType: r.resourceType,
      startMs: r.startMs,
      endMs: r.endMs,
    }));

    // ---- 基于内容的实体版本摘要 ----
    const entityVersions: Record<string, number> = {};
    for (const p of persons) {
      entityVersions[`person:${p.id}`] = this.entityVersion({
        status: p.status,
        healthStatus: p.healthStatus,
        loadLevel: p.loadLevel,
        fatigueLevel: p.fatigueLevel,
        x: p.x,
        y: p.y,
        skills: p.skills,
        certifications: p.certifications,
      });
    }
    for (const t of taskList) {
      entityVersions[`task:${t.id}`] = this.entityVersion({
        status: t.status,
        priority: t.priority,
        planStart: t.planStart,
        planEnd: t.planEnd,
        assigneeId: t.assigneeId,
        deviceId: t.deviceId,
        predecessorIds: t.predecessorIds,
        requiredSkills: t.requiredSkills,
        requiredCertifications: t.requiredCertifications,
      });
    }
    for (const d of deviceList) {
      entityVersions[`device:${d.id}`] = this.entityVersion({
        batteryPct: d.batteryPct,
        online: d.online,
        status: d.status,
      });
    }
    for (const r of routeStatus) {
      entityVersions[`route:${r.edgeId}`] = this.entityVersion({
        status: r.status,
        riskLevel: r.riskLevel,
      });
    }
    for (const s of stations) {
      entityVersions[`station:${s.id}`] = this.entityVersion({
        name: s.name,
        x: s.x,
        y: s.y,
      });
    }
    for (const fz of forbiddenZones) {
      entityVersions[`zone:${fz.zoneId}`] = this.entityVersion({
        zoneId: fz.zoneId,
        reason: fz.reason,
      });
    }
    for (const r of reservationList) {
      entityVersions[`reservation:${r.resourceType}:${r.resourceId}`] =
        this.entityVersion({ startMs: r.startMs, endMs: r.endMs });
    }
    entityVersions['safety'] = this.entityVersion({
      safetyBlockedPersonIds: Array.from(safetyBlockedPersonIds),
      safetyBlockedDeviceIds: Array.from(safetyBlockedDeviceIds),
      forbiddenZones,
    });

    // 粗略的单调标量，用于展示/排序；权威新鲜度信号见 entityVersions 精确比较。
    let versionSum = 0;
    for (const v of Object.values(entityVersions)) versionSum += v;
    const worldVersion = 1000 + versionSum + reservationList.length;

    return {
      worldVersion,
      entityVersions,
      reservations: reservationList,
      safetyBlockedPersonIds: Array.from(safetyBlockedPersonIds),
      safetyBlockedDeviceIds: Array.from(safetyBlockedDeviceIds),
      persons,
      tasks: taskList,
      devices: deviceList,
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

  /** jsonb 数组列可能以 unknown 返回；安全地规整为 string[]。 */
  private asStringArray(v: unknown): string[] {
    return Array.isArray(v)
      ? (v as string[]).filter((x): x is string => typeof x === 'string')
      : [];
  }

  /** djb2 字符串哈希。 */
  private hash(str: string): number {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  /** 基于对象 JSON 序列化内容的实体版本。 */
  private entityVersion(obj: unknown): number {
    return this.hash(JSON.stringify(obj));
  }

  /**
   * 依据来源时间戳与新鲜度阈值判定资源数据质量。
   * 无时间戳 → UNKNOWN；距今超过阈值 → STALE；否则 FRESH。
   */
  private classifyFreshness(
    sourceTs: number | null,
    now: number,
  ): 'FRESH' | 'STALE' | 'UNKNOWN' {
    if (sourceTs == null) return 'UNKNOWN';
    if (now - sourceTs > this.freshnessMs) return 'STALE';
    return 'FRESH';
  }

  /** 精确比较两个 entityVersions 映射（键集与每个值都需一致）。 */
  private mapsEqual(
    a: Record<string, number>,
    b: Record<string, number>,
  ): boolean {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((k) => b[k] === a[k]);
  }

  /** 精确比较两个 reservations 列表（id/type/时间窗一致）。 */
  private reservationsEqual(
    a: WorldStateSnapshot['reservations'],
    b: WorldStateSnapshot['reservations'],
  ): boolean {
    if (a.length !== b.length) return false;
    return a.every((ra, i) => {
      const rb = b[i];
      return (
        ra.reservationId === rb.reservationId &&
        ra.resourceId === rb.resourceId &&
        ra.resourceType === rb.resourceType &&
        ra.startMs === rb.startMs &&
        ra.endMs === rb.endMs
      );
    });
  }
}