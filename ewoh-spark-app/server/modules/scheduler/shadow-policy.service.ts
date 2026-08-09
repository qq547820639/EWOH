import { Inject, Injectable, Logger } from '@nestjs/common';
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
}
