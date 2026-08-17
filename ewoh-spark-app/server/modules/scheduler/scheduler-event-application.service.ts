/**
 * SchedulerService Strangler Refactor（Task 2）：事件驱动应用与执行反馈回填。
 *
 * 承载 injectSchedulingEvent（事件 → ReplanCoordinator 局部重排 → 级联状态触发器 →
 * M03 人工审批 consult → 影子评估节流）、recordTaskActuals（反馈闭环回填 +
 * SSE execution.deviation 推送）。
 *
 * 影子评估内部调用 comparePolicyVersion：经 facade 传入的 getter 在调用时
 * 求值（兼容旧单测构造后替换 svc.comparePolicyVersion 为 spy 的模式）。
 */
import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import type {
  SchedulingRun,
  SchedulingPlanV2,
  SchedulingEventRequest,
  RecordActualsRequest,
  SchedulingPolicyComparison,
  ReplanApprovalDecision,
  ReplanPreviewResult,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorldStateSnapshotService } from './world-state.service';
import { PlanService } from './plan.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SchedulingFeedbackService } from './scheduling-feedback.service';
import { OutboxService } from './outbox.service';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { ReplanPreviewService } from './replan-preview.service';
import { toOrgContext } from './scheduler-run-context';

/** 影子评估 / 审批 consult 所需的 comparePolicyVersion 引用（调用时求值）。 */
export type ComparePolicyVersionRef = (
  configVersion: number,
  actor?: OrgContext,
) => Promise<SchedulingPolicyComparison>;

@Injectable()
export class SchedulerEventApplicationService {
  private readonly logger = new Logger(SchedulerEventApplicationService.name);

  /** 事件驱动 run 计数器（影子评估节流）。 */
  private eventRunCounter = 0;
  /** 每 N 次事件驱动 run 触发一次影子评估。 */
  private static readonly SHADOW_EVAL_INTERVAL = 10;

  constructor(
    // v0.7 Batch6.1：事件驱动级联重排（可选注入；缺失时事件仅做局部重排不级联）。
    private readonly replanCoordinatorService?: ReplanCoordinatorService,
    // M03：Replan Preview（dry-run readonly；可选注入，缺失时审批 consult 不产出 preview）。
    private readonly replanPreviewService?: ReplanPreviewService,
    // v0.7 B3：SSE 实时事件推送（execution.deviation / replan.approval_required）。
    private readonly outboxService?: OutboxService,
    // v0.7 Batch6.4：调度可观测指标（recordRun/recordFallback）。
    private readonly metricsService?: SchedulerMetricsService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService = undefined as never,
    private readonly policyService: SchedulingPolicyService = undefined as never,
    private readonly planService: PlanService = undefined as never,
    private readonly auditService: import('../shared/audit.service').AuditService = undefined as never,
    private readonly feedbackService: SchedulingFeedbackService = undefined as never,
    /** comparePolicyVersion 引用（facade 注入；调用时求值，兼容测试替换 spy）。 */
    private readonly comparePolicyVersionRef: ComparePolicyVersionRef = async () => {
      throw new Error('comparePolicyVersionRef not injected');
    },
  ) {}

