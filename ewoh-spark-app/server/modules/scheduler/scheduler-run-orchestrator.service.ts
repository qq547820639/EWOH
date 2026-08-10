/**
 * SchedulerService Strangler Refactor（Task 2）：运行/方案生成编排。
 *
 * 承载 createRun（trigger 评估 → 快照 → 全局约束加载 → 求解变体 → profile 筛选 →
 * SHADOW 守卫 → persist → run 状态落库）与 legacy generatePlans 兼容入口。
 *
 * constraintLoaderService 经 getter 惰性读取（facade 保留可变字段，兼容旧单测
 * 构造后注入；getter 在调用时求值，保证后注入的 loader 生效）。
 */
import {
  Injectable,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulingRun } from '@server/database/schema';
import { eq } from 'drizzle-orm';
import type {
  SchedulePlan,
  SchedulingPlanV2,
  CreateRunRequest,
  SchedulingRun,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { TriggerService } from './trigger.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';
import { ConstraintLoaderService } from './constraint-loader.service';
import { toOrgContext } from './scheduler-run-context';

@Injectable()
export class SchedulerRunOrchestrator {
  private readonly logger = new Logger(SchedulerRunOrchestrator.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly triggerService: TriggerService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly solverService: SolverService,
    private readonly planService: PlanService,
    /** 惰性读取 facade 上的 constraintLoaderService（兼容旧单测构造后注入）。 */
    private readonly getConstraintLoader: () => ConstraintLoaderService | undefined,
  ) {}

  async generatePlans(body?: { idempotencyKey?: string }): Promise<SchedulePlan[]> {
    // P1-SSOT：遗留合成方案生成器（KEEP/CAP/BAL 伪造指标并写 ewohSchedulePlan）
    // 已删除。正式调度只走 V2 链路（createRun → SolverService → planService），
    // 本接口保留仅为兼容旧调用方：委托真实调度并把结果映射为 legacy 形状，
    // metricsJson 仅含真实 solver 指标（solverStatus/objective/solveDurationMs），不伪造。
    void body;
    const { plans } = await this.createRun({ trigger: 'MANUAL' });
    return plans.map((p) => this.toLegacyPlan(p));
  }

  async createRun(
    body: CreateRunRequest,
    actor?: OrgContext,
  ): Promise<{ run: SchedulingRun | null; plans: SchedulingPlanV2[]; debounced: boolean }> {
    const ctx = toOrgContext(actor);
    const trigger = body.trigger ?? 'MANUAL';
    const run = await this.triggerService.evaluate(trigger, body.entityId ?? null, ctx);
    if (!run) {
      return { run: null, plans: [], debounced: true };
    }

    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    const horizonMinutes = body.horizonMinutes ?? 480;
    // P0-2（G2）：createRun 主链路加载全局 active 约束（org + 有效期过滤）。
    // 人工 LOCK/EXCLUDE 不得因为空 constraints 在 manual/automatic run 中丢失。
    const constraintLoader = this.getConstraintLoader();
    const constraints = constraintLoader
      ? await constraintLoader.loadGlobalActive(ctx)
      : [];

    // P0-6：baselinePlanId → churn 基线（taskId → personId，复用 solveVariants 的
    // baselineAssignee 机制）；读取失败降级为空基线（仅记日志，不阻断求解）。
    let baselineAssignee: Map<string, string | null> | undefined;
    if (body.baselinePlanId) {
      try {
        const baseline = await this.planService.getPlan(body.baselinePlanId);
        baselineAssignee = new Map(
          baseline.assignments.map((a) => [a.taskId, a.personId ?? null]),
        );
      } catch (err) {
        this.logger.warn(
          `createRun: baselinePlanId ${body.baselinePlanId} 读取失败，churn 基线降级为空: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    let plans = await this.solverService.solveVariants(
      snapshot,
      constraints,
      {
        planId: run.runId,
        triggerType: trigger,
        triggerEntityId: run.triggerEntityId,
        snapshotVersion: snapshot.snapshotVersion,
        horizonMinutes,
        baselineAssignee,
      },
    );

    // P0-6：objectiveProfile → 单变体筛选（on_time=A / load_balance=B / composite=C）。
    // 未识别或缺省保持 A/B/C 三变体现状（solveVariants 不支持单 profile 参数，
    // 在调用处按 planId 后缀筛选，返回值形状不变）。
    const profileSuffix = this.resolveObjectiveProfileSuffix(body.objectiveProfile);
    if (profileSuffix) {
      plans = plans.filter((p) => p.planId === `${run.runId}${profileSuffix}`);
    }

    // P0-6：mode=SHADOW → 仅评估，不写入 ewoh_schedule_plan 正式表；
    // run 标记 succeeded 且 planIds=[]（shadow 方案不进入正式派工链）。
    const isShadow = body.mode === 'SHADOW';
    if (!isShadow) {
      for (const plan of plans) {
        await this.planService.persistPlan(plan, ctx);
      }
    }

    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        await this.db
          .update(ewohSchedulingRun)
          .set({
            status: 'succeeded',
            snapshotVersion: snapshot.snapshotVersion,
            planIds: isShadow ? [] : plans.map((p) => p.planId),
          })
          .where(eq(ewohSchedulingRun.runId, run.runId));
      },
    );

    return { run, plans, debounced: false };
  }

  /** P0-6：objectiveProfile → solveVariants 变体后缀（A/B/C）；未识别/缺省返回 null（三变体现状）。 */
  private static readonly OBJECTIVE_PROFILE_SUFFIX: Record<string, string> = {
    on_time: 'A',
    load_balance: 'B',
    composite: 'C',
  };

  private resolveObjectiveProfileSuffix(profile?: string): string | null {
    if (!profile) return null;
    return SchedulerRunOrchestrator.OBJECTIVE_PROFILE_SUFFIX[profile] ?? null;
  }

  /**
   * P1-SSOT：V2 SchedulingPlanV2 → legacy SchedulePlan 形状映射。
   * 仅透传真实求解事实（solverStatus / objective / solveDurationMs / fallbackReason），
   * 不合成任何演示指标（taktImprovement 等保持 0/null，metricsJson 不伪造）。
   */
  private toLegacyPlan(p: SchedulingPlanV2): SchedulePlan {
    return {
      id: p.planId,
      planId: p.planId,
      planName: p.planName ?? p.planId,
      strategy: this.variantLabel(p) ?? 'solver',
      status: (p.status as SchedulePlan['status']) ?? 'proposed',
      taktImprovement: 0,
      highLoadPersons: 0,
      lowBatteryRisk: 0,
      affectedPersons: p.assignments.length,
      metricsJson: {
        solverStatus: p.solverStatus,
        solverVersion: p.solverVersion,
        solveDurationMs: p.solveDurationMs ?? null,
        fallbackReason: p.fallbackReason ?? null,
        objective: p.objective ?? null,
        objectiveBreakdown: p.objectiveBreakdown ?? null,
        assignmentCount: p.assignments.length,
      },
      reason: p.fallbackReason ?? null,
      createdAt: new Date().toISOString(),
      confirmedBy: null,
      confirmedAt: null,
      confirmReason: null,
    };
  }

  /** 从 baselineDelta.variant（Record<string, unknown>）安全读取变体标签。 */
  private variantLabel(p: SchedulingPlanV2): string | null {
    const variant = (p.baselineDelta as Record<string, unknown> | null | undefined)
      ?.variant as Record<string, unknown> | null | undefined;
    return typeof variant?.label === 'string' ? variant.label : null;
  }
}
