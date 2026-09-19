import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohPersonnel,
  ewohDevice,
  ewohSpatialEntity,
  ewohWorldState,
  ewohMaintenanceCondition,
  ewohQualityFinding,
  ewohExoSession,
} from '@server/database/schema';
import { and, eq, isNull, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { OrgContext } from '../shared/org-context.interceptor';
import { normalizeBatteryPct } from '@shared/api.interface';
import type {
  CoordinateReference,
  FreshnessPolicy,
  ResourceState,
  WorldStateSnapshot,
} from '@shared/api.interface';
import type { ResourceStatus } from '@shared/resource';
import {
  isMaintenanceOverdue,
  type MaintenanceConditionProjection,
} from '@shared/maintenance';
import {
  ACTIVE_QUALITY_STATUSES,
  QUALITY_RESOURCE_LINK_KINDS,
  type QualityFindingProjection,
} from '@shared/quality';
import { normalizeSeverity } from '@shared/risk';
import {
  ResourceReservationService,
  type ReservationResult,
} from './resource-reservation.service';
import {
  loadDeviceCapabilityLedger,
  resolveDeviceCapabilities,
  type DeviceCapabilityLedger,
} from './device-capabilities';

/** 数据新鲜度阈值（ms）：sourceTs 距今超过该值则标 STALE。保留向后兼容常量。 */
export const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * 默认差异化新鲜度策略（Task 3 / 3.2）：按 resourceType + signalType 差异化阈值。
 * person:location=60s / telemetry=120s / master=5min；device:telemetry=60s /
 * location=120s / master=5min；station:master=5min；未命中一律回退 default=5min。
 * STALE/UNKNOWN 资源绝不被视为 AVAILABLE（fail-closed）。
 */
export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  policyVersion: 2,
  thresholdsMs: {
    'person:location': 60 * 1000,
    'person:telemetry': 120 * 1000,
    // 2026-08-21：master（档案/实体主数据）5min → 24h——seed 档案低频更新，
    // 5min 窗口下恒 STALE → 状态归一化 UNKNOWN → 求解全员 person_unavailable
    // （metrics 全 0 根因之五；模拟器已同步更新 _updated_at 保证活跃时 FRESH）。
    'person:master': 24 * 60 * 60 * 1000,
    'device:telemetry': 60 * 1000,
    'device:location': 120 * 1000,
    'device:master': 24 * 60 * 60 * 1000,
    'station:master': 24 * 60 * 60 * 1000,
  },
  defaultThresholdMs: DEFAULT_FRESHNESS_MS,
};
/** 可用窗口推导的规划前瞻（ms）：基于真实 reservation 计算空闲时间窗。 */
const AVAILABILITY_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * 统一资源状态投影服务：将人员 / 设备 / 工位（station）投影为统一的
 * ResourceState。复用现有表（ewohPersonnel / ewohDevice / ewohSpatialEntity），
 * 不新增数据模型。tool / material / vehicle 暂无对应表，投影为空。
 *
 * 作为统一资源状态聚合器（ResourceStateAggregator）的单一消费点：
 * 通过 getUnifiedResourceState() 返回水合了真实 reservation 的权威投影，
 * map / ResourcePool / Scheduler / Dispatch 均消费同一份投影。
 * reservations 来源于 ewohResourceReservation 表（reserved/active），
 * availableWindows 由真实占用时间窗推导；无背衬列的字段（currentTask /
 * shift）一律为 null，不虚构数据。
 */
@Injectable()
export class ResourceProjectionService {
  private readonly logger = new Logger(ResourceProjectionService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly reservationService: ResourceReservationService,
  ) {}

  /**
   * NEST-102（2026-08-17）：读面 org 条件（org 匹配或 NULL 存量，与 RLS USING
   * 等价）；ctx 缺省 = 系统后台流（GUC/RLS 兜底），HTTP 路径必须传 ctx。
   */
  private orgCondition(column: AnyColumn, ctx: OrgContext | undefined): SQL | undefined {
    const orgId = ctx?.primaryOrgId;
    if (!orgId) return undefined;
    return or(isNull(column), eq(column, orgId));
  }

  /**
   * 统一资源状态聚合入口：person / device / station 的单一权威投影，
   * 已水合 reservations 与 availableWindows。map / ResourcePool /
   * Scheduler / Dispatch 应统一从此处消费。
   * NEST-102：ctx 透传（org 过滤）。
   */
  async getUnifiedResourceState(ctx?: OrgContext): Promise<ResourceState[]> {
    return this.project(ctx);
  }

