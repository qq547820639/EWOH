import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { ewohSchedulingPolicy, ewohSchedulePlan } from '@server/database/schema';
import type {
  PlanCompareResult,
  SchedulingPlanV2,
  SchedulingPolicy,
  SchedulingPolicyStatus,
} from '@shared/api.interface';
import { WorldStateSnapshotService } from './world-state.service';
import { SolverService } from './solver.service';
import { PlanService } from './plan.service';
import { PlanCompareService } from './plan-compare.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { OutboxService } from './outbox.service';
import { ShadowEvaluatorService } from './prediction/shadow-evaluator.service';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Shadow Policy（Phase 4 / P4-SHADOW）。
 *
 * - 真实 Scheduling Trigger 下：Active Policy → Production Plan；Shadow Policy → Shadow Plan。
 * - Shadow Plan 以 is_shadow=true 落库（DB 层标识），服务端 hard guard：
 *   plan.service 的 approve/dispatch 与 reservation 均拒绝 shadow plan——
 *   不靠前端隐藏按钮（见 plan.service ShadowPlanGuard）。
 * - Shadow Plan 产出 comparison（与 active 方案对比）供 Gate 评估。
 */
@Injectable()
export class ShadowPolicyService {
  private readonly logger = new Logger(ShadowPolicyService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly solverService: SolverService,
    private readonly planService: PlanService,
    private readonly planCompareService: PlanCompareService,
    private readonly metricsService: SchedulerMetricsService,
    private readonly outboxService: OutboxService,
    // Task 6 / P1：canary 归属服务（可空；未注入时分歧仅记录，不回滚）。
    @Optional() private readonly shadowEvaluatorService?: ShadowEvaluatorService,
  ) {}

  /** 将策略置为 SHADOW（DRAFT → SHADOW；ACTIVE 不可直接进 SHADOW——需先 DRAFT）。 */
  async setStatus(
    configVersion: number,
    status: SchedulingPolicyStatus,
    operator?: string,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(eq(ewohSchedulingPolicy.configVersion, configVersion))
      .limit(1);
    if (!row) throw new Error(`policy v${configVersion} not found`);

    if (row.active && status === 'SHADOW') {
      throw new Error(
        `policy v${configVersion} is ACTIVE; cannot enter SHADOW directly (must DRAFT → SHADOW)`,
      );
    }
    if (status === 'ACTIVE') {
      throw new Error('use PolicyActivationService.activate (gate + human approval) to activate');
    }
    await this.db
      .update(ewohSchedulingPolicy)
      .set({ status, updatedBy: operator ?? null, updatedAt: new Date() })
      .where(eq(ewohSchedulingPolicy.configVersion, configVersion));
    void operator;
  }

  /**
   * 在真实世界快照上生成 Shadow Plan（不可派工）。
   * shadowPolicyVersion 标记策略版本；is_shadow=true 落库。
   * 返回 shadow plan + 与 active baseline 的 compare。
   */
  async generateShadowPlan(
    shadowPolicyVersion: number,
    ctx?: OrgContext,
  ): Promise<{
    shadowPlan: SchedulingPlanV2;
    compare: PlanCompareResult | null;
  }> {
    const [policyRow] = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(eq(ewohSchedulingPolicy.configVersion, shadowPolicyVersion))
      .limit(1);
    if (!policyRow) throw new Error(`shadow policy v${shadowPolicyVersion} not found`);
    if (policyRow.status !== 'SHADOW') {
      throw new Error(
        `policy v${shadowPolicyVersion} is not SHADOW (status=${policyRow.status}); shadow plan requires SHADOW policy`,
      );
    }

    const snapshot = await this.worldStateSnapshotService.buildSnapshot(ctx);
    const shadowPlanId = `SHADOW-${shadowPolicyVersion}-${Date.now()}`;
    // 与 production plan 同求解语义（SolverService），仅策略取 shadow 版本。
    const plans = await this.solverService.solveVariants(snapshot, [], {
      planId: shadowPlanId,
      planName: `shadow-v${shadowPolicyVersion}`,
      triggerType: 'MANUAL',
      triggerEntityId: null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      policy: policyRow as unknown as SchedulingPolicy,
    });
    const shadow = plans[0];
    // 落库并标记 is_shadow=true + shadow_policy_version（DB 层标识，服务端 guard 依据）。
    await this.planService.persistPlan({ ...shadow, planId: shadowPlanId }, ctx);
    await this.db
      .update(ewohSchedulePlan)
      .set({ isShadow: true, shadowPolicyVersion, updatedAt: new Date() })
      .where(eq(ewohSchedulePlan.planId, shadowPlanId));

    // 对比 active baseline（若存在）
    let compare: PlanCompareResult | null = null;
    try {
      const active = await this.solverService.solveVariants(snapshot, [], {
        planId: `BASE-${shadowPolicyVersion}-${Date.now()}`,
        triggerType: 'MANUAL',
        triggerEntityId: null,
        snapshotVersion: snapshot.snapshotVersion,
        horizonMinutes: 480,
      });
      compare = this.planCompareService.compare(active[0], shadow);
    } catch (err) {
      this.logger.warn(`shadow compare skipped: ${(err as Error)?.message ?? err}`);
    }

    try {
      this.metricsService.recordPolicyEvent('shadow');
      await this.outboxService.enqueue(
        'policy.shadow.completed',
        shadowPlanId,
        {
          policyVersion: shadowPolicyVersion,
          shadowPlanId,
          compare: compare ? { churn: compare.churn, changeTypeCounts: compare.changeTypeCounts } : null,
        },
        null,
        undefined,
        { entityType: 'policy', snapshotVersion: snapshot.snapshotVersion },
      );
    } catch {
      // 观测失败不阻断
    }

    return { shadowPlan: shadow, compare };
  }

