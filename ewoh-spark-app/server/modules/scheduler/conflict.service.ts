import {
  Injectable,
  Inject,
  Logger,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, inArray, asc, desc } from 'drizzle-orm';
import { ewohSchedulingConflict, ewohSchedulePlan } from '@server/database/schema';
import type {
  ConflictsListRequest,
  ConflictsListResponse,
  ConflictLifecycleStatus,
  SchedulingConflict,
  SchedulingPolicyConfig,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';
import { WorldStateSnapshotService } from './world-state.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { OutboxService } from './outbox.service';

/** 视为"活跃"（非终态）的方案状态（与 SchedulerService 保持一致）。 */
const ACTIVE_PLAN_STATUSES = [
  'draft',
  'shadow',
  'proposed',
  'approved',
  'dispatched',
  'executing',
];

/** 系统操作者标识（自动 RESOLVED / reopen 审计用）。 */
const SYSTEM_ACTOR = 'system';

/** 系统上下文（推导归并触发的审计默认）。 */
const SYSTEM_CTX: OrgContext = {
  userId: SYSTEM_ACTOR,
  primaryOrgId: '',
  role: 'system',
  accessibleOrgIds: [],
  isGlobalAdmin: false,
};

/**
 * 调度冲突服务（Phase 3 / P3-T1）：冲突从"实时推导"升级为"推导 + 落库 + 生命周期"。
 *
 * - derive()：从真实世界状态 / 预占 / 活跃方案推导统一冲突（迁移自 SchedulerService）；
 * - reconcile()：每次推导与已落库行按 conflictId 归并——复现→OPEN（已 ACK 保持），
 *   消失→自动 RESOLVED（resolution=auto_cleared，决策 D-C），suppressUntil 到期自动回 OPEN，
 *   RESOLVED 复现→reopen OPEN；状态转移写审计 + SSE 推送；
 * - acknowledge / resolve / suppress：人工生命周期转移（02 §6.1 状态机严格）。
 */
@Injectable()
export class ConflictService {
  private readonly logger = new Logger(ConflictService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly policyService: SchedulingPolicyService,
    private readonly auditService: AuditService,
    private readonly outboxService?: OutboxService,
  ) {}

  // ===== 公开查询 =====

  /**
   * T04 / P1-5（G5）：推导 + 只读合并 + 返回当前冲突视图（GET 纯读，无任何写副作用）。
   * 不再调用 reconcile()（写路径）；写操作走显式端点 acknowledge/resolve/suppress/reconcileNow。
   */
  async listConflicts(
    params: ConflictsListRequest = {},
  ): Promise<ConflictsListResponse> {
    const derived = await this.derive();
    const merged = await this.mergeWithDbReadOnly(derived);
    let conflicts = merged;
    if (params.type) conflicts = conflicts.filter((c) => c.type === params.type);
    if (params.severity)
      conflicts = conflicts.filter((c) => c.severity === params.severity);
    if (params.scope) conflicts = conflicts.filter((c) => c.scope === params.scope);
    if (params.resourceId)
      conflicts = conflicts.filter((c) => c.resourceId === params.resourceId);
    conflicts.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
    return { conflicts, total: conflicts.length };
  }

  /**
   * T04 / P1-5（G5）：显式冲突归并触发（写路径）。迁移既有 reconcile() 写逻辑：
   * 推导 → 归并落库（INSERT/UPDATE + SSE + audit）。供前端"立即归并"按钮/轮询任务使用。
   */
  async reconcileNow(
    ctx: OrgContext,
  ): Promise<{ ok: boolean; reconciledCount: number; conflicts: SchedulingConflict[] }> {
    const derived = await this.derive();
    const merged = await this.reconcile(derived, ctx ?? SYSTEM_CTX);
    return { ok: true, reconciledCount: merged.length, conflicts: merged };
  }

  /**
   * T04 / P1-5（G5）：只读合并——将推导结果投影已落库行的生命周期字段
   * （status/detectedAt/acknowledgedBy/.../suppressUntil/planId），**不产生任何
   * INSERT/UPDATE，不发 SSE，不写审计**。供 GET /conflicts 纯读。
   */
  private async mergeWithDbReadOnly(
    derived: SchedulingConflict[],
  ): Promise<SchedulingConflict[]> {
    const persisted = await this.loadAllRows();
    const byId = new Map(persisted.map((r) => [r.conflictId, r]));
    return derived.map((c) => {
      const row = byId.get(c.conflictId);
      if (!row) return c; // 未落库：返回推导态（status 缺省 OPEN，不写库）。
      return {
        ...c,
        status: (row.status ?? 'OPEN') as ConflictLifecycleStatus,
        detectedAt: row.detectedAt ? row.detectedAt.toISOString() : c.createdAt,
        acknowledgedBy: row.acknowledgedBy ?? null,
        acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
        resolvedBy: row.resolvedBy ?? null,
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        suppressUntil: row.suppressUntil ? row.suppressUntil.toISOString() : null,
        planId: c.planId ?? row.planId ?? null,
      };
    });
  }

  /** 冲突详情；当前真实数据中不存在且无落库行时抛 NotFoundException。 */
  async getConflictDetail(conflictId: string): Promise<SchedulingConflict> {
    const { conflicts } = await this.listConflicts({});
    const found = conflicts.find((c) => c.conflictId === conflictId);
    if (!found) {
      // 兜底：已落库但当前不再推导的冲突（如已 RESOLVED/SUPPRESSED 历史行）。
      const row = await this.findRowByConflictId(conflictId);
      if (!row) throw new NotFoundException(`Conflict ${conflictId} not found`);
      return this.rowToConflict(row);
    }
    return found;
  }

  // ===== 人工生命周期转移（02 §6.1） =====

  /** OPEN → ACKNOWLEDGED（已 ACK 幂等保持；RESOLVED/SUPPRESSED 拒绝）。 */
  async acknowledge(
    conflictId: string,
    operator: string,
    reason?: string,
    ctx?: OrgContext,
  ): Promise<SchedulingConflict> {
    const row = await this.findRowByConflictId(conflictId);
    if (!row) {
      // 未落库：先推导归并（使其落库），再执行转移。
      await this.reconcile(await this.derive(), ctx ?? SYSTEM_CTX);
    }
    const fresh = await this.findRowByConflictId(conflictId);
    if (!fresh) throw new NotFoundException(`Conflict ${conflictId} not found`);
    if (fresh.status === 'ACKNOWLEDGED') return this.rowToConflict(fresh);
    if (fresh.status !== 'OPEN') {
      throw new ConflictException(
        `Conflict ${conflictId} cannot be acknowledged from status ${fresh.status}`,
      );
    }
    const now = new Date();
    const actor = operator || ctx?.userId || SYSTEM_ACTOR;
    await this.updateRow(fresh.id, {
      status: 'ACKNOWLEDGED',
      acknowledgedBy: actor,
      acknowledgedAt: now,
      updatedAt: now,
    });
    const updated = await this.findRowByConflictId(conflictId);
    if (!updated) throw new NotFoundException(`Conflict ${conflictId} not found`);
    const view = this.rowToConflict(updated);
    await this.writeAudit(
      'conflict.acknowledge',
      view,
      actor,
      reason ?? '',
      ctx ?? SYSTEM_CTX,
    );
    await this.emitSse('conflict.acknowledged', view);
    return view;
  }

  /** OPEN/ACKNOWLEDGED/SUPPRESSED → RESOLVED（人工 resolve；自动 auto_cleared 走 reconcile）。 */
  async resolve(
    conflictId: string,
    operator: string,
    reason?: string,
    resolution?: string,
    ctx?: OrgContext,
  ): Promise<SchedulingConflict> {
    const fresh = await this.findRowByConflictId(conflictId);
    if (!fresh) throw new NotFoundException(`Conflict ${conflictId} not found`);
    if (fresh.status === 'RESOLVED') return this.rowToConflict(fresh);
    const now = new Date();
    const actor = operator || ctx?.userId || SYSTEM_ACTOR;
    await this.updateRow(fresh.id, {
      status: 'RESOLVED',
      resolvedBy: actor,
      resolvedAt: now,
      resolution: resolution ?? fresh.resolution ?? null,
      updatedAt: now,
    });
    const updated = await this.findRowByConflictId(conflictId);
    if (!updated) throw new NotFoundException(`Conflict ${conflictId} not found`);
    const view = this.rowToConflict(updated);
    await this.writeAudit(
      'conflict.resolve',
      view,
      actor,
      reason ?? '',
      ctx ?? SYSTEM_CTX,
    );
    await this.emitSse('conflict.resolved', view);
    return view;
  }

  /** OPEN/ACKNOWLEDGED → SUPPRESSED（suppressUntil 到期由 reconcile 自动回 OPEN）。 */
  async suppress(
    conflictId: string,
    operator: string,
    reason?: string,
    suppressUntilMs?: number,
    ctx?: OrgContext,
  ): Promise<SchedulingConflict> {
    const fresh = await this.findRowByConflictId(conflictId);
    if (!fresh) throw new NotFoundException(`Conflict ${conflictId} not found`);
    if (fresh.status === 'SUPPRESSED') return this.rowToConflict(fresh);
    if (fresh.status === 'RESOLVED') {
      throw new ConflictException(
        `Conflict ${conflictId} cannot be suppressed from status RESOLVED`,
      );
    }
    const now = new Date();
    const actor = operator || ctx?.userId || SYSTEM_ACTOR;
    const suppressUntil =
      typeof suppressUntilMs === 'number' && Number.isFinite(suppressUntilMs)
        ? new Date(suppressUntilMs)
        : new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await this.updateRow(fresh.id, {
      status: 'SUPPRESSED',
      suppressUntil,
      updatedAt: now,
    });
    const updated = await this.findRowByConflictId(conflictId);
    if (!updated) throw new NotFoundException(`Conflict ${conflictId} not found`);
    const view = this.rowToConflict(updated);
    await this.writeAudit(
      'conflict.suppress',
      view,
      actor,
      reason ?? '',
      ctx ?? SYSTEM_CTX,
    );
    await this.emitSse('conflict.suppressed', view);
    return view;
  }

  // ===== 推导 + 归并落库 =====

  /** 从当前世界状态 / 预占 / 活跃方案推导全部真实冲突（迁移自 SchedulerService）。 */
  async derive(): Promise<SchedulingConflict[]> {
    const state = await this.worldStateSnapshotService.getCurrentWorldState();
    const config = (await this.policyService
      .getConfig()
      .catch(() => null)) as SchedulingPolicyConfig | null;
    const minBatteryPct = config?.minBatteryPct ?? 15;
    const now = Date.now();
    const conflicts: SchedulingConflict[] = [];

    const terminalStatuses = new Set(['done', 'completed', 'cancelled', 'failed']);
    const affectedTasks = state.tasks.filter((t) => !terminalStatuses.has(t.status));

    const taskIdsFor = (kind: 'person' | 'device', id: string): string[] =>
      affectedTasks
        .filter((t) => (kind === 'person' ? t.assigneeId === id : t.deviceId === id))
        .map((t) => t.id);

    // 1. double booking：同一资源时间窗重叠的预占。
    const resByKey = new Map<string, typeof state.reservations>();
    for (const r of state.reservations ?? []) {
      const key = `${r.resourceType}:${r.resourceId}`;
      const list = resByKey.get(key) ?? [];
      list.push(r);
      resByKey.set(key, list);
    }
    for (const [key, list] of resByKey) {
      const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          if (a.startMs < b.endMs && b.startMs < a.endMs) {
            const [resourceType, resourceId] = key.split(':');
            conflicts.push(
              this.mkConflict(
                `double_booking:${key}:${a.reservationId}:${b.reservationId}`,
                {
                  type: 'double_booking',
                  severity: 'critical',
                  scope: 'resource',
                  resourceType,
                  resourceId,
                  taskIds: [],
                  message: `资源 ${resourceId}（${resourceType}）存在重叠预占：${a.reservationId} 与 ${b.reservationId}`,
                  resolution: '释放其中一条预占或调整时间窗',
                  snapshotVersion: 'CURRENT',
                  data: {
                    reservationIds: [a.reservationId, b.reservationId],
                    overlapStartMs: Math.max(a.startMs, b.startMs),
                    overlapEndMs: Math.min(a.endMs, b.endMs),
                  },
                },
              ),
            );
          }
        }
      }
    }

    // 2. resource stale：STALE / UNKNOWN 数据不被视为可信。
    for (const p of state.persons) {
      if (p.dataQuality === 'STALE' || p.dataQuality === 'UNKNOWN') {
        conflicts.push(
          this.mkConflict(`resource_stale:person:${p.id}`, {
            type: 'resource_stale',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'person',
            resourceId: p.id,
            taskIds: taskIdsFor('person', p.id),
            message: `人员 ${p.name ?? p.id} 数据陈旧（${p.dataQuality}）`,
            resolution: '等待遥测更新或人工确认状态',
            snapshotVersion: 'CURRENT',
            data: { dataQuality: p.dataQuality },
          }),
        );
      }
    }
    for (const d of state.devices) {
      if (d.dataQuality === 'STALE' || d.dataQuality === 'UNKNOWN') {
        conflicts.push(
          this.mkConflict(`resource_stale:device:${d.id}`, {
            type: 'resource_stale',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'device',
            resourceId: d.id,
            taskIds: taskIdsFor('device', d.id),
            message: `设备 ${d.id} 数据陈旧（${d.dataQuality}）`,
            resolution: '等待遥测更新确认状态',
            snapshotVersion: 'CURRENT',
            data: { dataQuality: d.dataQuality },
          }),
        );
      }
    }

    // 3. person unavailable：数据新鲜但状态不可用。
    for (const p of state.persons) {
      if (p.dataQuality === 'FRESH' && p.status === 'unavailable') {
        conflicts.push(
          this.mkConflict(`person_unavailable:${p.id}`, {
            type: 'person_unavailable',
            severity: 'high',
            scope: 'resource',
            resourceType: 'person',
            resourceId: p.id,
            taskIds: taskIdsFor('person', p.id),
            message: `人员 ${p.name ?? p.id} 当前不可用`,
            resolution: '等待人员恢复或调整人员分配',
            snapshotVersion: 'CURRENT',
            data: {},
          }),
        );
      }
    }

    // 4. device offline：数据新鲜但设备离线。
    for (const d of state.devices) {
      if (d.dataQuality === 'FRESH' && d.status === 'offline') {
        conflicts.push(
          this.mkConflict(`device_offline:${d.id}`, {
            type: 'device_offline',
            severity: 'high',
            scope: 'resource',
            resourceType: 'device',
            resourceId: d.id,
            taskIds: taskIdsFor('device', d.id),
            message: `设备 ${d.id} 当前离线`,
            resolution: '等待设备恢复在线',
            snapshotVersion: 'CURRENT',
            data: {},
          }),
        );
      }
    }

    // 5. low battery：设备电量低于阈值（数据新鲜且在线）。
    for (const d of state.devices) {
      if (
        d.dataQuality === 'FRESH' &&
        d.status !== 'offline' &&
        (d.batteryPct ?? 100) < minBatteryPct
      ) {
        conflicts.push(
          this.mkConflict(`low_battery:${d.id}`, {
            type: 'low_battery',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'device',
            resourceId: d.id,
            taskIds: taskIdsFor('device', d.id),
            message: `设备 ${d.id} 电量偏低（${d.batteryPct ?? 100}%）`,
            resolution: '安排充电或更换设备',
            snapshotVersion: 'CURRENT',
            data: { batteryPct: d.batteryPct ?? 100, minBatteryPct },
          }),
        );
      }
    }

    // 6. blocked route：路由阻断/拥塞。
    for (const r of state.routeStatus ?? []) {
      if (r.status === 'blocked' || r.status === 'congested') {
        conflicts.push(
          this.mkConflict(`blocked_route:${r.edgeId}`, {
            type: 'blocked_route',
            severity: 'high',
            scope: 'route',
            resourceType: 'route',
            resourceId: r.edgeId,
            taskIds: [],
            message: `路段 ${r.edgeId} 不可通行（${r.status}）`,
            resolution: '求解时排除该路段并绕行',
            snapshotVersion: 'CURRENT',
            data: { status: r.status, riskLevel: r.riskLevel },
          }),
        );
      }
    }

    // 7. forbidden zone：受限制区域 + 安全事件派生区域。
    for (const z of state.forbiddenZones ?? []) {
      const zoneTaskIds = affectedTasks
        .filter((t) => t.zoneId === z.zoneId)
        .map((t) => t.id);
      conflicts.push(
        this.mkConflict(`forbidden_zone:${z.zoneId}`, {
          type: 'forbidden_zone',
          severity: 'critical',
          scope: 'route',
          resourceType: 'zone',
          resourceId: z.zoneId,
          taskIds: zoneTaskIds,
          message: `区域 ${z.zoneId} 被禁止进入（${z.reason}）`,
          resolution: '取消该区域任务或人工介入',
          snapshotVersion: 'CURRENT',
          data: { reason: z.reason },
        }),
      );
    }

    // 8. safety block：安全事件触发的禁用人员/设备。
    for (const pid of state.safetyBlockedPersonIds ?? []) {
      conflicts.push(
        this.mkConflict(`safety_block:person:${pid}`, {
          type: 'safety_block',
          severity: 'critical',
          scope: 'resource',
          resourceType: 'person',
          resourceId: pid,
          taskIds: taskIdsFor('person', pid),
          message: `人员 ${pid} 因安全事件被禁止作业`,
          resolution: '确认安全事件消除后人工恢复',
          snapshotVersion: 'CURRENT',
          data: {},
        }),
      );
    }
    for (const did of state.safetyBlockedDeviceIds ?? []) {
      conflicts.push(
        this.mkConflict(`safety_block:device:${did}`, {
          type: 'safety_block',
          severity: 'critical',
          scope: 'resource',
          resourceType: 'device',
          resourceId: did,
          taskIds: taskIdsFor('device', did),
          message: `设备 ${did} 因安全事件被禁止启用`,
          resolution: '确认安全事件消除后人工恢复',
          snapshotVersion: 'CURRENT',
          data: {},
        }),
      );
    }

    // 9. predecessor violation：前置任务未完成仍被调度。
    const statusById = new Map(state.tasks.map((t) => [t.id, t.status]));
    for (const t of affectedTasks) {
      const pendingPreds = (t.predecessorIds ?? []).filter(
        (pid) => !terminalStatuses.has(statusById.get(pid) ?? ''),
      );
      if (pendingPreds.length > 0) {
        conflicts.push(
          this.mkConflict(`predecessor_violation:${t.id}`, {
            type: 'predecessor_violation',
            severity: 'high',
            scope: 'task',
            resourceType: null,
            resourceId: null,
            taskIds: [t.id],
            message: `任务 ${t.id} 的前置任务（${pendingPreds.join(', ')}）尚未完成`,
            resolution: '等待前置任务完成或调整依赖',
            snapshotVersion: 'CURRENT',
            data: { predecessorIds: pendingPreds },
          }),
        );
      }
    }

    // 10. station capacity：工位任务数量超过容量。
    const backlogCountById = new Map<string, number>();
    for (const b of state.backlog ?? []) backlogCountById.set(b.taskId, b.count);
    for (const s of state.stations ?? []) {
      if (s.capacity == null) continue;
      const count = backlogCountById.get(s.id) ?? 0;
      if (count > s.capacity) {
        conflicts.push(
          this.mkConflict(`station_capacity:${s.id}`, {
            type: 'station_capacity',
            severity: 'medium',
            scope: 'resource',
            resourceType: 'station',
            resourceId: s.id,
            taskIds: [],
            message: `工位 ${s.name ?? s.id} 任务数 ${count} 超过容量 ${s.capacity}`,
            resolution: '向其他空闲工位分流任务',
            snapshotVersion: 'CURRENT',
            data: { capacity: s.capacity, count },
          }),
        );
      }
    }

    // 11. stale plan：活跃方案基于已过期的快照。
    const activePlans = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(inArray(ewohSchedulePlan.status, ACTIVE_PLAN_STATUSES));
    for (const p of activePlans) {
      if (!p.snapshotVersion) continue;
      const stale = await this.worldStateSnapshotService.isPlanStale(
        p.snapshotVersion,
      );
      if (stale) {
        conflicts.push(
          this.mkConflict(`stale_plan:${p.planId}`, {
            type: 'stale_plan',
            severity: 'medium',
            scope: 'plan',
            resourceType: null,
            resourceId: null,
            taskIds: [],
            message: `方案 ${p.planId} 基于的快照 ${p.snapshotVersion} 已过期`,
            resolution: '基于最新快照重新运行调度生成新方案',
            snapshotVersion: p.snapshotVersion,
            data: { snapshotVersion: p.snapshotVersion, status: p.status },
          }),
        );
      }
    }

    // 12. reservation conflict：预占的资源当前离线/数据陈旧（预占不可用资源）。
    for (const r of state.reservations ?? []) {
      const offline =
        r.resourceType === 'device' &&
        state.devices.some((d) => d.id === r.resourceId && d.status === 'offline');
      const stale =
        r.resourceType === 'person' &&
        state.persons.some(
          (p) =>
            p.id === r.resourceId &&
            (p.dataQuality === 'STALE' || p.dataQuality === 'UNKNOWN'),
        );
      if (offline || stale) {
        conflicts.push(
          this.mkConflict(
            `reservation_conflict:${r.resourceType}:${r.resourceId}:${r.reservationId}`,
            {
              type: 'reservation_conflict',
              severity: 'high',
              scope: 'resource',
              resourceType: r.resourceType,
              resourceId: r.resourceId,
              taskIds: [],
              message: `预占 ${r.reservationId} 的资源 ${r.resourceId}（${r.resourceType}）当前不可用`,
              resolution: '释放预占或改派可用资源',
              snapshotVersion: 'CURRENT',
              data: { reservationId: r.reservationId, offline, stale },
            },
          ),
        );
      }
    }

    // 13. reservation expiring：预占即将过期（倒计时 < 阈值），需提前续约/重排。
    const expiringThresholdMs = (config?.triggerCooldownMs ?? 30_000) * 30;
    for (const r of state.reservations ?? []) {
      if (r.endMs == null) continue;
      const remainingMs = r.endMs - now;
      if (remainingMs > 0 && remainingMs < expiringThresholdMs) {
        conflicts.push(
          this.mkConflict(
            `reservation_expiring:${r.resourceType}:${r.resourceId}:${r.reservationId}`,
            {
              type: 'reservation_expiring',
              severity: 'medium',
              scope: 'resource',
              resourceType: r.resourceType,
              resourceId: r.resourceId,
              taskIds: [],
              message: `资源 ${r.resourceId}（${r.resourceType}）预占即将过期（剩余 ${Math.ceil(remainingMs / 60000)} 分钟）`,
              resolution: '续约预占或在过期前完成派工/重排',
              snapshotVersion: 'CURRENT',
              data: {
                reservationId: r.reservationId,
                startMs: r.startMs,
                endMs: r.endMs,
                remainingMs,
                thresholdMs: expiringThresholdMs,
              },
            },
          ),
        );
      }
    }

    return conflicts;
  }

  /**
   * 归并落库（决策 D-C）：每次推导与已落库行按 conflictId 归并。
   * - 复现：无落库行 → INSERT OPEN + SSE conflict.detected + audit；
   *   已 ACK 保持；SUPPRESSED（未到期）保持不告警；SUPPRESSED（到期）→ reopen OPEN；
   *   RESOLVED 复现 → reopen OPEN + audit + SSE。
   * - 消失：OPEN/ACKNOWLEDGED → 自动 RESOLVED（resolution=auto_cleared）+ audit + SSE。
   * 返回合并后的冲突视图（含生命周期字段）。
   */
  async reconcile(
    derived: SchedulingConflict[],
    ctx: OrgContext,
  ): Promise<SchedulingConflict[]> {
    const persisted = await this.loadAllRows();
    const byId = new Map(persisted.map((r) => [r.conflictId, r]));
    const now = new Date();
    const nowMs = now.getTime();
    const result: SchedulingConflict[] = [];

    for (const c of derived) {
      const row = byId.get(c.conflictId);
      if (!row) {
        // 新冲突 → 落库 OPEN + SSE + audit。
        await this.insertRow(c, ctx.primaryOrgId || null, now);
        const enriched: SchedulingConflict = {
          ...c,
          status: 'OPEN',
          detectedAt: now.toISOString(),
        };
        result.push(enriched);
        await this.emitSse('conflict.detected', enriched);
        await this.writeAudit('conflict.detected', enriched, SYSTEM_ACTOR, 'derived', ctx);
        continue;
      }

      // 已落库：按状态机归并（保留生命周期字段，更新推导内容）。
      let status: ConflictLifecycleStatus = (row.status ?? 'OPEN') as ConflictLifecycleStatus;
      let transition: 'reopen_suppress_expired' | 'reopen_reappeared' | null = null;
      if (row.status === 'SUPPRESSED') {
        if (row.suppressUntil && row.suppressUntil.getTime() <= nowMs) {
          status = 'OPEN';
          transition = 'reopen_suppress_expired';
        } else {
          status = 'SUPPRESSED';
        }
      } else if (row.status === 'RESOLVED') {
        status = 'OPEN';
        transition = 'reopen_reappeared';
      }
      const merged: SchedulingConflict = {
        ...c,
        status,
        detectedAt: row.detectedAt ? row.detectedAt.toISOString() : now.toISOString(),
        acknowledgedBy: row.acknowledgedBy ?? null,
        acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
        resolvedBy: row.resolvedBy ?? null,
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        suppressUntil: row.suppressUntil ? row.suppressUntil.toISOString() : null,
        planId: c.planId ?? row.planId ?? null,
      };
      if (transition) {
        await this.updateRow(row.id, { status: 'OPEN', updatedAt: now });
        await this.emitSse('conflict.detected', merged);
        await this.writeAudit(
          'conflict.reopen',
          merged,
          SYSTEM_ACTOR,
          transition === 'reopen_suppress_expired'
            ? 'suppress_until expired'
            : 'conflict reappeared after RESOLVED',
          ctx,
        );
      }
      result.push(merged);
    }

    // 消失 → 自动 RESOLVED（仅 OPEN/ACKNOWLEDGED；SUPPRESSED/RESOLVED 保持）。
    const derivedIds = new Set(derived.map((c) => c.conflictId));
    for (const row of persisted) {
      if (derivedIds.has(row.conflictId)) continue;
      if (row.status === 'OPEN' || row.status === 'ACKNOWLEDGED') {
        await this.updateRow(row.id, {
          status: 'RESOLVED',
          resolvedBy: SYSTEM_ACTOR,
          resolvedAt: now,
          resolution: 'auto_cleared',
          updatedAt: now,
        });
        const resolvedView: SchedulingConflict = {
          ...this.rowToConflict(row),
          status: 'RESOLVED',
          resolvedBy: SYSTEM_ACTOR,
          resolvedAt: now.toISOString(),
          resolution: 'auto_cleared',
        };
        await this.emitSse('conflict.resolved', resolvedView);
        await this.writeAudit(
          'conflict.resolve',
          resolvedView,
          SYSTEM_ACTOR,
          'auto_cleared',
          ctx,
        );
      }
    }

    return result;
  }

  // ===== 内部：DB 访问 =====

  private async loadAllRows() {
    const rows = await this.db
      .select()
      .from(ewohSchedulingConflict)
      .orderBy(asc(ewohSchedulingConflict.detectedAt));
    return rows;
  }

  private async findRowByConflictId(conflictId: string) {
    const rows = await this.db
      .select()
      .from(ewohSchedulingConflict)
      .where(eq(ewohSchedulingConflict.conflictId, conflictId))
      .limit(1);
    return rows[0] ?? null;
  }

  private async insertRow(
    c: SchedulingConflict,
    orgId: string | null,
    detectedAt: Date,
  ): Promise<void> {
    try {
      await this.db.insert(ewohSchedulingConflict).values({
        conflictId: c.conflictId,
        type: c.type,
        severity: c.severity,
        scope: c.scope,
        status: 'OPEN',
        taskIds: c.taskIds,
        resourceIds: c.resourceId ? [c.resourceId] : [],
        resourceId: c.resourceId,
        resourceType: c.resourceType,
        planId: c.planId ?? null,
        snapshotVersion: c.snapshotVersion,
        message: c.message,
        resolution: c.resolution,
        data: c.data ?? null,
        detectedAt,
        orgId,
      });
    } catch (err) {
      this.logger.warn(
        `conflict insert failed (${c.conflictId}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async updateRow(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db
        .update(ewohSchedulingConflict)
        .set(patch)
        .where(eq(ewohSchedulingConflict.id, id));
    } catch (err) {
      this.logger.warn(
        `conflict update failed (${id}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  // ===== 内部：SSE / audit / 映射 =====

  /** SSE 推送（conflict.detected/resolved/acknowledged/suppressed）。缺失 outbox 时静默。 */
  private async emitSse(
    eventType: string,
    conflict: SchedulingConflict,
  ): Promise<void> {
    if (!this.outboxService) return;
    try {
      await this.outboxService.enqueue(
        eventType,
        conflict.conflictId,
        {
          conflictId: conflict.conflictId,
          type: conflict.type,
          severity: conflict.severity,
          scope: conflict.scope,
          status: conflict.status,
          resourceId: conflict.resourceId,
          resourceType: conflict.resourceType,
          taskIds: conflict.taskIds,
          message: conflict.message,
          resolution: conflict.resolution,
          planId: conflict.planId ?? null,
          snapshotVersion: conflict.snapshotVersion,
          occurredAt: new Date().toISOString(),
        },
        null,
        undefined,
        {
          entityType: 'conflict',
          snapshotVersion: conflict.snapshotVersion ?? undefined,
          planId: conflict.planId ?? undefined,
          occurredAt: new Date().toISOString(),
        },
      );
    } catch (err) {
      this.logger.warn(
        `${eventType} enqueue failed (${conflict.conflictId}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** 状态转移审计（沿用 AuditService 模式：action=conflict.*）。 */
  private async writeAudit(
    action: string,
    conflict: SchedulingConflict,
    actor: string,
    reason: string,
    ctx: OrgContext,
  ): Promise<void> {
    try {
      await this.auditService.appendAuditLog({
        actorId: actor || ctx.userId || SYSTEM_ACTOR,
        orgId: ctx.primaryOrgId || '',
        action,
        entityType: 'scheduling_conflict',
        entityId: conflict.conflictId,
        before: { type: conflict.type, severity: conflict.severity },
        after: { status: conflict.status, resolution: conflict.resolution },
        reason,
      });
    } catch (err) {
      this.logger.warn(
        `conflict audit failed (${action} ${conflict.conflictId}): ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /** 构造统一冲突，conflictId 由内容种子哈希生成（跨查询稳定）。 */
  private mkConflict(
    seed: string,
    input: Omit<SchedulingConflict, 'conflictId' | 'createdAt'>,
  ): SchedulingConflict {
    return {
      conflictId: `CFL-${this.hash(seed)}`,
      createdAt: new Date().toISOString(),
      ...input,
    };
  }

  /** djb2 字符串哈希（生成稳定冲突 id）。 */
  private hash(str: string): number {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    }
    return h >>> 0;
  }

  /** 落库行 → 公开 SchedulingConflict 形状（生命周期字段齐全）。 */
  private rowToConflict(row: {
    conflictId: string;
    type: string;
    severity: string;
    scope: string;
    status: string;
    taskIds: unknown;
    resourceId: string | null;
    resourceType: string | null;
    planId: string | null;
    snapshotVersion: string | null;
    message: string;
    resolution: string | null;
    data: unknown;
    detectedAt: Date;
    acknowledgedBy: string | null;
    acknowledgedAt: Date | null;
    resolvedBy: string | null;
    resolvedAt: Date | null;
    suppressUntil: Date | null;
  }): SchedulingConflict {
    return {
      conflictId: row.conflictId,
      type: row.type as SchedulingConflict['type'],
      severity: row.severity as SchedulingConflict['severity'],
      scope: row.scope as SchedulingConflict['scope'],
      resourceId: row.resourceId ?? null,
      resourceType: row.resourceType ?? null,
      taskIds: this.asStringArray(row.taskIds),
      message: row.message,
      resolution: row.resolution ?? null,
      snapshotVersion: row.snapshotVersion ?? null,
      data: (row.data ?? undefined) as Record<string, unknown> | undefined,
      createdAt: row.detectedAt ? row.detectedAt.toISOString() : new Date().toISOString(),
      status: (row.status ?? 'OPEN') as ConflictLifecycleStatus,
      detectedAt: row.detectedAt ? row.detectedAt.toISOString() : null,
      acknowledgedBy: row.acknowledgedBy ?? null,
      acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
      resolvedBy: row.resolvedBy ?? null,
      resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
      suppressUntil: row.suppressUntil ? row.suppressUntil.toISOString() : null,
      planId: row.planId ?? null,
    };
  }

  /** jsonb 数组列安全规整为 string[]（runtime validation）。 */
  private asStringArray(v: unknown): string[] {
    return Array.isArray(v)
      ? (v as string[]).filter((x): x is string => typeof x === 'string')
      : [];
  }
}