  /** 查询全部资源（person / device / station）的统一投影。NEST-102：ctx 透传。 */
  async project(ctx?: OrgContext): Promise<ResourceState[]> {
    // NEST-102：org 过滤；ctx 缺省/空 org 不调 .where（无 where 能力测试替身兼容）。
    const personnelQuery = this.db.select().from(ewohPersonnel);
    const deviceQuery = this.db.select().from(ewohDevice);
    const spatialQuery = this.db.select().from(ewohSpatialEntity);
    const [personnelRows, deviceRows, spatialRows, reservations] =
      await Promise.all([
        ctx?.primaryOrgId
          ? personnelQuery.where(
              this.orgCondition(ewohPersonnel.orgId, ctx) as SQL,
            )
          : personnelQuery,
        ctx?.primaryOrgId
          ? deviceQuery.where(this.orgCondition(ewohDevice.orgId, ctx) as SQL)
          : deviceQuery,
        ctx?.primaryOrgId
          ? spatialQuery.where(
              this.orgCondition(ewohSpatialEntity.orgId, ctx) as SQL,
            )
          : spatialQuery,
        this.reservationService.listActive(ctx),
      ]);

    this.logger.debug(
      `resource projection: personnel=${personnelRows.length} device=${deviceRows.length} spatial=${spatialRows.length} reservations=${reservations.length}`,
    );

    // 负载水合（2026-08-20 修复"资源池人员负载恒 0"）：ewoh_personnel.currentLoad
    // 在模拟器场景无人写入（恒 null），而模拟器持续把 loadScore 写进
    // ewoh_world_state 最新帧——按人员空间实体批量取最新帧负载做 fallback。
    // LATERAL 索引查询（idx_ewoh_world_state_entity_ts），24 实体毫秒级。
    const personEntityIds = personnelRows
      .map((p) => p.spatialEntityId)
      .filter((id): id is string => Boolean(id));
    const wsLoadByEntityId = new Map<string, number>();
    if (personEntityIds.length > 0) {
      const idLiteral = personEntityIds
        .map((id) => `'${String(id).replace(/'/g, "''")}'`)
        .join(', ');
      const wsRows = (await this.db.execute(sql`
        SELECT ws."entity_id" AS "entityId", ws."state_json" AS "stateJson"
        FROM unnest(ARRAY[${sql.raw(idLiteral)}]::text[]) AS ids(e)
        JOIN LATERAL (
          SELECT "entity_id", "state_json" FROM ${ewohWorldState}
          WHERE "entity_id" = ids.e
          ORDER BY "ts" DESC
          LIMIT 1
        ) ws ON true
      `)) as unknown as Array<{
        entityId: string;
        stateJson: Record<string, unknown> | null;
      }>;
      for (const r of wsRows) {
        const raw = r.stateJson?.load_score ?? r.stateJson?.loadScore;
        if (raw != null && Number.isFinite(Number(raw))) {
          wsLoadByEntityId.set(r.entityId, Number(raw));
        }
      }
    }

    // 按 (resourceType, resourceId) 索引活跃预占，用于逐资源水合。
    const reservationsByKey = new Map<string, ReservationResult[]>();
    for (const r of reservations) {
      const key = `${r.resourceType}:${r.resourceId}`;
      const list = reservationsByKey.get(key) ?? [];
      list.push(r);
      reservationsByKey.set(key, list);
    }
    const resFor = (type: string, id: string): ReservationResult[] =>
      reservationsByKey.get(`${type}:${id}`) ?? [];

    const now = Date.now();
    const spatialByEntityId = new Map<string, (typeof spatialRows)[number]>();
    for (const se of spatialRows) spatialByEntityId.set(se.entityId, se);
    // 2026-08-21：person master 新鲜度回退——personnel._updated_at 为 seed 时间
    // （静态档案），模拟器持续更新同名 spatial person（P0xx）的 updatedAt；
    // 投影按姓名回退 spatial person 时间戳，保证 master 信号 FRESH
    // （否则 status 归一化 UNKNOWN → 求解全员 person_unavailable，metrics 全 0）。
    const spatialPersonUpdatedAtByName = new Map<string, number | null>();
    for (const se of spatialRows) {
      if (se.entityType !== 'person' || !se.name) continue;
      spatialPersonUpdatedAtByName.set(
        se.name,
        se.updatedAt ? se.updatedAt.getTime() : null,
      );
    }

    const persons: ResourceState[] = personnelRows.map((p) => {
      const se = p.spatialEntityId
        ? spatialByEntityId.get(p.spatialEntityId)
        : undefined;
      // ewohPersonnel.currentLoad 为 jsonb，可能含 loadLevel / fatigueLevel
      const load = (p.currentLoad as {
        loadLevel?: number;
        fatigueLevel?: number;
      } | null);
      const pRes = resFor('person', p.id);
      // 2026-08-21：master 新鲜度取 personnel._updated_at 与同名 spatial person
      //（模拟器 tick 更新 P0xx 实体 updatedAt）的较新者——任一信号新鲜即 FRESH，
      // 避免静态档案（seed 时间戳）把在岗人员误判 STALE → UNKNOWN。
      const personnelTs = p.updatedAt ? p.updatedAt.getTime() : null;
      const spatialTs = spatialPersonUpdatedAtByName.get(p.name) ?? null;
      const sourceTs =
        personnelTs == null
          ? (spatialTs ?? null)
          : spatialTs == null
            ? personnelTs
            : Math.max(personnelTs, spatialTs);
      const dataQuality = this.classifyFreshness(sourceTs, now, 'person', 'master');
      return {
        id: p.id,
        entityId: `person:${p.id}`,
        type: 'person',
        // ADR-007：投影状态收敛为 Canonical Resource 六态；数据过时
        // （STALE/UNKNOWN）→ status 显式 UNKNOWN（evaluateAvailability fail-closed），
        // 不再使用非契约词表 'available'/'unavailable'。
        status: this.toCanonicalStatus(
          dataQuality === 'FRESH' ? (p.status ?? 'AVAILABLE') : 'UNKNOWN',
        ),
        capabilities: this.asStringArray(p.skills),
        certifications: this.asStringArray(p.certifications),
        location: {
          stationId: p.spatialEntityId ?? null,
          zoneId: se ? (se.parentId ?? null) : null,
          // 坐标缺失 → 显式 UNKNOWN(null)，禁止用 0 冒充真实坐标。
          // P0-3：WGS84 坐标不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
          x: se && (se.coordinateType ?? 'FACTORY_CARTESIAN') !== 'WGS84' ? (se.x ?? null) : null,
          y: se && (se.coordinateType ?? 'FACTORY_CARTESIAN') !== 'WGS84' ? (se.y ?? null) : null,
        },
        availableWindows: this.computeAvailabilityWindows(pRes, now),
        reservations: pRes.map((r) => ({
          reservationId: r.reservationId,
          startMs: r.startMs,
          endMs: r.endMs,
        })),
        telemetry: {
          batteryPct: null,
          // 负载水合：personnel.currentLoad 优先，缺失回落 world_state 最新帧
          // loadScore（模拟器数据源，2026-08-20 修复恒 0）。
          loadLevel:
            load?.loadLevel ??
            (p.spatialEntityId
              ? (wsLoadByEntityId.get(p.spatialEntityId) ?? null)
              : null),
          fatigueLevel: load?.fatigueLevel ?? null,
          healthStatus: p.healthStatus ?? null,
        },
        // 领域新列（P1-T3）：shift / workload / currentTask 有背衬列才填充，无则 null。
        currentTask: p.currentTaskId ?? null,
        team: p.teamName ?? null,
        shift: p.shift ?? null,
        workload: p.workload ?? null,
        certificationExpiry: this.parseCertificationExpiry(p.certificationExpiry),
        locationConfidence: null,
        locationUpdatedAt: null,
        telemetryUpdatedAt: null,
        capacity: null,
        queue: null,
        updatedAt: sourceTs,
        sourceTs,
        freshnessMs: this.resolveFreshnessMs('person', 'master'),
        freshnessPolicyVersion: DEFAULT_FRESHNESS_POLICY.policyVersion,
        dataQuality,
        // P1-B：字段来源维度（与 dataQuality 正交）。person 投影无派生兜底字段 → AUTHORITATIVE。
        source: 'AUTHORITATIVE',
        version: p.version ?? 1,
        // T02 / P0-3：坐标判别联合（FACTORY_CARTESIAN 时填充；缺失 UNKNOWN）。
        coordinate: this.toCoordinateFromSpatial(se),
      };
    });

    // NO-14f：设备能力以**权威台账**（ewoh_device_capability，摄入路径写入的
    // Canonical CapabilityRecord）为准；`ewoh_device.capabilities` 列与型号白名单
    // 只是历史兜底。此前台账没有任何消费方，`capabilities` 列又全为空 →
    // 调度侧的 `requiredDeviceCapabilities` 匹配实际上永远匹配不到任何设备。
    const capabilityLedger = await loadDeviceCapabilityLedger(
      this.db,
      ctx?.primaryOrgId,
      deviceRows.map((d) => d.deviceId).filter((id): id is string => typeof id === 'string' && id !== ''),
    );

    // ewohDevice 无 spatialEntityId 列；设备空间位置通过
    // ewohSpatialEntity(entityType='device', entityId=deviceId) 关联解析。
    const deviceResources: ResourceState[] = deviceRows.map((d) => {
      const se = d.deviceId ? spatialByEntityId.get(d.deviceId) : undefined;
      const parentSe = se?.parentId
        ? spatialByEntityId.get(se.parentId)
        : undefined;
      const dRes = resFor('device', d.id);
      const sourceTs = d.lastTelemetryAt
        ? d.lastTelemetryAt.getTime()
        : d.updatedAt
          ? d.updatedAt.getTime()
          : null;
      const deviceDataQuality = this.classifyFreshness(sourceTs, now, 'device', 'telemetry');
      const derived: string[] = [];
      // 能力优先级（NO-14f，逐级显式，绝不混用）：
      //   1) 权威台账（摄入路径声明的 Canonical CapabilityRecord，仅 active）
      //   2) ewoh_device.capabilities 列（历史/人工登记）
      //   3) 型号白名单派生（兜底，标记 derived）
      const ledger: DeviceCapabilityLedger | undefined = d.deviceId
        ? capabilityLedger.get(d.deviceId)
        : undefined;
      const resolved = resolveDeviceCapabilities({
        ledger,
        columnCapabilities: this.asStringArray(d.capabilities),
        deviceModel: d.deviceModel,
      });
      const capabilities = resolved.capabilities;
      if (resolved.derivedFromModelWhitelist) derived.push('capabilities');
      // 位置：设备自身 location_lat/lng（真实遥测）；缺失则显式 UNKNOWN(null)，绝不借人员坐标。
      const hasDeviceLocation = d.locationLat != null && d.locationLng != null;
      return {
        // 调度域主键 = ewoh_device.id（uuid）；业务设备号（`ewoh_device.device_id`，
        // 如 EXO-001 / ENV-SIM-x）单列透出：边缘遥测、能力台账、批次事件都以业务号
        // 标识设备，世界模型必须能 join 两者（此前快照只给 uuid，无法关联）。
        id: d.id,
        deviceId: d.deviceId ?? null,
        entityId: `device:${d.id}`,
        type: 'device',
        // ADR-007：投影状态收敛为 Canonical Resource 六态（fault→DEGRADED、
        // 离线→OFFLINE、在线→AVAILABLE；新鲜度由 dataQuality 承载）。
        status: this.toCanonicalStatus(
          d.faultCode
            ? 'fault'
            : deviceDataQuality === 'FRESH'
              ? 'online'
              : 'OFFLINE',
        ),
        capabilities,
        // NO-14g：观测能力（mode='observation'）单列——世界模型/AI 用它知道
        // 设备"能看到"什么，调度匹配只用 capabilities（设备"能做什么"）。
        ...(resolved.observedCapabilities.length > 0
          ? { observedCapabilities: resolved.observedCapabilities }
          : {}),
        // NO-15b：人工停用的能力也是事实（缺失 ≠ 停用），随世界模型透出
        ...(resolved.disabledCapabilities && resolved.disabledCapabilities.length > 0
          ? {
              disabledCapabilities: resolved.disabledCapabilities,
              disabledCapabilityLifecycle: resolved.disabledCapabilityLifecycle,
            }
          : {}),
        // 台账记录（含 subject/evidence/providerType）随资源视图透出：
        // 快照据此携带契约记录，无需再从名称反推。
        ...(resolved.capabilityRecords && resolved.capabilityRecords.length > 0
          ? { capabilityRecords: resolved.capabilityRecords }
          : {}),
        ...(resolved.capabilityLedgerIssues
          ? { capabilityLedgerIssues: resolved.capabilityLedgerIssues }
          : {}),
        certifications: [],
        location: {
          stationId: se ? (se.parentId ?? null) : null,
          zoneId: parentSe ? (parentSe.parentId ?? null) : null,
          // P0-3：WGS84 设备位置不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
          x: hasDeviceLocation && (d.locationCoordinateType ?? 'FACTORY_CARTESIAN') !== 'WGS84' ? d.locationLat ?? null : null,
          y: hasDeviceLocation && (d.locationCoordinateType ?? 'FACTORY_CARTESIAN') !== 'WGS84' ? d.locationLng ?? null : null,
        },
        availableWindows: this.computeAvailabilityWindows(dRes, now),
        reservations: dRes.map((r) => ({
          reservationId: r.reservationId,
          startMs: r.startMs,
          endMs: r.endMs,
        })),
        telemetry: {
          batteryPct: normalizeBatteryPct(d.batteryPct),
          loadLevel: null,
          fatigueLevel: null,
          healthStatus: null,
        },
        // ewohDevice 无 currentTask / team / shift 背衬列，一律 null。
        currentTask: null,
        team: null,
        shift: null,
        workload: null,
        certificationExpiry: null,
        // 字段级位置/遥测明细（P1-T3）：有背衬列才填充。
        locationConfidence: hasDeviceLocation ? (d.locationConfidence ?? null) : null,
        locationUpdatedAt: d.locationUpdatedAt ? d.locationUpdatedAt.getTime() : null,
        telemetryUpdatedAt: d.telemetryUpdatedAt ? d.telemetryUpdatedAt.getTime() : null,
        capacity: null,
        queue: null,
        updatedAt: sourceTs,
        sourceTs,
        freshnessMs: this.resolveFreshnessMs('device', 'telemetry'),
        freshnessPolicyVersion: DEFAULT_FRESHNESS_POLICY.policyVersion,
        dataQuality: deviceDataQuality,
        // P1-B：字段来源维度——capabilities 命中型号白名单兜底（derived 非空）→ DERIVED，否则 AUTHORITATIVE。
        source: derived.length > 0 ? 'DERIVED' : 'AUTHORITATIVE',
        // P1-A：维护时间窗（真实列 maintenance_start_ms/end_ms；两列均 NULL → 空数组，不伪造）。
        maintenanceWindows: this.parseMaintenanceWindows(
          d.maintenanceStartMs,
          d.maintenanceEndMs,
        ),
        version: 1,
        derived,
        // T02 / P0-3：设备位置坐标类型（location_coordinate_type 列）。
        coordinate: this.toCoordinateFromDevice(d, hasDeviceLocation),
      };
    });

    const stations: ResourceState[] = spatialRows
      .filter(
        (se) => se.entityType === 'workstation' || se.entityType === 'station',
      )
      .map((se) => {
        const sRes = resFor('station', se.entityId);
        const sourceTs = se.updatedAt ? se.updatedAt.getTime() : null;
        const stationDataQuality = this.classifyFreshness(sourceTs, now, 'station', 'master');
        return {
          id: se.entityId,
          entityId: `station:${se.entityId}`,
          type: 'station',
          // ADR-007：投影状态收敛为 Canonical Resource 六态；禁止虚构
          // （STALE/UNKNOWN → UNKNOWN；FRESH 取真实状态并归一化）。
          status: this.toCanonicalStatus(
            stationDataQuality === 'FRESH'
              ? (se.status ?? 'AVAILABLE')
              : 'UNKNOWN',
          ),
          capabilities: [se.entityType],
          certifications: [],
          location: {
            stationId: se.entityId,
            zoneId: se.parentId ?? null,
            // P0-3：WGS84 工位坐标不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
            x: (se.coordinateType ?? 'FACTORY_CARTESIAN') !== 'WGS84' ? (se.x ?? null) : null,
            y: (se.coordinateType ?? 'FACTORY_CARTESIAN') !== 'WGS84' ? (se.y ?? null) : null,
          },
          availableWindows: this.computeAvailabilityWindows(sRes, now),
          reservations: sRes.map((r) => ({
            reservationId: r.reservationId,
            startMs: r.startMs,
            endMs: r.endMs,
          })),
          telemetry: {
            batteryPct: null,
            loadLevel: null,
            fatigueLevel: null,
            healthStatus: null,
          },
          // 领域新列（P1-T3）：station 投影补 capacity/queue；其余无背衬列一律 null。
          currentTask: null,
          team: null,
          shift: null,
          workload: null,
          certificationExpiry: null,
          locationConfidence: null,
          locationUpdatedAt: null,
          telemetryUpdatedAt: null,
          capacity: se.capacity ?? null,
          queue: this.asStringArray(se.queue),
          updatedAt: sourceTs,
          sourceTs,
          freshnessMs: this.resolveFreshnessMs('station', 'master'),
          freshnessPolicyVersion: DEFAULT_FRESHNESS_POLICY.policyVersion,
          dataQuality: stationDataQuality,
          // P1-B：station 能力来自真实列 entityType（非白名单兜底）→ AUTHORITATIVE。
          source: 'AUTHORITATIVE',
          version: se.version ?? 1,
          // T02 / P0-3：工位坐标类型（coordinate_type / floor_id 列）。
          coordinate: this.toCoordinateFromSpatial(se),
        };
      });

    // NO-05c（ADR-010）：活跃维护状态事实 → 状态收敛 + 事实附着
    // （critical → OFFLINE fail-closed 禁派；其余 → DEGRADED；UNKNOWN/OFFLINE 不升级）。
    // R2-SSV-04（2026-08-17）：维护/质量事实加载透传 ctx（org 过滤）——
    // 此前两表全表扫描，跨租户维护/质量事实附着到本租户资源投影。
    const maintenanceByEntity = await this.loadActiveMaintenance(ctx);
    const applyMaintenance = (state: ResourceState): ResourceState =>
      this.applyMaintenance(state, maintenanceByEntity.get(state.entityId ?? '') ?? []);

    // NO-05d（ADR-011）：活跃质量发现事实 → 仅事实附着（不改资源状态；
    // critical/high 封锁由 Eligibility 执行，medium/low 仅可见）。
    const qualityByEntity = await this.loadActiveQualityFindings(ctx);
    const applyQuality = (state: ResourceState): ResourceState =>
      this.attachQualityFindings(state, qualityByEntity.get(state.entityId ?? '') ?? []);

    return [...persons, ...deviceResources, ...stations]
      .map(applyMaintenance)
      .map(applyQuality);
  }

