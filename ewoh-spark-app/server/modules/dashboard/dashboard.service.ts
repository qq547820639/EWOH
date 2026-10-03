import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohDevice,
  ewohDeviceCapability,
  ewohEvent,
  ewohTelemetry,
  ewohSpatialEntity,
  ewohDeviceBinding,
  ewohEnvironment,
} from '@server/database/schema';
import { eq, desc, asc, sql, and, gte, lte, ilike, or, type SQL } from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';
import { AuditService } from '../shared/audit.service';
import { validateCapability } from '@shared/capability';
import {
  buildCapabilityRestoreApprovalSubject,
  buildApprovalUsageKey,
  deviceCapabilityChangeNeedsApproval,
  suggestSimilarCapabilityNames,
  verifyCapabilityRestoreApproval,
} from '@shared/capability-requirements';
import { ApprovalPersistenceService } from '../approval/approval-persistence.service';
import {
  clampEventWindowHours,
  clampListLimit,
  clampListOffset,
  MAX_LIST_LIMIT,
} from '@shared/query-params';
import { deriveDeviceCapabilities } from '../scheduler/device-capabilities';
import {
  DEVICE_CATEGORIES,
  DEVICE_CATEGORY_UNKNOWN,
  isKnownDeviceCategory,
  normalizeDeviceCategory,
} from '@shared/device-category';
import {
  DEVICE_CAPABILITY_SPECS,
  capabilityIdFor,
  capabilityRiskLevel,
  DEVICE_CAPABILITY_NAMES,
  toCapabilityRecord,
  formatCapability,
  isRegisteredCapability,
} from '@shared/device-capability';
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
  DeviceCapabilityLifecycleInfo,
  DeviceCapabilityStatus,
  SetDeviceCapabilityStatusRequest,
  SetDeviceCapabilityStatusResponse,
} from '@shared/api.interface';

export function normalizePagination(page?: number, pageSize?: number) {
  const safePage = Math.max(1, Math.trunc(page ?? 1));
  const safeSize = Math.min(100, Math.max(1, Math.trunc(pageSize ?? 20)));
  return { page: safePage, pageSize: safeSize };
}

/**
 * NEST-347/348/349（2026-08-17 审计整改）：查询数值参数统一清洗——
 * parseInt NaN 一律拒绝（不允许 gte(col, NaN) 这类未定义行为），limit 设上限。
 *
 * 上限常量已收敛至 `@shared/query-params`（跨端单一事实源），此处重导出以
 * 保持既有 import 路径 `from './dashboard.service'` 的对外契约不变。
 */
export { MAX_LIST_LIMIT };

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

/**
 * 解析台账 `capability_value.lifecycle`（人工停用/恢复留痕）。
 *
 * fail-honest：形状不完整就返回 null（"没有可展示的人工留痕"），
 * 绝不半截渲染出误导性的"已人工确认"。
 */
