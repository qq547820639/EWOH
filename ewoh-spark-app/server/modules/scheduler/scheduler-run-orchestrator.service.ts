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
  ConflictException,
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
import { SchedulingContextService } from './scheduling-context.service';
import { SchedulingNarratorService } from './narration/scheduling-narrator.service';
import { toOrgContext } from './scheduler-run-context';
import {
  compileConstraints,
  type ConstraintCompileTask,
} from './constraint-compiler';

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
    /** context 短缓存失效（run 成功后新快照立即对前端可见）。 */
    private readonly schedulingContextService: SchedulingContextService,
    /** 惰性读取 facade 上的 constraintLoaderService（兼容旧单测构造后注入）。 */
    private readonly getConstraintLoader: () => ConstraintLoaderService | undefined,
    /** AI 调度说明层（2026-08-21）：方案落库后异步生成自然语言说明（fire-and-forget）。 */
    private readonly narratorService?: SchedulingNarratorService,
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
    // DATA-FLOW 修复（2026-08-18）：手动触发（MANUAL）用时间戳作 eventVersion——
    // trigger_key 幂等键固定为 `org:MANUAL:ALL:0` 会让手动调度"只成功一次"，
    // 之后被 ON CONFLICT DO NOTHING 永久去重（前端手动触发按钮失效）。
    // 手动 = 每次新意图 → 新 key；冷却（按 org+type+entity 查最近记录）仍生效。
    // C10（2026-08-19 审计）：改秒级时间戳——毫秒级 Date.now()（13 位）超出
    // int4 上限（2.1e9），在未热修 bigint 的新环境上手动调度必 500。
    // 秒级粒度与触发冷却窗口（默认 30s）语义一致，不会引入额外去重。
    const eventVersion = trigger === 'MANUAL' ? Math.floor(Date.now() / 1000) : undefined;
    const run = await this.triggerService.evaluate(trigger, body.entityId ?? null, ctx, eventVersion);
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
        // ADR-071：churn 基线读面透传 ctx（跨租户方案与不存在同语义）。
        const baseline = await this.planService.getPlan(body.baselinePlanId, ctx);
        baselineAssignee = new Map(
          baseline.assignments.map((a) => [a.taskId, a.personId ?? null]),
        );
      } catch (err) {
        this.logger.warn(
          `createRun: baselinePlanId ${body.baselinePlanId} 读取失败，churn 基线降级为空: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // R2-SCH-007（2026-08-17，NEST-140 残留）：solveVariants 抛错与
    // INFEASIBLE_PROFILE 筛选失败必须先闭合 run（status=failed）再向上抛——
    // 此前 run 已创建但两条路径均无闭合动作，run 永久滞留 queued。
    let plans: SchedulingPlanV2[];
    try {
      plans = await this.solverService.solveVariants(
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
      // NEST-140 修复（2026-08-17）：筛选后空集是显式 INFEASIBLE 事实——抛出
      // ConflictException 让 run 闭合为 failed（此前空集静默走 succeeded+planIds=[]，
      // 调用方无法区分"单变体不可行"与"shadow 不落库"）。
      const profileSuffix = this.resolveObjectiveProfileSuffix(body.objectiveProfile);
      if (profileSuffix) {
        plans = plans.filter((p) => p.planId === `${run.runId}${profileSuffix}`);
        if (plans.length === 0) {
          throw new ConflictException(
            `INFEASIBLE_PROFILE: objectiveProfile=${body.objectiveProfile} 无可行变体（planId 后缀 ${profileSuffix} 未产出方案）`,
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
        this.logger.error(
          `createRun: failed to mark run ${run.runId} as failed: ${inner instanceof Error ? (inner as Error).message : String(inner)}`,
        );
      }
      throw err;
    }

    // P1-1：统一约束 IR（仅审计/解释；additive，不参与求解决策，不改动求解结果）。
    // 把本次 run 的约束语义归一化为 SchedulingConstraintIR[]，挂到每个 assignment 的
    // DecisionTrace（可选字段，向后兼容；缺省不影响现有序列化）。
    const tasksById = new Map<string, ConstraintCompileTask>(
      snapshot.tasks.map((t) => [
        t.id,
        {
          requiredSkills: t.requiredSkills ?? [],
          skillMatchMode: t.skillMatchMode,
          requiredCertifications: t.requiredCertifications ?? [],
          mustFinishByMs: t.latestFinishMs ?? null,
          dueMs: t.dueAtMs ?? null,
          predIds: t.predecessorIds ?? [],
        },
      ]),
    );
    const constraintIR = compileConstraints(constraints, { tasksById });
    for (const plan of plans) {
      for (const assignment of plan.assignments) {
        if (assignment.decisionTrace) {
          assignment.decisionTrace.constraintIR = constraintIR;
        }
      }
    }

    // P0-6：mode=SHADOW → 仅评估，不写入 ewoh_schedule_plan 正式表；
    // run 标记 succeeded 且 planIds=[]（shadow 方案不进入正式派工链）。
    const isShadow = body.mode === 'SHADOW';
    // NEST-129 修复（2026-08-17）：persistPlan 循环 + run 状态更新包进单个事务
    // ——此前逐方案独立事务，plan 2 失败时 plan 1 已落库（半持久化）。
    // RequestDatabaseContext 嵌套复用同一事务。
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        if (!isShadow) {
          for (const plan of plans) {
            await this.planService.persistPlan(plan, ctx);
          }
        }

        // standalone_030_solver_activation（Task A / P0）：run 回填方案求解器状态/回退原因
        // （取首个被采用方案；shadow 模式 plans 不落库正式表，仅回填观测值）。
        const first = plans[0];
        await this.db
          .update(ewohSchedulingRun)
          .set({
            status: 'succeeded',
            snapshotVersion: snapshot.snapshotVersion,
            planIds: isShadow ? [] : plans.map((p) => p.planId),
            solverStatus: first?.solverStatus ?? null,
            fallbackReason: first?.fallbackReason ?? null,
          })
          .where(eq(ewohSchedulingRun.runId, run.runId));

        // 缓存一致性（2026-08-19）：调度成功 = 世界版本推进，立即失效 org 的
        // context 短缓存（否则"触发调度→前端看到新版本"延迟最多 10s TTL）。
        this.schedulingContextService?.invalidate(ctx.primaryOrgId);
      },
    );

    // AI 调度说明层（2026-08-21）：事务外异步生成（不阻塞 createRun 响应；
    // 失败仅告警，不影响方案状态与审批）。LLM 不可用自动规则回退。
    if (!isShadow) {
      for (const plan of plans) {
        this.narratorService?.generateForPlan(plan.planId, ctx).catch((error) => {
          this.logger.warn(
            `plan narration 生成失败 planId=${plan.planId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    }

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
