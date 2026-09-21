import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, desc, ne, or, isNull, sql } from 'drizzle-orm';
import { ewohSchedulePlan, ewohSchedulingRun } from '@server/database/schema';
import type {
  ReplanConfig,
  ReplanImpact,
  SchedulingRun,
  SchedulingPlanV2,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { TriggerService } from './trigger.service';
import { WorldStateSnapshotService } from './world-state.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { ImpactAnalyzer } from './impact-analyzer';
import { ConstraintLoaderService } from './constraint-loader.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { OutboxService } from './outbox.service';
import { propagateImpact } from './impact-propagation';
import { ReplanGuardStatusService } from '../health/replan-guard-status.service';
import { projectReplanDecision } from './decision-projection';
import { appendPlanDecisionRecords } from './decision-ledger';

/** 影响分析结果：哪些任务需重排、哪些被冻结、原因说明。 */
export interface ImpactAnalysis {
  affectedTaskIds: string[];
  frozenTaskIds: string[];
  reason: string;
}

/** Replan V2 触发结果（兼容旧 handleTrigger 形状；suppressed 为 M02 新增可选字段）。 */
export interface TriggerResult {
  run: SchedulingRun | null;
  plans: SchedulingPlanV2[];
  debounced: boolean;
  /** Replan V2 风暴守卫：被抑制（未创建 run）。 */
  suppressed?: boolean;
  /** P1-6：production fail-closed——advisory-lock 能力异常阻止 automatic replan（未创建 run）。 */
  blocked?: boolean;
  /** P1-6：fail-closed 原因（同 tryAcquireCrossInstanceGuard 抛错信息）。 */
  blockReason?: string;
}

/** 按 org 的风暴守卫状态（内存有界，无表）。 */
interface OrgReplanState {
  lastReplanAt: number;
  replanTimes: number[];
  suppressedCount: number;
}

/** 内存有界 LRU 上限（org 数）。 */
const MAX_ORG_STATES = 256;

/** 默认 Replan 风暴配置（与 DEFAULT_CONFIG.replan 对齐；缺省=现状）。 */
const FALLBACK_REPLAN: ReplanConfig = {
  replanDebounceMs: 5_000,
  minimumReplanIntervalMs: 30_000,
  maximumReplansPerWindow: 12,
  conflictAggregationWindowMs: 60_000,
  maxPropagationDepth: 3,
  maxAffectedTasks: 200,
  freezeWindowMinutes: 15,
  minimumObjectiveImprovement: 0.02,
};

/**
 * ReplanStabilityBudget（Task 5）：freeze window 对"计划开始时间已轻微过去"的宽容（ms）。
 * 防时钟偏差把本应在窗口外的任务误判进冻结集。
 */
const FREEZE_WINDOW_GRACE_MS = 5 * 60_000;

/**
 * 重排协调器：对一次触发做影响分析，并据此执行一次确定性的局部/全量重排。
 * 独立可运行的基础 partial-replan 能力。
 */
@Injectable()
export class ReplanCoordinatorService {
  private readonly logger = new Logger(ReplanCoordinatorService.name);
  private readonly impactAnalyzer = new ImpactAnalyzer();
  /**
   * Replan V2 风暴守卫（按 org 内存有界 LRU；无表）。
   * P0-5：内存态降级为缓存——advisory lock 可用时跨实例一致性由锁承载；
   * 锁不可用（fake db / 非 PG）时显式降级至此内存态（与现状完全一致）。
   */
  private readonly orgReplanStates = new Map<string, OrgReplanState>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly triggerService: TriggerService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly solverService: SolverService,
    @Inject(forwardRef(() => PlanService))
    private readonly planService: PlanService,
    private readonly policyService: SchedulingPolicyService,
    // T02 / P0-2：持久化人工约束唯一加载入口（可选注入；缺失时回退空约束，兼容旧单测）。
    private readonly constraintLoaderService?: ConstraintLoaderService,
    // M02：风暴守卫抑制计数上报（可选注入；缺失时仅内存计数，兼容旧单测）。
    private readonly metricsService?: SchedulerMetricsService,
    // M05-FIX：风暴守卫抑制 SSE 发射（可选注入；缺失时静默跳过，兼容旧单测）。
    private readonly outboxService?: OutboxService,
    // P1-6：跨实例守卫降级状态持有（health/readiness 上报；可选注入，兼容旧单测）。
    private readonly guardStatusService?: ReplanGuardStatusService,
  ) {}

  /** Replan V2 风暴守卫状态读取（供测试/审计）。 */
  getStormState(orgKey: string): OrgReplanState | undefined {
    return this.orgReplanStates.get(orgKey);
  }

  /** Replan V2 风暴守卫抑制总数（按 org，供 KPI/审计）。 */
  getSuppressedCount(orgKey: string): number {
    return this.orgReplanStates.get(orgKey)?.suppressedCount ?? 0;
  }

  /**
   * Replan V2（M02，08 §1/§3）：影响分析 V2——构建快照 → 构造 seed
   * ReplanImpact（直接命中集合）→ propagateImpact 闭包 → 返回 ReplanImpact。
   * 现有 impactAnalysis():ImpactAnalysis 保留（旧调用方不变）。
   */
  async analyzeImpactV2(
    triggerType: string,
    triggerIds: string[],
    ctx: OrgContext,
  ): Promise<ReplanImpact> {
    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    return this.analyzeImpactV2FromSnapshot(snapshot, triggerType, triggerIds);
  }

  /**
   * Replan V2：从既有快照做影响分析 V2（handleTrigger 复用同一快照，避免双构建）。
   */
  async analyzeImpactV2FromSnapshot(
    snapshot: WorldStateSnapshot,
    triggerType: string,
    triggerIds: string[],
  ): Promise<ReplanImpact> {
    const replan = await this.readReplanConfig();
    const seed = this.impactAnalyzer.buildSeed(triggerType, triggerIds, snapshot);
    return propagateImpact(snapshot, seed, {
      maxPropagationDepth: replan?.maxPropagationDepth,
      maxAffectedTasks: replan?.maxAffectedTasks,
    });
  }

  /**
   * P1-6（§六）：部署模式判定——production 下跨实例守卫异常 fail-closed
   * （阻止 automatic replan，不静默降级内存守卫）；其余（缺省/standalone/test）
   * 保持 memory fallback（既有单测与单实例 E2E 依赖）。
   */
  private isProductionDeploy(): boolean {
    return process.env.EWOH_DEPLOY_TARGET === 'production';
  }

  /** P1-6：记录一次守卫降级（metric + readiness 状态；失败仅记日志）。 */
  private recordGuardDegraded(reason: string): void {
    if (this.metricsService) {
      try {
        this.metricsService.recordReplanGuardDegraded();
      } catch (err) {
        this.logger.warn(
          `recordReplanGuardDegraded failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.guardStatusService) {
      try {
        this.guardStatusService.recordDegradation(reason);
      } catch (err) {
        this.logger.warn(
          `guard status record failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** P1-6：guard fail-closed 结果（production 下 advisory-lock 能力异常 → 阻止 automatic replan）。 */
  private failClosedResult(err: unknown): TriggerResult {
    const reason = err instanceof Error ? err.message : String(err);
    this.logger.error(`automatic replan blocked (guard fail-closed): ${reason}`);
    return {
      run: null,
      plans: [],
      debounced: false,
      suppressed: false,
      blocked: true,
      blockReason: reason,
    };
  }

  /**
   * P0-5（跨实例一致性）：跨实例守卫权获取。
   * NEST-124（2026-08-17）：本方法已并入 evaluateStormGuard——advisory lock
   * 与状态判定必须在**同一事务**内（此前锁在短事务内获取即提交释放，状态
   * 检查发生在锁窗口外，构成 TOCTOU）。保留此注释作为设计说明锚点：
   * pg_try_advisory_xact_lock 以 org 级稳定 key（hashtext('<orgId>:replan_guard')）
   * 在多 Pod 间串行化风暴守卫判定；锁不可用时的降级语义
   * （production fail-closed / 非 production 回退内存态）不变，见
   * evaluateStormGuard 的 catch 分支。
   */

  /**
   * Replan V2 风暴守卫（08 §7）：按 org 有界 LRU（P0-5：内存态为降级缓存）。
   * 距同 org 上次 replan < minimumReplanIntervalMs 且窗口内已达
   * maximumReplansPerWindow → 抑制（计数 + SSE replan.suppressed）。
   * 距上次 < replanDebounceMs → debounced（合并，不创建 run）。
   * P0-5：先获取跨实例守卫权（org 级 advisory xact lock）；未获得 → 另一实例正在
   * 处理该 org → 直接 suppressed；锁不可用 → 显式降级（见 catch）。
   * NEST-124 修复（2026-08-17）：advisory lock 与状态判定收进**同一事务**——
   * 此前锁在短事务内获取即提交释放，状态检查发生在锁窗口外（TOCTOU：实例 A
   * 判定通过→释放锁→实例 B 获取锁→其本地内存态判定也通过→双实例并发重排）。
   * 现在 runInTransaction 同时覆盖「取锁 + 读配置 + 内存态判定」，判定期间
   * 锁始终持有；判定返回后事务提交释放锁，窗口收窄到判定本身。
   */
  private async evaluateStormGuard(
    ctx: OrgContext,
  ): Promise<'allowed' | 'debounced' | 'suppressed'> {
    const orgKey = ctx.primaryOrgId || 'ALL';
    try {
      return await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(ctx),
        async () => {
          // 1) 跨实例守卫权（org 级 advisory xact lock；事务提交即释放）。
          const res = (await this.db.execute(
            sql`SELECT pg_try_advisory_xact_lock(hashtext(${orgKey + ':replan_guard'})) AS acquired`,
          )) as unknown;
          const row = Array.isArray(res)
            ? (res as Array<Record<string, unknown>>)[0]
            : (res as { rows?: Array<Record<string, unknown>> }).rows?.[0];
          if (row == null) {
            throw new Error('advisory lock result row missing (unexpected execute shape)');
          }
          if (row.acquired !== true) {
            return 'suppressed' as const;
          }
          // 2) 状态判定在锁事务内（NEST-124：不再在锁释放后判定）。
          // R2-SCH-009（2026-08-17，NEST-124 残留）：状态源改为 DB 权威——
          // 以 ewoh_scheduling_run 行（非 MANUAL 触发，org 隔离）派生
          // lastReplanAt 与窗口内计数，advisory lock 事务内读取即跨实例一致
          // （内存 LRU 仅作锁/DB 不可用时的降级缓存，见 catch 分支）。
          const now = Date.now();
          const replan = await this.readReplanConfig();
          const debounceMs = replan?.replanDebounceMs ?? FALLBACK_REPLAN.replanDebounceMs!;
          const minIntervalMs =
            replan?.minimumReplanIntervalMs ?? FALLBACK_REPLAN.minimumReplanIntervalMs!;
          const maxPerWindow =
            replan?.maximumReplansPerWindow ?? FALLBACK_REPLAN.maximumReplansPerWindow!;
          const windowMs =
            replan?.conflictAggregationWindowMs ?? FALLBACK_REPLAN.conflictAggregationWindowMs!;

          const recentRuns = await this.db
            .select({ createdAt: ewohSchedulingRun.createdAt })
            .from(ewohSchedulingRun)
            .where(
              and(
                eq(ewohSchedulingRun.orgId, orgKey),
                ne(ewohSchedulingRun.triggerType, 'MANUAL'),
              ),
            )
            .orderBy(desc(ewohSchedulingRun.createdAt))
            .limit(Math.max(maxPerWindow, 1) + 1);
          const runTimesMs = recentRuns
            .map((r) => (r.createdAt instanceof Date ? r.createdAt.getTime() : NaN))
            .filter((t) => Number.isFinite(t));
          const lastReplanAt = runTimesMs[0] ?? 0;
          const replanTimesInWindow = runTimesMs.filter(
            (t) => now - t < windowMs,
          ).length;

          if (now - lastReplanAt < debounceMs) {
            return 'debounced' as const;
          }
          if (
            now - lastReplanAt < minIntervalMs &&
            replanTimesInWindow >= maxPerWindow
          ) {
            return 'suppressed' as const;
          }
          return 'allowed' as const;
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // P1-6：无论部署模式都上报降级（metric + readiness 状态）。
      this.recordGuardDegraded(reason);
      if (this.isProductionDeploy()) {
        // 降级路径（production）：fail-closed——不静默降级为内存态，阻断 automatic replan。
        this.logger.error(
          `cross-instance replan guard unavailable in production; automatic replan blocked (fail-closed): ${reason}`,
        );
        throw new Error(
          `cross-instance replan guard unavailable in production (fail-closed): ${reason}`,
        );
      }
      // 降级路径（非 production）：无法执行原生 SQL / 无法解析结果 → 显式回退内存态守卫（与现状一致）。
      this.logger.warn(
        `cross-instance replan guard unavailable, falling back to in-memory state: ${reason}`,
      );
      // 内存态降级判定（无锁，与历史行为一致）。
      const now = Date.now();
      const replan = await this.readReplanConfig();
      const debounceMs = replan?.replanDebounceMs ?? FALLBACK_REPLAN.replanDebounceMs!;
      const minIntervalMs =
        replan?.minimumReplanIntervalMs ?? FALLBACK_REPLAN.minimumReplanIntervalMs!;
      const maxPerWindow =
        replan?.maximumReplansPerWindow ?? FALLBACK_REPLAN.maximumReplansPerWindow!;
      const windowMs =
        replan?.conflictAggregationWindowMs ?? FALLBACK_REPLAN.conflictAggregationWindowMs!;
      const state = this.touchOrgState(orgKey);
      state.replanTimes = state.replanTimes.filter((t) => now - t < windowMs);
      if (now - state.lastReplanAt < debounceMs) return 'debounced';
      if (
        now - state.lastReplanAt < minIntervalMs &&
        state.replanTimes.length >= maxPerWindow
      ) {
        return 'suppressed';
      }
      return 'allowed';
    }
  }

  /** 记录一次被抑制的触发（内存计数 + metrics + SSE replan.suppressed）。 */
  private async recordSuppressed(
    ctx: OrgContext,
    triggerType: string,
    triggerIds: string[],
    reason: string = 'storm_guard_suppressed',
  ): Promise<void> {
    const orgKey = ctx.primaryOrgId || 'ALL';
    const state = this.touchOrgState(orgKey);
    state.suppressedCount += 1;
    if (this.metricsService) {
      try {
        this.metricsService.recordReplanSuppressed();
      } catch (err) {
        this.logger.warn(`recordReplanSuppressed failed: ${(err as Error).message}`);
      }
    }
    // M05-FIX：SSE 发射 replan.suppressed（事件目录已登记 ReplanSuppressed）。
    if (this.outboxService) {
      try {
        await this.outboxService.enqueue(
          'replan.suppressed',
          (triggerIds[0] ?? triggerType ?? 'ALL'),
          {
            triggerType,
            triggerEntityId: triggerIds[0] ?? null,
            triggerIds,
            reason,
            suppressedAt: new Date().toISOString(),
            suppressedCount: state.suppressedCount,
          },
          orgKey,
          undefined,
          { entityType: 'replan', occurredAt: new Date().toISOString() },
        );
      } catch (err) {
        this.logger.warn(
          `replan.suppressed enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.warn(
      `replan suppressed for org ${orgKey} (${reason}): total=${state.suppressedCount}`,
    );
  }

  /**
   * M04：replan KPI 埋点（affectedAssignmentRatio / unchangedAssignmentRate）。
   * 数据源=影响闭包 + 快照；由 kpi.service 聚合进 SchedulerKpiSnapshot.stability。
   * 失败仅记日志，不影响主流程。
   */
  private recordReplanKpis(
    impact: ReplanImpact,
    snapshot: WorldStateSnapshot,
    ctx: OrgContext,
  ): void {
    if (!this.metricsService) return;
    try {
      const schedulable = snapshot.tasks.filter((t) =>
        ['draft', 'pending_confirm', 'pending_approval', 'pending_dispatch', 'pending', 'queued'].includes(
          t.status,
        ),
      ).length;
      const affectedRatio =
        schedulable > 0 ? (impact.affectedTaskIds?.length ?? 0) / schedulable : 0;
      this.metricsService.recordAffectedAssignmentRatio(affectedRatio);
      const baselineAssignments = snapshot.tasks.filter((t) => t.assigneeId).length;
      const unchangedRate =
        baselineAssignments > 0
          ? Math.max(0, 1 - (impact.movableAssignmentIds?.length ?? 0) / baselineAssignments)
          : 1;
      this.metricsService.recordUnchangedAssignmentRate(unchangedRate);
    } catch (err) {
      this.logger.warn(`recordReplanKpis failed: ${(err as Error).message}`);
    }
  }

  /** 触发成功/允许后登记本次 replan（更新 lastReplanAt + 窗口时间戳 + KPI 埋点）。 */
  private markReplanAllowed(ctx: OrgContext, triggerType?: string): void {
    const orgKey = ctx.primaryOrgId || 'ALL';
    const state = this.touchOrgState(orgKey);
    const now = Date.now();
    state.lastReplanAt = now;
    state.replanTimes.push(now);
    // M04：非 MANUAL 触发计入 replanTriggerCount KPI 数据源。
    if (triggerType && triggerType !== 'MANUAL' && this.metricsService) {
      try {
        this.metricsService.recordReplanTrigger();
      } catch (err) {
        this.logger.warn(`recordReplanTrigger failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 获取或创建 org 状态（有界缓存）。
   * NEST-040 修复（2026-08-17）：注释与实现一致化 + 真实 LRU 语义——命中时
   * 重插键（Map 迭代序=插入序，重插即"最近使用"），超上限淘汰最久未使用键
   * （旧实现只在新插入时淘汰队首= FIFO，且注释误称 LRU）。
   */
  private touchOrgState(orgKey: string): OrgReplanState {
    let state = this.orgReplanStates.get(orgKey);
    if (state) {
      // LRU：命中即刷新新鲜度（删除后重插到迭代序尾）。
      this.orgReplanStates.delete(orgKey);
      this.orgReplanStates.set(orgKey, state);
      return state;
    }
    state = { lastReplanAt: 0, replanTimes: [], suppressedCount: 0 };
    this.orgReplanStates.set(orgKey, state);
    while (this.orgReplanStates.size > MAX_ORG_STATES) {
      const lruKey = this.orgReplanStates.keys().next().value as string;
      this.orgReplanStates.delete(lruKey);
    }
    return state;
  }

  /** 读取 replan 配置（缺省回退）。 */
  private async readReplanConfig(): Promise<ReplanConfig> {
    try {
      const config = await this.policyService.getConfig();
      return config?.replan ?? {};
    } catch {
      return {};
    }
  }

  /**
   * NEST-167（2026-08-17）：求解视界（horizonMinutes）从策略配置读取
   * （SchedulingPolicyConfig.horizonMinutes，缺省 480 与旧硬编码一致）——
   * 不再散落魔数。
   */
  private async resolveHorizonMinutes(ctx?: OrgContext): Promise<number> {
    try {
      const config = await this.policyService.getConfig(
        ctx?.primaryOrgId || null,
      );
      const h = config?.horizonMinutes;
      if (typeof h === 'number' && h > 0) return h;
    } catch {
      // 配置不可用回退默认（与历史行为一致）
    }
    return 480;
  }

  /**
   * ReplanStabilityBudget（Task 5）：freeze window 收集。
   * 将计划开始时间落在 [now - FREEZE_WINDOW_GRACE_MS, now + freezeWindowMs] 的
   * 已分配任务并入冻结集（求解器不可移动），返回 windowFrozenTaskIds。
   * freezeWindowMs <= 0 视为禁用（显式配置 0 表示不启用冻结窗口）。
   * 必须在子图过滤前调用：frozenSet 的扩充使临期任务同样保留在子图中。
   */
  private collectWindowFrozenTaskIds(
    snapshot: WorldStateSnapshot,
    frozenSet: Set<string>,
    freezeWindowMs: number,
  ): Set<string> {
    const windowFrozenTaskIds = new Set<string>();
    if (freezeWindowMs <= 0) return windowFrozenTaskIds;
    const nowMs = Date.now();
    for (const t of snapshot.tasks) {
      if (t.assigneeId == null || t.planStart == null) continue;
      const planStartMs = new Date(t.planStart).getTime();
      if (!Number.isFinite(planStartMs)) continue;
      const msUntilStart = planStartMs - nowMs;
      if (msUntilStart > freezeWindowMs || msUntilStart < -FREEZE_WINDOW_GRACE_MS) continue;
      windowFrozenTaskIds.add(t.id);
      frozenSet.add(t.id);
    }
    return windowFrozenTaskIds;
  }

  /**
   * ReplanStabilityBudget（Task 5）：freeze window 锁追加。
   * 将 windowFrozenTaskIds 的当前分配以 LOCKED_ASSIGNMENT 语义追加进
   * partialSnapshot.lockedAssignments（taskId 已存在的则不覆盖），求解器据此视为不可移动。
   */
  private appendFreezeWindowLocks(
    snapshot: WorldStateSnapshot,
    lockedAssignments: WorldStateSnapshot['lockedAssignments'],
    windowFrozenTaskIds: Set<string>,
  ): WorldStateSnapshot['lockedAssignments'] {
    if (windowFrozenTaskIds.size === 0) return lockedAssignments;
    const taskById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const lockedByTask = new Set(lockedAssignments.map((la) => la.taskId));
    for (const id of windowFrozenTaskIds) {
      if (lockedByTask.has(id)) continue;
      const t = taskById.get(id);
      if (!t || t.assigneeId == null) continue;
      lockedAssignments.push({
        taskId: id,
        personId: t.assigneeId,
        deviceId: t.deviceId,
        stationId: t.stationId,
      });
      lockedByTask.add(id);
    }
    return lockedAssignments;
  }

  /** 读取本租户最近一次正式方案的目标总值（scoreBreakdownJson.total；jsonb，无则 null）。 */
  private async loadLatestPlanObjective(ctx: OrgContext): Promise<number | null> {
    try {
      // ADR-071（NO-13v）：基线按 org 作用域（org 匹配或 NULL 存量行）——
      // 此前全局 createdAt 倒序会把他租户方案目标值当成本租户基线（跨租户事实污染）。
      const [latestPlan] = await this.db
        .select()
        .from(ewohSchedulePlan)
        .where(or(isNull(ewohSchedulePlan.orgId), eq(ewohSchedulePlan.orgId, ctx.primaryOrgId)))
        .orderBy(desc(ewohSchedulePlan.createdAt))
        .limit(1);
      const breakdown = (latestPlan?.scoreBreakdownJson ?? null) as { total?: number } | null;
      const total = breakdown?.total;
      return typeof total === 'number' && Number.isFinite(total) ? total : null;
    } catch (err) {
      // 旧单测 db mock 无 select、表不可达等情况：跳过门禁（保持现状，不抑制）。
      this.logger.debug(
        `loadLatestPlanObjective unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * ReplanStabilityBudget（Task 5）：minimumObjectiveImprovement 抑制门。
   * 非 critical 触发、且影响集无 safetyCritical 任务、且候选方案无冲突/硬约束待修复、
   * 且候选目标改进率低于阈值（缺省 2%）→ 返回 true（应抑制）。
   * 基线或候选目标缺失/基线 ≤ 0 → 返回 false（不抑制，保持现状）。
   */
  private async shouldSuppressForLowImprovement(
    best: SchedulingPlanV2,
    impact: ReplanImpact,
    snapshot: WorldStateSnapshot,
    triggerType: string,
    replan: ReplanConfig,
    ctx: OrgContext,
  ): Promise<boolean> {
    // 1) critical 触发（安全/资源禁用类）不做目标门槛——必须重排。
    const criticalTrigger =
      triggerType === 'SAFETY_EVENT' ||
      triggerType === 'ZONE_RESTRICTED' ||
      triggerType === 'PERSON_UNAVAILABLE' ||
      triggerType === 'DEVICE_OFFLINE';
    if (criticalTrigger) return false;
    // 2) 影响集含 safetyCritical 任务，或候选方案仍有冲突/硬约束待修复 → 必须落盘。
    const hasSafetyCriticalInImpact = impact.affectedTaskIds.some((id) =>
      snapshot.tasks.some((t) => t.id === id && t.safetyCritical === true),
    );
    const hasViolations = (best.violations?.length ?? 0) > 0;
    const hasFailedAssignments = best.assignments.some((a) =>
      ['failed', 'blocked', 'cancelled'].includes(a.status),
    );
    if (hasSafetyCriticalInImpact || hasViolations || hasFailedAssignments) return false;

    const minImprovement =
      replan.minimumObjectiveImprovement ?? FALLBACK_REPLAN.minimumObjectiveImprovement!;
    if (minImprovement <= 0) return false;
    const candidateTotal = best.scoreBreakdown?.total;
    const baselineTotal = await this.loadLatestPlanObjective(ctx);
    if (
      baselineTotal == null ||
      candidateTotal == null ||
      !Number.isFinite(baselineTotal) ||
      !Number.isFinite(candidateTotal) ||
      baselineTotal <= 0
    ) {
      return false;
    }
    return (baselineTotal - candidateTotal) / baselineTotal < minImprovement;
  }

  /**
   * 处理一次重排触发：求值（去重/去抖）→ 构建快照 → 影响分析 → 局部重排 → 持久化 → 更新运行状态。
   * 局部重排：仅把受影响任务 + 冻结任务交给求解器，无关任务不进入子图（不 churn），
   * 并传递 baselineAssignee 作为 churn/stability 罚项基线。
   * Replan V2（M02）：风暴守卫在 triggerService 求值前执行（抑制不创建 run）；
   * 影响分析升级为 analyzeImpactV2（propagateImpact 闭包，语义=现状超集）。
   */
  async handleTrigger(
    triggerType: string,
    entityId: string | null,
    ctx: OrgContext,
    /**
     * R2-SCH-013（2026-08-17）：聚合触发的完整实体列表（如一批 blocked route
     * edges）。缺省 [entityId]（既有单实体语义不变）；影响分析 seed 用完整列表
     * 反查受影响任务并集，entityId 仅作为 run 的展示/去重键。
     */
    triggerIds?: string[],
  ): Promise<TriggerResult> {
    // Replan V2 风暴守卫（08 §7）：抑制/去抖先于 triggerService 求值。
    if (triggerType !== 'MANUAL') {
      let guard: 'allowed' | 'debounced' | 'suppressed';
      try {
        guard = await this.evaluateStormGuard(ctx);
      } catch (err) {
        // P1-6 production fail-closed：advisory-lock 能力异常 → 阻止 automatic replan（不创建 run）。
        return this.failClosedResult(err);
      }
      if (guard === 'suppressed') {
        await this.recordSuppressed(ctx, triggerType, entityId ? [entityId] : []);
        return { run: null, plans: [], debounced: false, suppressed: true };
      }
      if (guard === 'debounced') {
        return { run: null, plans: [], debounced: true, suppressed: false };
      }
    }

    const run = await this.triggerService.evaluate(triggerType, entityId, ctx);
    if (!run) {
      return { run: null, plans: [], debounced: true, suppressed: false };
    }

    try {
      // 重排必须基于最新世界状态：always 在此刻重新构建快照，
      // 绝不复用旧 plan/snapshot 的 snapshotVersion。新方案绑定 snapshot.snapshotVersion。
      const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
      // R2-SCH-013：显式 triggerIds 优先（聚合触发）；缺省回退 [entityId]。
      const impact = await this.analyzeImpactV2FromSnapshot(
        snapshot,
        triggerType,
        triggerIds && triggerIds.length > 0
          ? triggerIds
          : entityId
            ? [entityId]
            : [],
      );
      this.logger.debug(
        `replan impact v2: affected=${impact.affectedTaskIds.length}, frozen=${impact.frozenAssignmentIds.length}, movable=${impact.movableAssignmentIds.length}`,
      );

      // 局部重排子图 = 受影响任务 ∪ 冻结任务；无关任务不进入求解输入 → 天然不 churn。
      // ReplanStabilityBudget（Task 5）：freeze window 先于子图过滤——
      // 计划开始时间落在 [now-宽容, now+freezeWindowMinutes] 的已分配任务并入冻结集，
      // 使临执行前的近期 assignment 保留在子图中且以 LOCKED_ASSIGNMENT 语义不可移动。
      const affectedSet = new Set(impact.affectedTaskIds);
      const frozenSet = new Set(impact.frozenAssignmentIds);
      const replan = await this.readReplanConfig();
      const windowFrozenTaskIds = this.collectWindowFrozenTaskIds(
        snapshot,
        frozenSet,
        (replan.freezeWindowMinutes ?? FALLBACK_REPLAN.freezeWindowMinutes!) * 60_000,
      );
      const partialSnapshot: WorldStateSnapshot = {
        ...snapshot,
        tasks: snapshot.tasks.filter(
          (t) => affectedSet.has(t.id) || frozenSet.has(t.id),
        ),
        lockedAssignments: this.appendFreezeWindowLocks(
          snapshot,
          [...snapshot.lockedAssignments],
          windowFrozenTaskIds,
        ),
      };

      // baselineAssignee：当前分配作为 churn/stability 罚项基线，避免已排任务被无谓移动。
      const baselineAssignee = new Map<string, string | null>();
      for (const t of snapshot.tasks) {
        if (t.assigneeId) {
          if (baselineAssignee.has(t.id)) continue;
          baselineAssignee.set(t.id, t.assigneeId);
        }
      }
      for (const la of snapshot.lockedAssignments) {
        baselineAssignee.set(la.taskId, la.personId);
      }

      // 执行中/已锁定分配由 snapshot.lockedAssignments 承载，
      // 求解器据此将 executing/dispatched/in_progress 任务冻结为不可移动项。
      // P0-2（G2）：事件驱动/局部重排同样加载全局 active 约束（LOCK/EXCLUDE 不丢）。
      const constraints = this.constraintLoaderService
        ? await this.constraintLoaderService.loadGlobalActive(ctx)
        : [];
      const plans = await this.solverService.solveVariants(partialSnapshot, constraints, {
        planId: run.runId,
        triggerType,
        triggerEntityId: run.triggerEntityId,
        snapshotVersion: snapshot.snapshotVersion,
        // NEST-167：视界从策略配置读取（缺省 480）。
        horizonMinutes: await this.resolveHorizonMinutes(ctx),
        baselineAssignee,
        // Task B / P0：局部重排真实影响集（scheduler_partial_replan_affected 取真实受影响数，
        // 不随 partial snapshot 的 frozen 任务数膨胀）。
        affectedTaskIds: impact.affectedTaskIds,
      });

      // ReplanStabilityBudget（Task 5）：minimumObjectiveImprovement 抑制门——
      // 非 critical 且无冲突/硬约束待修复、候选目标改进低于阈值时，不落盘并 emit
      // replan.suppressed（reason=minimum_objective_improvement）；run 闭合为 succeeded（planIds=[]）。
      const best = plans[0];
      if (
        best &&
        (await this.shouldSuppressForLowImprovement(
          best,
          impact,
          snapshot,
          triggerType,
          replan,
          ctx,
        ))
      ) {
        await this.requestDatabaseContext.runInTransaction(
          buildGucSettings(ctx),
          async () => {
            await this.db
              .update(ewohSchedulingRun)
              .set({
                status: 'succeeded',
                snapshotVersion: snapshot.snapshotVersion,
                planIds: [],
              })
              .where(and(eq(ewohSchedulingRun.runId, run.runId), eq(ewohSchedulingRun.orgId, ctx.primaryOrgId)));
          },
        );
        await this.recordSuppressed(
          ctx,
          triggerType,
          entityId ? [entityId] : [],
          'minimum_objective_improvement',
        );
        this.logger.debug(
          `replan suppressed (minimum_objective_improvement): trigger=${triggerType}, candidate objective 改进率低于阈值`,
        );
        // NEST-130 修复（2026-08-17）：run 已闭合为 succeeded（planIds=[]），
        // 返回真实状态视图（此前返回 run:null 与 DB 状态矛盾，调用方无法追溯
        // 抑制对应的 run）。suppressed=true 仍标识抑制语义。
        return {
          run: {
            ...run,
            status: 'succeeded' as const,
            snapshotVersion: snapshot.snapshotVersion,
            planIds: [],
          },
          plans: [],
          debounced: false,
          suppressed: true,
        };
      }

      // NEST-125 修复（2026-08-17）：persistPlan 循环 + 决策台账 + run 状态更新
      // 包进**单个事务**——此前逐方案独立事务，plan 2 失败时 plan 1 已落库
      // （半持久化，run 可能永远 queued/脏状态）。RequestDatabaseContext 嵌套
      // 复用同一事务（persistPlan 内部 runInTransaction 加入外层事务）。
      await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(ctx),
        async () => {
          for (const plan of plans) {
            await this.planService.persistPlan(plan, ctx);
          }

          // NO-13m / ADR-062：replan 决策追加进新方案决策台账（§12 Decision
          // History；投影缺口/追加失败 log 显式绝不阻断重排主流程，§2/§33）。
          try {
            for (const plan of plans) {
              const projected = projectReplanDecision({
                planId: plan.planId,
                runId: run.runId,
                triggerType,
                triggerEntityId: run.triggerEntityId ?? null,
                affectedCount: impact.affectedTaskIds.length,
                orgId: ctx.primaryOrgId ?? '',
                now: new Date(),
              });
              if (projected.record) {
                await appendPlanDecisionRecords(
                  this.db,
                  plan.planId,
                  [projected.record],
                  ctx.primaryOrgId || null,
                );
              } else {
                this.logger.warn(
                  `replan 决策投影缺口 ${plan.planId}（显式跳过，§33）：${projected.issues.join(',')}`,
                );
              }
            }
          } catch (err) {
            this.logger.warn(
              `replan 决策台账追加失败（不阻断重排主流程）：${err instanceof Error ? err.message : String(err)}`,
            );
          }

          await this.db
            .update(ewohSchedulingRun)
            .set({
              status: 'succeeded',
              snapshotVersion: snapshot.snapshotVersion,
              planIds: plans.map((p) => p.planId),
            })
            .where(and(eq(ewohSchedulingRun.runId, run.runId), eq(ewohSchedulingRun.orgId, ctx.primaryOrgId)));
        },
      );

      // Replan V2：登记本次 replan（风暴守卫窗口 + KPI 埋点）。
      this.markReplanAllowed(ctx, triggerType);
      this.recordReplanKpis(impact, snapshot, ctx);

      return { run, plans, debounced: false, suppressed: false };
    } catch (e) {
      // v0.7 A2 熔断：触发链路任一步失败，将已登记的 run 置为 failed（而非永远卡 queued），
      // 记录失败原因到 failure_reason 列供审计（P1-T2，替代仅日志）；不向上抛导致调用链断裂。
      const message = (e as Error).message ?? String(e);
      this.logger.error(
        `handleTrigger(${triggerType}, ${entityId ?? '-'}) failed: ${message}`,
      );
      try {
        await this.requestDatabaseContext.runInTransaction(
          buildGucSettings(ctx),
          async () => {
            await this.db
              .update(ewohSchedulingRun)
              .set({ status: 'failed', failureReason: message })
              .where(and(eq(ewohSchedulingRun.runId, run.runId), eq(ewohSchedulingRun.orgId, ctx.primaryOrgId)));
          },
        );
      } catch (inner) {
        this.logger.error(`failed to mark run ${run.runId} as failed: ${(inner as Error).message}`);
      }
      return { run: null, plans: [], debounced: false, suppressed: false };
    }
  }

  /**
   * Replan V2（M02，08 §7）：conflict batch 触发——将 open conflicts 聚合为一个
   * ReplanImpact seed（triggerType=RESERVATION_CONFLICT，triggerIds=冲突资源并集，
   * 受影响任务并集），一次 solveVariants 处理一批。供 dispatchStateTriggers 消费。
   * 保留 ROUTE_BLOCKED/CONGESTED 逐边语义（不聚合 route edge）。
   */
  async handleConflictBatch(
    triggerIds: string[],
    affectedTaskIds: string[],
    ctx: OrgContext,
  ): Promise<TriggerResult> {
    if (triggerIds.length === 0) {
      return { run: null, plans: [], debounced: true, suppressed: false };
    }
    let guard: 'allowed' | 'debounced' | 'suppressed';
    try {
      guard = await this.evaluateStormGuard(ctx);
    } catch (err) {
      // P1-6 production fail-closed：advisory-lock 能力异常 → 阻止 automatic replan（不创建 run）。
      return this.failClosedResult(err);
    }
    if (guard === 'suppressed') {
      await this.recordSuppressed(ctx, 'RESERVATION_CONFLICT', triggerIds);
      return { run: null, plans: [], debounced: false, suppressed: true };
    }
    if (guard === 'debounced') {
      return { run: null, plans: [], debounced: true, suppressed: false };
    }

    // 聚合 seed：triggerType=RESERVATION_CONFLICT；entityId=资源并集（逗号连接，兼容 evaluate key）。
    const entityId = triggerIds.join(',');
    const run = await this.triggerService.evaluate(
      'RESERVATION_CONFLICT',
      entityId,
      ctx,
    );
    if (!run) {
      return { run: null, plans: [], debounced: true, suppressed: false };
    }

    try {
      const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
      const seed = this.impactAnalyzer.buildSeed(
        'RESERVATION_CONFLICT',
        triggerIds,
        snapshot,
      );
      seed.affectedTaskIds = [...new Set([...(seed.affectedTaskIds ?? []), ...affectedTaskIds])];
      const replan = await this.readReplanConfig();
      const impact = propagateImpact(snapshot, seed, {
        maxPropagationDepth: replan?.maxPropagationDepth,
        maxAffectedTasks: replan?.maxAffectedTasks,
      });

      const affectedSet = new Set(impact.affectedTaskIds);
      const frozenSet = new Set(impact.frozenAssignmentIds);
      // ReplanStabilityBudget（Task 5）：freeze window 同样适用于 conflict batch——
      // 临执行前（planStart ∈ [now-宽容, now+freezeWindowMinutes]）的已分配任务并入冻结集。
      const windowFrozenTaskIds = this.collectWindowFrozenTaskIds(
        snapshot,
        frozenSet,
        (replan.freezeWindowMinutes ?? FALLBACK_REPLAN.freezeWindowMinutes!) * 60_000,
      );
      const partialSnapshot: WorldStateSnapshot = {
        ...snapshot,
        tasks: snapshot.tasks.filter(
          (t) => affectedSet.has(t.id) || frozenSet.has(t.id),
        ),
        lockedAssignments: this.appendFreezeWindowLocks(
          snapshot,
          [...snapshot.lockedAssignments],
          windowFrozenTaskIds,
        ),
      };

      const baselineAssignee = new Map<string, string | null>();
      for (const t of snapshot.tasks) {
        if (t.assigneeId) {
          if (baselineAssignee.has(t.id)) continue;
          baselineAssignee.set(t.id, t.assigneeId);
        }
      }
      for (const la of snapshot.lockedAssignments) {
        baselineAssignee.set(la.taskId, la.personId);
      }

      const constraints = this.constraintLoaderService
        ? await this.constraintLoaderService.loadGlobalActive(ctx)
        : [];
      const plans = await this.solverService.solveVariants(partialSnapshot, constraints, {
        planId: run.runId,
        triggerType: 'RESERVATION_CONFLICT',
        triggerEntityId: entityId,
        snapshotVersion: snapshot.snapshotVersion,
        // NEST-167：视界从策略配置读取（缺省 480）。
        horizonMinutes: await this.resolveHorizonMinutes(ctx),
        baselineAssignee,
      });

      // NEST-125（2026-08-17）：同 handleTrigger——persist 循环 + 决策台账 +
      // run 状态更新单事务（消除半持久化窗口）。
      await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(ctx),
        async () => {
          for (const plan of plans) {
            await this.planService.persistPlan(plan, ctx);
          }

          // NO-13m / ADR-062：replan 决策追加进新方案决策台账（§12 Decision
          // History；投影缺口/追加失败 log 显式绝不阻断重排主流程，§2/§33）。
          try {
            for (const plan of plans) {
              const projected = projectReplanDecision({
                planId: plan.planId,
                runId: run.runId,
                triggerType: 'RESERVATION_CONFLICT',
                triggerEntityId: run.triggerEntityId ?? null,
                affectedCount: impact.affectedTaskIds.length,
                orgId: ctx.primaryOrgId ?? '',
                now: new Date(),
              });
              if (projected.record) {
                await appendPlanDecisionRecords(
                  this.db,
                  plan.planId,
                  [projected.record],
                  ctx.primaryOrgId || null,
                );
              } else {
                this.logger.warn(
                  `replan 决策投影缺口 ${plan.planId}（显式跳过，§33）：${projected.issues.join(',')}`,
                );
              }
            }
          } catch (err) {
            this.logger.warn(
              `replan 决策台账追加失败（不阻断重排主流程）：${err instanceof Error ? err.message : String(err)}`,
            );
          }

          await this.db
            .update(ewohSchedulingRun)
            .set({
              status: 'succeeded',
              snapshotVersion: snapshot.snapshotVersion,
              planIds: plans.map((p) => p.planId),
            })
            .where(and(eq(ewohSchedulingRun.runId, run.runId), eq(ewohSchedulingRun.orgId, ctx.primaryOrgId)));
        },
      );

      this.markReplanAllowed(ctx, 'RESERVATION_CONFLICT');
      this.recordReplanKpis(impact, snapshot, ctx);
      return { run, plans, debounced: false, suppressed: false };
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      this.logger.error(`handleConflictBatch failed: ${message}`);
      try {
        await this.requestDatabaseContext.runInTransaction(
          buildGucSettings(ctx),
          async () => {
            await this.db
              .update(ewohSchedulingRun)
              .set({ status: 'failed', failureReason: message })
              .where(and(eq(ewohSchedulingRun.runId, run.runId), eq(ewohSchedulingRun.orgId, ctx.primaryOrgId)));
          },
        );
      } catch (inner) {
        this.logger.error(`failed to mark run ${run.runId} as failed: ${(inner as Error).message}`);
      }
      return { run: null, plans: [], debounced: false, suppressed: false };
    }
  }

  /**
   * 影响分析：识别受影响（需重排）与冻结（保持不动）的任务。
   * 委托给 ImpactAnalyzer（统一异常分类），并保持既有返回形状以兼容调用方。
   */
  async impactAnalysis(
    snapshot: WorldStateSnapshot,
    triggerType: string,
    entityId: string | null,
  ): Promise<ImpactAnalysis> {
    const result = this.impactAnalyzer.analyze(snapshot, {
      eventType: triggerType,
      entityId,
    });
    return {
      affectedTaskIds: result.affectedTaskIds,
      frozenTaskIds: result.frozenTaskIds,
      reason: result.reason,
    };
  }

  /**
   * 将世界状态中的路由阻断/拥塞与资源预占冲突转译为重排触发输入。
   * Replan V2（M02）：保留 ROUTE_BLOCKED/CONGESTED 逐边语义；资源预占冲突在
   * conflictAggregationWindowMs 内聚合为一个 ReplanImpact seed（一次求解处理一批），
   * 替换逐冲突 handleTrigger 循环。返回实际派发并创建运行的触发列表。
   */
  async dispatchStateTriggers(
    snapshot: WorldStateSnapshot,
    ctx: OrgContext,
  ): Promise<Array<{ triggerType: string; entityId: string }>> {
    const dispatched: Array<{ triggerType: string; entityId: string }> = [];

    // 1) 路由阻断 / 拥塞。
    // R2-SCH-013（2026-08-17）：同状态边聚合为一次触发（此前逐边独立
    // handleTrigger——每边一次全量快照+求解，多边场景全量重排反复执行）。
    // entityId=边列表逗号连接（展示/去重键）；triggerIds=完整边列表供影响
    // 分析 seed 反查受影响任务并集。单边场景 entityId 即边 id（与旧语义一致）。
    const blockedEdgeIds = snapshot.routeStatus
      .filter((r) => r.status === 'blocked')
      .map((r) => r.edgeId);
    if (blockedEdgeIds.length > 0) {
      const entityId = blockedEdgeIds.join(',');
      const run = await this.handleTrigger('ROUTE_BLOCKED', entityId, ctx, blockedEdgeIds);
      if (run.run) {
        dispatched.push({ triggerType: 'ROUTE_BLOCKED', entityId });
      }
    }
    const congestedEdgeIds = snapshot.routeStatus
      .filter((r) => r.status === 'congested')
      .map((r) => r.edgeId);
    if (congestedEdgeIds.length > 0) {
      const entityId = congestedEdgeIds.join(',');
      const run = await this.handleTrigger('ROUTE_CONGESTED', entityId, ctx, congestedEdgeIds);
      if (run.run) {
        dispatched.push({ triggerType: 'ROUTE_CONGESTED', entityId });
      }
    }

    // 2) 资源预占冲突 → conflict batch（Replan V2 / 08 §7）。
    //    在 conflictAggregationWindowMs 内聚合 open conflicts 为一个 seed：
    //    triggerIds=冲突资源并集，受影响任务并集；一次 solveVariants 处理一批。
    const conflictBatch = this.aggregateReservationConflicts(snapshot);
    if (conflictBatch.triggerIds.length > 0) {
      const run = await this.handleConflictBatch(
        conflictBatch.triggerIds,
        conflictBatch.affectedTaskIds,
        ctx,
      );
      if (run.run) {
        dispatched.push({
          triggerType: 'RESERVATION_CONFLICT',
          entityId: conflictBatch.triggerIds.join(','),
        });
      }
    }

    return dispatched;
  }

  /** NEST-041：倒排索引追加（resourceId → taskIds）。 */
  private appendToIndex(
    idx: Map<string, string[]>,
    key: string,
    taskId: string,
  ): void {
    const list = idx.get(key);
    if (list) list.push(taskId);
    else idx.set(key, [taskId]);
  }

  /**
   * Replan V2：将快照内 open conflicts（同资源时间窗重叠预占）聚合为 batch。
   * 同资源冲突归并为一个 triggerId；受影响任务并集（设备/人员维度）。
   * 纯计算，只读，不改生命周期写路径。
   * NEST-041 修复（2026-08-17）：全对 O(n²) 扫描 → 按 (resourceType, resourceId)
   * 分组后组内按 startMs 排序扫描（排序后 j 一旦不重叠即可 break，
   * O(n log n + k)）；任务命中改为一次倒排索引（旧实现逐资源 × 全任务双循环）。
   */
  private aggregateReservationConflicts(snapshot: WorldStateSnapshot): {
    triggerIds: string[];
    affectedTaskIds: string[];
  } {
    const reserved = snapshot.reservations ?? [];
    // 1) 分组：同资源预占归并到同一列表。
    const byResource = new Map<string, typeof reserved>();
    for (const r of reserved) {
      const key = `${r.resourceType}:${r.resourceId}`;
      const list = byResource.get(key);
      if (list) list.push(r);
      else byResource.set(key, [r]);
    }
    // 2) 组内重叠检测（排序 + 提前 break）。
    const conflictedResourceIds = new Set<string>();
    for (const [key, list] of byResource) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((x, y) => x.startMs - y.startMs);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          if (sorted[j].startMs >= sorted[i].endMs) break;
          conflictedResourceIds.add(key);
          break; // 该资源已确认冲突，无需继续组内扫描
        }
      }
    }
    // 3) 受影响任务：一次倒排索引（resourceId → tasks，含类型维度判定）。
    const tasksByPerson = new Map<string, string[]>();
    const tasksByDevice = new Map<string, string[]>();
    const tasksByStation = new Map<string, string[]>();
    for (const t of snapshot.tasks) {
      if (t.assigneeId) this.appendToIndex(tasksByPerson, t.assigneeId, t.id);
      if (t.deviceId) this.appendToIndex(tasksByDevice, t.deviceId, t.id);
      if (t.stationId) this.appendToIndex(tasksByStation, t.stationId, t.id);
    }
    const affectedTaskIds = new Set<string>();
    const triggerIds: string[] = [];
    for (const key of conflictedResourceIds) {
      const [resourceType, resourceId] = key.split(':');
      triggerIds.push(resourceId);
      const idx =
        resourceType === 'person'
          ? tasksByPerson
          : resourceType === 'device'
            ? tasksByDevice
            : tasksByStation;
      for (const taskId of idx.get(resourceId) ?? []) {
        affectedTaskIds.add(taskId);
      }
    }
    return {
      triggerIds: Array.from(new Set(triggerIds)).sort(),
      affectedTaskIds: Array.from(affectedTaskIds).sort(),
    };
  }
}