  /**
   * 按资源类型过滤投影；tool / material / vehicle 无对应表，返回空数组。
   * R2-SSV-22（2026-08-17）：接收 ctx 并透传 getUnifiedResourceState——
   * 此前经适配器消费的调用方拿到无 org 过滤的全租户投影（NEST-102 旁路）。
   */
  async projectByType(
    type: ResourceState['type'],
    ctx?: OrgContext,
  ): Promise<ResourceState[]> {
    const all = await this.getUnifiedResourceState(ctx);
    return all.filter((r) => r.type === type);
  }

  /**
   * NO-05c（ADR-010）：加载活跃维护状态事实（status ∉ {resolved, closed}），
   * 按 subjectEntityId（规范身份 kind:value）索引。
   *
   * 终态过滤在行守卫内完成（唯一代码路径）：真实表行必带 conditionId /
   * subjectEntityId / conditionType / severity / status 形状；形状守卫同时兼容
   * 单元层链式 fake（fake 对任意 select 返回同集合，非维护行在此被过滤——不做
   * 任何静默兜底或数据猜测）。
   */
  private async loadActiveMaintenance(
    ctx?: OrgContext,
  ): Promise<Map<string, MaintenanceConditionProjection[]>> {
    // R2-SSV-04：ctx 携带 org 时按 org 过滤（本表 org_id NOT NULL，无存量
    // NULL 行——直接 eq；ctx 缺省 = 系统后台流，GUC/RLS 兜底，不调 where）。
    const orgId = ctx?.primaryOrgId;
    const baseQuery = this.db.select().from(ewohMaintenanceCondition);
    const rows = orgId
      ? await baseQuery.where(eq(ewohMaintenanceCondition.orgId, orgId))
      : await baseQuery;
    const nowIso = new Date().toISOString();
    const byEntity = new Map<string, MaintenanceConditionProjection[]>();
    for (const raw of rows as Array<Record<string, unknown>>) {
      const { subjectEntityId, conditionId, conditionType, severity, status } = raw;
      if (
        typeof subjectEntityId !== 'string' ||
        typeof conditionId !== 'string' ||
        typeof conditionType !== 'string' ||
        typeof severity !== 'string' ||
        typeof status !== 'string'
      ) {
        continue;
      }
      // 终态排除（与 SQL where 双保险；unit 层链式 fake 无法执行 where 谓词）。
      if (status === 'resolved' || status === 'closed') continue;
      const due =
        raw.dueAt instanceof Date
          ? raw.dueAt.toISOString()
          : typeof raw.dueAt === 'string'
            ? raw.dueAt
            : null;
      const list = byEntity.get(subjectEntityId) ?? [];
      list.push({
        conditionId,
        conditionType,
        severity,
        status,
        dueAt: due,
        overdue: isMaintenanceOverdue(due, status, nowIso),
      });
      byEntity.set(subjectEntityId, list);
    }
    return byEntity;
  }