export function parseCapabilityLifecycle(raw: unknown): DeviceCapabilityLifecycleInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const action = rec.action;
  if (action !== 'disable' && action !== 'restore') return null;
  const operator = typeof rec.operator === 'string' ? rec.operator.trim() : '';
  const reason = typeof rec.reason === 'string' ? rec.reason.trim() : '';
  const at = typeof rec.at === 'string' ? rec.at.trim() : '';
  if (operator.length === 0 || reason.length === 0 || at.length === 0) return null;
  const previous = rec.previousStatus;
  return {
    action,
    operator,
    reason,
    at,
    previousStatus: previous === 'active' || previous === 'disabled' ? previous : null,
  };
}

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  /**
   * 性能优化：dashboard/overview 5秒缓存（减少数据库查询频率）。
   *
   * 按 orgKey 分桶（此前为单槽变量：任一 org 的请求都会覆盖上一条，
   * 多租户交替访问时命中率趋近 0，"未命中"成为常态路径而非异常路径）。
   * 写法对齐 SchedulingPolicyService 的 activeRowCache。
   *
   * 有界化：Map 无界会随租户数增长而泄漏，故设容量上限并在超限时
   * 淘汰最老一半（Map 保持插入序，近似 LRU；同 SchedulerStreamService.SEEN_CAP 做法）。
   */
  private readonly overviewCache = new Map<
    string,
    { data: OverviewStats; timestamp: number }
  >();
  private readonly OVERVIEW_CACHE_TTL_MS = 5000;
  private static readonly OVERVIEW_CACHE_MAX_ORGS = 500;

  /** 超限时淘汰最老一半，防止多租户下 Map 无界增长。 */
  private evictOverviewCacheIfNeeded(): void {
    const cache = this.overviewCache;
    if (cache.size <= DashboardService.OVERVIEW_CACHE_MAX_ORGS) return;
    const drop = Math.floor(cache.size / 2);
    let i = 0;
    for (const oldKey of cache.keys()) {
      if (i++ >= drop) break;
      cache.delete(oldKey);
    }
  }

  /**
   * 统一「记日志后原样重抛」的 catch 收尾（`catch (e) { log(...); throw e; }`）。
   *
   * ## 为什么不直接删掉 try/catch
   * 全部 15 处 catch 的语义都是「记录后重抛」——重抛意味着**异常语义与 HTTP
   * 状态码完全不变**，try/catch 存在的唯一价值是那条日志。删除它们会丢掉可观测性，
   * 因此改为收敛日志语句本身。
   *
   * ## 为什么不改变重抛行为
   * `throw error` 保持原样：调用方（Nest 异常过滤器）依赖原始错误对象上的
   * `getStatus()`，包装成新异常会改变对外 HTTP 状态码。故本方法返回 `never`，
   * 类型上标注以确保调用点无法「记录后忘记重抛」。
   *
   * @param context 日志上下文，如 `'getEvents 失败'`
   * @param error 捕获到的异常
   * @param isExpected 预期内异常（404/400 等业务异常）——为 true 时**跳过日志**直接重抛，
   *   避免正常业务分支污染错误日志。默认为 false（即记录）。
   */
  private rethrowWithLog(context: string, error: unknown, isExpected = false): never {
    if (!isExpected) this.logger.error(context, error);
    throw error;
  }

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    /** NO-21a：恢复高风险设备能力的审批核对（可选注入，保持既有单测构造兼容）。 */
    @Optional() private readonly approvalPort?: ApprovalPersistenceService,
  ) {}

  /**
   * NEST-312~319（2026-08-17 审计整改）：dashboard 全部聚合/列表/详情/写路径
   * 带 org 谓词。global_admin 显式放行（与 RLS 例外路径一致）。
   */
  private orgCondition(
    // 允许任意 org 列：各表 org_id 类型不同（varchar/uuid），但谓词语义完全一致
    // （等值比较 + global_admin 不过滤）。收紧为联合类型只会在新增表时反复报错。
    column: PgColumn,
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
    // 性能优化：5秒缓存（仪表板数据实时性要求不高）
    const orgKey = actor?.primaryOrgId ?? 'global';
    const now = Date.now();
    const cached = this.overviewCache.get(orgKey);
    if (cached && now - cached.timestamp < this.OVERVIEW_CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const deviceOrg = this.orgCondition(ewohDevice.orgId, actor);
      const eventOrg = this.orgCondition(ewohEvent.orgId, actor);
      const telemetryOrg = this.orgCondition(ewohTelemetry.orgId, actor);

      // 性能优化：将4个独立查询并行执行（原串行~700ms → 并行~200ms）
      const [deviceStats, eventStats, loadStats, workerStats] = await Promise.all([
        this.db
          .select({
            total: sql<number>`count(*)::int`,
            online: sql<number>`count(*) filter (where ${ewohDevice.online} = true)::int`,
          })
          .from(ewohDevice)
          .where(deviceOrg),
        this.db
          .select({
            open: sql<number>`count(*) filter (where ${ewohEvent.status} = 'open')::int`,
            // ADR-027：新写入规范阶梯（critical/high/medium）；legacy L2/L3 为存量兼容
            // 并集统计，避免存量/新量口径漂移（真实 PG 首推后按需收紧）。
            critical: sql<number>`count(*) filter (where ${ewohEvent.severity} in ('critical','high','medium','L2','L3'))::int`,
          })
          .from(ewohEvent)
          .where(eventOrg),
        this.db
          .select({
            avgLoad: sql<number>`coalesce(avg(${ewohTelemetry.loadScore}), 0)::float`,
          })
          .from(ewohTelemetry)
          .where(
            telemetryOrg
              ? and(telemetryOrg, gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`))
              : gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`),
          ),
        this.db
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
          ),
      ]);

      const result = {
        deviceTotal: deviceStats?.[0]?.total ?? 0,
        deviceOnline: deviceStats?.[0]?.online ?? 0,
        eventOpen: eventStats?.[0]?.open ?? 0,
        eventCritical: eventStats?.[0]?.critical ?? 0,
        avgLoad: Number((loadStats?.[0]?.avgLoad ?? 0).toFixed(3)),
        workerCount: workerStats?.[0]?.count ?? 0,
      };

      // 更新缓存（按 orgKey 分桶；写入前做容量收敛）
      this.evictOverviewCacheIfNeeded();
      this.overviewCache.set(orgKey, { data: result, timestamp: now });
      return result;
    } catch (error) {
      this.rethrowWithLog('getOverview 失败', error);
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
      this.rethrowWithLog('getEnvironmentSummary 失败', error);
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
      const base = this.buildDeviceQuery(conditions).orderBy(this.buildDeviceOrder(query));
      // BUG-006 修复：支持 limit/offset 分页参数（默认不限制，保持向后兼容）。
      const limit = query?.limit != null && query.limit > 0 ? query.limit : undefined;
      const offset = query?.offset != null && query.offset >= 0 ? query.offset : undefined;
      const rows = await (limit !== undefined
        ? base.limit(limit).offset(offset ?? 0)
        : offset !== undefined
          ? base.limit(10000).offset(offset) // offset 无 limit 时设安全上限
          : base);
      return this.mapDeviceRows(rows);
    } catch (error) {
      this.rethrowWithLog('getDevices 失败', error);
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
      const detail = this.mapDeviceRows(rows)[0];
      // 设备详情附能力清单（列表不带：避免每行 N+1 与 payload 膨胀）。
      // 能力是"设备能观测/执行什么"的权威事实，用于世界模型与 AI 解释。
      detail.capabilities = await this.listDeviceCapabilities(deviceId, actor);
      return detail;
    } catch (error) {
      this.rethrowWithLog('getDeviceDetail 失败', error, error instanceof NotFoundException);
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
      this.rethrowWithLog('searchDevices 失败', error);
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
    if (query?.category) {
      // 类别过滤（shared/device-category 词表）。未识别类别不做模糊匹配——
      // 过滤结果为空比"猜一个相近类别"更诚实（前端只提供词表内选项）。
      conditions.push(
        eq(
          sql`COALESCE(${ewohDevice.deviceCategory}, ${DEVICE_CATEGORY_UNKNOWN})`,
          normalizeDeviceCategory(query.category),
        ),
      );
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
        deviceCategory: ewohDevice.deviceCategory,
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

  /**
   * 设备能力清单（租户作用域；`status='active'` 才计入"当前能力"，
   * 停用/过期能力保留在台账但明确标记，不混入当前能力）。
   */
  private async listDeviceCapabilities(
    deviceId: string,
    actor?: OrgContext,
  ): Promise<DeviceInfo['capabilities']> {
    const conditions: SQL[] = [eq(ewohDeviceCapability.deviceId, deviceId)];
    const orgCond = this.orgCondition(ewohDeviceCapability.orgId, actor);
    if (orgCond) conditions.push(orgCond);
    const rows = await this.db
      .select({
        capabilityId: ewohDeviceCapability.capabilityId,
        capabilityKey: ewohDeviceCapability.capabilityKey,
        capabilityType: ewohDeviceCapability.capabilityType,
        capabilityValue: ewohDeviceCapability.capabilityValue,
        status: ewohDeviceCapability.status,
        grantedAt: ewohDeviceCapability.effectiveFrom,
      })
      .from(ewohDeviceCapability)
      .where(and(...conditions));
    return rows.map((row) => {
      const value = (row.capabilityValue ?? {}) as Record<string, unknown>;
      const name = String(row.capabilityKey);
      const spec = DEVICE_CAPABILITY_SPECS[name];
      // 权威字段（ADR-043）：kind/providerType/name 来自台账列；
      // 观测/交互形态（mode）是我们附加的子属性，缺省按词表回退。
      const kind = String(row.capabilityType ?? spec?.kind ?? 'device_capability');
      const providerType =
        typeof value.providerType === 'string'
          ? String(value.providerType)
          : (spec?.providerType ?? 'device');
      const mode =
        typeof value.mode === 'string' ? String(value.mode) : (spec?.mode ?? 'observation');
      return {
        capabilityId: String(row.capabilityId ?? ''),
        name,
        // 兼容字段：key === name（历史调用方与 UI 用 key；不隐藏差异）
        key: name,
        kind,
        providerType,
        mode,
        label: typeof value.label === 'string' && value.label ? value.label : formatCapability(name),
        status: String(row.status ?? 'unknown'),
        fields: Array.isArray(value.fields) ? (value.fields as string[]).map(String) : [],
        grantedAt: row.grantedAt ? new Date(row.grantedAt as Date).toISOString() : null,
        // 词表外能力名原样展示（不隐藏、不猜含义）
        registered: isRegisteredCapability(name),
        // 人工停用/恢复留痕（没有人工操作过 = null，自动声明不冒充人工确认）
        lifecycle: parseCapabilityLifecycle(value.lifecycle),
      };
    });
  }

  /**
   * 人工变更设备能力状态（停用 / 恢复）。
   *
   * 为什么必须有人工通道（2026-09-11 审计）：摄入声明路径**刻意不复活**被人工停用的
   * 能力（`ON CONFLICT` 不覆盖 `status`），但此前**没有任何 API 能设置 status**——
   * 那条保护不可达，"能力台账"只有自动写入一个入口。现场无法处置误声明（例如某设备
   * 实际不具备 `observe.load`），而能力直接决定派工资格（`requiredDeviceCapabilities`
   * 匹配），错了只能改库。
   *
   * 语义（逐条明确，不留模糊）：
   * - **只能显式变更**：仅接受 `active` / `disabled`；其它值 400（不猜）。
   * - **理由必填**：非空白；写入台账留痕与审计。空理由 400。
   * - **幂等**：状态与当前相同 → `changed=false`，不写库、不记审计（重复点击无副作用）。
   * - **租户隔离**：非 global_admin 必须带 org，且只能命中本租户行；跨租户 = 404
   *   （不泄露存在性）。
   * - **恢复 fail-closed**：恢复前按权威契约（ADR-043）重新校验；不合规**拒绝恢复**
   *   （409）——不把脏记录放回调度集合。`kind`/`providerType`/`subject`/`capabilityId`
   *   本就由能力名与提供方推导（不是人工输入），历史脏值按词表**自愈并如实列出**
   *   （`repairedFields`）；词表外能力名无法校验 → 409（提示先登记能力名）。
   * - **时间语义**：停用写 `effective_to = now`（不再生效）；恢复写
   *   `effective_from = now` 且清空 `effective_to`。
   * - **审计**：`device.capability.disable` / `device.capability.restore`，含 before/after、
   *   理由与纠正字段；审计失败抛错，不静默成功。
   */
  async setDeviceCapabilityStatus(
    deviceId: string,
    capabilityKey: string,
    body: SetDeviceCapabilityStatusRequest,
    actor?: OrgContext,
  ): Promise<SetDeviceCapabilityStatusResponse> {
    const status = body?.status;
    if (status !== 'active' && status !== 'disabled') {
      throw new BadRequestException(
        `不支持的设备能力状态 '${String(status)}'（仅允许 active / disabled）`,
      );
    }
    const reason = (body?.reason ?? '').trim();
    if (reason.length === 0) {
      throw new BadRequestException('变更设备能力状态必须提供非空理由（写入台账留痕与审计）');
    }

    const now = new Date();
    const conditions: SQL[] = [
      eq(ewohDeviceCapability.deviceId, deviceId),
      // 路径用能力名（`observe.temperature`）：可读，且 (org, device, key) 本就唯一。
      eq(ewohDeviceCapability.capabilityKey, capabilityKey),
    ];
    const orgCond = this.orgCondition(ewohDeviceCapability.orgId, actor);
    if (orgCond) conditions.push(orgCond);

    const [existing] = await this.db
      .select()
      .from(ewohDeviceCapability)
      .where(and(...conditions))
      .limit(1);

    // 没有台账行时：如果该能力**当前经由列或型号白名单生效**，停用必须能落地
    // ——否则"型号派生的执行能力"（如 NyExo→exo-lift）根本停不掉，而它恰恰决定
    // 派工资格（2026-09-11 e2e 实测：404 让现场无路可走）。
    // 语义：人工停用是**权威决定**，首次停用把该能力物化进台账（status='disabled'）。
    // 恢复仍走同一行的 active 路径（并重新过契约校验）。
    let row = existing;
    let materialized = false;
    if (!row) {
      const spec = DEVICE_CAPABILITY_SPECS[capabilityKey];
      if (!spec) {
        // 能力名精确匹配：拼写差异会让人以为"设备没这个能力"。有相近名称就直说。
        const similar = suggestSimilarCapabilityNames(capabilityKey, DEVICE_CAPABILITY_NAMES);
        throw new NotFoundException(
          `设备能力不存在或不属于当前租户：device=${deviceId} capability=${capabilityKey}` +
            (similar.length > 0 ? `（疑似笔误：是否指 ${similar.join(' / ')}？）` : ''),
        );
      }
      const deviceRow = await this.loadDeviceForCapabilityWrite(deviceId, actor);
      if (!deviceRow) {
        throw new NotFoundException(`设备不存在或不属于当前租户：device=${deviceId}`);
      }
      const effectiveNow = this.effectiveCapabilityNames(deviceRow);
      if (!effectiveNow.includes(capabilityKey)) {
        throw new NotFoundException(
          `设备 ${deviceId} 当前不具备能力 ${capabilityKey}（台账、列、型号白名单均未声明）`,
        );
      }
      if (status === 'active') {
        throw new ConflictException(
          `能力 ${capabilityKey} 当前未登记为人工停用，无需恢复（若设备已具备，它已在生效集中）`,
        );
      }
      const canonicalCategory = spec.providerType === 'exo' ? 'exoskeleton' : null;
      const record = toCapabilityRecord({
        deviceId,
        category: canonicalCategory,
        name: capabilityKey,
        mode: spec.mode,
        label: spec.label,
        fields: spec.fields,
        grantedAt: now.toISOString(),
      });
      const errors = validateCapability(record);
      if (errors.length > 0) {
        throw new ConflictException(
          `能力记录不符合权威契约，拒绝写入停用记录（fail-closed）：${errors.join(', ')}`,
        );
      }
      const lifecycleEntry: DeviceCapabilityLifecycleInfo = {
        action: 'disable',
        operator: (actor?.userId ?? '').trim() || 'unknown',
        reason,
        at: now.toISOString(),
        previousStatus: 'active',
      };
      const [inserted] = await this.db
        .insert(ewohDeviceCapability)
        .values({
          orgId: actor?.primaryOrgId ?? deviceRow.orgId ?? null,
          capabilityId: record.capabilityId,
          deviceId,
          capabilityType: record.kind,
          capabilityKey,
          capabilityValue: {
            mode: spec.mode,
            label: spec.label,
            fields: [...spec.fields],
            subject: record.subject,
            providerType: record.providerType,
            evidence: record.evidence,
            lifecycle: lifecycleEntry,
            // 如实标注来源：这条记录是人工停用时物化的，不是摄入声明的
            materializedBy: 'human_disable',
          },
          compatible: true,
          version: 1,
          status: 'disabled',
          effectiveFrom: null,
          effectiveTo: now,
        })
        .returning();
      if (!inserted) {
        throw new ConflictException('停用记录写入未生效（并发冲突），请重试并复核当前状态');
      }
      materialized = true;
      row = inserted;
    }

    const name = String(row.capabilityKey);
    const rowStatus = String(row.status) as DeviceCapabilityStatus;
    // 物化行（首次停用型号派生能力）刚刚按目标状态写入：它**不是** no-op，
    // 必须走审计与 changed=true（此前直接落进下面的 no-op 分支 → 明明写了库却
    // 报"未变化"，且停用这件事**没有审计**——2026-09-11 e2e 实测）。
    const previousStatus: DeviceCapabilityStatus = materialized ? 'active' : rowStatus;
    const toIso = (value: unknown): string | null =>
      value ? new Date(value as Date).toISOString() : null;

    // ---- 幂等：状态未变化 → no-op（不写库、不记审计，明确告知调用方）----
    // 位置很重要（NO-22a）：no-op 必须在审批闸门**之前**。否则重复点击/网络重试会
    // 白烧掉一个授权额度（审批号是"一次现场决定"，被无效请求消耗掉就得重新审批）。
    // 语义上也更准确：什么都没做，就不需要授权。
    if (!materialized && rowStatus === status) {
      return {
        deviceId: String(row.deviceId),
        capabilityId: String(row.capabilityId),
        capabilityName: name,
        status,
        previousStatus,
        changed: false,
        effectiveFrom: toIso(row.effectiveFrom),
        effectiveTo: toIso(row.effectiveTo),
        updatedAt: toIso(row.updatedAt) ?? now.toISOString(),
        contractValid: true,
        repairedFields: [],
      };
    }

    // ---- NO-21a/22a：恢复高风险能力需安全负责人审批 + 授权时效与消耗 ----
    // 停用属收紧（不加流程）；恢复 exo-lift/crane/interact.assist 一类高风险能力 =
    // 设备重新具备高风险作业资格，属执行边界变更，必须持**已获批且在有效期内**的审批号，
    // 且该审批**未被用于本设备的这次恢复**（一次现场决定只放行一次）。
    let restoreApprovedBy: string | null = null;
    let restoreApprovalApprovedAt: string | null = null;
    let restoreApprovalExpiresAt: string | null = null;
    if (
      !materialized &&
      deviceCapabilityChangeNeedsApproval({
        targetStatus: status,
        previousStatus: rowStatus,
        risk: capabilityRiskLevel(name),
      })
    ) {
      const approvalId = (body?.approvalId ?? '').trim();
      const approvalSubjectForRestore = buildCapabilityRestoreApprovalSubject({
        capabilityKey: name,
        deviceIds: [deviceId],
        reason,
      });
      if (!approvalId) {
        throw new ConflictException(
          `HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL：恢复高风险能力（${name}）` +
            '需安全管理员审批，现场不得单独放行。请先创建审批：POST /api/approvals ' +
            `{entityType:'device_capability_change', entityId:'capability:${name}', subject:` +
            `${JSON.stringify(approvalSubjectForRestore)}}（deviceIds 可一次列出本批需要恢复的设备），` +
            '获批后带 approvalId 重新提交。',
        );
      }
      if (!this.approvalPort) {
        // 装配缺失（例如 DashboardModule 漏 import ApprovalModule）不得被伪装成"审批无效"，
        // 否则运维会去排查一张其实存在、只是本实例读不到的审批单。
        throw new ServiceUnavailableException(
          'APPROVAL_PORT_UNAVAILABLE：本实例未装配审批服务，无法校验高风险能力恢复审批' +
            '（既不静默放行，也不谎报审批不存在），请检查部署装配后重试。',
        );
      }
      const approval = await this.approvalPort
        .getApproval(approvalId, actor)
        .catch(() => null);
      const verification = verifyCapabilityRestoreApproval(
        approval
          ? {
              status: approval.status,
              steps: approval.steps,
              approvedAt: approval.approvedAt ?? null,
              evidence: {
                entityType: approval.entityType,
                entityId: approval.entityId,
                subject: approval.subject,
              },
            }
          : null,
        { capabilityKey: name, deviceId },
      );
      if (!verification.ok) {
        throw new ConflictException(
          `APPROVAL_INVALID：${verification.reason ?? '审批校验未通过'}` +
            '（放行条件：审批已通过且在 24 小时有效期内、能力名一致、本设备在获批名单内、该审批未用于本次恢复）',
        );
      }
      restoreApprovedBy = approvalId;
      restoreApprovalApprovedAt = verification.approvedAt ?? null;
      restoreApprovalExpiresAt = verification.expiresAt ?? null;
    }

    const value = (row.capabilityValue ?? {}) as Record<string, unknown>;
    const spec = DEVICE_CAPABILITY_SPECS[name];
    const repairedFields: string[] = [];
    if (materialized) {
      // 台账行已在上面按目标状态写入（含 lifecycle 留痕）：直接补审计并返回，
      // 不再重复 UPDATE（重复写会把刚写入的 lifecycle 覆盖成同一份，纯属多余风险）。
      await this.auditService.appendAuditLog({
        actorId: (actor?.userId ?? '').trim() || 'system',
        orgId: this.auditOrgId(actor, row.orgId ? String(row.orgId) : null),
        action: 'device.capability.disable',
        entityType: 'device_capability',
        entityId: String(row.capabilityId),
        before: { status: 'active', effectiveTo: null, source: 'derived_or_column' },
        after: { status: 'disabled', effectiveTo: toIso(row.effectiveTo), capabilityName: name },
        reason,
        metadata: { deviceId: String(row.deviceId), materializedFromDeclaration: true },
      });
      return {
        deviceId: String(row.deviceId),
        capabilityId: String(row.capabilityId),
        capabilityName: name,
        status: 'disabled',
        previousStatus: 'active',
        changed: true,
        effectiveFrom: null,
        effectiveTo: toIso(row.effectiveTo),
        updatedAt: toIso(row.updatedAt) ?? now.toISOString(),
        contractValid: true,
        repairedFields: [],
      };
    }
    let canonicalType = String(row.capabilityType);
    let canonicalId = String(row.capabilityId);
    let canonicalSubject = typeof value.subject === 'string' ? String(value.subject) : null;

    if (status === 'active') {
      // 恢复必须过权威契约（fail-closed）：词表外能力名无法校验 → 拒绝
      if (!spec) {
        throw new ConflictException(
          `能力名 '${name}' 不在能力词表内（无法按权威契约校验），拒绝恢复生效；` +
            '请先登记该能力名，或直接改用已登记的能力',
        );
      }
      // 词表内：用**唯一的** canonical 推导（与摄入声明同一 helper，不另造一套）
      const canonicalCategory = spec.providerType === 'exo' ? 'exoskeleton' : null;
      const record = toCapabilityRecord({
        deviceId: String(row.deviceId),
        category: canonicalCategory,
        name,
        mode: spec.mode,
        label: spec.label,
        fields: spec.fields,
        grantedAt: now.toISOString(),
      });
      const errors = validateCapability(record);
      if (errors.length > 0) {
        throw new ConflictException(
          `能力记录不符合权威契约，拒绝恢复生效（fail-closed）：${errors.join(', ')}`,
        );
      }
      if (canonicalType !== record.kind) repairedFields.push('capabilityType');
      if (canonicalId !== record.capabilityId) repairedFields.push('capabilityId');
      if (canonicalSubject !== record.subject) repairedFields.push('subject');
      canonicalType = record.kind;
      canonicalId = record.capabilityId;
      canonicalSubject = record.subject;
    }

    const lifecycle: DeviceCapabilityLifecycleInfo = {
      action: status === 'active' ? 'restore' : 'disable',
      operator: (actor?.userId ?? '').trim() || 'unknown',
      reason,
      at: now.toISOString(),
      previousStatus,
    };
    const nextValue: Record<string, unknown> = {
      ...value,
      lifecycle,
      // 记录内冗余的权威字段与列同步（读路径可能只取 JSON 里的 subject/providerType）
      ...(status === 'active'
        ? {
            subject: canonicalSubject,
            mode: spec?.mode ?? value.mode,
            providerType: spec?.providerType ?? value.providerType,
            label: spec?.label ?? value.label,
            fields: spec ? [...spec.fields] : value.fields,
          }
        : {}),
    };

    // NO-22a：授权消耗与业务写入同事务——写失败则消耗回滚，
    // 不会出现"审批被烧掉但设备状态没变"的假消耗（现场不必重新审批）。
    const [updated] = await this.db.transaction(async (tx) => {
      if (restoreApprovedBy && this.approvalPort) {
        const claim = await this.approvalPort.claimUsage(
          {
            approvalId: restoreApprovedBy,
            usageKey: buildApprovalUsageKey({ capabilityKey: name, deviceId }),
            usedBy: (actor?.userId ?? '').trim() || 'system',
            note: reason,
            orgId: actor?.primaryOrgId ?? (row.orgId ? String(row.orgId) : null),
            entityType: 'device_capability_change',
            entityId: `capability:${name}`,
            deviceId,
            at: now,
          },
          tx as unknown as PostgresJsDatabase,
        );
        if (!claim.claimed) {
          const used = claim.existing;
          throw new ConflictException(
            'APPROVAL_ALREADY_CONSUMED：该审批已用于本设备的这次恢复' +
              (used?.at ? `（${used.at}` : '（时间未记录') +
              (used?.usedBy ? ` 由 ${used.usedBy}` : '') +
              (used?.note ? `，理由：${used.note}` : '') +
              '）。审批描述的是当时那一次现场条件，若需再次恢复请重新申请审批。',
          );
        }
      }
      return tx
        .update(ewohDeviceCapability)
        .set({
          status,
          updatedAt: now,
          ...(status === 'active'
            ? { effectiveFrom: now, effectiveTo: null }
            : { effectiveTo: now }),
          capabilityValue: nextValue,
          ...(status === 'active' && spec
            ? { capabilityType: canonicalType, capabilityId: canonicalId }
            : {}),
        })
        .where(and(...conditions))
        .returning();
    });

    if (!updated) {
      // 并发下同键被改走（预期外的 0 行）：不静默成功
      throw new ConflictException('设备能力状态变更未生效（并发冲突），请重试并复核当前状态');
    }

    await this.auditService.appendAuditLog({
      actorId: (actor?.userId ?? '').trim() || 'system',
      orgId: this.auditOrgId(actor, row.orgId ? String(row.orgId) : null),
      action: status === 'active' ? 'device.capability.restore' : 'device.capability.disable',
      entityType: 'device_capability',
      entityId: String(updated.capabilityId),
      before: { status: previousStatus, effectiveTo: toIso(row.effectiveTo) },
      metadata: {
        deviceId: String(updated.deviceId),
        materializedFromDeclaration: materialized,
        ...(restoreApprovedBy
          ? {
              approvalId: restoreApprovedBy,
              // NO-22a：把"批准时刻 / 有效期"一并留痕，事后可对账这次放行是否在时效内
              approvalApprovedAt: restoreApprovalApprovedAt ?? undefined,
              approvalExpiresAt: restoreApprovalExpiresAt ?? undefined,
            }
          : {}),
      },
      after: {
        status,
        effectiveTo: toIso(updated.effectiveTo),
        capabilityName: name,
        repairedFields: repairedFields.length > 0 ? repairedFields : undefined,
      },
      reason,
    });

    return {
      deviceId: String(updated.deviceId),
      capabilityId: String(updated.capabilityId),
      capabilityName: name,
      status,
      previousStatus,
      changed: true,
      ...(restoreApprovedBy ? { approvalId: restoreApprovedBy } : {}),
      effectiveFrom: toIso(updated.effectiveFrom),
      effectiveTo: toIso(updated.effectiveTo),
      updatedAt: toIso(updated.updatedAt) ?? now.toISOString(),
      contractValid: true,
      repairedFields,
    };
  }

  /** 读取设备行（能力生命周期写路径用；租户作用域，缺失 → null）。 */
  private async loadDeviceForCapabilityWrite(
    deviceId: string,
    actor?: OrgContext,
  ): Promise<{ id: string; deviceId: string; capabilities: unknown; deviceModel: string | null; orgId: string | null } | null> {
    const conditions: SQL[] = [eq(ewohDevice.deviceId, deviceId)];
    const orgCond = this.orgCondition(ewohDevice.orgId, actor);
    if (orgCond) conditions.push(orgCond);
    const [device] = await this.db
      .select({
        id: ewohDevice.id,
        deviceId: ewohDevice.deviceId,
        capabilities: ewohDevice.capabilities,
        deviceModel: ewohDevice.deviceModel,
        orgId: ewohDevice.orgId,
      })
      .from(ewohDevice)
      .where(and(...conditions))
      .limit(1);
    if (!device) return null;
    return {
      id: String(device.id),
      deviceId: String(device.deviceId),
      capabilities: device.capabilities,
      deviceModel: device.deviceModel ?? null,
      orgId: device.orgId ? String(device.orgId) : null,
    };
  }

  /**
   * 设备"当前生效能力"（列 ∪ 型号白名单）——仅用于判断"停用是否有的放矢"。
   * 台账部分不在这里：调用方已确认该能力没有台账行。
   */
  private effectiveCapabilityNames(device: {
    capabilities: unknown;
    deviceModel: string | null;
  }): string[] {
    const columnNames = Array.isArray(device.capabilities)
      ? (device.capabilities as unknown[]).map((c) => String(c))
      : [];
    const whitelist = columnNames.length > 0 ? [] : deriveDeviceCapabilities(device.deviceModel);
    return [...new Set([...columnNames, ...whitelist])];
  }

  private mapDeviceRows(rows: Array<Record<string, unknown>>): DeviceInfo[] {
    return rows.map((r) => ({
      id: String(r.id),
      deviceId: String(r.deviceId),
      workerName: String(r.workerName ?? ''),
      deviceModel: String(r.deviceModel ?? ''),
      // 未知/历史行 → 'unknown'（显式未知；前端显示"未知类别"而不是猜一个）
      deviceCategory: normalizeDeviceCategory(r.deviceCategory),
      // 关键诚信修复（2026-09-10）：没有电池的设备（环境传感器/摄像头/定位标签）
      // 电量列是 NULL，此前强转 0 → 前端显示"0% 低电量"，把"不适用"伪造成告警。
      // 现在 NULL 直通为 null，由 UI 显示"—"。
      batteryPct:
        r.batteryPct === null || r.batteryPct === undefined ? null : Number(r.batteryPct),
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
      const safeLimit = clampListLimit(limit, 50);
      const safeOffset = clampListOffset(offset);
      // 时间窗：默认 24h，显式传入则 clamp 到 [1, 168]（7 天）。
      const safeHours = clampEventWindowHours(hours);
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
          // 2026-09-11：透出 sourceType——注意力列表据此区分「现场异常」与
          // 学习/仿真等系统审计事件（OutcomeAnnotationRecorded、
          // SimulationRun* 不是现场异常，混同展示违反状态明确区分原则）。
          sourceType: r.sourceType ?? '',
        })),
      };
    } catch (error) {
      this.rethrowWithLog('getEvents 失败', error);
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
      this.rethrowWithLog('getEventStats 失败', error);
    }
  }

  async getTelemetry(
    deviceId: string,
    limit: number = 50,
    actor?: OrgContext,
  ): Promise<TelemetryInfo[]> {
    try {
      // NEST-348：limit 上限。
      const safeLimit = clampListLimit(limit, 50);
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
      this.rethrowWithLog('getTelemetry 失败', error);
    }
  }

  async getWorkers(actor?: OrgContext): Promise<WorkerLoad[]> {
    try {
      const orgCond = this.orgCondition(ewohDevice.orgId, actor);
      // 遥测 1 小时窗必须放在 LEFT JOIN 的 **ON** 里，而不是 WHERE——
      // 放 WHERE 时无遥测行（离线/停报设备）的 NULL.ts 谓词过滤掉整行，
      // LEFT JOIN 退化为 INNER JOIN，这些设备从"人员负荷"看板整行消失；
      // 放 ON 则保留设备行、聚合退化为 coalesce 0（telemetryCount=0 如实可见）。
      const telemetryWindow = gte(ewohTelemetry.ts, sql`now() - interval '1 hour'`);
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
        .leftJoin(ewohTelemetry, and(eq(ewohTelemetry.deviceId, ewohDevice.deviceId), telemetryWindow))
        .where(orgCond)
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
      this.rethrowWithLog('getWorkers 失败', error);
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
      this.rethrowWithLog('handleEvent 失败', error, error instanceof NotFoundException);
    }
  }

  async createDevice(dto: CreateDeviceDto, actor?: OrgContext): Promise<DeviceInfo> {
    try {
      // NEST-331：无租户上下文时使用默认 org（演示/单租户环境兜底）。
      // 生产环境应由 OrgContextInterceptor 确保 actor.orgId 非空。
      const orgId = this.orgParam(actor) ?? process.env.EWOH_DEFAULT_ORG_ID ?? 'default';
      const [existing] = await this.db
        .select({ deviceId: ewohDevice.deviceId })
        .from(ewohDevice)
        .where(and(eq(ewohDevice.deviceId, dto.deviceId), eq(ewohDevice.orgId, orgId)))
        .limit(1);
      if (existing) {
        throw new BadRequestException('设备 ID 已存在');
      }
      // 类别校验：词表外 fail-closed（列里塞进任意字符串会让台账词表失效，
      // 前端只能显示"未知类别"——不如在写入点就拒绝并给出允许值）。
      if (dto.deviceCategory !== undefined && !isKnownDeviceCategory(dto.deviceCategory)) {
        throw new BadRequestException(
          `deviceCategory 必须是以下之一：${DEVICE_CATEGORIES.join(', ')}`,
        );
      }

      const [created] = await this.db
        .insert(ewohDevice)
        .values({
          deviceId: dto.deviceId,
          workerName: dto.workerName ?? null,
          deviceModel: dto.deviceModel ?? null,
          deviceCategory: dto.deviceCategory ?? DEVICE_CATEGORY_UNKNOWN,
          // 电量缺省不再写 100：未提供就是未提供（NULL → UI 显示"—"），
          // 写 100 会让"从没上报过电量"看起来像"满电"。
          batteryPct: dto.batteryPct ?? null,
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
      this.rethrowWithLog('createDevice 失败', error, error instanceof BadRequestException);
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
      this.rethrowWithLog('updateDevice 失败', error, error instanceof NotFoundException);
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
      this.rethrowWithLog(`getDeviceBindings 失败 deviceId=${deviceId}`, error);
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
      this.rethrowWithLog(`bindDevice 失败 deviceId=${deviceId}`, error);
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
      this.rethrowWithLog(`unbindDevice 失败 deviceId=${deviceId}`, error);
    }
  }

  private mapDevice(r: typeof ewohDevice.$inferSelect): DeviceInfo {
    return {
      id: r.id,
      deviceId: r.deviceId,
      workerName: r.workerName ?? '',
      deviceModel: r.deviceModel ?? '',
      deviceCategory: normalizeDeviceCategory(r.deviceCategory),
      // 与 mapDeviceRows 同口径：NULL 电量直通（不伪装 0%）
      batteryPct: r.batteryPct ?? null,
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
