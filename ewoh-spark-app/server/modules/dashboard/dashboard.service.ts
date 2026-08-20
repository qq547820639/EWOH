import { Injectable, Inject, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
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

/**
 * NEST-347/348/349（2026-08-17 审计整改）：查询数值参数统一清洗——
 * parseInt NaN 一律拒绝（不允许 gte(col, NaN) 这类未定义行为），limit 设上限。
 */
export const MAX_LIST_LIMIT = 500;

export function parseLimitParam(
  raw: string | undefined,
  fallback = 50,
  max = MAX_LIST_LIMIT,
): number {
  if (raw === undefined || raw === '') return fallback;
  // 严格数值解析（Number 而非 parseInt——'12abc' 这类尾随垃圾显式拒绝）。
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new BadRequestException(`invalid limit: ${raw}`);
  }
  return Math.min(Math.trunc(value), max);
}

export function parseBatteryParam(
  raw: string | undefined,
  field: 'batteryMin' | 'batteryMax',
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new BadRequestException(`invalid ${field}: ${raw}`);
  }
  return value;
}

export function parsePageParam(raw: string | undefined, fallback = 1): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw new BadRequestException(`invalid page: ${raw}`);
  }
  return Math.trunc(value);
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  /**
   * NEST-312~319（2026-08-17 审计整改）：dashboard 全部聚合/列表/详情/写路径
   * 带 org 谓词。global_admin 显式放行（与 RLS 例外路径一致）。
   */
  private orgCondition(
    column:
      | typeof ewohDevice.orgId
      | typeof ewohEvent.orgId
      | typeof ewohTelemetry.orgId
      | typeof ewohSpatialEntity.orgId
      | typeof ewohEnvironment.orgId,
    actor?: OrgContext,
  ): SQL | undefined {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: dashboard operations require tenant context',
      );
    }
    return eq(column, orgId) as SQL;
  }

  private auditOrgId(actor: OrgContext | undefined, rowOrgId?: string | null): string {
    return actor?.primaryOrgId ?? rowOrgId ?? '';
  }

  async getOverview(actor?: OrgContext): Promise<OverviewStats> {
    try {
      const deviceOrg = this.orgCondition(ewohDevice.orgId, actor);
      const [deviceStats] = await this.db
        .select({
          total: sql<number>`count(*)::int`,
          online: sql<number>`count(*) filter (where ${ewohDevice.online} = true)::int`,
        })
        .from(ewohDevice)
        .where(deviceOrg);

      const eventOrg = this.orgCondition(ewohEvent.orgId, actor);
      const [eventStats] = await this.db
        .select({
          open: sql<number>`count(*) filter (where ${ewohEvent.status} = 'open')::int`,
          // ADR-027：新写入规范阶梯（critical/high/medium）；legacy L2/L3 为存量兼容
          // 并集统计，避免存量/新量口径漂移（真实 PG 首推后按需收紧）。
          critical: sql<number>`count(*) filter (where ${ewohEvent.severity} in ('critical','high','medium','L2','L3'))::int`,
        })
        .from(ewohEvent)
        .where(eventOrg);

      const telemetryOrg = this.orgCondition(ewohTelemetry.orgId, actor);
      const [loadStats] = await this.db
        .select({
          avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
        })
        .from(ewohTelemetry)
        .where(
          telemetryOrg
            ? and(telemetryOrg, gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
            : gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
        );

      const [workerStats] = await this.db
        .select({
          count: sql<number>`count(distinct ${ewohDevice.workerName})::int`,
        })
        .from(ewohDevice)
        .where(
          deviceOrg
            ? and(
                deviceOrg,
                sql`${ewohDevice.workerName} is not null and ${ewohDevice.workerName} != ''`,
              )
            : sql`${ewohDevice.workerName} is not null and ${ewohDevice.workerName} != ''`,
        );

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

  async getEnvironmentSummary(actor?: OrgContext): Promise<EnvironmentReading[]> {
    try {
      const orgId = this.orgParam(actor);
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
          ${orgId ? sql`where org_id = ${orgId}` : sql``}
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

  /** raw SQL 用的 org 参数（global_admin → null = 不加过滤）。 */
  private orgParam(actor?: OrgContext): string | null {
    if (actor?.isGlobalAdmin) return null;
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: dashboard operations require tenant context',
      );
    }
    return orgId;
  }

  async getDevices(query?: DeviceSearchQuery, actor?: OrgContext): Promise<DeviceInfo[]> {
    try {
      const conditions = this.buildDeviceConditions(query, actor);
      const rows = await this.buildDeviceQuery(conditions).orderBy(this.buildDeviceOrder(query));
      return this.mapDeviceRows(rows);
    } catch (error) {
      this.logger.error('getDevices 失败', error);
      throw error;
    }
  }

  async getDeviceDetail(deviceId: string, actor?: OrgContext): Promise<DeviceInfo> {
    try {
      const conditions = this.buildDeviceConditions(undefined, actor);
      conditions.push(eq(ewohDevice.deviceId, deviceId));
      const rows = await this.buildDeviceQuery(conditions);
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

  async searchDevices(
    query: DeviceSearchQuery = {},
    actor?: OrgContext,
  ): Promise<DeviceSearchResult> {
    try {
      const conditions = this.buildDeviceConditions(query, actor);
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

  private buildDeviceConditions(query?: DeviceSearchQuery, actor?: OrgContext): SQL[] {
    const conditions: SQL[] = [];
    // NEST-314：设备查询 org 谓词（global_admin 不加过滤）。
    const orgCond = this.orgCondition(ewohDevice.orgId, actor);
    if (orgCond) conditions.push(orgCond);
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

  /**
   * 事件列表（时间窗滚动查询，2026-08-19）。
   * hours：查询最近 N 小时事件（默认 24h，1~168 clamp）——事件表高写入量
   * （模拟器持续生成），无时间窗的全表 ORDER BY 在峰值时拖垮平台；演示/
   * 运营语义也只需要近期事件，历史事件走 7d 留存的归档查询。
   */
  async getEvents(
    limit: number = 50,
    status?: string,
    actor?: OrgContext,
    hours?: number,
    offset?: number,
  ): Promise<{ items: EventInfo[]; total: number }> {
    try {
      // NEST-347：limit 上限（防 parseInt('1e9') 全表拉取）。
      const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT);
      const safeOffset = Math.max(0, Math.trunc(offset ?? 0));
      // 时间窗：默认 24h，显式传入则 clamp 到 [1, 168]（7 天）。
      const safeHours = Math.min(
        Math.max(hours != null && Number.isFinite(hours) ? Math.trunc(hours) : 24, 1),
        168,
      );
      const conditions: SQL[] = [];
      const orgCond = this.orgCondition(ewohEvent.orgId, actor);
      if (orgCond) conditions.push(orgCond);
      if (status) conditions.push(eq(ewohEvent.status, status));
      conditions.push(
        gte(ewohEvent.createdAt, new Date(Date.now() - safeHours * 3_600_000)),
      );
      const where = conditions.length > 0 ? and(...conditions) : undefined;
      // 2026-08-20 分页：count + 数据两条查询（事件表无复合分页索引场景下
      // count 走 status/created_at 组合过滤，成本可控；offset 分页供工作台
      // 翻页浏览全部 open 事件）。
      const [countRow] = await this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(ewohEvent)
        .where(where);
      const rows = await this.db
        .select()
        .from(ewohEvent)
        .where(where)
        .orderBy(desc(ewohEvent.createdAt))
        .limit(safeLimit)
        .offset(safeOffset);
      return {
        total: countRow?.total ?? 0,
        items: rows.map((r) => ({
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
        })),
      };
    } catch (error) {
      this.logger.error('getEvents 失败', error);
      throw error;
    }
  }

  async getEventStats(actor?: OrgContext): Promise<EventStats> {
    try {
      const orgCond = this.orgCondition(ewohEvent.orgId, actor);
      const severityRows = await this.db
        .select({
          severity: ewohEvent.severity,
          count: sql<number>`count(*)::int`,
        })
        .from(ewohEvent)
        .where(orgCond)
        .groupBy(ewohEvent.severity);

      const statusRows = await this.db
        .select({
          status: ewohEvent.status,
          count: sql<number>`count(*)::int`,
        })
        .from(ewohEvent)
        .where(orgCond)
        .groupBy(ewohEvent.status);

      const trendRows = await this.db
        .select({
          time: sql<string>`to_char(date_trunc('hour', ${ewohEvent.createdAt}), 'YYYY-MM-DD HH24:MI')`,
          count: sql<number>`count(*)::int`,
        })
        .from(ewohEvent)
        .where(
          orgCond
            ? and(orgCond, gte(ewohEvent.createdAt, sql`now() - interval '24 hours'`))
            : gte(ewohEvent.createdAt, sql`now() - interval '24 hours'`),
        )
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

  async getTelemetry(
    deviceId: string,
    limit: number = 50,
    actor?: OrgContext,
  ): Promise<TelemetryInfo[]> {
    try {
      // NEST-348：limit 上限。
      const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), MAX_LIST_LIMIT);
      const conditions: SQL[] = [eq(ewohTelemetry.deviceId, deviceId)];
      const orgCond = this.orgCondition(ewohTelemetry.orgId, actor);
      if (orgCond) conditions.push(orgCond);
      const rows = await this.db
        .select()
        .from(ewohTelemetry)
        .where(and(...conditions))
        .orderBy(desc(ewohTelemetry.ts))
        .limit(safeLimit);
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

  async getWorkers(actor?: OrgContext): Promise<WorkerLoad[]> {
    try {
      const orgCond = this.orgCondition(ewohDevice.orgId, actor);
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
        .where(
          orgCond
            ? and(orgCond, gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
            : gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
        )
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
      // NEST-317：按 (orgId, eventId) 定位；他租户事件对本租户呈现 404。
      const orgCond = this.orgCondition(ewohEvent.orgId, actor);
      const [existing] = await this.db
        .select()
        .from(ewohEvent)
        .where(orgCond ? and(eq(ewohEvent.eventId, eventId), orgCond) : eq(ewohEvent.eventId, eventId))
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
        .where(
          orgCond
            ? and(eq(ewohEvent.eventId, eventId), orgCond)
            : eq(ewohEvent.eventId, eventId),
        )
        .returning();

      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? operator ?? 'system',
        orgId: this.auditOrgId(actor, existing.orgId),
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

  async createDevice(dto: CreateDeviceDto, actor?: OrgContext): Promise<DeviceInfo> {
    try {
      // NEST-331：无租户上下文显式拒绝（不再回退 NULL=全局可见行）。
      const orgId = this.orgParam(actor) ?? undefined;
      if (!orgId) {
        throw new BadRequestException(
          'org context missing: device creation requires tenant context',
        );
      }
      const [existing] = await this.db
        .select({ deviceId: ewohDevice.deviceId })
        .from(ewohDevice)
        .where(and(eq(ewohDevice.deviceId, dto.deviceId), eq(ewohDevice.orgId, orgId)))
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
          // NO-13aa（ADR-075 续）：设备行归属注入（001 ewoh_org_visible RLS 对齐）。
          orgId,
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
      const orgCond = this.orgCondition(ewohDevice.orgId, actor);
      // NEST-318：按 (orgId, deviceId) 定位与更新（跨租户设备不可见不可改）。
      const [existing] = await this.db
        .select()
        .from(ewohDevice)
        .where(orgCond ? and(eq(ewohDevice.deviceId, deviceId), orgCond) : eq(ewohDevice.deviceId, deviceId))
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
        .where(
          orgCond ? and(eq(ewohDevice.deviceId, deviceId), orgCond) : eq(ewohDevice.deviceId, deviceId),
        )
        .returning();

      await this.auditService.appendAuditLog({
        actorId: actor?.userId ?? 'system',
        orgId: this.auditOrgId(actor, existing.orgId),
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

  async getDeviceBindings(deviceId: string, actor?: OrgContext): Promise<DeviceBinding> {
    try {
      const orgCond = this.orgCondition(ewohSpatialEntity.orgId, actor);
      const [deviceEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.entityType, 'device'),
            eq(ewohSpatialEntity.entityId, deviceId),
            ...(orgCond ? [orgCond] : []),
          ),
        )
        .limit(1);

      // NEST-346：层级遍历去 N+1 —— 单条递归 CTE 一次取全部祖先链。
      const hierarchyPath: Array<{ entityId: string; name: string; entityType: string }> = [];
      if (deviceEntity?.parentId) {
        const ancestorRows = await this.db.execute<Record<string, unknown>>(sql`
          with recursive ancestors as (
            select entity_id, name, entity_type, parent_id
            from ${ewohSpatialEntity}
            where entity_id = ${deviceEntity.parentId}
            ${orgCond ? sql`and org_id = ${this.orgParam(actor)}` : sql``}
            union
            select e.entity_id, e.name, e.entity_type, e.parent_id
            from ${ewohSpatialEntity} e
            join ancestors a on e.entity_id = a.parent_id
            ${orgCond ? sql`where e.org_id = ${this.orgParam(actor)}` : sql``}
          )
          select entity_id, name, entity_type from ancestors
        `);
        for (const row of ancestorRows.reverse()) {
          hierarchyPath.push({
            entityId: String(row.entity_id),
            name: String(row.name),
            entityType: String(row.entity_type),
          });
        }
      }

      const [personEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.entityType, 'person'),
            sql`${ewohSpatialEntity.extra}->>'device_id' = ${deviceId}`,
            ...(orgCond ? [orgCond] : []),
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

  async bindDevice(
    deviceId: string,
    req: BindDeviceRequest,
    actor?: OrgContext,
  ): Promise<DeviceBinding> {
    try {
      // NEST-331 + 2026-08-20：orgParam 对 global_admin 返回 null（原意「跨租户
      // 全局可见」），但绑定写操作必须落定 org 归属——global_admin 回退其
      // primaryOrgId，否则 admin 用户在设备中心/人员页的绑定操作恒报
      // org context missing（存量 bug：此前结构化绑定从未经 API 写通过）。
      const orgId = this.orgParam(actor) ?? actor?.primaryOrgId?.trim() ?? undefined;
      if (!orgId) {
        throw new BadRequestException(
          'org context missing: device binding requires tenant context',
        );
      }
      const [existingDeviceEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.entityType, 'device'),
            eq(ewohSpatialEntity.entityId, deviceId),
            eq(ewohSpatialEntity.orgId, orgId),
          ),
        )
        .limit(1);

      // NEST-319：目标空间实体必须属于本租户（防跨租户挂载）。
      if (req.spatialEntityId !== undefined) {
        const [target] = await this.db
          .select({ id: ewohSpatialEntity.id })
          .from(ewohSpatialEntity)
          .where(and(eq(ewohSpatialEntity.entityId, req.spatialEntityId), eq(ewohSpatialEntity.orgId, orgId)))
          .limit(1);
        if (!target) {
          throw new NotFoundException(`Spatial entity ${req.spatialEntityId} not found`);
        }
      }

      let deviceEntity = existingDeviceEntity;
      if (!deviceEntity) {
        const [created] = await this.db
          .insert(ewohSpatialEntity)
          .values({
            entityId: deviceId,
            entityType: 'device',
            name: deviceId,
            parentId: req.spatialEntityId ?? null,
            orgId,
          })
          .returning();
        deviceEntity = created;
      }

      if (req.spatialEntityId !== undefined && deviceEntity) {
        await this.db
          .update(ewohSpatialEntity)
          .set({ parentId: req.spatialEntityId })
          .where(
            and(eq(ewohSpatialEntity.id, deviceEntity.id), eq(ewohSpatialEntity.orgId, orgId)),
          );
      }

      if (req.personEntityId !== undefined && deviceEntity) {
        const [personEntity] = await this.db
          .select()
          .from(ewohSpatialEntity)
          .where(
            and(
              eq(ewohSpatialEntity.entityId, req.personEntityId),
              eq(ewohSpatialEntity.orgId, orgId),
            ),
          )
          .limit(1);
        if (!personEntity) {
          throw new NotFoundException(
            `Person entity ${req.personEntityId} not found`,
          );
        }
        if (personEntity.entityType !== 'person') {
          throw new BadRequestException(
            `Entity ${req.personEntityId} is not a person`,
          );
        }
        // 2026-08-20 防重复硬校验（设备中心下拉绑定需求）：
        // 一人一设备、一设备一人。服务端兜底，杜绝前端绕过产生 extra 脏引用。
        const personExtra =
          (personEntity.extra as Record<string, unknown> | null) ?? {};
        const personBoundDevice = personExtra.device_id as string | undefined;
        if (personBoundDevice && personBoundDevice !== deviceId) {
          throw new ConflictException(
            `人员已被设备 ${personBoundDevice} 绑定，请先解绑（换绑走先解后绑流程）`,
          );
        }
        const deviceExtra =
          (deviceEntity.extra as Record<string, unknown> | null) ?? {};
        const deviceWorker = deviceExtra.worker_id as string | undefined;
        if (deviceWorker && deviceWorker !== req.personEntityId) {
          throw new ConflictException(
            `设备已被人员占用，请先解绑当前绑定人再绑定`,
          );
        }
        // 双向写 extra（person.device_id ↔ device.worker_id）。
        await this.db
          .update(ewohSpatialEntity)
          .set({ extra: { ...personExtra, device_id: deviceId } })
          .where(eq(ewohSpatialEntity.id, personEntity.id));
        await this.db
          .update(ewohSpatialEntity)
          .set({ extra: { ...deviceExtra, worker_id: req.personEntityId } })
          .where(
            and(eq(ewohSpatialEntity.id, deviceEntity.id), eq(ewohSpatialEntity.orgId, orgId)),
          );
      }

      return this.getDeviceBindings(deviceId, actor);
    } catch (error) {
      this.logger.error(`bindDevice 失败 deviceId=${deviceId}`, error);
      throw error;
    }
  }

  async unbindDevice(deviceId: string, actor?: OrgContext): Promise<void> {
    try {
      const orgCond = this.orgCondition(ewohSpatialEntity.orgId, actor);
      const [deviceEntity] = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.entityType, 'device'),
            eq(ewohSpatialEntity.entityId, deviceId),
            ...(orgCond ? [orgCond] : []),
          ),
        )
        .limit(1);

      if (deviceEntity) {
        await this.db
          .update(ewohSpatialEntity)
          .set({ parentId: null })
          .where(
            orgCond
              ? and(eq(ewohSpatialEntity.id, deviceEntity.id), orgCond)
              : eq(ewohSpatialEntity.id, deviceEntity.id),
          );

        const deviceExtra = (deviceEntity.extra as Record<string, unknown> | null) ?? {};
        if ('worker_id' in deviceExtra) {
          const newExtra: Record<string, unknown> = { ...deviceExtra };
          delete newExtra.worker_id;
          await this.db
            .update(ewohSpatialEntity)
            .set({ extra: newExtra })
            .where(
              orgCond
                ? and(eq(ewohSpatialEntity.id, deviceEntity.id), orgCond)
                : eq(ewohSpatialEntity.id, deviceEntity.id),
            );
        }
      }

      const persons = await this.db
        .select()
        .from(ewohSpatialEntity)
        .where(
          and(
            eq(ewohSpatialEntity.entityType, 'person'),
            sql`${ewohSpatialEntity.extra}->>'device_id' = ${deviceId}`,
            ...(orgCond ? [orgCond] : []),
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
            .where(
              orgCond
                ? and(eq(ewohSpatialEntity.id, person.id), orgCond)
                : eq(ewohSpatialEntity.id, person.id),
            );
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
