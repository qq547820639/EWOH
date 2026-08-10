import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { ewohSchedulingRun } from '@server/database/schema';
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
import { propagateImpact } from './impact-propagation';

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
};

/**
 * 重排协调器：对一次触发做影响分析，并据此执行一次确定性的局部/全量重排。
 * 独立可运行的基础 partial-replan 能力。
 */
@Injectable()
export class ReplanCoordinatorService {
  private readonly logger = new Logger(ReplanCoordinatorService.name);
  private readonly impactAnalyzer = new ImpactAnalyzer();
  /** Replan V2 风暴守卫（按 org 内存有界 LRU；无表）。 */
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
   * Replan V2 风暴守卫（08 §7）：按 org 有界 LRU。
   * 距同 org 上次 replan < minimumReplanIntervalMs 且窗口内已达
   * maximumReplansPerWindow → 抑制（计数 + SSE replan.suppressed）。
   * 距上次 < replanDebounceMs → debounced（合并，不创建 run）。
   */
  private async evaluateStormGuard(
    ctx: OrgContext,
  ): Promise<'allowed' | 'debounced' | 'suppressed'> {
    const orgKey = ctx.primaryOrgId || 'ALL';
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
    // 清理窗口外时间戳（conflictAggregationWindowMs）。
    state.replanTimes = state.replanTimes.filter(
      (t) => now - t < windowMs,
    );

    if (now - state.lastReplanAt < debounceMs) {
      return 'debounced';
    }
    if (
      now - state.lastReplanAt < minIntervalMs &&
      state.replanTimes.length >= maxPerWindow
    ) {
      return 'suppressed';
    }
    return 'allowed';
  }

  /** 记录一次被抑制的触发（内存计数 + metrics + SSE）。 */
  private async recordSuppressed(ctx: OrgContext): Promise<void> {
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
    this.logger.warn(
      `replan suppressed for org ${orgKey} (storm guard): total=${state.suppressedCount}`,
    );
  }

  /** 触发成功/允许后登记本次 replan（更新 lastReplanAt + 窗口时间戳）。 */
  private markReplanAllowed(ctx: OrgContext): void {
    const orgKey = ctx.primaryOrgId || 'ALL';
    const state = this.touchOrgState(orgKey);
    const now = Date.now();
    state.lastReplanAt = now;
    state.replanTimes.push(now);
  }

