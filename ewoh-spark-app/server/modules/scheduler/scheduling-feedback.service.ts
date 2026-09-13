import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { currentRequestContext } from '../../common/request-context';
import { sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  ewohSchedulingFeedback,
  ewohSchedulePlan,
  ewohSchedulingPlanAssignment,
} from '@server/database/schema';
import { and, eq, or, isNull } from 'drizzle-orm';
import type {
  SchedulingFeedback,
  SchedulingFeedbackKpis,
  SchedulingFeedbackResource,
} from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ShadowEvaluatorService, shadowCorrelationId, stableSampleSeed } from './prediction/shadow-evaluator.service';
import {
  PREDICTION_PROVIDER,
  type EmpiricalDurationPredictionProvider,
} from './prediction/empirical-duration-prediction-provider';
import { TaskService } from '../task/task.service';
import { ExecutionReceiptApplicationService } from './execution-receipt-application.service';
import type { ExecutionReceiptSummary, FeedbackActualsReceiptRequest } from '@shared/execution-receipt';

/** R-3：shadow 观测的预测维度（时长预测；与 shadow-evaluator 的 aggregate/回填键约定一致）。 */
const SHADOW_PREDICTION_TYPE = 'task_duration';

/** recordActuals 的入参形状（与公开签名逐字一致，供内部回填辅助方法复用）。 */
type RecordActualsInput = Omit<FeedbackActualsReceiptRequest, 'actualStart' | 'actualEnd'> & {
  actualStart?: Date | string | null;
  actualEnd?: Date | string | null;
};

/** Planned baselines, acceptance and KPI reads. Actuals delegate exclusively to the
 * canonical receipt application; missing composition fails closed before writes. */
@Injectable()
export class SchedulingFeedbackService {
  private readonly logger = new Logger(SchedulingFeedbackService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    // M05：Prediction Shadow Learning 回填点（可选注入；缺失时静默跳过，不改变反馈写入）。
    private readonly shadowEvaluatorService?: ShadowEvaluatorService,
    // Retained constructor position for existing baseline-only compositions.
    private readonly taskService?: TaskService,
    @Optional() private readonly receiptService?: ExecutionReceiptApplicationService,
    // R-3（2026-09-13）：shadow 采样腿的预测来源（shadow only，ADR-056 决策 2）。
    // 可选注入：未装配时显式不采样（不伪造 prediction），既有直构测试不受影响。
    @Optional() @Inject(PREDICTION_PROVIDER) private readonly predictionProvider?: EmpiricalDurationPredictionProvider,
  ) {}

