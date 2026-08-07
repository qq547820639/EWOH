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

/**
 * 统一资源状态投影服务：将人员 / 设备 / 工位（station）投影为统一的
 * ResourceState。复用现有表（ewohPersonnel / ewohDevice / ewohSpatialEntity），
 * 不新增数据模型。tool / material / vehicle 暂无对应表，投影为空。
 * reservations 由 reservation 服务单独水合，此处默认为空数组。
 */
@Injectable()
export class ResourceProjectionService {
  private readonly logger = new Logger(ResourceProjectionService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** 查询全部资源（person / device / station）的统一投影。 */
  async project(): Promise<ResourceState[]> {
    const [personnelRows, deviceRows, spatialRows] = await Promise.all([
      this.db.select().from(ewohPersonnel),
      this.db.select().from(ewohDevice),
      this.db.select().from(ewohSpatialEntity),
    ]);
    this.logger.debug(
      `resource projection: personnel=${personnelRows.length} device=${deviceRows.length} spatial=${spatialRows.length}`,
    );

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
        availableWindows: [],
        reservations: [],
        telemetry: {
          batteryPct: null,
          loadLevel: load?.loadLevel ?? null,
          fatigueLevel: load?.fatigueLevel ?? null,
          healthStatus: p.healthStatus ?? null,
        },
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
        availableWindows: [],
        reservations: [],
        telemetry: {
          batteryPct: d.batteryPct ?? null,
          loadLevel: null,
          fatigueLevel: null,
          healthStatus: null,
        },
        version: 1,
      };
    });

    const stations: ResourceState[] = spatialRows
      .filter(
        (se) => se.entityType === 'workstation' || se.entityType === 'station',
      )
      .map((se) => ({
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
        availableWindows: [],
        reservations: [],
        telemetry: {
          batteryPct: null,
          loadLevel: null,
          fatigueLevel: null,
          healthStatus: null,
        },
        version: 1,
      }));

    return [...persons, ...deviceResources, ...stations];
  }

  /** 按资源类型过滤投影；tool / material / vehicle 无对应表，返回空数组。 */
  async projectByType(type: ResourceState['type']): Promise<ResourceState[]> {
    const all = await this.project();
    return all.filter((r) => r.type === type);
  }
}