import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohPersonnel,
  ewohDevice,
  ewohSpatialEntity,
} from '@server/database/schema';
import type {
  CoordinateReference,
  FreshnessPolicy,
  ResourceState,
  WorldStateSnapshot,
} from '@shared/api.interface';
import {
  ResourceReservationService,
  type ReservationResult,
} from './resource-reservation.service';
import { deriveDeviceCapabilities } from './device-capabilities';

/** 数据新鲜度阈值（ms）：sourceTs 距今超过该值则标 STALE。保留向后兼容常量。 */
export const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * 默认差异化新鲜度策略（Task 3 / 3.2）：按 resourceType + signalType 差异化阈值。
 * person:location=60s / telemetry=120s / master=5min；device:telemetry=60s /
 * location=120s / master=5min；station:master=5min；未命中一律回退 default=5min。
 * STALE/UNKNOWN 资源绝不被视为 AVAILABLE（fail-closed）。
 */
export const DEFAULT_FRESHNESS_POLICY: FreshnessPolicy = {
  policyVersion: 1,
  thresholdsMs: {
    'person:location': 60 * 1000,
    'person:telemetry': 120 * 1000,
    'person:master': DEFAULT_FRESHNESS_MS,
    'device:telemetry': 60 * 1000,
    'device:location': 120 * 1000,
    'device:master': DEFAULT_FRESHNESS_MS,
    'station:master': DEFAULT_FRESHNESS_MS,
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
   * 统一资源状态聚合入口：person / device / station 的单一权威投影，
   * 已水合 reservations 与 availableWindows。map / ResourcePool /
   * Scheduler / Dispatch 应统一从此处消费。
   */
  async getUnifiedResourceState(): Promise<ResourceState[]> {
    return this.project();
  }

  /** 查询全部资源（person / device / station）的统一投影。 */
  async project(): Promise<ResourceState[]> {
    const [personnelRows, deviceRows, spatialRows, reservations] =
      await Promise.all([
        this.db.select().from(ewohPersonnel),
        this.db.select().from(ewohDevice),
        this.db.select().from(ewohSpatialEntity),
        this.reservationService.listActive(),
      ]);
    this.logger.debug(
      `resource projection: personnel=${personnelRows.length} device=${deviceRows.length} spatial=${spatialRows.length} reservations=${reservations.length}`,
    );

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
      const sourceTs = p.updatedAt ? p.updatedAt.getTime() : null;
      const dataQuality = this.classifyFreshness(sourceTs, now, 'person', 'master');
      return {
        id: p.id,
        type: 'person',
        // 数据过时（STALE/UNKNOWN）时不得显示为可派工：与调度 world-state 语义一致。
        status:
          dataQuality === 'FRESH' ? (p.status ?? 'available') : 'unavailable',
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
          loadLevel: load?.loadLevel ?? null,
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
      // 能力：与 world-state 统一读 ewoh_device.capabilities 列（SSOT，消除 [deviceModel]
      // 裸串语义不一致）；列无值才按型号白名单派生并标记 derived。
      const columnCaps = this.asStringArray(d.capabilities);
      const capabilities =
        columnCaps.length > 0 ? columnCaps : deriveDeviceCapabilities(d.deviceModel);
      if (columnCaps.length === 0) derived.push('capabilities');
      // 位置：设备自身 location_lat/lng（真实遥测）；缺失则显式 UNKNOWN(null)，绝不借人员坐标。
      const hasDeviceLocation = d.locationLat != null && d.locationLng != null;
      return {
        id: d.id,
        type: 'device',
        // 数据过时（STALE/UNKNOWN）→ 视为离线；faultCode 存在 → fault（优先）。
        status: d.faultCode
          ? 'fault'
          : deviceDataQuality === 'FRESH'
            ? 'online'
            : 'offline',
        capabilities,
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
          batteryPct: d.batteryPct ?? null,
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
          type: 'station',
          // 禁止虚构：无数据（STALE/UNKNOWN）→ unavailable；FRESH 时取真实状态
          // （空间实体的 status 列，如 active），否则 unavailable 而非臆造 available。
          status:
            stationDataQuality === 'FRESH'
              ? (se.status ?? 'available')
              : 'unavailable',
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

    return [...persons, ...deviceResources, ...stations];
  }

  /** 按资源类型过滤投影；tool / material / vehicle 无对应表，返回空数组。 */
  async projectByType(type: ResourceState['type']): Promise<ResourceState[]> {
    const all = await this.getUnifiedResourceState();
    return all.filter((r) => r.type === type);
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
  private classifyFreshness(
    sourceTs: number | null,
    now: number,
    resourceType?: string,
    signalType?: string,
  ): 'FRESH' | 'STALE' | 'UNKNOWN' {
    if (sourceTs == null) return 'UNKNOWN';
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
  async projectForSnapshot(): Promise<{
    persons: WorldStateSnapshot['persons'];
    devices: WorldStateSnapshot['devices'];
    stations: WorldStateSnapshot['stations'];
  }> {
    const [personnelRows, deviceRows, spatialRows, reservations] =
      await Promise.all([
        this.db.select().from(ewohPersonnel),
        this.db.select().from(ewohDevice),
        this.db.select().from(ewohSpatialEntity),
        this.reservationService.listActive(),
      ]);

    const spatialByEntityId = new Map<string, (typeof spatialRows)[number]>();
    for (const se of spatialRows) spatialByEntityId.set(se.entityId, se);

    // 人员下一次可用时间：取该人员未来 reservation 的最大结束时间（真实占用）。
    const personReservationEnd = new Map<string, number>();
    for (const r of reservations) {
      if (r.resourceType === 'person' && r.endMs != null) {
        const cur = personReservationEnd.get(r.resourceId) ?? 0;
        if (r.endMs > cur) personReservationEnd.set(r.resourceId, r.endMs);
      }
    }

    const now = Date.now();

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
      const sourceTs = p.updatedAt ? p.updatedAt.getTime() : null;
      const dataQuality = this.classifyFreshness(sourceTs, now, 'person', 'master');
      return {
        id: p.id,
        name: p.name,
        status:
          dataQuality === 'FRESH' ? (p.status ?? 'available') : 'unavailable',
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
        // P1-B：字段来源维度（与 dataQuality 正交）。person 投影无派生兜底字段 → AUTHORITATIVE。
        source: 'AUTHORITATIVE',
        coordinate: this.toCoordinateFromSpatial(se),
      };
    });

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
      const columnCaps = this.asStringArray(d.capabilities);
      const capabilities =
        columnCaps.length > 0 ? columnCaps : deriveDeviceCapabilities(d.deviceModel);
      if (columnCaps.length === 0) derived.push('capabilities');
      const lat = d.locationLat ?? null;
      const lng = d.locationLng ?? null;
      const hasDeviceLocation = lat != null && lng != null;
      // P0-3：WGS84 坐标不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
      const isWgs84 = (d.locationCoordinateType ?? 'FACTORY_CARTESIAN') === 'WGS84';
      const deviceSe = d.deviceId ? spatialByEntityId.get(d.deviceId) : undefined;
      return {
        id: d.id,
        workerName: d.workerName ?? null,
        deviceModel: d.deviceModel ?? null,
        batteryPct: d.batteryPct ?? 100,
        capabilities,
        online: stale ? false : (d.online ?? false),
        status: d.faultCode ? 'fault' : stale ? 'offline' : 'online',
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
        derived,
        coordinate: this.toCoordinateFromDevice(d, hasDeviceLocation),
      };
    });

    const stations: Array<
      WorldStateSnapshot['stations'][number] & { source?: 'AUTHORITATIVE' | 'DERIVED' }
    > = spatialRows
      .filter((se) => ['workstation', 'station'].includes(se.entityType ?? ''))
      .map((se) => {
        const capacity =
          typeof se.capacity === 'number' && se.capacity > 0 ? se.capacity : null;
        // P0-3：WGS84 坐标不进笛卡尔 x/y（仅 coordinate 承载 lat/lng）。
        const isWgs84 = (se.coordinateType ?? 'FACTORY_CARTESIAN') === 'WGS84';
        return {
          id: se.entityId,
          name: se.name,
          x: !isWgs84 ? (se.x ?? null) : null,
          y: !isWgs84 ? (se.y ?? null) : null,
          capacity,
          queue: this.asStringArray(se.queue),
          availableWindows: this.parseWindows(se.availableWindows),
          // P1-3：工位基础能力（空间实体类型；供 requiredStationCapabilities 匹配）。
          capabilities: se.entityType ? [se.entityType] : [],
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
      const lat = se.y ?? se.x;
      const lng = se.x ?? se.y;
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
    if (!hasDeviceLocation || type === 'UNKNOWN') {
      return { type: 'UNKNOWN' };
    }
    if (type === 'WGS84') {
      return { type: 'WGS84', lat: d.locationLat ?? 0, lng: d.locationLng ?? 0 };
    }
    return {
      type: 'FACTORY_CARTESIAN',
      x: d.locationLat ?? 0,
      y: d.locationLng ?? 0,
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