  /**
   * 在 dispatch 时记录 planned 基线（观测型，不改变任何调度行为）。
   * 每个 assignment 写入一行；无 assignment 时写一行 plan 级反馈。
   * @returns 写入/更新的反馈行数。
   */
  async recordBaseline(
    planId: string,
    opts?: {
      runId?: string | null;
      solverRuntime?: number | null;
      solverFallback?: boolean;
      replanCount?: number;
      conflictCount?: number;
      overrideCount?: number;
      ts?: Date;
    },
    ctx?: OrgContext,
  ): Promise<number> {
    // R2-SSV-15（2026-08-17）：plan/assignments 读取叠加 org 条件（本 org +
    // NULL 存量）——跨租户 planId 不再进入基线写入（此前会用他租户方案的
    // assignments 生成本租户反馈行，污染 KPI 面）。
    const orgId = ctx?.primaryOrgId ?? null;
    const planOrgCond = orgId
      ? and(
          eq(ewohSchedulePlan.planId, planId),
          or(
            isNull(ewohSchedulePlan.orgId),
            eq(ewohSchedulePlan.orgId, orgId),
          ),
        )
      : eq(ewohSchedulePlan.planId, planId);
    const [plan] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(planOrgCond)
      .limit(1);
    if (!plan) return 0;

    const assignmentOrgCond = orgId
      ? and(
          eq(ewohSchedulingPlanAssignment.planId, planId),
          or(
            isNull(ewohSchedulingPlanAssignment.orgId),
            eq(ewohSchedulingPlanAssignment.orgId, orgId),
          ),
        )
      : eq(ewohSchedulingPlanAssignment.planId, planId);
    const assignments = await this.db
      .select()
      .from(ewohSchedulingPlanAssignment)
      .where(assignmentOrgCond);

    const metrics = (plan.metricsJson ?? {}) as Record<string, unknown>;
    const solverRuntimeOpt = opts?.solverRuntime ?? (metrics['solveDurationMs'] as number | undefined) ?? null;
    const solverFallbackOpt =
      opts?.solverFallback ?? this.isFallbackStatus(metrics['solverStatus'] as string | undefined);
    const replanCount = opts?.replanCount ?? 0;
    const conflictCount = opts?.conflictCount ?? 0;
    const overrideCount = opts?.overrideCount ?? 0;
    const ts = opts?.ts ?? new Date();
    const runId = opts?.runId ?? plan.triggerEntityId ?? null;
    // 审批发生在 dispatch 之前，故此处按 plan 状态推导验收结果（approved→true, rejected→false）。
    const acceptedFromPlan =
      plan.status === 'approved' ? true : plan.status === 'rejected' ? false : null;

    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: orgId ?? '' },
    );

    // Phase 4 / P4-T1：plannedWait 语义——同 person 的连续任务，wait = start - 前一任务 end
    // （clamp ≥0）；无前任务（该人员首任务）→ 0（调度起点无等待，非伪造）。按 plannedStart 升序计算。
    const personSeq = new Map<string, { endMs: number }>();
    const sortedAssignments = [...assignments].sort((x, y) => {
      const xs = x.plannedStart ? x.plannedStart.getTime() : 0;
      const ys = y.plannedStart ? y.plannedStart.getTime() : 0;
      return xs - ys;
    });
    const waitByAssignment = new Map<string, number>();
    for (const a of sortedAssignments) {
      if (!a.assignmentId || !a.plannedStart || !a.personId) continue;
      const startMs = a.plannedStart.getTime();
      const prev = personSeq.get(a.personId);
      const waitMs = prev ? Math.max(startMs - prev.endMs, 0) : 0;
      waitByAssignment.set(a.assignmentId, waitMs);
      if (a.plannedEnd) personSeq.set(a.personId, { endMs: a.plannedEnd.getTime() });
    }

    let written = 0;
    /** 本次调用**新增**基线的 assignment（R-3 自查修正：采样只发生在首基线）。 */
    const newlyBaselinedAssignmentIds = new Set<string>();
    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      const targets = assignments.length > 0 ? assignments : [null];

      // P2（2026-08-19 审计）advisory lock N+1：原循环内对每个 assignment
      // 单独 execute 一次 pg_advisory_xact_lock（N 次往返）。xact 级锁在
      // 事务结束前持续持有，循环前单语句批量预取全部锁与逐条获取的串行化
      // 语义完全等价（同一锁集覆盖整个事务），往返从 N 次降为 1 次。
      // NEST-127 原语义保持：键=plan|assignment；无 execute 能力的测试替身
      // 跳过锁（单进程测试无并发）。
      const lockAssignmentIds = [
        ...new Set(
          targets
            .map((a) => a?.assignmentId)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      if (lockAssignmentIds.length > 0) {
        try {
          const lockCalls = lockAssignmentIds.map(
            (id) =>
              sql`pg_advisory_xact_lock(hashtext(${planId} || '|' || ${id}))`,
          );
          await this.db.execute(
            sql`SELECT ${sql.join(lockCalls, sql`, `)}`,
          );
        } catch {
          // 测试替身/无 execute 环境：跳过锁（单进程测试无并发）
        }
      }

      for (const a of targets) {
        const assignmentId = a?.assignmentId ?? null;
        const taskId = a?.taskId ?? null;
        const originalResource: SchedulingFeedbackResource | null = assignmentId
          ? {
              personId: a.personId ?? null,
              deviceId: a.deviceId ?? null,
              stationId: a.stationId ?? null,
            }
          : null;

        const plannedStart = a?.plannedStart ?? null;
        const plannedEnd = a?.plannedEnd ?? null;
        // Phase 4 / P4-T1 语义修复：plannedTravel 记录 ETA 时间语义（etaSeconds），
        // 而非 distanceMeters；plannedWait 按同 person 前一任务 end 计算（不再恒 null）。
        const plannedTravel = a?.etaSeconds ?? null;
        const plannedWait = assignmentId ? waitByAssignment.get(assignmentId) ?? null : null;

        // 幂等：同一 assignment 已存在则回填 planned 基线，否则新增。
        const [existing] = assignmentId
          ? await this.db
              .select()
              .from(ewohSchedulingFeedback)
              .where(
                and(
                  eq(ewohSchedulingFeedback.assignmentId, assignmentId),
                  eq(ewohSchedulingFeedback.planId, planId),
                ),
              )
              .limit(1)
          : [];

        if (existing) {
          await this.db
            .update(ewohSchedulingFeedback)
            .set({
              plannedStart,
              plannedEnd,
              plannedTravel,
              plannedWait,
              originalResourceJson: originalResource as unknown as Record<string, unknown> | null,
              replanCount,
              conflictCount,
              overrideCount,
              solverRuntime: solverRuntimeOpt,
              solverFallback: solverFallbackOpt,
              ts,
            })
            .where(eq(ewohSchedulingFeedback.feedbackId, existing.feedbackId));
        } else {
          await this.db.insert(ewohSchedulingFeedback).values({
            // R2-SSV-20：Date.now()+4 字符随机后缀（同毫秒 1/1.7M 碰撞）→ randomUUID。
            feedbackId: `FB-${randomUUID()}`,
            runId,
            planId,
            taskId,
            assignmentId,
            plannedStart,
            plannedEnd,
            plannedTravel,
            plannedWait,
            originalResourceJson: originalResource as unknown as Record<string, unknown> | null,
            replanCount,
            conflictCount,
            overrideCount,
            solverRuntime: solverRuntimeOpt,
            solverFallback: solverFallbackOpt,
            accepted: acceptedFromPlan,
            ts,
            orgId,
          });
          if (assignmentId) newlyBaselinedAssignmentIds.add(assignmentId);
        }
        written += 1;
      }
    });

    this.logger.log(
      `scheduling feedback baseline recorded for plan ${planId} (${written} row${written === 1 ? '' : 's'})`,
    );

    // R-3（2026-09-13）：shadow 采样腿。放在反馈事务**之外**——观测是 advisory-only，
    // 绝不能因为预测提供者变慢/抛错而污染或回滚反馈写入；默认 canary=0 时该方法首个判断
    // 即返回（不调用预测提供者、不写观测行），行为与接线前逐字节一致。
    try {
      await this.sampleShadowPredictions(planId, plan, assignments, ctx, newlyBaselinedAssignmentIds);
    } catch (err) {
      this.logger.warn(
        `shadow sampling skipped for plan ${planId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return written;
  }

  /**
   * R-3（2026-09-13）Prediction Shadow Learning 采样腿（advisory-only）。
   *
   * 为什么落在这里：本方法持有 plan（snapshotVersion/policyVersion 溯源）与 assignments
   * （taskId/assignmentId/plannedStart/plannedEnd），且本类早就注入了 ShadowEvaluatorService
   * （此前是零使用的死依赖，注释明写"M05：Prediction Shadow Learning 回填点"）——
   * 采样与回填必须共用同一 correlationId，放在同一个类里才能保证不漂移。
   *
   * 语义边界（ADR-056 决策 2 / empirical-duration-prediction-provider 头注释，shadow-only）：
   *  - 只写内存缓冲 + prediction_shadow_observation（advisory 观测表），绝不写回
   *    ewoh_schedule_plan / ewoh_scheduling_plan_assignment，绝不改变求解输出；
   *  - prediction = 经验时长模型对任务的预测（PREDICTION_PROVIDER）。模型未训练或无 org
   *    上下文时提供者自身回退确定性基线，并以 modelVersion=deterministic-v1 标注——这类样本
   *    会被 aggregate 计入 fallbackRate（不粉饰、不冒充 ml 来源）；
   *  - baseline = 确定性基线，即求解器本次实际采用的时长（plannedEnd − plannedStart, ms）；
   *  - 采样比例由 shouldSample(种子, ctx) 决定，种子 = correlationId 的确定性哈希。
   *
   * 自查修正（2026-09-13）：只对**本次新增基线**的 assignment 采样（newlyBaselined）。
   * recordBaseline 对同一 plan 是可重入的——分波派工（dispatch wave）每波成功后都会
   * 调一次本方法，而已派波次的 feedback 行走 update 分支；若不做首基线限定，同一
   * correlationId 会重复写入多条**永远无法回填**的开放样本（一条回执只关一条，
   * 实测两波 ×2 assignment → 4 条样本），coverage 被永久钉在 ≤1/波数，canary 被迫回退，
   * 观测表也被无意义行灌满。
   */
  private async sampleShadowPredictions(
    planId: string,
    plan: typeof ewohSchedulePlan.$inferSelect,
    assignments: Array<typeof ewohSchedulingPlanAssignment.$inferSelect>,
    ctx?: OrgContext,
    newlyBaselinedAssignmentIds?: ReadonlySet<string>,
  ): Promise<void> {
    const shadow = this.shadowEvaluatorService;
    if (!shadow) return;
    // 默认 canary=0 → 立即返回：不采样、不调用预测提供者（接线前的行为逐字节保持）。
    if (shadow.getCanaryFraction(ctx) <= 0) return;
    const provider = this.predictionProvider;
    if (!provider) return; // 无预测提供者 → 显式不采样（§33 不伪造 prediction）。

    const orgId = ctx?.primaryOrgId ?? plan.orgId;
    const snapshotVersion = plan.snapshotVersion ?? undefined;
    for (const a of assignments) {
      // 首基线限定：已基线过的 assignment（重复基线/后续波次）不再采样——
      // 每 assignment 同时至多存在一条开放样本，才可能与回执一一对应。
      if (!a.assignmentId || !newlyBaselinedAssignmentIds?.has(a.assignmentId)) continue;
      // 无稳定关联键（缺 assignment/task）→ 回填必然失配，宁可不采样也不留不可回填的观测。
      const correlationId = shadowCorrelationId(planId, a.assignmentId, a.taskId);
      if (!correlationId) continue;
      if (!shadow.shouldSample(stableSampleSeed(correlationId), ctx)) continue;
      // 缺计划窗口 → 没有确定性基线可比，跳过（不补 0、不猜默认时长）。
      if (!a.plannedStart || !a.plannedEnd) continue;
      const baselineMs = a.plannedEnd.getTime() - a.plannedStart.getTime();
      if (!Number.isFinite(baselineMs) || baselineMs <= 0) continue;

      let result: { value: number; modelVersion: string; confidence: number };
      try {
        result = await provider.predictTaskDuration({
          taskId: a.taskId ?? undefined,
          orgId,
        });
      } catch (err) {
        // 预测失败 → 不写样本（宁可无观测，不可伪造预测值）。
        this.logger.warn(
          `shadow sample skipped (predict failed) ${correlationId}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (!Number.isFinite(result.value)) continue;

      shadow.recordSample(
        {
          modelVersion: result.modelVersion,
          predictionType: SHADOW_PREDICTION_TYPE,
          // 未知快照版本显式写 'unknown'（观测溯源字段，不冒充具体版本）。
          inputVersion: snapshotVersion ?? 'unknown',
          prediction: result.value,
          baseline: baselineMs,
          confidence: result.confidence,
          createdAt: new Date().toISOString(),
          taskId: a.taskId ?? undefined,
          correlationId,
          policyVersion: plan.policyVersion ?? undefined,
          snapshotVersion,
          // 回填到期判据：计划窗口结束时刻（evaluateCanary 的 coverage 判定用，
          // 见 shadow-evaluator BACKFILL_DUE_GRACE_MS——在途样本不算"应回填而未回填"）。
          expectedActualAt: a.plannedEnd.toISOString(),
        },
        ctx,
      );
    }
  }

  /** 记录 plan 审批结果（accepted）。观测型，不影响审批流程。NEST-117：org 条件。 */
  async recordAcceptance(planId: string, accepted: boolean, ctx?: OrgContext): Promise<void> {
    const gucSettings = buildGucSettings(
      ctx ?? { userId: 'system', primaryOrgId: '' },
    );
    const orgId = ctx?.primaryOrgId || null;
    await this.requestDatabaseContext.runInTransaction(gucSettings, async () => {
      // NEST-117 修复（2026-08-17）：UPDATE 按 org 过滤（无 ctx 时不再跨租户
      // 改他租户 feedback 行的 accepted 标记；org 匹配或 NULL 存量）。
      await this.db
        .update(ewohSchedulingFeedback)
        .set({ accepted })
        .where(
          and(
            eq(ewohSchedulingFeedback.planId, planId),
            orgId
              ? or(
                  isNull(ewohSchedulingFeedback.orgId),
                  eq(ewohSchedulingFeedback.orgId, orgId),
                )
              : undefined,
          ),
        );
    });
    this.logger.log(
      `scheduling feedback acceptance=${String(accepted)} recorded for plan ${planId}`,
    );
  }

  /**
   * 回填任务实际执行数据（实际开始/结束、实际 travel/wait、实际资源）。
   * 与 execution、assignment/task 和 outbox 原子更新。
   */
  async recordActuals(
    input: RecordActualsInput,
    ctx?: OrgContext,
  ): Promise<ExecutionReceiptSummary> {
    if (!this.receiptService) {
      throw new ServiceUnavailableException('Canonical receipt service is required for recordActuals');
    }
    const result = await this.receiptService.applyFromActuals({
      ...input,
      actualStart: input.actualStart instanceof Date ? input.actualStart.toISOString() : input.actualStart,
      actualEnd: input.actualEnd instanceof Date ? input.actualEnd.toISOString() : input.actualEnd,
    }, ctx);
    const receipt = result?.receipt ?? {
      matchedRows: 0,
      advancedAssignments: 0,
      advancedTaskSteps: 0,
      skips: ['receipt:not_matched'],
    };
    // R-3（2026-09-13）：shadow 回填腿——真实回执落库成功之后才回填 actual。
    // 观测型：失败只记日志，绝不改变 recordActuals 的返回值/语义。
    this.backfillShadowActuals(input, receipt, ctx);
    return receipt;
  }

  /**
   * R-3（2026-09-13）Prediction Shadow Learning 回填腿（advisory-only）。
   *
   * 为什么在这里：真实执行事实（actualStart/actualEnd）的唯一权威入口就是 recordActuals
   * 委托的规范回执服务；只有回执真正命中行（matchedRows>0）才存在"实际值"，
   * 未命中就回填等于凭空造 actual（§33 禁止）。
   *
   * 匹配键：shadowCorrelationId(planId, assignmentId, taskId)——与采样腿同一函数构造，
   * 因此不受采样时刻（createdAt 无法在回填侧复现）影响；匹配不到静默跳过（既有语义）。
   *
   * 阈值判定：回填成功后按内存窗口聚合评估 canary（evaluateCanary）。回退只由**坏证据**
   * 触发（相对误差/fallbackRate 超限、到期样本 coverage 不足）；缺证据（误差不可判定、
   * 其余样本仍在途）只观测不回退。**只改采样比例**：不触碰 ewoh_schedule_plan/assignment、
   * 不改变任何求解输出。
   *
   * 可见性（自查修正 2026-09-13）：public——规范回执路径
   * （SchedulerEventApplicationService.recordTaskActuals → ExecutionReceiptApplication
   * .applyFromActuals）绕过本类的 recordActuals 直达回执服务，必须显式回调本钩子，
   * 否则生产回执永远不回填 shadow 样本（学习腿断链）。
   */
  backfillShadowActuals(
    input: RecordActualsInput,
    receipt: ExecutionReceiptSummary,
    ctx?: OrgContext,
  ): void {
    const shadow = this.shadowEvaluatorService;
    if (!shadow) return;
    // 默认 canary=0 → 无采样窗口，无需回填/评估（接线前的行为逐字节保持）。
    if (shadow.getCanaryFraction(ctx) <= 0) return;
    // 回执未命中任何行 = 没有真实执行事实可回填（不伪造 actual）。
    if (!receipt || receipt.matchedRows <= 0) return;
    if (!input.planId) return;
    const actualMs = this.actualDurationMs(input.actualStart, input.actualEnd);
    if (actualMs == null) return;
    const correlationId = shadowCorrelationId(input.planId, input.assignmentId, input.taskId);
    if (!correlationId) return;

    try {
      const matched = shadow.backfillActual(
        SHADOW_PREDICTION_TYPE,
        actualMs,
        // 关联键存在时 createdAt 仅作末位回退键（两侧都不会用到）；用真实回执时间而非 now，
        // 保持"回填时间"永远是真实事件时间。
        this.toIso(input.actualEnd),
        ctx,
        { taskId: input.taskId ?? undefined, correlationId },
      );
      if (!matched) {
        this.logger.debug(
          `shadow backfill missed for ${correlationId}（无对应未回填样本，静默跳过）`,
        );
        return;
      }
      // 窗口聚合 + 阈值判定：误差/回退率/覆盖率超限 → canary 归 0（advisory-only）。
      const verdict = shadow.evaluateCanary(undefined, ctx);
      if (verdict.rolledBack) {
        this.logger.warn(
          `shadow canary auto-rollback (plan ${input.planId}): ${verdict.reasons.join('; ')}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `shadow backfill skipped for ${correlationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 实际执行时长（ms）：actualEnd − actualStart；任一端缺失或倒序 → null（不补 0、不猜）。 */
  private actualDurationMs(
    start?: Date | string | null,
    end?: Date | string | null,
  ): number | null {
    const s = start instanceof Date ? start.getTime() : start ? Date.parse(start) : NaN;
    const e = end instanceof Date ? end.getTime() : end ? Date.parse(end) : NaN;
    if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
    const durationMs = e - s;
    return durationMs >= 0 ? durationMs : null;
  }

  /** Date/ISO 字符串 → ISO 字符串；缺失 → ''（调用方仅在关联键存在时使用）。 */
  private toIso(value?: Date | string | null): string {
    if (value instanceof Date) return value.toISOString();
    return value ?? '';
  }

  /** 读取指定 plan 的反馈行（离线评估视图）。 */
  async listForPlan(planId: string): Promise<SchedulingFeedback[]> {
    const rows = await this.db
      .select()
      .from(ewohSchedulingFeedback)
      .where(eq(ewohSchedulingFeedback.planId, planId));
    return rows.map((r) => this.toFeedback(r));
  }

  /**
   * 全部反馈行（离线评估视图）。NEST-108：HTTP 上下文强制 orgId。
   * R2-SSV-26（2026-08-17）：globalScope 显式放行全局聚合（scope=ALL 语义，
   * 供无 primaryOrgId 的 global_admin 跨租户运维视角；非 global 调用方不变）。
   */
  async list(
    orgId?: string | null,
    opts?: { globalScope?: boolean },
  ): Promise<SchedulingFeedback[]> {
    // NEST-108 修复（2026-08-17）：HTTP 请求上下文内 orgId 必传（无 org 即
    // 全表反馈暴露）；系统后台流（无 request context）保持全量系统语义。
    if (!orgId && !opts?.globalScope && currentRequestContext()) {
      throw new BadRequestException(
        'orgId required for feedback listing（NEST-108）',
      );
    }
    // ADR-073：feedback 读面 org 条件（org 匹配或 NULL 存量；RLS 语义等价）。
    const rows = orgId
      ? await this.db
          .select()
          .from(ewohSchedulingFeedback)
          .where(
            or(
              isNull(ewohSchedulingFeedback.orgId),
              eq(ewohSchedulingFeedback.orgId, orgId),
            ),
          )
      : await this.db.select().from(ewohSchedulingFeedback);
    return rows.map((r) => this.toFeedback(r));
  }

  /**
   * 由反馈表派生调度 KPI（acceptanceRate / overrideRate / fallbackRate / solverRuntime +
   * Phase 4 / P4-T1 扩展：on-time rate / mean+P95 lateness / total travel / workload imbalance /
   * plan churn / conflict rate / replan success rate）。输入缺省时显式 null 标注缺数据，不伪造。
   * R2-SSV-26：globalScope 显式放行全局聚合（同 list；global_admin 语义）。
   */
  async deriveKpis(
    orgId?: string | null,
    opts?: { globalScope?: boolean },
  ): Promise<SchedulingFeedbackKpis> {
    // NEST-108：同 list——HTTP 上下文内 orgId 必传（无认证调用不再全表 KPI）。
    if (!orgId && !opts?.globalScope && currentRequestContext()) {
      throw new BadRequestException(
        'orgId required for KPI derivation（NEST-108）',
      );
    }
    const rows = orgId
      ? await this.db
          .select()
          .from(ewohSchedulingFeedback)
          .where(
            or(
              isNull(ewohSchedulingFeedback.orgId),
              eq(ewohSchedulingFeedback.orgId, orgId),
            ),
          )
      : await this.db.select().from(ewohSchedulingFeedback);
    const total = rows.length;
    let accepted = 0;
    let rejected = 0;
    let overrideRows = 0;
    let fallbackRows = 0;
    let runtimeSum = 0;
    let runtimeCount = 0;
    let replanCount = 0;
    let conflictCount = 0;

    for (const r of rows) {
      if (r.accepted === true) accepted += 1;
      else if (r.accepted === false) rejected += 1;
      if ((r.overrideCount ?? 0) > 0) overrideRows += 1;
      if (r.solverFallback) fallbackRows += 1;
      if (r.solverRuntime != null) {
        runtimeSum += r.solverRuntime;
        runtimeCount += 1;
      }
      replanCount += r.replanCount ?? 0;
      conflictCount += r.conflictCount ?? 0;
    }

    const decided = accepted + rejected;

    // ---- Phase 4 / P4-T1：扩展 KPI（缺失数据显式 null） ----
    // on-time / lateness：需 plannedEnd + actualEnd 成对。
    const lateness: number[] = [];
    let onTime = 0;
    for (const r of rows) {
      if (!r.plannedEnd || !r.actualEnd) continue;
      const ms = r.actualEnd.getTime() - r.plannedEnd.getTime();
      lateness.push(ms);
      if (ms <= 0) onTime += 1;
    }
    const onTimeRate =
      lateness.length > 0 ? onTime / lateness.length : null;
    const sortedLateness = [...lateness].sort((a, b) => a - b);
    const meanLatenessMs =
      sortedLateness.length > 0
        ? sortedLateness.reduce((s, v) => s + v, 0) / sortedLateness.length
        : null;
    const p95LatenessMs =
      sortedLateness.length > 0
        ? sortedLateness[Math.min(
            Math.ceil(sortedLateness.length * 0.95) - 1,
            sortedLateness.length - 1,
          )]
        : null;

    // total travel：plannedTravel 为 etaSeconds 语义 → ms。
    const travelSeconds = rows
      .map((r) => r.plannedTravel)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const totalTravelMs =
      travelSeconds.length > 0
        ? travelSeconds.reduce((s, v) => s + v, 0) * 1000
        : null;

    // workload imbalance：同 person 的任务数 max-min（>=2 人数据才有意义）。
    const perPerson = new Map<string, number>();
    for (const r of rows) {
      const pid = (r.originalResourceJson as { personId?: string | null } | null)?.personId;
      if (!pid) continue;
      perPerson.set(pid, (perPerson.get(pid) ?? 0) + 1);
    }
    const personCounts = [...perPerson.values()];
    const workloadImbalance =
      personCounts.length >= 2
        ? Math.max(...personCounts) - Math.min(...personCounts)
        : null;

    // plan churn：Σ replanCount（重排次数代理）。
    const planChurn = replanCount > 0 ? replanCount : null;

    // conflict rate：Σ conflictCount / totalFeedback（每方案平均冲突数）。
    const conflictRate = total > 0 ? conflictCount / total : null;

    // replan success rate：重排过的行中 accepted=true 占比。
    const replanRows = rows.filter((r) => (r.replanCount ?? 0) > 0);
    const replanAccepted = replanRows.filter((r) => r.accepted === true).length;
    const replanSuccessRate =
      replanRows.length > 0 ? replanAccepted / replanRows.length : null;

    return {
      totalFeedback: total,
      accepted,
      rejected,
      pendingAcceptance: total - decided,
      acceptanceRate: decided > 0 ? accepted / decided : 0,
      overrideRate: total > 0 ? overrideRows / total : 0,
      fallbackRate: total > 0 ? fallbackRows / total : 0,
      solverRuntimeMs: runtimeCount > 0 ? runtimeSum / runtimeCount : 0,
      replanCount,
      conflictCount,
      onTimeRate,
      meanLatenessMs,
      p95LatenessMs,
      totalTravelMs,
      workloadImbalance,
      planChurn,
      conflictRate,
      replanSuccessRate,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private isFallbackStatus(status?: string): boolean {
    if (!status) return false;
    return ['UNAVAILABLE', 'FALLBACK', 'TIMEOUT', 'INFEASIBLE'].includes(
      status.toUpperCase(),
    );
  }

  private toFeedback(
    r: typeof ewohSchedulingFeedback.$inferSelect,
  ): SchedulingFeedback {
    return {
      feedbackId: r.feedbackId,
      runId: r.runId ?? null,
      planId: r.planId,
      taskId: r.taskId ?? null,
      assignmentId: r.assignmentId ?? null,
      plannedStart: r.plannedStart ? r.plannedStart.toISOString() : null,
      actualStart: r.actualStart ? r.actualStart.toISOString() : null,
      plannedEnd: r.plannedEnd ? r.plannedEnd.toISOString() : null,
      actualEnd: r.actualEnd ? r.actualEnd.toISOString() : null,
      plannedTravel: r.plannedTravel ?? null,
      actualTravel: r.actualTravel ?? null,
      plannedWait: r.plannedWait ?? null,
      actualWait: r.actualWait ?? null,
      originalResource: (r.originalResourceJson ?? null) as unknown as SchedulingFeedbackResource | null,
      actualResource: (r.actualResourceJson ?? null) as unknown as SchedulingFeedbackResource | null,
      replanCount: r.replanCount ?? 0,
      conflictCount: r.conflictCount ?? 0,
      overrideCount: r.overrideCount ?? 0,
      solverRuntime: r.solverRuntime ?? null,
      solverFallback: r.solverFallback ?? false,
      accepted: r.accepted ?? null,
      ts: r.ts ? r.ts.toISOString() : new Date().toISOString(),
    };
  }

}
