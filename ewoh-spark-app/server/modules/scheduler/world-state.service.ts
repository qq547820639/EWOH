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
import { deriveDeviceCapabilities } from './device-capabilities';

/** 资源数据新鲜度阈值（ms）：sourceTs 距今超过该值则标 STALE。 */
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

/** 世界状态快照服务：构建/持久化/新鲜度校验。 */
@Injectable()
export class WorldStateSnapshotService {
  private readonly logger = new Logger(WorldStateSnapshotService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}
  // 资源数据新鲜度阈值（ms）。必须为类字段而非构造参数：
  // Nest DI 会将构造参数按类型 token 解析，原始类型 number 无法注入 → 启动崩溃
  // （此前误改构造参数导致 standalone 启动失败，见 Batch 12 修复）。
  private readonly freshnessMs = DEFAULT_FRESHNESS_MS;

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

  /** 汇总当前世界状态（不持久化快照）。供只读查询（如候选资源）复用同一真实状态。 */
  async getCurrentWorldState(): Promise<
    Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>
  > {
    return this.collectState();
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

    // 人员下一次可用时间：取该人员未来 reservation 的最大结束时间（真实占用）。
    const personReservationEnd = new Map<string, number>();
    for (const r of reservations) {
      if (r.resourceType === 'person' && r.endMs != null) {
        const cur = personReservationEnd.get(r.resourceId) ?? 0;
        if (r.endMs > cur) personReservationEnd.set(r.resourceId, r.endMs);
      }
    }

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
        // 坐标缺失 → 显式 UNKNOWN（null），禁止用 0 冒充真实坐标。
        x: se ? (se.x ?? null) : null,
        y: se ? (se.y ?? null) : null,
        availableFromMs: personReservationEnd.get(p.id) ?? null,
        shift: p.shift ?? null,
        workload: p.workload ?? null,
        currentTaskId: p.currentTaskId ?? null,
        certificationExpiry: this.parseCertificationExpiry(p.certificationExpiry),
        sourceTs,
        freshnessMs: this.freshnessMs,
        dataQuality,
      };
    });

    // 设备 → 当前绑定人员（targetType='person' 且 active）。
    // 注：设备位置不再借用人员坐标（见 01 §4.1），绑定仅用于安全事件影响链。

    // 工位列表（v0.7 A1：提前计算，供任务 candidateStations 派生使用）。
    const stations = spatialEntities
      .filter((se) => ['workstation', 'station'].includes(se.entityType))
      .map((se) => {
        // 工位容量：读 capacity 列（真实来源，替代 extra.capacity 非正式字段），否则 null。
        const capacity =
          typeof se.capacity === 'number' && se.capacity > 0 ? se.capacity : null;
        return {
          id: se.entityId,
          name: se.name,
          // P0：坐标缺失显式 null（禁止 0,0 伪坐标；无坐标工位不参与定位决策）。
          x: se.x ?? null,
          y: se.y ?? null,
          capacity,
          queue: this.asStringArray(se.queue),
          availableWindows: this.parseWindows(se.availableWindows),
        };
      });

    const taskList = tasks.map((t) => {
      // 派生字段标记：本快照中这些字段来自派生而非真实列（P1-T2）。
      const derived: string[] = [];

      // safetyCritical：新列优先；列无值才派生并带 derived 标记（替代白名单直接猜测）。
      const safetyCritical = t.safetyCritical ?? this.deriveSafetyCritical(t.taskType);
      if (t.safetyCritical == null) derived.push('safetyCritical');
      // preemptible：新列优先（替代固定 false）。
      const preemptible = t.preemptible ?? false;
      if (t.preemptible == null) derived.push('preemptible');
      // skillMatchMode：新列优先（替代固定 'ALL'）；运行时规整为 'ALL'|'ANY'。
      const skillMatchMode: 'ALL' | 'ANY' = t.skillMatchMode === 'ANY' ? 'ANY' : 'ALL';
      if (t.skillMatchMode == null) derived.push('skillMatchMode');
      // productionImpact：新列优先；列无值才按 priority 派生并带标记。
      const productionImpact = t.productionImpact ?? this.deriveProductionImpact(t.priority);
      if (t.productionImpact == null) derived.push('productionImpact');
      // requiredDeviceCapabilities：P1-TREQ 真实列优先（TaskRequirement 业务事实）。
      // 列值为空数组时按 taskType 白名单派生（backfill 兼容旧数据）并标记 derived；
      // 写入真实值的行标记 authoritative（derived[] 可区分）。
      const rawDeviceCaps = this.asStringArray(t.requiredDeviceCapabilities);
      const deviceCaps =
        rawDeviceCaps.length > 0
          ? rawDeviceCaps
          : this.deriveRequiredDeviceCapabilities(t.taskType);
      if (rawDeviceCaps.length === 0) derived.push('requiredDeviceCapabilities');
      // candidateStations：P1-TREQ 真实列优先（TaskRequirement 业务事实）；
      // 列无值则回退空间拓扑派生（zone 内工位/任务自身工位）并标记 derived。
      const rawCandidateStations = this.asStringArray(t.candidateStations);
      const candidateStations =
        rawCandidateStations.length > 0
          ? rawCandidateStations
          : this.deriveCandidateStations(
              t.spatialEntityId,
              spatialByEntityId,
              stations,
              spatialEntities,
            );
      if (rawCandidateStations.length === 0) derived.push('candidateStations');

      return {
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
        // P1-TREQ：设备能力需求——真实列优先（TaskRequirement 业务事实），
        // 列无值才回退 taskType 白名单派生（backfill 兼容，derived[] 标记）。
        // P1-TREQ：设备能力需求——真实列优先（TaskRequirement 业务事实），
        // 列无值才回退 taskType 白名单派生（backfill 兼容，derived[] 标记）。
        requiredDeviceCapabilities: deviceCaps,
        // P1-TREQ：候选工位——真实列优先，无值回退空间拓扑派生（derived[] 标记）。
        candidateStations,
        safetyCritical,
        preemptible,
        skillMatchMode,
        dueAtMs: t.planEnd ? t.planEnd.getTime() : null,
        productionImpact,
        // P1-T2：领域新列透传（有值取真实值，无值显式 null/空数组，绝不伪造）。
        basePriority: t.basePriority ?? null,
        earliestStartMs: t.earliestStartMs ?? null,
        latestFinishMs: t.latestFinishMs ?? null,
        downstreamImpact: t.downstreamImpact ?? null,
        requiredStationCapabilities: this.asStringArray(t.requiredStationCapabilities),
        preferredResources: this.asStringArray(t.preferredResources),
        excludedResources: this.asStringArray(t.excludedResources),
        derived,
      };
    });

    const deviceList = devices.map((d) => {
      const sourceTs = d.lastTelemetryAt
        ? d.lastTelemetryAt.getTime()
        : d.updatedAt
          ? d.updatedAt.getTime()
          : null;
      const dataQuality = this.classifyFreshness(sourceTs, now);
      const stale = dataQuality !== 'FRESH';
      const derived: string[] = [];
      // 能力：真实列优先（SSOT，消除两处语义不一致）；列无值才按型号白名单派生并标记。
      const columnCaps = this.asStringArray(d.capabilities);
      const capabilities =
        columnCaps.length > 0 ? columnCaps : deriveDeviceCapabilities(d.deviceModel);
      if (columnCaps.length === 0) derived.push('capabilities');
      // 位置：设备自身 location_lat/lng（真实遥测）；缺失则显式 UNKNOWN(null)，
      // 绝不借用人员坐标（见 01 §4.1）。
      const lat = d.locationLat ?? null;
      const lng = d.locationLng ?? null;
      const hasDeviceLocation = lat != null && lng != null;
      // 设备自身空间实体（entityId=deviceId），用于解析所在工位（parentId）。
      const deviceSe = d.deviceId ? spatialByEntityId.get(d.deviceId) : undefined;
      return {
        id: d.id,
        workerName: d.workerName ?? null,
        deviceModel: d.deviceModel ?? null,
        batteryPct: d.batteryPct ?? 100,
        capabilities,
        // STALE/UNKNOWN 设备不视为可用（离线/不可派）。
        online: stale ? false : (d.online ?? false),
        status: d.faultCode ? 'fault' : stale ? 'offline' : 'online',
        x: hasDeviceLocation ? lat : null,
        y: hasDeviceLocation ? lng : null,
        locationStationId: deviceSe ? (deviceSe.parentId ?? null) : null,
        availableWindows: this.parseWindows(d.availableWindows),
        locationConfidence: hasDeviceLocation ? (d.locationConfidence ?? null) : null,
        locationUpdatedAt: d.locationUpdatedAt ? d.locationUpdatedAt.getTime() : null,
        telemetryUpdatedAt: d.telemetryUpdatedAt ? d.telemetryUpdatedAt.getTime() : null,
        sourceTs,
        freshnessMs: this.freshnessMs,
        dataQuality,
        derived,
      };
    });

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
        shift: p.shift,
        workload: p.workload,
        currentTaskId: p.currentTaskId,
        certificationExpiry: p.certificationExpiry,
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
        basePriority: t.basePriority,
        earliestStartMs: t.earliestStartMs,
        latestFinishMs: t.latestFinishMs,
        safetyCritical: t.safetyCritical,
        preemptible: t.preemptible,
        skillMatchMode: t.skillMatchMode,
        productionImpact: t.productionImpact,
        downstreamImpact: t.downstreamImpact,
        requiredStationCapabilities: t.requiredStationCapabilities,
        preferredResources: t.preferredResources,
        excludedResources: t.excludedResources,
      });
    }
    for (const d of deviceList) {
      entityVersions[`device:${d.id}`] = this.entityVersion({
        batteryPct: d.batteryPct,
        online: d.online,
        status: d.status,
        capabilities: d.capabilities,
        x: d.x,
        y: d.y,
        locationStationId: d.locationStationId,
        locationConfidence: d.locationConfidence,
        telemetryUpdatedAt: d.telemetryUpdatedAt,
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
        capacity: s.capacity,
        queue: s.queue,
        availableWindows: s.availableWindows,
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

  /**
   * v0.7 Batch5.3：从任务类型派生设备能力需求（重体力/搬运类 → exo-lift）。
   * 与 safetyCritical 白名单同源语义；未命中返回空数组（无能力要求）。
   */
  private deriveRequiredDeviceCapabilities(taskType: string): string[] {
    const t = (taskType ?? '').toLowerCase();
    if (
      t.includes('lift') ||
      t.includes('carry') ||
      t.includes('heavy') ||
      t.includes('handling') ||
      t.includes('搬运') ||
      t.includes('重体力') ||
      t.includes('物料')
    ) {
      return ['exo-lift'];
    }
    return [];
  }

  /** jsonb 数组列可能以 unknown 返回；安全地规整为 string[]。 */
  private asStringArray(v: unknown): string[] {
    return Array.isArray(v)
      ? (v as string[]).filter((x): x is string => typeof x === 'string')
      : [];
  }

  /**
   * 解析 jsonb 可用窗口列（[{ startMs, endMs }]）；非法条目丢弃（runtime validation，
   * 禁止 as unknown as 逃避类型检查）。无值/非数组返回空数组。
   */
  private parseWindows(v: unknown): Array<{ startMs: number; endMs: number }> {
    if (!Array.isArray(v)) return [];
    const out: Array<{ startMs: number; endMs: number }> = [];
    for (const item of v) {
      if (this.isWindow(item)) out.push({ startMs: item.startMs, endMs: item.endMs });
    }
    return out;
  }

  /** 可用窗口条目形状守卫。 */
  private isWindow(v: unknown): v is { startMs: number; endMs: number } {
    if (typeof v !== 'object' || v === null) return false;
    const rec = v as Record<string, unknown>;
    return typeof rec.startMs === 'number' && typeof rec.endMs === 'number';
  }

  /**
   * 解析证书到期平行列（[{ name, expiresAtMs }]，决策 D-A）。
   * 无值/非数组返回空数组；name 缺失的条目丢弃。
   */
  private parseCertificationExpiry(
    v: unknown,
  ): Array<{ name: string; expiresAtMs: number | null }> {
    if (!Array.isArray(v)) return [];
    const out: Array<{ name: string; expiresAtMs: number | null }> = [];
    for (const item of v) {
      if (typeof item !== 'object' || item === null) continue;
      const rec = item as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name : '';
      const expiresAtMs = typeof rec.expiresAtMs === 'number' ? rec.expiresAtMs : null;
      if (name) out.push({ name, expiresAtMs });
    }
    return out;
  }

  /**
   * v0.7 A1：从任务类型派生安全关键语义（重体力/搬运类），保守默认 false。
   * 仅作白名单匹配，未命中的任务绝不被误判为安全关键（避免误阻断）。
   */
  private deriveSafetyCritical(taskType: string): boolean {
    const criticalTypes = [
      'lift',
      'carry',
      'heavy_lift',
      'material_handling',
      '搬运',
      '重体力',
      '物料搬运',
      'lifting',
    ];
    const t = (taskType ?? '').toLowerCase();
    return criticalTypes.some((k) => t.includes(k.toLowerCase()));
  }

  /**
   * v0.7 A1：从优先级语义派生生产影响度 0..1（越高越影响产线节拍）。
   * urgent/critical 视为最高影响；缺省 0 保持向后兼容。
   */
  private deriveProductionImpact(priority: string): number {
    switch ((priority ?? '').toLowerCase()) {
      case 'urgent':
      case 'critical':
        return 1.0;
      case 'high':
        return 0.7;
      case 'medium':
        return 0.4;
      case 'low':
        return 0.1;
      default:
        return 0;
    }
  }

  /**
   * v0.7 A1：推导候选工位 = 任务所在 zone（父区域）内的所有工位。
   * 任务绑定工位可解析到父区域 → 返回该区域内全部工位（就近分配候选）；
   * 无 zone 但任务绑定工位本身是工位 → 回退 [stationId]；
   * 均不可解析 → 空数组（求解器回退到无候选约束）。
   */
  private deriveCandidateStations(
    spatialEntityId: string | null,
    spatialByEntityId: Map<string, { entityId: string; entityType: string | null; parentId: string | null }>,
    stations: Array<{ id: string }>,
    allSpatialEntities: Array<{ entityId: string; entityType: string | null; parentId: string | null }>,
  ): string[] {
    if (!spatialEntityId) return [];
    const se = spatialByEntityId.get(spatialEntityId);
    if (!se) return [];
    // 任务绑定工位本身就是 station → 直接回退。
    if (['workstation', 'station'].includes(se.entityType)) {
      return [se.entityId];
    }
    // 任务绑定的是区域/设备 → 取其父区域（zone）内的所有工位。
    const zoneId = se.parentId ?? se.entityId;
    const zone = spatialByEntityId.get(zoneId);
    const zoneChildren = zone
      ? allSpatialEntities.filter((s) => s.parentId === zoneId)
      : allSpatialEntities.filter((s) => s.entityId === zoneId);
    const inZone = zoneChildren
      .filter((s) => ['workstation', 'station'].includes(s.entityType))
      .map((s) => s.entityId);
    if (inZone.length > 0) return inZone;
    // 兜底：绑定工位自身（若在 stations 中）。
    if (stations.some((s) => s.id === spatialEntityId)) {
      return [spatialEntityId];
    }
    return [];
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