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
import type { ResourceState } from '@shared/api.interface';
import {
  ResourceReservationService,
  type ReservationResult,
} from './resource-reservation.service';

/** 数据新鲜度阈值（ms）：sourceTs 距今超过该值则标 STALE。 */
const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;
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
      return {
        id: p.id,
        type: 'person',
        status: p.status ?? 'available',
        capabilities: Array.isArray(p.skills) ? (p.skills as string[]) : [],
        certifications: Array.isArray(p.certifications)
          ? (p.certifications as string[])
          : [],
        location: {
          stationId: p.spatialEntityId ?? null,
          zoneId: se ? (se.parentId ?? null) : null,
          x: se ? (se.x ?? 0) : 0,
          y: se ? (se.y ?? 0) : 0,
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
        // ewohPersonnel 无"当前任务"列，team 取真实 team_name 列，班次无列故为 null。
        currentTask: null,
        team: p.teamName ?? null,
        shift: null,
        updatedAt: sourceTs,
        sourceTs,
        freshnessMs: DEFAULT_FRESHNESS_MS,
        dataQuality: this.classifyFreshness(sourceTs, now),
        version: p.version ?? 1,
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
      return {
        id: d.id,
        type: 'device',
        status: d.faultCode ? 'fault' : 'online',
        capabilities: d.deviceModel ? [d.deviceModel] : [],
        certifications: [],
        location: {
          stationId: se ? (se.parentId ?? null) : null,
          zoneId: parentSe ? (parentSe.parentId ?? null) : null,
          x: se ? (se.x ?? 0) : 0,
          y: se ? (se.y ?? 0) : 0,
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
        updatedAt: sourceTs,
        sourceTs,
        freshnessMs: DEFAULT_FRESHNESS_MS,
        dataQuality: this.classifyFreshness(sourceTs, now),
        version: 1,
      };
    });

    const stations: ResourceState[] = spatialRows
      .filter(
        (se) => se.entityType === 'workstation' || se.entityType === 'station',
      )
      .map((se) => {
        const sRes = resFor('station', se.entityId);
        const sourceTs = se.updatedAt ? se.updatedAt.getTime() : null;
        return {
          id: se.entityId,
          type: 'station',
          status: 'available',
          capabilities: [se.entityType],
          certifications: [],
          location: {
            stationId: se.entityId,
            zoneId: se.parentId ?? null,
            x: se.x ?? 0,
            y: se.y ?? 0,
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
          // ewohSpatialEntity 无 currentTask / team / shift 背衬列，一律 null。
          currentTask: null,
          team: null,
          shift: null,
          updatedAt: sourceTs,
          sourceTs,
          freshnessMs: DEFAULT_FRESHNESS_MS,
          dataQuality: this.classifyFreshness(sourceTs, now),
          version: se.version ?? 1,
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

  /** 无时间戳 → UNKNOWN；距今超过阈值 → STALE；否则 FRESH。 */
  private classifyFreshness(
    sourceTs: number | null,
    now: number,
  ): 'FRESH' | 'STALE' | 'UNKNOWN' {
    if (sourceTs == null) return 'UNKNOWN';
    if (now - sourceTs > DEFAULT_FRESHNESS_MS) return 'STALE';
    return 'FRESH';
  }
}