import { Injectable, Inject, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohDevice,
  ewohEvent,
  ewohTelemetry,
  ewohSpatialEntity,
  ewohDeviceBinding,
  ewohEnvironment,
} from '@server/database/schema';
import { eq, desc, asc, sql, and, gte, lte, ilike, or, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import type {
  DeviceInfo,
  DeviceSearchQuery,
  CreateDeviceDto,
  UpdateDeviceDto,
  DeviceBinding,
  BindDeviceRequest,
  EventInfo,
  TelemetryInfo,
  OverviewStats,
  EventStats,
  WorkerLoad,
  DeviceSearchResult,
  EnvironmentReading,
} from '@shared/api.interface';

export function normalizePagination(page?: number, pageSize?: number) {
  const safePage = Math.max(1, Math.trunc(page ?? 1));
  const safeSize = Math.min(100, Math.max(1, Math.trunc(pageSize ?? 20)));
  return { page: safePage, pageSize: safeSize };
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async getOverview(): Promise<OverviewStats> {
    try {
      const [deviceStats] = await this.db
        .select({
          total: sql<number>`count(*)::int`,
          online: sql<number>`count(*) filter (where ${ewohDevice.online} = true)::int`,
        })
        .from(ewohDevice);

      const [eventStats] = await this.db
        .select({
          open: sql<number>`count(*) filter (where ${ewohEvent.status} = 'open')::int`,
          critical: sql<number>`count(*) filter (where ${ewohEvent.severity} in ('L2','L3'))::int`,
        })
        .from(ewohEvent);

      const [loadStats] = await this.db
        .select({
          avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
        })
        .from(ewohTelemetry)
        .where(gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`));

      const [workerStats] = await this.db
        .select({
          count: sql<number>`count(distinct ${ewohDevice.workerName})::int`,
        })
        .from(ewohDevice)
        .where(sql`${ewohDevice.workerName} is not null and ${ewohDevice.workerName} != ''`);

      return {
        deviceTotal: deviceStats?.total ?? 0,
        deviceOnline: deviceStats?.online ?? 0,
        eventOpen: eventStats?.open ?? 0,
        eventCritical: eventStats?.critical ?? 0,
        avgLoad: Number((loadStats?.avgLoad ?? 0).toFixed(3)),
        workerCount: workerStats?.count ?? 0,
      };
    } catch (error) {
      this.logger.error('getOverview 失败', error);
      throw error;
    }
  }

  async getEnvironmentSummary(): Promise<EnvironmentReading[]> {
    try {
      const rows = await this.db.execute<Record<string, unknown>>(
        sql`
          select distinct on (sensor_id)
            id::text as id,
            sensor_id,
            entity_id,
            temperature,
            vibration,
            noise,
            air_quality,
            ts,
            source_type,
            record_id,
            data_confidence
          from ${ewohEnvironment}
          order by sensor_id, ts desc
          limit 500
        `,
      );
      return rows.map((row) => ({
        id: String(row.id),
        sensorId: String(row.sensor_id),
        entityId: row.entity_id ? String(row.entity_id) : null,
        temperature: row.temperature === null || row.temperature === undefined ? null : Number(row.temperature),
        vibration: row.vibration === null || row.vibration === undefined ? null : Number(row.vibration),
        noise: row.noise === null || row.noise === undefined ? null : Number(row.noise),
        airQuality: row.air_quality === null || row.air_quality === undefined ? null : Number(row.air_quality),
        ts: row.ts ? new Date(row.ts as Date).toISOString() : new Date().toISOString(),
        sourceType: row.source_type ? String(row.source_type) : undefined,
        recordId: row.record_id ? String(row.record_id) : null,
        dataConfidence: row.data_confidence === null || row.data_confidence === undefined ? null : Number(row.data_confidence),
      }));
    } catch (error) {
      this.logger.error('getEnvironmentSummary 失败', error);
      throw error;
    }
  }

  async getDevices(query?: DeviceSearchQuery): Promise<DeviceInfo[]> {
    try {
      const conditions = this.buildDeviceConditions(query);
      const rows = await this.buildDeviceQuery(conditions).orderBy(this.buildDeviceOrder(query));
      return this.mapDeviceRows(rows);
    } catch (error) {
      this.logger.error('getDevices 失败', error);
      throw error;
    }
  }

  async getDeviceDetail(deviceId: string): Promise<DeviceInfo> {
    try {
      const rows = await this.buildDeviceQuery([eq(ewohDevice.deviceId, deviceId)]);
      if (rows.length === 0) {
        throw new NotFoundException(`Device ${deviceId} not found`);
      }
      return this.mapDeviceRows(rows)[0];
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.logger.error('getDeviceDetail 失败', error);
      throw error;
    }
  }

  async searchDevices(query: DeviceSearchQuery = {}): Promise<DeviceSearchResult> {
    try {
      const conditions = this.buildDeviceConditions(query);
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      const { page, pageSize } = normalizePagination(query.page, query.pageSize);

      const [totalRows] = await this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(ewohDevice)
        .where(where);

      const rows = await this.buildDeviceQuery(conditions)
        .orderBy(this.buildDeviceOrder(query))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: this.mapDeviceRows(rows),
        total: totalRows?.total ?? 0,
        page,
        pageSize,
      };
    } catch (error) {
      this.logger.error('searchDevices 失败', error);
      throw error;
    }
  }

  private buildDeviceConditions(query?: DeviceSearchQuery): SQL[] {
    const conditions: SQL[] = [];
    if (query?.keyword) {
      const kw = `%${query.keyword}%`;
      conditions.push(
        or(
          ilike(ewohDevice.deviceId, kw),
          ilike(ewohDevice.workerName, kw),
          ilike(ewohDevice.deviceModel, kw),
        ) as SQL,
      );
    }
    if (query?.online !== undefined) {
      conditions.push(eq(ewohDevice.online, query.online));
    }
    if (query?.batteryMin !== undefined) {
      conditions.push(gte(ewohDevice.batteryPct, query.batteryMin));
    }
    if (query?.batteryMax !== undefined) {
      conditions.push(lte(ewohDevice.batteryPct, query.batteryMax));
    }
    if (query?.sourceType) {
      conditions.push(eq(ewohDevice.sourceType, query.sourceType));
    }
    if (query?.model) {
      conditions.push(eq(ewohDevice.deviceModel, query.model));
    }
    if (query?.firmwareVersion) {
      conditions.push(eq(ewohDevice.firmwareVersion, query.firmwareVersion));
    }
    if (query?.protocolVersion) {
      conditions.push(eq(ewohDevice.protocolVersion, query.protocolVersion));
    }
    if (query?.faultCode) {
      conditions.push(eq(ewohDevice.faultCode, query.faultCode));
    }
    if (query?.bindingStatus === 'bound') {
      conditions.push(
        sql`exists (select 1 from ${ewohDeviceBinding} b where b.device_id = ${ewohDevice.deviceId} and b.status = 'active')`,
      );
    }
    if (query?.bindingStatus === 'unbound') {
      conditions.push(
        sql`not exists (select 1 from ${ewohDeviceBinding} b where b.device_id = ${ewohDevice.deviceId} and b.status = 'active')`,
      );
    }
    return conditions;
  }

  private buildDeviceOrder(query?: DeviceSearchQuery) {
    switch (query?.orderby) {
      case 'battery':
        return asc(ewohDevice.batteryPct);
      case 'batteryDesc':
        return desc(ewohDevice.batteryPct);
      case 'lastTelemetryAt':
        return asc(ewohDevice.lastTelemetryAt);
      case 'lastTelemetryAtDesc':
        return desc(ewohDevice.lastTelemetryAt);
      case 'deviceId':
        return asc(ewohDevice.deviceId);
      case 'deviceIdDesc':
        return desc(ewohDevice.deviceId);
      default:
        return desc(ewohDevice.online);
    }
  }

  private buildDeviceQuery(conditions: SQL[]) {
    const deviceEntity = alias(ewohSpatialEntity, 'device_entity');
    const personEntity = alias(ewohSpatialEntity, 'person_entity');
    return this.db
      .select({
        id: ewohDevice.id,
        deviceId: ewohDevice.deviceId,
        workerName: ewohDevice.workerName,
        deviceModel: ewohDevice.deviceModel,
        batteryPct: ewohDevice.batteryPct,
        online: ewohDevice.online,
        lastTelemetryAt: ewohDevice.lastTelemetryAt,
        sourceType: ewohDevice.sourceType,
        firmwareVersion: ewohDevice.firmwareVersion,
        hardwareVersion: ewohDevice.hardwareVersion,
        protocolVersion: ewohDevice.protocolVersion,
        temperatureC: ewohDevice.temperatureC,
        faultCode: ewohDevice.faultCode,
        lastRawRef: ewohDevice.lastRawRef,
        entityId: deviceEntity.entityId,
        parentId: deviceEntity.parentId,
        x: deviceEntity.x,
        y: deviceEntity.y,
        boundPersonId: personEntity.entityId,
        boundPersonName: personEntity.name,
      })
      .from(ewohDevice)
      .leftJoin(
        deviceEntity,
        and(eq(deviceEntity.entityType, 'device'), eq(deviceEntity.entityId, ewohDevice.deviceId)),
      )
      .leftJoin(
        personEntity,
        and(
          eq(personEntity.entityType, 'person'),
          sql`${personEntity.extra}->>'device_id' = ${ewohDevice.deviceId}`,
        ),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined);
  }

  private mapDeviceRows(rows: Array<Record<string, unknown>>) {
    return rows.map((r) => ({
      id: String(r.id),
      deviceId: String(r.deviceId),
      workerName: String(r.workerName ?? ''),
      deviceModel: String(r.deviceModel ?? ''),
      batteryPct: Number(r.batteryPct ?? 0),
      online: Boolean(r.online),
      lastTelemetryAt: r.lastTelemetryAt
        ? new Date(r.lastTelemetryAt as Date).toISOString()
        : null,
      sourceType: r.sourceType ? String(r.sourceType) : undefined,
      firmwareVersion: r.firmwareVersion ? String(r.firmwareVersion) : null,
      hardwareVersion: r.hardwareVersion ? String(r.hardwareVersion) : null,
      protocolVersion: r.protocolVersion ? String(r.protocolVersion) : null,
      temperatureC: r.temperatureC === null || r.temperatureC === undefined ? null : Number(r.temperatureC),
      faultCode: r.faultCode ? String(r.faultCode) : null,
      lastRawRef: r.lastRawRef ? String(r.lastRawRef) : null,
      entityId: r.entityId ? String(r.entityId) : undefined,
      parentId: r.parentId ? String(r.parentId) : null,
      x: r.x === null || r.x === undefined ? undefined : Number(r.x),
      y: r.y === null || r.y === undefined ? undefined : Number(r.y),
      boundPersonId: r.boundPersonId ? String(r.boundPersonId) : null,
      boundPersonName: r.boundPersonName ? String(r.boundPersonName) : null,
    }));
  }

  async getEvents(limit: number = 50, status?: string): Promise<EventInfo[]> {
    try {
      const conditions = status ? [eq(ewohEvent.status, status)] : [];
      const query = this.db
        .select()
        .from(ewohEvent)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(ewohEvent.createdAt))
        .limit(limit);
      const rows = await query;
      return rows.map((r) => ({
        id: r.id,
        eventId: r.eventId,
        deviceId: r.deviceId ?? '',
        eventCode: r.eventCode ?? '',
        eventType: r.eventType ?? '',
        severity: r.severity ?? '',
        title: r.title ?? '',
        status: r.status ?? 'open',
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
        handlerAction: r.handlerAction ?? null,
      }));
    } catch (error) {
      this.logger.error('getEvents 失败', error);
      throw error;
    }
  }

  async getEventStats(): Promise<EventStats> {
    try {
      const severityRows = await this.db
        .select({
          severity: ewohEvent.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(ewohEvent)
        .groupBy(ewohEvent.severity);

      const statusRows = await this.db
        .select({
          status: ewohEvent.status,
          count: sql<number>`count(*)::int`,
        })
        .from(ewohEvent)
        .groupBy(ewohEvent.status);

      const trendRows = await this.db
        .select({
          time: sql<string>`to_char(date_trunc('hour', ${ewohEvent.createdAt}), 'YYYY-MM-DD HH24:MI')`,
          count: sql<number>`count(*)::int`,
        })
        .from(ewohEvent)
        .where(gte(ewohEvent.createdAt, sql`now() - interval '24 hours'`))
        .groupBy(sql`date_trunc('hour', ${ewohEvent.createdAt})`)
        .orderBy(sql`date_trunc('hour', ${ewohEvent.createdAt})`);

      const bySeverity: Record<string, number> = {};
      severityRows.forEach((r) => {
        if (r.severity) bySeverity[r.severity] = r.count;
      });

      const byStatus: Record<string, number> = {};
      statusRows.forEach((r) => {
        if (r.status) byStatus[r.status] = r.count;
      });

      return {
        bySeverity,
        byStatus,
        trend: trendRows.map((r) => ({ time: r.time, count: r.count })),
      };
    } catch (error) {
      this.logger.error('getEventStats 失败', error);
      throw error;
    }
  }

  async getTelemetry(deviceId: string, limit: number = 50): Promise<TelemetryInfo[]> {
    try {
      const rows = await this.db
        .select()
        .from(ewohTelemetry)
        .where(eq(ewohTelemetry.deviceId, deviceId))
        .orderBy(desc(ewohTelemetry.ts))
        .limit(limit);
      return rows.map((r) => ({
        id: r.id,
        deviceId: r.deviceId,
        ts: r.ts.toISOString(),
        pitchDeg: r.pitchDeg,
        loadScore: r.loadScore,
        fatigueTrend: r.fatigueTrend,
        batteryPct: r.batteryPct,
        qualityStatus: r.qualityStatus,
      }));
    } catch (error) {
      this.logger.error('getTelemetry 失败', error);
      throw error;
    }
  }

  async getWorkers(): Promise<WorkerLoad[]> {
    try {
      const rows = await this.db
        .select({
          deviceId: ewohDevice.deviceId,
          workerName: ewohDevice.workerName,
          online: ewohDevice.online,
          batteryPct: ewohDevice.batteryPct,
          avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
          maxLoad: sql<number>`coalesce(max(${ewohTelemetry.loadScore}), 0)::float`,
          fatigueTrend: sql<number>`coalesce(avg(${ewohTelemetry.fatigueTrend}), 0)::float`,
          telemetryCount: sql<number>`count(${ewohTelemetry.id})::int`,
        })
        .from(ewohDevice)
        .leftJoin(ewohTelemetry, eq(ewohTelemetry.deviceId, ewohDevice.deviceId))
        .where(gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
        .groupBy(ewohDevice.deviceId, ewohDevice.workerName, ewohDevice.online, ewohDevice.batteryPct);

      return rows.map((r) => ({
        deviceId: r.deviceId,
        workerName: r.workerName ?? '',
        avgLoad: Number((r.avgLoad ?? 0).toFixed(3)),
        maxLoad: Number((r.maxLoad ?? 0).toFixed(3)),
        fatigueTrend: Number((r.fatigueTrend ?? 0).toFixed(3)),
        batteryPct: r.batteryPct ?? 0,
        online: r.online ?? false,
        telemetryCount: r.telemetryCount ?? 0,
      }));
    } catch (error) {
      this.logger.error('getWorkers 失败', error);
      throw error;
    }
  }

  async handleEvent(
    eventId: string,
    handlerAction: string,
    handlerNote?: string,
    operator?: string,
    actor?: OrgContext,
  ): Promise<EventInfo> {
    try {
      const [existing] = await this.db
        .select()
        .from(ewohEvent)
        .where(eq(ewohEvent.eventId, eventId))
        .limit(1);

      if (!existing) {
        throw new NotFoundException(`Event ${eventId} not found`);
      }

      const now = new Date();
      const existingEvidence = (existing.evidenceJson as Record<string, unknown> | null) ?? {};

      const [updated] = await this.db
        .update(ewohEvent)
        .set({
          status: 'handled',
          handlerAction,
          evidenceJson: {
            ...existingEvidence,
            handler_note: handlerNote ?? null,
            handler_operator: operator ?? null,
            handled_at: now.toISOString(),
          },
        })
        .where(eq(ewohEvent.eventId, eventId))
        .returning();

      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? operator ?? 'system',
        orgId: actor?.primaryOrgId ?? '',
        action: 'event.handle',
        entityType: 'event',
        entityId: eventId,
        before: { status: existing.status, handlerAction: existing.handlerAction ?? null },
        after: { status: updated.status, handlerAction: updated.handlerAction ?? null },
        reason: handlerNote ?? null,
      });

      return {
        id: updated.id,
        eventId: updated.eventId,
        deviceId: updated.deviceId ?? '',
        eventCode: updated.eventCode ?? '',
        eventType: updated.eventType ?? '',
        severity: updated.severity ?? '',
        title: updated.title ?? '',
        status: updated.status ?? 'handled',
        createdAt: updated.createdAt ? updated.createdAt.toISOString() : null,
        handlerAction: updated.handlerAction ?? null,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error('handleEvent 失败', error);
      throw error;
    }
  }

  async createDevice(dto: CreateDeviceDto): Promise<DeviceInfo> {
    try {
      const [existing] = await this.db
        .select({ deviceId: ewohDevice.deviceId })
        .from(ewohDevice)
        .where(eq(ewohDevice.deviceId, dto.deviceId))
        .limit(1);
      if (existing) {
        throw new BadRequestException('设备 ID 已存在');
      }

      const [created] = await this.db
        .insert(ewohDevice)
        .values({
          deviceId: dto.deviceId,
          workerName: dto.workerName ?? null,
          deviceModel: dto.deviceModel ?? null,
          batteryPct: dto.batteryPct ?? 100,
          online: dto.online ?? false,
          sourceType: dto.sourceType ?? 'simulated',
          firmwareVersion: dto.firmwareVersion ?? null,
          hardwareVersion: dto.hardwareVersion ?? null,
          protocolVersion: dto.protocolVersion ?? null,
        })
        .returning();

      return this.mapDevice(created);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      this.logger.error('createDevice 失败', error);
      throw error;
    }
  }

  async updateDevice(
    deviceId: string,
    dto: UpdateDeviceDto,
    actor?: OrgContext,
  ): Promise<DeviceInfo> {
    try {
      const [existing] = await this.db
        .select()
        .from(ewohDevice)
        .where(eq(ewohDevice.deviceId, deviceId))
        .limit(1);
      if (!existing) {
        throw new NotFoundException(`Device ${deviceId} not found`);
      }

      const updateData: Partial<typeof ewohDevice.$inferInsert> = {};
      if (dto.workerName !== undefined) updateData.workerName = dto.workerName;
      if (dto.deviceModel !== undefined) updateData.deviceModel = dto.deviceModel;
      if (dto.batteryPct !== undefined) updateData.batteryPct = dto.batteryPct;
      if (dto.online !== undefined) updateData.online = dto.online;
      if (dto.faultCode !== undefined) updateData.faultCode = dto.faultCode;
      if (dto.firmwareVersion !== undefined) updateData.firmwareVersion = dto.firmwareVersion;
      if (dto.hardwareVersion !== undefined) updateData.hardwareVersion = dto.hardwareVersion;
      if (dto.protocolVersion !== undefined) updateData.protocolVersion = dto.protocolVersion;
      if (dto.temperatureC !== undefined) updateData.temperatureC = dto.temperatureC;

      const [updated] = await this.db
        .update(ewohDevice)
        .set(updateData)
        .where(eq(ewohDevice.deviceId, deviceId))
        .returning();

      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'system',
        orgId: actor?.primaryOrgId ?? '',
        action: 'device.update',
        entityType: 'device',
        entityId: deviceId,
        before: {
          workerName: existing.workerName ?? null,
          deviceModel: existing.deviceModel ?? null,
          batteryPct: existing.batteryPct ?? null,
          online: existing.online ?? null,
          faultCode: existing.faultCode ?? null,
        },
        after: {
          workerName: updated.workerName ?? null,
          deviceModel: updated.deviceModel ?? null,
          batteryPct: updated.batteryPct ?? null,
          online: updated.online ?? null,
          faultCode: updated.faultCode ?? null,
        },
      });

      return this.mapDevice(updated);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error('updateDevice 失败', error);
      throw error;
    }
  }

  async getDeviceBindings(deviceId: string): Promise<DeviceBinding> {
    try {
      const [deviceEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(eq(ewohSpatialEntity.entityType, 'device'), eq(ewohSpatialEntity.entityId, deviceId)),
        )
        .limit(1);

      const hierarchyPath: Array<{ entityId: string; name: string; entityType: string }> = [];
      if (deviceEntity?.parentId) {
        const visited = new Set<string>();
        let currentId: string | null = deviceEntity.parentId;
        while (currentId && !visited.has(currentId)) {
          visited.add(currentId);
          const [entity] = await this.db
            .select()
            .from(ewohSpatialEntity)
            .where(eq(ewohSpatialEntity.entityId, currentId))
            .limit(1);
          if (!entity) break;
          hierarchyPath.push({
            entityId: entity.entityId,
            name: entity.name,
            entityType: entity.entityType,
          });
          currentId = entity.parentId;
        }
        hierarchyPath.reverse();
      }

      const [personEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.entityType, 'person'),
            sql`${ewohSpatialEntity.extra}->>'device_id' = ${deviceId}`,
          ),
        )
        .limit(1);

      return {
        deviceId,
        spatialEntityId: deviceEntity?.parentId ?? null,
        hierarchyPath,
        boundPersonId: personEntity?.entityId ?? null,
        boundPersonName: personEntity?.name ?? null,
      };
    } catch (error) {
      this.logger.error(`getDeviceBindings 失败 deviceId=${deviceId}`, error);
      throw error;
    }
  }

  async bindDevice(deviceId: string, req: BindDeviceRequest): Promise<DeviceBinding> {
    try {
      const [existingDeviceEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(eq(ewohSpatialEntity.entityType, 'device'), eq(ewohSpatialEntity.entityId, deviceId)),
        )
        .limit(1);

      let deviceEntity = existingDeviceEntity;
      if (!deviceEntity) {
        const [created] = await this.db
          .insert(ewohSpatialEntity)
          .values({
            entityId: deviceId,
            entityType: 'device',
            name: deviceId,
            parentId: req.spatialEntityId ?? null,
          })
          .returning();
        deviceEntity = created;
      }

      if (req.spatialEntityId !== undefined && deviceEntity) {
        await this.db
          .update(ewohSpatialEntity)
          .set({ parentId: req.spatialEntityId })
          .where(eq(ewohSpatialEntity.id, deviceEntity.id));
      }

      if (req.personEntityId !== undefined && deviceEntity) {
        const [personEntity] = await this.db
          .select()
          .from(ewohSpatialEntity)
          .where(eq(ewohSpatialEntity.entityId, req.personEntityId))
          .limit(1);
        if (personEntity) {
          const personExtra = (personEntity.extra as Record<string, unknown> | null) ?? {};
          await this.db
            .update(ewohSpatialEntity)
            .set({ extra: { ...personExtra, device_id: deviceId } })
            .where(eq(ewohSpatialEntity.id, personEntity.id));
        }
        const deviceExtra = (deviceEntity.extra as Record<string, unknown> | null) ?? {};
        await this.db
          .update(ewohSpatialEntity)
          .set({ extra: { ...deviceExtra, worker_id: req.personEntityId } })
          .where(eq(ewohSpatialEntity.id, deviceEntity.id));
      }

      return this.getDeviceBindings(deviceId);
    } catch (error) {
      this.logger.error(`bindDevice 失败 deviceId=${deviceId}`, error);
      throw error;
    }
  }

  async unbindDevice(deviceId: string): Promise<void> {
    try {
      const [deviceEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(eq(ewohSpatialEntity.entityType, 'device'), eq(ewohSpatialEntity.entityId, deviceId)),
        )
        .limit(1);

      if (deviceEntity) {
        await this.db
          .update(ewohSpatialEntity)
          .set({ parentId: null })
          .where(eq(ewohSpatialEntity.id, deviceEntity.id));

        const deviceExtra = (deviceEntity.extra as Record<string, unknown> | null) ?? {};
        if ('worker_id' in deviceExtra) {
          const newExtra: Record<string, unknown> = { ...deviceExtra };
          delete newExtra.worker_id;
          await this.db
            .update(ewohSpatialEntity)
            .set({ extra: newExtra })
            .where(eq(ewohSpatialEntity.id, deviceEntity.id));
        }
      }

      const persons = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.entityType, 'person'),
            sql`${ewohSpatialEntity.extra}->>'device_id' = ${deviceId}`,
          ),
        );

      for (const person of persons) {
        const personExtra = (person.extra as Record<string, unknown> | null) ?? {};
        if ('device_id' in personExtra) {
          const newExtra: Record<string, unknown> = { ...personExtra };
          delete newExtra.device_id;
          await this.db
            .update(ewohSpatialEntity)
            .set({ extra: newExtra })
            .where(eq(ewohSpatialEntity.id, person.id));
        }
      }
    } catch (error) {
      this.logger.error(`unbindDevice 失败 deviceId=${deviceId}`, error);
      throw error;
    }
  }

  private mapDevice(r: typeof ewohDevice.$inferSelect): DeviceInfo {
    return {
      id: r.id,
      deviceId: r.deviceId,
      workerName: r.workerName ?? '',
      deviceModel: r.deviceModel ?? '',
      batteryPct: r.batteryPct ?? 0,
      online: r.online ?? false,
      lastTelemetryAt: r.lastTelemetryAt ? r.lastTelemetryAt.toISOString() : null,
      sourceType: r.sourceType ?? undefined,
      firmwareVersion: r.firmwareVersion,
      hardwareVersion: r.hardwareVersion,
      protocolVersion: r.protocolVersion,
      temperatureC: r.temperatureC,
      faultCode: r.faultCode,
      lastRawRef: r.lastRawRef,
    };
  }
}
