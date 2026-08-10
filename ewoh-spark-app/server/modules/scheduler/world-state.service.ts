import { Injectable, Inject, Logger, ConflictException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
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
import type {
  SchedulingEventImpact,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ResourceProjectionService } from './resource-projection.service';

/** 世界状态快照服务：构建/持久化/新鲜度校验。 */
@Injectable()
export class WorldStateSnapshotService {
  private readonly logger = new Logger(WorldStateSnapshotService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    // T02 / P0-1（G1）：资源视图单一事实源（必选）。persons/devices/stations
    // 统一消费 ResourceProjectionService.projectForSnapshot()（与 resources/state 同源），
    // 消除双轨直读（旧回退分支已删除）。
    private readonly resourceProjectionService: ResourceProjectionService,
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
      tasks,
      spatialEntities,
      events,
      routeNodes,
      routeEdges,
      reservations,
      deviceBindings,
    ] = await Promise.all([
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

    // T02 / P0-1（G1）：persons/devices/stations 资源视图单一事实源（必选）。
    // 统一消费 projectForSnapshot()（与 resources/state 同源），消除双轨直读。
    const resourceView = await this.resourceProjectionService.projectForSnapshot();
    const persons = resourceView.persons;
    const stations = resourceView.stations;
    const deviceList = resourceView.devices;

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

    // P0-6：路由边 → 受影响任务索引（edgeId → taskIds）。
    // route graph 边连接 route node；node.stationId 指向工位；任务落在工位。
    // 由 "边连接的工位上的任务" 推导受影响集合——edgeId 与 zoneId 是两套 ID 体系，
    // 旧影响分析用 zoneId 匹配 edgeId 属错配（ROUTE_BLOCKED 永远圈不中任务）。
    // 若 route node 无 stationId 关联，则该边无已知受影响任务（fail-safe，不误伤）。
    const routeEdgeTaskIndex: Record<string, string[]> = {};
    {
      const stationByEdge = new Map<string, Set<string>>();
      const stationById = new Map<string, string>(); // stationId → nodeId（仅需存在性）
      for (const n of routeNodes) {
        if (n.stationId) stationById.set(n.stationId, n.nodeId);
      }
      for (const e of routeEdges) {
        const stationIds = new Set<string>();
        const fromNode = routeNodes.find((n) => n.nodeId === e.fromNodeId);
        const toNode = routeNodes.find((n) => n.nodeId === e.toNodeId);
        if (fromNode?.stationId) stationIds.add(fromNode.stationId);
        if (toNode?.stationId) stationIds.add(toNode.stationId);
        if (stationIds.size > 0) stationByEdge.set(e.edgeId, stationIds);
      }
      for (const t of taskList) {
        if (!t.stationId) continue;
        for (const [edgeId, stationIds] of stationByEdge) {
          if (stationIds.has(t.stationId)) {
            (routeEdgeTaskIndex[edgeId] ??= []).push(t.id);
          }
        }
      }
    }

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

    // ---- 事件影响范围（P0-2 / eventImpacts）----
    // 为 PriorityEngine 提供"事件 → 受影响任务/资源"的 scope 索引，使开放事件只影响相关任务，
    // 而非无差别作用于所有任务。已锁定/已派出任务（executing/dispatched/in_progress）不纳入受影响集合，
    // 避免对正在执行的任务重新排优。
    const eventImpacts: SchedulingEventImpact[] = events.map((e) => {
      const evidence = (e.evidenceJson ?? {}) as Record<string, unknown>;
      const affectedTaskIds = this.asStringArray(evidence.affectedTaskIds);
      const affectedPersonIds = this.asStringArray(evidence.affectedPersonIds);
      const affectedDeviceIds = this.asStringArray(evidence.affectedDeviceIds);
      const affectedStationIds = this.asStringArray(evidence.affectedStationIds);
      const affectedZoneIds = this.asStringArray(evidence.affectedZoneIds);

      // 事件自身设备：加入受影响设备集合（若未在证据链中）。
      const deviceId = e.deviceId ?? null;
      if (deviceId && !affectedDeviceIds.includes(deviceId)) {
        affectedDeviceIds.push(deviceId);
      }
      // 设备拥有空间实体 → 解析其所在 zone（parentId）；设备自身为工位时录入受影响工位。
      if (deviceId) {
        const deviceSe = spatialByEntityId.get(deviceId);
        const zoneId = deviceSe?.parentId ?? null;
        if (zoneId && !affectedZoneIds.includes(zoneId)) {
          affectedZoneIds.push(zoneId);
        }
        if (
          deviceSe &&
          ['workstation', 'station'].includes(deviceSe.entityType) &&
          !affectedStationIds.includes(deviceId)
        ) {
          affectedStationIds.push(deviceId);
        }
      }

      // 传播到任务：设备/工位/区域任一匹配的任务，且未锁定（skip 已派出/执行中）。
      const relatedTaskIds = new Set<string>();
      for (const t of taskList) {
        if (['executing', 'dispatched', 'in_progress'].includes(t.status)) continue;
        const related =
          (deviceId != null && t.deviceId === deviceId) ||
          (t.stationId != null && affectedStationIds.includes(t.stationId)) ||
          (t.zoneId != null && affectedZoneIds.includes(t.zoneId));
        if (related) relatedTaskIds.add(t.id);
      }
      for (const tid of affectedTaskIds) relatedTaskIds.add(tid);

      return {
        eventId: e.eventId,
        severity: e.severity ?? 'L1',
        status: e.status ?? 'open',
        affectedTaskIds: Array.from(relatedTaskIds),
        affectedPersonIds,
        affectedDeviceIds,
        affectedStationIds,
        affectedZoneIds,
      };
    });

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
      // P0-2：事件影响 scope（供 PriorityEngine 只消费相关事件）。
      eventImpacts,
      routeStatus,
      // P0-6：edgeId → 受影响任务索引（供 ROUTE_BLOCKED/ROUTE_CONGESTED 影响分析）。
      routeEdgeTaskIndex,
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