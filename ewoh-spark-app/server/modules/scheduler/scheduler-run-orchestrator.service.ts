/* eslint-disable @darraghor/nestjs-typed/injectable-should-be-provided -- 手工组合装配：由 SchedulerService 构造函数 new 实例化，不经 DI providers 注册，规则误报 */
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
  Optional,
  ServiceUnavailableException,
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
    @Optional()
    private readonly narratorService?: SchedulingNarratorService,
  ) {}

  async generatePlans(
    body?: { idempotencyKey?: string },
    actor?: OrgContext,
  ): Promise<SchedulePlan[]> {
    // P1-SSOT：遗留合成方案生成器（KEEP/CAP/BAL 伪造指标并写 ewohSchedulePlan）
    // 已删除。正式调度只走 V2 链路（createRun → SolverService → planService），
    // 本接口保留仅为兼容旧调用方：委托真实调度并把结果映射为 legacy 形状，
    // metricsJson 仅含真实 solver 指标（solverStatus/objective/solveDurationMs），不伪造。
    // actor 必须透传：HTTP 路径下 TriggerService 强制租户语义（NEST-146），
    // 丢 actor = 每个已认证调用方 401。
    void body;
    const { plans } = await this.createRun({ trigger: 'MANUAL' }, actor);
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
    // T11（2026-08-28 审计）：此前 constraintLoader 缺失时静默返回空约束——
    // 人工 LOCK 可能丢失且无任何告警。现升格为 error 日志显形；生产可设
    // EWOH_REQUIRE_CONSTRAINT_LOADER=1 切换 fail-closed（装配缺失直接拒绝
    // 调度）。默认仍 fail-open：loader 为 undefined 主要是直构测试的既有
    // 语义（构造后注入，见 :59 注释），无条件抛错会大面积破坏表征测试。
    const constraintLoader = this.getConstraintLoader();
    let constraints: Awaited<ReturnType<ConstraintLoaderService['loadGlobalActive']>> = [];
    if (constraintLoader) {
      constraints = await constraintLoader.loadGlobalActive(ctx);
    } else {
      const message =
        'createRun: constraintLoader 未装配，本次 run 将在空约束下求解——人工 LOCK/EXCLUDE 约束丢失';
      if (process.env.EWOH_REQUIRE_CONSTRAINT_LOADER === '1') {
        this.logger.error(`${message}；EWOH_REQUIRE_CONSTRAINT_LOADER=1 → fail-closed`);
        throw new ServiceUnavailableException(
          'constraint loader not assembled; scheduling refused (EWOH_REQUIRE_CONSTRAINT_LOADER=1)',
        );
      }
      this.logger.error(message);
    }

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

    // 排产规模可观测（2026-09-13）：单次求解的成本对**任务数**超线性，而规模此前
    // 只存在于快照内部、任何日志里都看不到。实测后果：本地库被历轮 E2E 残留撑到
    // 约 20 倍时，`POST /api/scheduler/runs` 从 5 秒退化到 3 分钟以上，而**没有任何
    // 信号指向数据量**——排障者会以为是产品故障（我实际这样误判过一次）。
    // 这里只做观测（不参与任何判定、不改求解语义），把"这次要吃多少活"写进日志，
    // 让"数据量问题"与"代码问题"一眼可分。
    this.logger.log(
      `scheduling run scale: run=${run.runId} org=${ctx?.primaryOrgId ?? 'n/a'} `
        + `snapshot=${snapshot.snapshotVersion} tasks=${snapshot.tasks?.length ?? 0} `
        + `entities=${Object.keys(snapshot.entityVersions ?? {}).length} `
        + `constraints=${constraints.length} horizonMinutes=${horizonMinutes}`,
    );

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
        // 2026-08-21 修复：fire-and-forget 调用必须脱离请求级事务 store——
        // AsyncLocalStorage 的 store 会传播到异步调用，generateForPlan 内部的
        // runInTransaction 因此命中 activeTransaction 分支，在已提交/外层事务
        // 对象上执行 set_config → 永久挂起（PG 无查询、narration 永不落库）。
        // storage.run(undefined, ...) 显式清空 store，使其走独立 rootDatabase
        // 事务（实测：NARR-PLAN/LLM/DONE 全链路 40s 内完成，narration_source=llm）。
        const ctxStorage = (
          this.requestDatabaseContext as unknown as {
            storage?: import('node:async_hooks').AsyncLocalStorage<unknown>;
          }
        ).storage;
        if (ctxStorage) {
          ctxStorage.run(undefined, () => {
            this.narratorService?.generateForPlan(plan.planId, ctx).catch((error) => {
              this.logger.warn(
                `plan narration 生成失败 planId=${plan.planId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          });
        } else {
          this.narratorService?.generateForPlan(plan.planId, ctx).catch((error) => {
            this.logger.warn(
              `plan narration 生成失败 planId=${plan.planId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }
      }
    }

    // 剥离重量级字段（decisionTrace ~36KB/assignment、alternatives、scoreBreakdown 等），
    // 将响应体从 ~2.3MB 压缩到 ~50KB。前端按需通过 GET /plans/:planId 获取完整数据。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summaryPlans = plans.map((p: any) => ({
      ...p,
      assignments: p.assignments.map((a: any) => {
        const { decisionTrace: _dt, alternatives: _alt, scoreBreakdown: _sb, ...rest } = a;
        return rest;
      }),
      decisionRecords: undefined,
      decisionProjectionIssues: undefined,
      weights: undefined,
    })) as typeof plans;

    return { run, plans: summaryPlans, debounced: false };
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