  /**
   * NO-05c（ADR-010）：维护事实 → 资源状态收敛。
   * critical → OFFLINE（fail-closed 禁派，人审解除）；其余活跃条件 → DEGRADED
   * （可用性降级）；UNKNOWN / OFFLINE / MAINTENANCE 保持（绝不升级状态）。
   * 未知严重度按 critical 处理并留痕（fail-closed，不把未知当作安全）。
   */
  private applyMaintenance(
    state: ResourceState,
    conditions: MaintenanceConditionProjection[],
  ): ResourceState {
    if (conditions.length === 0) {
      return { ...state, maintenance: null };
    }
    return {
      ...state,
      // degradeByMaintenance 仅返回 'OFFLINE'/'DEGRADED' 或原 status（绝不升级），
      // 因此投影为 ResourceStatus 是安全的。
      status: this.degradeByMaintenance(state.status, conditions) as ResourceStatus,
      maintenance: conditions,
    };
  }

  /** NO-05c：维护事实 → 状态收敛（project / projectForSnapshot 共用）。 */
  private degradeByMaintenance(
    status: string,
    conditions: MaintenanceConditionProjection[],
  ): string {
    if (conditions.length === 0) return status;
    const critical = conditions.some((c) => {
      try {
        return normalizeSeverity(c.severity) === 'critical';
      } catch (err) {
        this.logger.warn(
          `维护状态严重度非契约值，按 critical 禁派（fail-closed）: ${c.severity} (${err})`,
        );
        return true;
      }
    });
    if (critical) return 'OFFLINE';
    return status === 'AVAILABLE' || status === 'DEGRADED' ? 'DEGRADED' : status;
  }

