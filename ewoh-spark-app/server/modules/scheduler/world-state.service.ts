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
import { eq, and, or, sql } from 'drizzle-orm';
import { validateCloudWorldSnapshot } from '@shared/world-contract';
import type {
  SchedulingEventImpact,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ResourceProjectionService } from './resource-projection.service';
import {
  projectDeviceCapabilities,
  projectPersonCapabilities,
  projectStationCapabilities,
} from './capability-projection';

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
    const snapshot = await this.allocateAndPersistSnapshot(state, ctx);
    this.logger.log(`world state snapshot built: ${snapshot.snapshotVersion}`);
    return snapshot;
  }

  /**
   * 原子分配快照版本并持久化：分配（计数器 upsert）与插入在同一事务内完成，
   * 行锁覆盖「分配 + 插入」窗口，保证并发下版本互异且无缺口。
   * 有界重试：MAX_ATTEMPTS 次；快照版本唯一冲突（23505）或可串行化冲突（40001）
   * 时以全新版本重试，超过上限抛明确错误，绝不无限循环。
   */
  private async allocateAndPersistSnapshot(
    state: Omit<WorldStateSnapshot, 'snapshotVersion' | 'ts'>,
    ctx: OrgContext,
  ): Promise<WorldStateSnapshot> {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.requestDatabaseContext.runInTransaction(
          buildGucSettings(ctx),
          async () => {
            const snapshotVersion = await this.nextSnapshotVersion();
            const snapshot: WorldStateSnapshot = {
              ...state,
              snapshotVersion,
              ts: new Date().toISOString(),
            };
            await this.db.insert(ewohWorldStateSnapshot).values({
              snapshotVersion,
              snapshotJson: snapshot as unknown as Record<string, unknown>,
              createdAt: new Date(),
            });
            return snapshot;
          },
        );
      } catch (err) {
        if (this.isRetryableAllocationError(err)) {
          if (attempt < MAX_ATTEMPTS) {
            this.logger.warn(
              `world snapshot version allocation collision (attempt ${attempt}/${MAX_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          throw new Error(
            `world snapshot version allocation failed after ${MAX_ATTEMPTS} attempts: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
    }
    throw new Error(
      `world snapshot version allocation failed after ${MAX_ATTEMPTS} attempts`,
    );
  }

  /** 可重试的分配冲突：snapshot_version 唯一冲突（23505）或可串行化冲突（40001）。 */
  private isRetryableAllocationError(err: unknown): boolean {
    const code = (err as { code?: string } | null)?.code;
    return code === '23505' || code === '40001';
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

    // NO-12u / ADR-044：能力投影接线（Canonical CapabilityRecord，ADR-043）。
    // 快照实体附 capabilityRecords（契约合法记录）；投影缺口（certification
    // 缺 issuer/expiry 等数据源事实缺失）显式计数绝不静默（§33）。
    const capabilityProjectionIssues: string[] = [];
    const personRows = persons.map((p) => {
      const projection = projectPersonCapabilities(p);
      capabilityProjectionIssues.push(...projection.issues);
      return { ...p, capabilityRecords: projection.records };
    });
    const deviceRows = deviceList.map((d) => {
      const projection = projectDeviceCapabilities(d);
      capabilityProjectionIssues.push(...projection.issues);
      return { ...d, capabilityRecords: projection.records };
    });
    const stationRows = stations.map((s) => {
      const projection = projectStationCapabilities(s);
      capabilityProjectionIssues.push(...projection.issues);
      return { ...s, capabilityRecords: projection.records };
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
        entityId: `task:${t.id}`,
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

    // P0-6 核验（spec §八.10）：backlog 语义 =「工位排队任务数」，与 stations[].queue
    // （真实 queue 列）一致；不是「工位上的全量任务数」（含执行中/已完成）。
    // 注意：backlog[].taskId 字段实为 stationId（既有消费方 buildConflicts /
    // conflict.service 按 stationId 取用，类型命名历史遗留，此处保持形状不改名）。
    const backlog = stations
      .filter((s) => Array.isArray(s.queue) && s.queue.length > 0)
      .map((s) => ({ taskId: s.id, count: s.queue.length }));

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

    const snapshot = {
      worldVersion,
      entityVersions,
      reservations: reservationList,
      safetyBlockedPersonIds: Array.from(safetyBlockedPersonIds),
      safetyBlockedDeviceIds: Array.from(safetyBlockedDeviceIds),
      persons: personRows,
      tasks: taskList,
      devices: deviceRows,
      stations: stationRows,
      backlog,
      events: eventList,
      // P0-2：事件影响 scope（供 PriorityEngine 只消费相关事件）。
      eventImpacts,
      routeStatus,
      // P0-6：edgeId → 受影响任务索引（供 ROUTE_BLOCKED/ROUTE_CONGESTED 影响分析）。
      routeEdgeTaskIndex,
      forbiddenZones,
      lockedAssignments,
      // NO-12u / ADR-044：能力投影缺口显式计数（certification 缺 issuer/expiry 等）。
      capabilityProjectionIssues,
    };

    // ADR-008 / NO-03b：快照构建时的契约自检（entityVersions 键 + 实体规范身份引用）。
    // 自检失败显式留痕（errors 落快照 + warn 日志），不静默吞掉也不中断投影构建
    // （投影词表已由 ADR-007 收敛；此处防御未来漂移并给出可观测证据）。
    const contractErrors = validateCloudWorldSnapshot(snapshot);
    if (contractErrors.length > 0) {
      this.logger.warn(
        `world snapshot contract check failed: ${contractErrors.join(', ')}`,
      );
    }
    (snapshot as { contractCheck?: { valid: boolean; errors: string[] } }).contractCheck = {
      valid: contractErrors.length === 0,
      errors: contractErrors,
    };

    return snapshot;
  }

  /**
   * 原子分配形如 WS-YYYYMMDD-NNNN 的快照版本。
   * 必须在调用方事务内执行（buildSnapshot 经 RequestDatabaseContext 保证分配与
   * 插入同事务）：对 ewoh_snapshot_version_counter 按天 upsert（ON CONFLICT (day)
   * DO UPDATE SET last_seq = last_seq + 1），行锁串行化同一天内的并发分配，
   * 保证版本互异且无缺口；ewoh_world_state_snapshot.snapshot_version 唯一约束
   * 保留为最终兜底（冲突由 allocateAndPersistSnapshot 有界重试收敛）。
   */
  private async nextSnapshotVersion(): Promise<string> {
    const day = this.dateStamp(new Date());
    const rows = (await this.db.execute(
      sql`
        INSERT INTO ewoh_snapshot_version_counter (day, last_seq)
        VALUES (${day}, 1)
        ON CONFLICT (day) DO UPDATE SET
          last_seq = ewoh_snapshot_version_counter.last_seq + 1,
          _updated_at = now()
        RETURNING last_seq
      `,
    )) as unknown as Array<{ last_seq?: number | string }>;
    const seq = Number(rows[0]?.last_seq ?? 0);
    return `WS-${day}-${String(seq).padStart(4, '0')}`;
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