  /** Shadow Plan 服务端 hard guard（供 plan.service 调用）：is_shadow plan 拒绝业务动作。 */
  async guardShadowPlan(planId: string, action: 'approve' | 'dispatch' | 'reserve'): Promise<void> {
    const [planRow] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(eq(ewohSchedulePlan.planId, planId))
      .limit(1);
    if (planRow && planRow.isShadow) {
      throw new Error(
        `SHADOW_PLAN_GUARD: shadow plan ${planId} cannot be ${action} (shadow plans are not dispatchable/reservable)`,
      );
    }
  }

  /**
   * Task 6 / P1：SHADOW/CANARY 硬约束分歧检测 + canary 自动回滚。
   * 比较 production（heuristic）与 shadow（CP-SAT）的硬约束违例签名集合；任一侧出现对方
   * 没有的违例 → 硬约束分歧 → canary 自动归 0（复用 ShadowEvaluatorService 的 canary 模式：
   * setCanaryFraction(0) + 日志 + outbox 事件 policy.shadow.canary.rollback）。
   * 纯服务级方法（不接端点）；advisory-only，绝不改变生产方案。
   * 手动回滚已存在：ShadowEvaluatorService.setCanaryFraction（无需新增管理方法）。
   */
  async handleShadowCompareDivergence(
    productionPlan: SchedulingPlanV2,
    shadowPlan: SchedulingPlanV2,
    ctx?: OrgContext,
  ): Promise<{ diverged: boolean; reasons: string[]; canaryRolledBack: boolean }> {
    const productionSigs = this.violationSignatures(productionPlan.violations);
    const shadowSigs = this.violationSignatures(shadowPlan.violations);
    const productionOnly = [...productionSigs].filter((v) => !shadowSigs.has(v));
    const shadowOnly = [...shadowSigs].filter((v) => !productionSigs.has(v));
    const diverged = productionOnly.length > 0 || shadowOnly.length > 0;
    if (!diverged) {
      return { diverged: false, reasons: [], canaryRolledBack: false };
    }

    const reasons: string[] = [];
    if (productionOnly.length > 0) {
      reasons.push(`heuristic_only_violations:${productionOnly.join(',')}`);
    }
    if (shadowOnly.length > 0) {
      reasons.push(`cpsat_only_violations:${shadowOnly.join(',')}`);
    }

    let canaryRolledBack = false;
    if (this.shadowEvaluatorService) {
      try {
        this.shadowEvaluatorService.setCanaryFraction(0, ctx);
        canaryRolledBack = true;
      } catch (err) {
        this.logger.warn(
          `canary rollback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.warn(
      `SHADOW/CANARY divergence detected (plan=${shadowPlan.planId}): ${reasons.join('; ')}; canary reset to 0`,
    );

    // 审计事件（复用 outbox 模式：policy.shadow.completed → policy.shadow.canary.rollback）。
    try {
      this.metricsService.recordPolicyEvent('shadow');
      await this.outboxService.enqueue(
        'policy.shadow.canary.rollback',
        shadowPlan.planId,
        {
          policyVersion: shadowPlan.policyVersion,
          productionPlanId: productionPlan.planId,
          shadowPlanId: shadowPlan.planId,
          reasons,
          canaryRolledBack,
        },
        null,
        undefined,
        { entityType: 'policy', snapshotVersion: shadowPlan.snapshotVersion },
      );
    } catch (err) {
      this.logger.warn(
        `canary rollback event enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { diverged: true, reasons, canaryRolledBack };
  }

  /** 硬约束违例签名集合（type 优先；无 type 退化为整体序列化）。 */
  private violationSignatures(violations: Array<Record<string, unknown>>): Set<string> {
    const sigs = new Set<string>();
    for (const v of violations ?? []) {
      const t = typeof v === 'object' && v != null ? v['type'] : undefined;
      sigs.add(typeof t === 'string' && t ? `type:${t}` : `raw:${JSON.stringify(v)}`);
    }
    return sigs;
  }
}