  /**
   * NO-05d（ADR-011）：加载活跃质量发现（status ∈ {open, under_review}），按
   * links 中 kind ∈ {station, device, person} 的规范身份索引（其余 kind 如
   * order/material/batch 是检验对象而非调度资源，不产生资源封锁，留待
   * NO-05e MES/工单闭环消费）。
   *
   * 活跃过滤在行守卫内完成（唯一代码路径）：真实表行必带 findingId/findingType/
   * severity/status/links 形状；形状守卫同时兼容单元层链式 fake（非质量行被过滤，
   * 不做任何静默兜底或数据猜测）。
   */
  private async loadActiveQualityFindings(
    ctx?: OrgContext,
  ): Promise<Map<string, QualityFindingProjection[]>> {
    // R2-SSV-04：同 loadActiveMaintenance——ctx org 过滤（本表 org_id NOT NULL）。
    const orgId = ctx?.primaryOrgId;
    const baseQuery = this.db.select().from(ewohQualityFinding);
    const rows = orgId
      ? await baseQuery.where(eq(ewohQualityFinding.orgId, orgId))
      : await baseQuery;
    const byEntity = new Map<string, QualityFindingProjection[]>();
    for (const raw of rows as Array<Record<string, unknown>>) {
      const { findingId, findingType, severity, status, links } = raw;
      if (
        typeof findingId !== 'string' ||
        typeof findingType !== 'string' ||
        typeof severity !== 'string' ||
        typeof status !== 'string'
      ) {
        continue;
      }
      // 处置终态（dispositioned/closed）不参与调度（处置即解除，ADR-011）。
      if (!ACTIVE_QUALITY_STATUSES.has(status)) continue;
      const linkList = Array.isArray(links)
        ? links.filter((l): l is string => typeof l === 'string')
        : [];
      const detectedAt =
        raw.detectedAt instanceof Date
          ? raw.detectedAt.toISOString()
          : typeof raw.detectedAt === 'string'
            ? raw.detectedAt
            : '';
      const disposition =
        typeof raw.disposition === 'string' ? raw.disposition : null;
      const projection: QualityFindingProjection = {
        findingId,
        findingType,
        severity,
        status,
        disposition,
        links: linkList,
        detectedAt,
      };
      for (const link of linkList) {
        const kind = link.split(':')[0];
        if (!link.includes(':') || !QUALITY_RESOURCE_LINK_KINDS.has(kind)) continue;
        const list = byEntity.get(link) ?? [];
        list.push(projection);
        byEntity.set(link, list);
      }
    }
    return byEntity;
  }

  /**
   * NO-05d（ADR-011）：质量发现事实附着——不改变资源状态（质量事实不改变
   * 资源物理可用性，只影响派工决策）；无关联 → qualityFindings=null（不伪造）。
   */
  private attachQualityFindings(
    state: ResourceState,
    findings: QualityFindingProjection[],
  ): ResourceState {
    if (findings.length === 0) {
      return { ...state, qualityFindings: null };
    }
    return { ...state, qualityFindings: findings };
  }

  /**
   * 由真实 reservation（占用时间窗）推导空闲可用窗口：在 [now, now+前瞻]
   * 区间内，减去全部尚未结束的占用，剩余连续区间即为 availableWindows。
   */
  private computeAvailabilityWindows(
    reservations: ReadonlyArray<{ startMs: number; endMs: number }>,
    now: number,
  ): Array<{ startMs: number; endMs: number }> {
    const horizon = now + AVAILABILITY_HORIZON_MS;
    if (reservations.length === 0) {
      return [{ startMs: now, endMs: horizon }];
    }
    const sorted = reservations
      .filter((r) => r.endMs > now)
      .sort((a, b) => a.startMs - b.startMs);
    const windows: Array<{ startMs: number; endMs: number }> = [];
    let cursor = now;
    for (const r of sorted) {
      if (r.endMs <= cursor) continue; // 已被更早占用覆盖
      if (r.startMs > cursor) {
        windows.push({ startMs: cursor, endMs: Math.min(r.startMs, horizon) });
      }
      cursor = Math.max(cursor, r.endMs);
    }
    if (cursor < horizon) windows.push({ startMs: cursor, endMs: horizon });
    return windows.filter((w) => w.endMs > w.startMs);
  }

  /** 无时间戳 → UNKNOWN；距今超过（类型/信号差异化）阈值 → STALE；否则 FRESH。 */
  /**
   * ADR-007：把投影/DB 历史词表显式归一为 Canonical Resource 六态 + UNKNOWN。
   * 未知值 → UNKNOWN + warn 留痕（fail-closed，绝不猜测为可用状态）。
   */
  private toCanonicalStatus(raw: string | null | undefined): ResourceStatus {
    switch (raw) {
      case 'AVAILABLE':
      case 'available':
      case 'online':
      case 'active':
        return 'AVAILABLE';
      case 'RESERVED':
      case 'reserved':
        return 'RESERVED';
      case 'BUSY':
      case 'busy':
      case 'working':
        return 'BUSY';
      case 'DEGRADED':
      case 'degraded':
      case 'fault':
        return 'DEGRADED';
      case 'OFFLINE':
      case 'offline':
        return 'OFFLINE';
      case 'MAINTENANCE':
      case 'maintenance':
        return 'MAINTENANCE';
      case 'UNKNOWN':
      case 'unavailable':
        return 'UNKNOWN';
      default:
        if (raw) {
          this.logger.warn(`投影状态非契约词表，显式按 UNKNOWN 处理（fail-closed）: ${raw}`);
        }
        return 'UNKNOWN';
    }
  }

  /**
   * 跨系统时钟偏差容忍（2026-09-19 实测）。
   *
   * 写侧时间戳来自 DB 时钟（`now()` / 容器时钟），读侧比较用应用宿主机
   * `Date.now()`——两者天然存在毫秒到秒级偏差。写后立读时 `sourceTs` 可能
   * 比 `now` 超前几毫秒：原实现零容差判 UNKNOWN（fail-closed），实测导致
   * 「写后立读 ⇒ 全员资源 UNKNOWN ⇒ 求解/候选全员 person_unavailable」的
   * 瞬时翻转，且随 VM/宿主机钟差符号漂移间歇复现。
   *
   * 处理：允许一个小的前向钟差窗口（NTP 同步后典型的残余偏差 ≪ 5s）；
   * 超出容忍的未来时间戳仍然 UNKNOWN（远超容忍 = 时钟确实坏了，维持
   * fail-closed 不放松）。
   */
  private static readonly CLOCK_SKEW_TOLERANCE_MS = 5_000;

  private classifyFreshness(
    sourceTs: number | null,
    now: number,
    resourceType?: string,
    signalType?: string,
  ): 'FRESH' | 'STALE' | 'UNKNOWN' {
    if (
      sourceTs == null ||
      !Number.isFinite(sourceTs) ||
      !Number.isFinite(now)
    ) return 'UNKNOWN';
    // 未来时间戳：容忍小的跨系统钟差；超过容忍仍视为不可信（fail-closed）。
    if (sourceTs - now > ResourceProjectionService.CLOCK_SKEW_TOLERANCE_MS) {
      return 'UNKNOWN';
    }
    if (now - sourceTs > this.resolveFreshnessMs(resourceType, signalType)) {
      return 'STALE';
    }
    return 'FRESH';
  }