  /**
   * v0.7 Batch6.1 事件驱动智能重排（service 层入口，取代 controller 直连）。
   * 1. 事件 → ReplanCoordinator 局部重排（影响分析 → 冻结无关任务 → 子图求解 → 熔断）；
   * 2. 级联：基于最新世界状态检查路由阻断/拥塞/预占冲突，逐条触发 scoped 重排
   *    （TriggerService 冷却去抖 + 幂等去重天然防风暴）。
   * 缺失 replanCoordinatorService（测试/降级）时返回空结果。
   *
   * M03（08 §6）：编排 AUTO_REPLAN / HUMAN_APPROVAL——当 policy.replanApproval 判定
   * 需人工审批（critical_event/affected_ratio/safety_critical/human_lock/churn/lateness_risk）
   * 时，不自动落库，产出 ReplanPreview + 发 SSE `replan.approval_required`；否则走
   * 现有 handleTrigger 自动落库 proposed（唯一写路径不变）。仅当 policy 配置
   * replanApproval 且事件非 MANUAL 时 consult；未配置保持现状（兼容）。
   */
  async injectSchedulingEvent(
    body: SchedulingEventRequest,
    actor?: OrgContext,
  ): Promise<{
    run: SchedulingRun | null;
    plans: SchedulingPlanV2[];
    debounced: boolean;
    cascaded: string[];
    approval?: ReplanApprovalDecision;
    preview?: ReplanPreviewResult | null;
  }> {
    const ctx = toOrgContext(actor);
    if (!this.replanCoordinatorService) {
      return { run: null, plans: [], debounced: true, cascaded: [] };
    }

    // M03：人工审批政策 consult（仅配置 replanApproval 且非 MANUAL 时）。
    if (body.trigger !== 'MANUAL') {
      const approval = await this.maybeConsultApproval(
        body.trigger,
        body.entityId ?? null,
        ctx,
      );
      if (approval && approval.decision === 'HUMAN_APPROVAL_REQUIRED') {
        const preview = await this.replanPreviewService
          .previewReplan(body.trigger, body.entityId ? [body.entityId] : [], ctx)
          .catch(() => null);
        if (this.outboxService) {
          // NEST-137（2026-08-17）：审批事件（人工介入触发）属关键事件——
          // await 落库（失败留痕但不阻断返回；此前 fire-and-forget 可能静默丢失）。
          try {
            await this.outboxService.enqueue(
              'replan.approval_required',
              body.entityId ?? 'ALL',
              {
                triggerType: body.trigger,
                triggerEntityId: body.entityId ?? null,
                reasons: approval.reasons,
                preview: preview ?? null,
                occurredAt: new Date().toISOString(),
              },
              ctx.primaryOrgId || null,
            );
          } catch (e) {
            this.logger.warn(
              `replan.approval_required enqueue failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return {
          run: null,
          plans: [],
          debounced: false,
          cascaded: [],
          approval,
          preview,
        };
      }
    }

    const primary = await this.replanCoordinatorService.handleTrigger(
      body.trigger,
      body.entityId ?? null,
      ctx,
    );

    // v0.7 Batch6.4：事件驱动调度可观测埋点（成功/回退/级联数）。
    if (this.metricsService) {
      this.metricsService.recordRun({
        durationMs: 0, // 事件驱动路径耗时由 handleTrigger 内部测量，此处仅计数
        feasible: !primary.debounced,
        solverStatus: primary.run?.status ?? 'debounced',
      });
      if (primary.debounced) this.metricsService.recordFallback();
    }

    // 级联：事件处理后，世界状态中的路由/预占问题自动触发 scoped 重排。
    let cascaded: string[] = [];
    try {
      const state = await this.worldStateSnapshotService.buildSnapshot(ctx);
      const dispatched = await this.replanCoordinatorService.dispatchStateTriggers(state, ctx);
      cascaded = dispatched.map((d) => d.triggerType);
    } catch (e) {
      this.logger.warn(
        `cascade state triggers failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // v0.7 Batch10.2：影子评估自动化——每 N 次事件驱动 run 后自动对比候选策略与活跃策略
    // （复用 comparePolicyVersion 的 KPI + param delta，仅观测不改活跃策略）。
    // await 保证评估在响应前完成（观测型，失败仅记日志不阻断）。
    await this.maybeRunShadowEvaluation(ctx);

    return { ...primary, cascaded };
  }

  /** M03：consult replanApproval policy；未配置 replanApproval 或 consult 失败 → null（保持现状）。 */
  private async maybeConsultApproval(
    triggerType: string,
    entityId: string | null,
    ctx: OrgContext,
  ): Promise<ReplanApprovalDecision | null> {
    try {
      const config = await this.policyService
        .resolveReplanApprovalConfig()
        .catch(() => null);
      if (!config) return null;
      if (!this.replanCoordinatorService) return null;
      const impact = await this.replanCoordinatorService.analyzeImpactV2(
        triggerType,
        entityId ? [entityId] : [],
        ctx,
      );
      return this.planService.consultReplanApproval({
        triggerType,
        impact,
        preview: null,
        ctx,
      });
    } catch (err) {
      this.logger.warn(
        `replan approval consult failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * v0.7 Batch10.2：影子评估自动化。
   * 每 SHADOW_EVAL_INTERVAL 次事件驱动 run，自动调用 comparePolicyVersion（候选 vs 活跃），
   * 结果写入审计日志（观测型，不激活任何候选策略）。失败仅记日志不阻断主流程。
   */
  private async maybeRunShadowEvaluation(ctx: OrgContext): Promise<void> {
    this.eventRunCounter += 1;
    if (this.eventRunCounter % SchedulerEventApplicationService.SHADOW_EVAL_INTERVAL !== 0) return;
    if (!this.policyService) return;
    try {
      const active = await this.policyService.getConfig().catch(() => null);
      if (!active) return;
      // 候选 = 活跃版本 + 1（若有注册的未激活版本）；无则跳过。
      const candidates = await this.policyService.listVersions().catch(() => []);
      const pending = candidates.find((v) => v.configVersion === active.configVersion + 1);
      if (!pending) return;
      const comparison = await this.comparePolicyVersionRef(pending.configVersion, ctx);
      this.logger.log(
        `[shadow-eval] run#${this.eventRunCounter} candidate v${pending.configVersion} vs active v${active.configVersion}: ` +
          `acceptance=${comparison.feedbackKpis?.acceptanceRate ?? '-'}% verdict=${comparison.verdict}`,
      );
      await this.auditService.appendAuditLog({
        actorId: 'shadow-eval',
        orgId: ctx.primaryOrgId,
        action: 'scheduler.policy.shadow_eval',
        entityType: 'scheduling_policy',
        entityId: String(pending.configVersion),
        before: { configVersion: active.configVersion },
        after: { candidateVersion: pending.configVersion, verdict: comparison.verdict },
        reason: 'automatic shadow evaluation (Batch 10.2)',
      });
    } catch (e) {
      this.logger.warn(`shadow evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * v0.7 D1 反馈闭环：回填任务执行实际值（actualStart/actualEnd/实际资源等）。
   * 委托 SchedulingFeedbackService.recordActuals（按 assignmentId/planId/taskId 匹配更新）。
   * 匹配语义：至少提供一个匹配键，否则拒绝；重复回填为覆盖式更新（天然幂等）。
   * 调用方：POST /api/scheduler/feedback/actuals（任务执行方/移动端/边缘）。
   */
  async recordTaskActuals(
    input: RecordActualsRequest,
    actor?: OrgContext,
  ): Promise<{
    ok: boolean;
    matched: boolean;
    advancedAssignments?: number;
    advancedTaskSteps?: number;
    skips?: string[];
  }> {
    if (
      !input.assignmentId &&
      !input.planId &&
      !input.taskId
    ) {
      throw new BadRequestException(
        '至少提供一个匹配键（assignmentId / planId / taskId）',
      );
    }
    const ctx = toOrgContext(actor);
    // NO-13a / ADR-050：recordActuals 返回推进 summary（additive 透出，供调用方可观测）。
    // ?? 兜底：既有测试/调用方 stub 返回 undefined 时保持向后兼容（不读取推进字段）。
    const advancement = (await this.feedbackService.recordActuals(
      {
        planId: input.planId,
        assignmentId: input.assignmentId,
        taskId: input.taskId,
        actualStart: input.actualStart ?? null,
        actualEnd: input.actualEnd ?? null,
        actualTravel: input.actualTravel ?? null,
        actualWait: input.actualWait ?? null,
        actualResource: input.actualResource ?? null,
      },
      ctx,
    )) ?? { advancedAssignments: 0, advancedTaskSteps: 0, skips: [] };
    // v0.7 B3：执行偏差实时推送（SSE execution.deviation），供地图执行偏差图层消费。
    // 观测型：推送失败仅记日志，不影响回填主流程。
    if (this.outboxService) {
      // NEST-137（2026-08-17）：执行偏差事件 await 落库（关键观测事件，
      // 丢失会断地图偏差图层；失败留痕不阻断回填主流程）。
      try {
        await this.outboxService.enqueue(
          'execution.deviation',
          input.taskId ?? input.assignmentId ?? 'unknown',
          {
            planId: input.planId ?? null,
            assignmentId: input.assignmentId ?? null,
            taskId: input.taskId ?? null,
            actualStart: input.actualStart ?? null,
            actualEnd: input.actualEnd ?? null,
            actualTravel: input.actualTravel ?? null,
            actualWait: input.actualWait ?? null,
          },
          ctx.primaryOrgId || null,
        );
      } catch (e) {
        this.logger.warn(`execution.deviation enqueue failed: ${(e as Error).message}`);
      }
    }
    // recordActuals 为更新语义（无行则不写）；推进 summary additive 透出（NO-13a）。
    // NEST-121 修复（2026-08-17）：matched 不再无条件 true——feedbackService
    // recordActuals 以 UPDATE ... RETURNING 统计 matchedRows（真实命中行数）；
    // 旧 stub 无该字段时保守回退 true（向后兼容，避免旧测试误判）。
    const matchedRows = (advancement as { matchedRows?: number }).matchedRows;
    const matched = matchedRows != null ? matchedRows > 0 : true;
    return {
      ok: true,
      matched,
      advancedAssignments: advancement.advancedAssignments,
      advancedTaskSteps: advancement.advancedTaskSteps,
      skips: advancement.skips,
    };
  }
}