  /** 获取或创建 org 状态（有界 LRU：超出上限时淘汰最旧）。 */
  private touchOrgState(orgKey: string): OrgReplanState {
    let state = this.orgReplanStates.get(orgKey);
    if (!state) {
      state = { lastReplanAt: 0, replanTimes: [], suppressedCount: 0 };
      this.orgReplanStates.set(orgKey, state);
      if (this.orgReplanStates.size > MAX_ORG_STATES) {
        const oldestKey = this.orgReplanStates.keys().next().value as string;
        this.orgReplanStates.delete(oldestKey);
      }
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
  ): Promise<TriggerResult> {
    // Replan V2 风暴守卫（08 §7）：抑制/去抖先于 triggerService 求值。
    if (triggerType !== 'MANUAL') {
      const guard = await this.evaluateStormGuard(ctx);
      if (guard === 'suppressed') {
        await this.recordSuppressed(ctx);
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
      const impact = await this.analyzeImpactV2FromSnapshot(
        snapshot,
        triggerType,
        entityId ? [entityId] : [],
      );
      this.logger.debug(
        `replan impact v2: affected=${impact.affectedTaskIds.length}, frozen=${impact.frozenAssignmentIds.length}, movable=${impact.movableAssignmentIds.length}`,
      );

      // 局部重排子图 = 受影响任务 ∪ 冻结任务；无关任务不进入求解输入 → 天然不 churn。
      const affectedSet = new Set(impact.affectedTaskIds);
      const frozenSet = new Set(impact.frozenAssignmentIds);
      const partialSnapshot: WorldStateSnapshot = {
        ...snapshot,
        tasks: snapshot.tasks.filter(
          (t) => affectedSet.has(t.id) || frozenSet.has(t.id),
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
        horizonMinutes: 480,
        baselineAssignee,
      });

      for (const plan of plans) {
        await this.planService.persistPlan(plan, ctx);
      }

      await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(ctx),
        async () => {
          await this.db
            .update(ewohSchedulingRun)
            .set({
              status: 'succeeded',
              snapshotVersion: snapshot.snapshotVersion,
              planIds: plans.map((p) => p.planId),
            })
            .where(eq(ewohSchedulingRun.runId, run.runId));
        },
      );

      // Replan V2：登记本次 replan（风暴守卫窗口）。
      this.markReplanAllowed(ctx);

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
              .where(eq(ewohSchedulingRun.runId, run.runId));
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
    const guard = await this.evaluateStormGuard(ctx);
    if (guard === 'suppressed') {
      await this.recordSuppressed(ctx);
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
      const partialSnapshot: WorldStateSnapshot = {
        ...snapshot,
        tasks: snapshot.tasks.filter(
          (t) => affectedSet.has(t.id) || frozenSet.has(t.id),
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
        horizonMinutes: 480,
        baselineAssignee,
      });

      for (const plan of plans) {
        await this.planService.persistPlan(plan, ctx);
      }

      await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(ctx),
        async () => {
          await this.db
            .update(ewohSchedulingRun)
            .set({
              status: 'succeeded',
              snapshotVersion: snapshot.snapshotVersion,
              planIds: plans.map((p) => p.planId),
            })
            .where(eq(ewohSchedulingRun.runId, run.runId));
        },
      );

      this.markReplanAllowed(ctx);
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
              .where(eq(ewohSchedulingRun.runId, run.runId));
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

    // 1) 路由阻断 / 拥塞（逐边语义保留）。
    for (const r of snapshot.routeStatus) {
      if (r.status === 'blocked') {
        const run = await this.handleTrigger('ROUTE_BLOCKED', r.edgeId, ctx);
        if (run.run) {
          dispatched.push({ triggerType: 'ROUTE_BLOCKED', entityId: r.edgeId });
        }
      } else if (r.status === 'congested') {
        const run = await this.handleTrigger('ROUTE_CONGESTED', r.edgeId, ctx);
        if (run.run) {
          dispatched.push({ triggerType: 'ROUTE_CONGESTED', entityId: r.edgeId });
        }
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

  /**
   * Replan V2：将快照内 open conflicts（同资源时间窗重叠预占）聚合为 batch。
   * 同资源冲突归并为一个 triggerId；受影响任务并集（设备/人员维度）。
   * 纯计算，只读，不改生命周期写路径。
   */
  private aggregateReservationConflicts(snapshot: WorldStateSnapshot): {
    triggerIds: string[];
    affectedTaskIds: string[];
  } {
    const reserved = snapshot.reservations ?? [];
    const resourceByType = new Map<string, Set<string>>();
    const affectedTaskIds = new Set<string>();
    for (let i = 0; i < reserved.length; i++) {
      for (let j = i + 1; j < reserved.length; j++) {
        const a = reserved[i];
        const b = reserved[j];
        const sameResource =
          a.resourceType === b.resourceType && a.resourceId === b.resourceId;
        const overlap = a.startMs < b.endMs && b.startMs < a.endMs;
        if (sameResource && overlap) {
          if (!resourceByType.has(a.resourceType)) {
            resourceByType.set(a.resourceType, new Set<string>());
          }
          resourceByType.get(a.resourceType)!.add(a.resourceId);
        }
      }
    }
    // 受影响任务：资源维度直接命中（person=assigneeId / device=deviceId / station=stationId）。
    for (const [resourceType, resourceIds] of resourceByType) {
      for (const resourceId of resourceIds) {
        for (const t of snapshot.tasks) {
          if (
            (resourceType === 'person' && t.assigneeId === resourceId) ||
            (resourceType === 'device' && t.deviceId === resourceId) ||
            (resourceType === 'station' && t.stationId === resourceId)
          ) {
            affectedTaskIds.add(t.id);
          }
        }
      }
    }
    // triggerIds=冲突资源并集（纯 resourceId，与旧 evaluate key 兼容；类型信息经
    // buildSeed RESERVATION_CONFLICT 分支处理）。
    const triggerIds = Array.from(
      new Set(Array.from(resourceByType.values()).flatMap((s) => Array.from(s))),
    ).sort();
    return {
      triggerIds,
      affectedTaskIds: Array.from(affectedTaskIds).sort(),
    };
  }
}