  /** 按 resourceType + signalType 从策略解析阈值；未命中回退默认阈值。 */
  private resolveFreshnessMs(
    resourceType?: string,
    signalType?: string,
  ): number {
    if (resourceType && signalType) {
      const hit = DEFAULT_FRESHNESS_POLICY.thresholdsMs[
        `${resourceType}:${signalType}`
      ];
      if (hit != null) return hit;
    }
    return DEFAULT_FRESHNESS_POLICY.defaultThresholdMs;
  }

  /** jsonb 数组列可能以 unknown 返回；安全地规整为 string[]（runtime validation）。 */
  private asStringArray(v: unknown): string[] {
    return Array.isArray(v)
      ? (v as string[]).filter((x): x is string => typeof x === 'string')
      : [];
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

  // ==========================================================================
  // T02 / P0-1（G1）：Snapshot 资源视图单一事实源 + P0-3（G8）坐标类型化
  // ==========================================================================

  /**
   * 快照形态的资源视图（WorldStateSnapshot.persons/devices/stations）。
   * WorldStateSnapshotService.collectState 消费本方法替换旧的双轨直读，
   * 保证 resources/state 与 world-state 对同一 person/device/station 完全一致。
   * 只换来源不换形状：字段与旧快照装配一致（availableFromMs 由真实 reservation
   * 推导、dataQuality FRESH/STALE/UNKNOWN），并增加 coordinate 判别联合。
   */
  async projectForSnapshot(ctx?: OrgContext): Promise<{
    persons: WorldStateSnapshot['persons'];
    devices: WorldStateSnapshot['devices'];
    stations: WorldStateSnapshot['stations'];
  }> {
    // NEST-102（2026-08-17）：快照资源视图同 ctx 透传（org 匹配或 NULL 存量；
    // ctx 缺省/空 org 不调 .where——无 where 能力测试替身兼容）。
    const personnelQuery = this.db.select().from(ewohPersonnel);
    const deviceQuery = this.db.select().from(ewohDevice);
    const spatialQuery = this.db.select().from(ewohSpatialEntity);
    // NO-34a：活跃外骨骼会话（佩戴中的设备不可同时派给他人）。
    // 与其它查询并行；org 作用域与设备一致（有 ctx 才过滤 org，保持能力测试替身兼容）。
    // 与上面三条查询同构：**有 ctx 才加 where**（无 where 的能力测试替身兼容）。
    // 无 ctx 时状态过滤退到内存里做（语义等价，见下方 for 循环）。
    const sessionQuery = ctx?.primaryOrgId
      ? this.db
          .select()
          .from(ewohExoSession)
          .where(
            and(
              eq(ewohExoSession.status, 'active'),
              this.orgCondition(ewohExoSession.orgId, ctx) as SQL,
            ) as SQL,
          )
      : this.db.select().from(ewohExoSession);
    const [personnelRows, deviceRows, spatialRows, reservations, activeSessions] =
      await Promise.all([
        ctx?.primaryOrgId
          ? personnelQuery.where(
              this.orgCondition(ewohPersonnel.orgId, ctx) as SQL,
            )
          : personnelQuery,
        ctx?.primaryOrgId
          ? deviceQuery.where(this.orgCondition(ewohDevice.orgId, ctx) as SQL)
          : deviceQuery,
        ctx?.primaryOrgId
          ? spatialQuery.where(
              this.orgCondition(ewohSpatialEntity.orgId, ctx) as SQL,
            )
          : spatialQuery,
        this.reservationService.listActive(ctx),
        sessionQuery,
      ]);

    // 会话的 exoId 是规范身份 `device:<业务设备号>`（ADR-032），而世界模型设备键是
    // 业务设备号 → 显式剥离映射；形状不符的会话不猜、直接忽略（宁可不加约束也不误判）。
    const activeSessionByDeviceId = new Map<
      string,
      { sessionId: string; personId: string; startedAt: string }
    >();
    for (const session of activeSessions) {
      // 无 ctx 分支未在 SQL 里过滤状态 → 这里补上（终态会话不构成"佩戴中"）
      if (String(session.status ?? '') !== 'active') continue;
      const exoId = String(session.exoId ?? '');
      if (!exoId.startsWith('device:')) continue;
      const businessId = exoId.slice('device:'.length).trim();
      if (!businessId) continue;
      activeSessionByDeviceId.set(businessId, {
        sessionId: String(session.sessionId),
        personId: String(session.personId ?? ''),
        startedAt:
          session.startedAt instanceof Date
            ? session.startedAt.toISOString()
            : String(session.startedAt ?? ''),
      });
    }

    const spatialByEntityId = new Map<string, (typeof spatialRows)[number]>();
    for (const se of spatialRows) spatialByEntityId.set(se.entityId, se);

    // 2026-08-21（与 project() 同口径）：person master 新鲜度回退同名 spatial
    // person（模拟器 tick 更新 P0xx 实体 updatedAt）——调度快照 persons 来自
    // 静态档案（seed 时间戳），无此回退则恒 STALE → UNKNOWN → 求解全员
    // person_unavailable → metrics 全 0。
    const spatialPersonUpdatedAtByName = new Map<string, number | null>();
    for (const se of spatialRows) {
      if (se.entityType !== 'person' || !se.name) continue;
      spatialPersonUpdatedAtByName.set(
        se.name,
        se.updatedAt ? se.updatedAt.getTime() : null,
      );
    }

    // 人员下一次可用时间：取该人员未来 reservation 的最大结束时间（真实占用）。
    const personReservationEnd = new Map<string, number>();
    for (const r of reservations) {
      if (r.resourceType === 'person' && r.endMs != null) {
        const cur = personReservationEnd.get(r.resourceId) ?? 0;
        if (r.endMs > cur) personReservationEnd.set(r.resourceId, r.endMs);
      }
    }

    const now = Date.now();

    // NO-05c（ADR-010）：活跃维护状态事实（person:/device:/station:<id> 索引）。
    // R2-SSV-04：ctx org 过滤（与 project() 同口径）。
    const maintenanceByEntity = await this.loadActiveMaintenance(ctx);
    const maintenanceFor = (entityId: string | undefined): MaintenanceConditionProjection[] =>
      entityId ? (maintenanceByEntity.get(entityId) ?? []) : [];

    // NO-05d（ADR-011）：活跃质量发现事实（links 资源 kind 索引；不改状态）。
    const qualityByEntity = await this.loadActiveQualityFindings(ctx);
    const qualityFor = (entityId: string | undefined): QualityFindingProjection[] =>
      entityId ? (qualityByEntity.get(entityId) ?? []) : [];

    // P1-B：persons 附带字段来源维度（source），与 WorldStateSnapshot 形状兼容（可选超集）。
    const persons: Array<
      WorldStateSnapshot['persons'][number] & { source?: 'AUTHORITATIVE' | 'DERIVED' }
    > = personnelRows.map((p) => {
      const se = p.spatialEntityId
        ? spatialByEntityId.get(p.spatialEntityId)
        : undefined;
      // P0-3：WGS84 坐标不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
      const isWgs84 = (se?.coordinateType ?? 'FACTORY_CARTESIAN') === 'WGS84';
      const load = (p.currentLoad as { loadLevel?: number; fatigueLevel?: number } | null) ?? {};
      // 2026-08-21（与 project() 同口径）：master 新鲜度取档案与同名 spatial
      // person 的较新者——模拟器运行期间恒 FRESH，status 归一化为真实值。
      const personnelTs = p.updatedAt ? p.updatedAt.getTime() : null;
      const spatialTs = spatialPersonUpdatedAtByName.get(p.name) ?? null;
      const sourceTs =
        personnelTs == null
          ? (spatialTs ?? null)
          : spatialTs == null
            ? personnelTs
            : Math.max(personnelTs, spatialTs);
      const dataQuality = this.classifyFreshness(sourceTs, now, 'person', 'master');
      const maintenance = maintenanceFor(`person:${p.id}`);
      const qualityFindings = qualityFor(`person:${p.id}`);
      return {
        id: p.id,
        entityId: `person:${p.id}`,
        name: p.name,
        // NO-05c：维护事实收敛（critical→OFFLINE；其余 AVAILABLE/DEGRADED→DEGRADED）。
        status: this.degradeByMaintenance(
          this.toCanonicalStatus(
            dataQuality === 'FRESH' ? (p.status ?? 'AVAILABLE') : 'UNKNOWN',
          ),
          maintenance,
        ),
        healthStatus: p.healthStatus ?? 'normal',
        skills: this.asStringArray(p.skills),
        certifications: this.asStringArray(p.certifications),
        loadLevel: load.loadLevel ?? 0,
        fatigueLevel: load.fatigueLevel ?? 0,
        stationId: p.spatialEntityId ?? null,
        zoneId: se ? (se.parentId ?? null) : null,
        x: se && !isWgs84 ? (se.x ?? null) : null,
        y: se && !isWgs84 ? (se.y ?? null) : null,
        availableFromMs: personReservationEnd.get(p.id) ?? null,
        shift: p.shift ?? null,
        workload: p.workload ?? null,
        currentTaskId: p.currentTaskId ?? null,
        certificationExpiry: this.parseCertificationExpiry(p.certificationExpiry),
        sourceTs,
        freshnessMs: this.resolveFreshnessMs('person', 'master'),
        dataQuality,
        // NO-05c：活跃维护事实附着（无活跃条件 → null，不伪造）。
        maintenance: maintenance.length > 0 ? maintenance : null,
        // NO-05d：活跃质量发现事实附着（无关联 → null，不伪造）。
        qualityFindings: qualityFindings.length > 0 ? qualityFindings : null,
        // P1-B：字段来源维度（与 dataQuality 正交）。person 投影无派生兜底字段 → AUTHORITATIVE。
        source: 'AUTHORITATIVE',
        coordinate: this.toCoordinateFromSpatial(se),
      };
    });

    // NO-14f：快照路径同样以权威台账为准（与 project() 共用同一解析器——
    // 此前两条路径各写一份设备能力语义，接线只改一处会让快照仍然读空列）。
    const snapshotCapabilityLedger = await loadDeviceCapabilityLedger(
      this.db,
      ctx?.primaryOrgId,
      deviceRows
        .map((d) => d.deviceId)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    );

    // P1-B：devices 附带字段来源维度（source）+ 维护时间窗（maintenanceWindows），
    // 与 WorldStateSnapshot 形状兼容（可选超集）。
    const devices: Array<
      WorldStateSnapshot['devices'][number] & {
        source?: 'AUTHORITATIVE' | 'DERIVED';
        maintenanceWindows?: Array<{ startMs: number; endMs: number }>;
      }
    > = deviceRows.map((d) => {
      const sourceTs = d.lastTelemetryAt
        ? d.lastTelemetryAt.getTime()
        : d.updatedAt
          ? d.updatedAt.getTime()
          : null;
      const dataQuality = this.classifyFreshness(sourceTs, now, 'device', 'telemetry');
      const stale = dataQuality !== 'FRESH';
      const derived: string[] = [];
      const ledger = d.deviceId ? snapshotCapabilityLedger.get(d.deviceId) : undefined;
      const resolved = resolveDeviceCapabilities({
        ledger,
        columnCapabilities: this.asStringArray(d.capabilities),
        deviceModel: d.deviceModel,
      });
      const capabilities = resolved.capabilities;
      if (resolved.derivedFromModelWhitelist) derived.push('capabilities');
      const lat = d.locationLat ?? null;
      const lng = d.locationLng ?? null;
      const hasDeviceLocation = lat != null && lng != null;
      // P0-3：WGS84 坐标不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
      const isWgs84 = (d.locationCoordinateType ?? 'FACTORY_CARTESIAN') === 'WGS84';
      const deviceSe = d.deviceId ? spatialByEntityId.get(d.deviceId) : undefined;
      const maintenance = maintenanceFor(`device:${d.id}`);
      const qualityFindings = qualityFor(`device:${d.id}`);
      const degradedStatus = this.degradeByMaintenance(
        this.toCanonicalStatus(d.faultCode ? 'fault' : stale ? 'offline' : 'online'),
        maintenance,
      );
      return {
        // 调度主键 = uuid；业务设备号单列透出（世界模型 join 边缘事实的显式键）
        id: d.id,
        deviceId: d.deviceId ?? null,
        entityId: `device:${d.id}`,
        workerName: d.workerName ?? null,
        deviceModel: d.deviceModel ?? null,
        batteryPct: normalizeBatteryPct(d.batteryPct),
        // NO-34a：活跃会话随世界模型透出（无会话 → null，不伪造）
        activeExoSession: (d.deviceId ? activeSessionByDeviceId.get(d.deviceId) : undefined) ?? null,
        capabilities,
        ...(resolved.observedCapabilities.length > 0
          ? { observedCapabilities: resolved.observedCapabilities }
          : {}),
        // NO-15b：人工停用的能力也是事实（缺失 ≠ 停用），随世界模型透出
        ...(resolved.disabledCapabilities && resolved.disabledCapabilities.length > 0
          ? {
              disabledCapabilities: resolved.disabledCapabilities,
              disabledCapabilityLifecycle: resolved.disabledCapabilityLifecycle,
            }
          : {}),
        ...(resolved.capabilityRecords && resolved.capabilityRecords.length > 0
          ? { capabilityRecords: resolved.capabilityRecords }
          : {}),
        ...(resolved.capabilityLedgerIssues
          ? { capabilityLedgerIssues: resolved.capabilityLedgerIssues }
          : {}),
        // NO-05c：critical 维护 → 离线（fail-closed）；STALE 与 fault 语义不变。
        online: stale ? false : degradedStatus === 'OFFLINE' ? false : (d.online ?? false),
        status: degradedStatus,
        x: hasDeviceLocation && !isWgs84 ? lat : null,
        y: hasDeviceLocation && !isWgs84 ? lng : null,
        locationStationId: deviceSe ? (deviceSe.parentId ?? null) : null,
        availableWindows: this.parseWindows(d.availableWindows),
        locationConfidence: hasDeviceLocation ? (d.locationConfidence ?? null) : null,
        locationUpdatedAt: d.locationUpdatedAt ? d.locationUpdatedAt.getTime() : null,
        telemetryUpdatedAt: d.telemetryUpdatedAt ? d.telemetryUpdatedAt.getTime() : null,
        sourceTs,
        freshnessMs: this.resolveFreshnessMs('device', 'telemetry'),
        dataQuality,
        // P1-B：capabilities 命中型号白名单兜底（derived 非空）→ DERIVED，否则 AUTHORITATIVE。
        source: derived.length > 0 ? 'DERIVED' : 'AUTHORITATIVE',
        // P1-A：维护时间窗（真实列；两列均 NULL → 空数组，不伪造）。
        maintenanceWindows: this.parseMaintenanceWindows(
          d.maintenanceStartMs,
          d.maintenanceEndMs,
        ),
        // NO-05c：活跃维护事实附着（无活跃条件 → null，不伪造）。
        maintenance: maintenance.length > 0 ? maintenance : null,
        // NO-05d：活跃质量发现事实附着（无关联 → null，不伪造）。
        qualityFindings: qualityFindings.length > 0 ? qualityFindings : null,
        derived,
        coordinate: this.toCoordinateFromDevice(d, hasDeviceLocation),
      };
    });

    const stations: Array<
      WorldStateSnapshot['stations'][number] & { source?: 'AUTHORITATIVE' | 'DERIVED' }
    > = spatialRows
      .filter((se) => ['workstation', 'station'].includes(se.entityType ?? ''))
      .map((se) => {
        // NEST-154 修复（2026-08-17）：capacity=0（显式不可用/已封位）不再被
        // 误判为 null（未知）。仅非法类型/未写值才回退 null。
        const capacity = typeof se.capacity === 'number' ? se.capacity : null;
        // P0-3：WGS84 坐标不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
        const isWgs84 = (se.coordinateType ?? 'FACTORY_CARTESIAN') === 'WGS84';
        // NO-05c：工位快照无 status 字段；活跃维护事实附着（无 → null），
        // 资格评估经 stationMaintenanceBlockedById fail-closed 拒绝派工。
        const maintenance = maintenanceFor(`station:${se.entityId}`);
        // NO-05d：活跃质量发现事实附着（无关联 → null）；critical/high 封锁经
        // stationQualityBlockedById（candidate-engine）执行，medium/low 仅可见。
        const qualityFindings = qualityFor(`station:${se.entityId}`);
        return {
          id: se.entityId,
          entityId: `station:${se.entityId}`,
          name: se.name,
          x: !isWgs84 ? (se.x ?? null) : null,
          y: !isWgs84 ? (se.y ?? null) : null,
          capacity,
          queue: this.asStringArray(se.queue),
          availableWindows: this.parseWindows(se.availableWindows),
          // P1-3：工位基础能力（空间实体类型；供 requiredStationCapabilities 匹配）。
          capabilities: se.entityType ? [se.entityType] : [],
          // NO-05c：活跃维护事实附着（无活跃条件 → null，不伪造）。
          maintenance: maintenance.length > 0 ? maintenance : null,
          // NO-05d：活跃质量发现事实附着（无关联 → null，不伪造）。
          qualityFindings: qualityFindings.length > 0 ? qualityFindings : null,
          // P1-B：station 能力来自真实列 entityType（非白名单兜底）→ AUTHORITATIVE。
          source: 'AUTHORITATIVE',
          coordinate: this.toCoordinateFromSpatial(se),
        };
      });

    return { persons, devices, stations };
  }

  /** 空间实体 → 坐标判别联合（P0-3；coordinate_type/floor_id 列）。 */
  private toCoordinateFromSpatial(se?: {
    coordinateType?: string | null;
    floorId?: string | null;
    x?: number | null;
    y?: number | null;
  }): CoordinateReference {
    if (!se || !se.coordinateType || se.coordinateType === 'UNKNOWN') {
      return { type: 'UNKNOWN' };
    }
    if (se.coordinateType === 'WGS84') {
      // P1（2026-08-19 审计）坐标混载修正：契约（shared/location.ts +
      // contracts/location/location.schema.json + Python 契约）明确 WGS84
      // 行 x 轴承载 lat∈[-90,90]、y 轴承载 lng∈[-180,180]。原实现
      // `lat = se.y ?? se.x` 与契约相反——同一组 x/y 在不同消费点被解释
      // 为不同语义（这正是混载病灶的实物证据）。
      const lat = se.x;
      const lng = se.y;
      if (lat == null || lng == null) return { type: 'UNKNOWN' };
      return { type: 'WGS84', lat, lng };
    }
    // FACTORY_CARTESIAN（默认）。
    if (se.x == null || se.y == null) return { type: 'UNKNOWN' };
    return { type: 'FACTORY_CARTESIAN', x: se.x, y: se.y, floorId: se.floorId ?? null };
  }

  /** 设备位置 → 坐标判别联合（location_coordinate_type 列；location_lat/lng 可能为 WGS84）。 */
  private toCoordinateFromDevice(
    d: {
      locationCoordinateType?: string | null;
      locationLat?: number | null;
      locationLng?: number | null;
    },
    hasDeviceLocation: boolean,
  ): CoordinateReference {
    const type = d.locationCoordinateType ?? 'FACTORY_CARTESIAN';
    // NEST-155 修复（2026-08-17）：坐标任一缺失 → 显式 UNKNOWN（禁止 0,0
    // 伪坐标兜底——0 兜底会把"未知位置"伪装成工厂原点参与路由计算）。
    if (
      !hasDeviceLocation ||
      type === 'UNKNOWN' ||
      d.locationLat == null ||
      d.locationLng == null
    ) {
      return { type: 'UNKNOWN' };
    }
    if (type === 'WGS84') {
      return { type: 'WGS84', lat: d.locationLat, lng: d.locationLng };
    }
    return {
      type: 'FACTORY_CARTESIAN',
      x: d.locationLat,
      y: d.locationLng,
      floorId: null,
    };
  }

  /** jsonb 可用窗口列解析（[{ startMs, endMs }]）。 */
  private parseWindows(v: unknown): Array<{ startMs: number; endMs: number }> {
    if (!Array.isArray(v)) return [];
    const out: Array<{ startMs: number; endMs: number }> = [];
    for (const item of v) {
      if (typeof item === 'object' && item !== null) {
        const rec = item as Record<string, unknown>;
        if (typeof rec.startMs === 'number' && typeof rec.endMs === 'number') {
          out.push({ startMs: rec.startMs, endMs: rec.endMs });
        }
      }
    }
    return out;
  }

  /**
   * 设备维护时间窗（P1-A）：读取真实列 maintenance_start_ms / maintenance_end_ms。
   * 两列任一为 NULL（无维护计划/数据不完整）→ 空数组（缺数据不伪造窗口、不产生约束）；
   * endMs <= startMs（非法区间）同样丢弃（fail-safe）。
   */
  private parseMaintenanceWindows(
    startMs: number | null | undefined,
    endMs: number | null | undefined,
  ): Array<{ startMs: number; endMs: number }> {
    if (startMs == null || endMs == null) return [];
    if (!(endMs > startMs)) return [];
    return [{ startMs, endMs }];
  }
}
