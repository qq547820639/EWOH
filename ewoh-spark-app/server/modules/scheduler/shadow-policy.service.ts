import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, isNull, or } from 'drizzle-orm';
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
import { SchedulingPolicyService } from './scheduling-policy.service';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
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
    // R2-SSV-03：shadow plan 落库与 isShadow 标记同事务（可空；直构测试回退补偿路径）。
    @Optional() private readonly requestDatabaseContext?: RequestDatabaseContext,
    // T8（2026-08-28）：setStatus 会改写 ewohSchedulingPolicy 行（status 字段），
    // activeRowCache 缓存的是整行快照，写后需失效。@Optional 保持直构测试兼容。
    @Optional() private readonly policyService?: SchedulingPolicyService,
  ) {}

  /**
   * 将策略置为 SHADOW（DRAFT → SHADOW；ACTIVE 不可直接进 SHADOW——需先 DRAFT）。
   * NEST-115（2026-08-17）：策略读取/更新带 org 条件（跨租户 configVersion 404；
   * configVersion 按 org 作用域递增，仅凭版本号会命中他租户行）。
   */
  async setStatus(
    configVersion: number,
    status: SchedulingPolicyStatus,
    operator?: string,
    ctx?: OrgContext,
  ): Promise<void> {
    const orgScope = this.policyOrgScope(ctx);
    const [row] = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(
        orgScope
          ? and(eq(ewohSchedulingPolicy.configVersion, configVersion), orgScope)
          : eq(ewohSchedulingPolicy.configVersion, configVersion),
      )
      .limit(1);
    if (!row) throw new NotFoundException(`policy v${configVersion} not found`);

    if (row.active && status === 'SHADOW') {
      throw new ConflictException(
        `policy v${configVersion} is ACTIVE; cannot enter SHADOW directly (must DRAFT → SHADOW)`,
      );
    }
    if (status === 'ACTIVE') {
      throw new ConflictException('use PolicyActivationService.activate (gate + human approval) to activate');
    }
    await this.db
      .update(ewohSchedulingPolicy)
      .set({ status, updatedBy: operator ?? null, updatedAt: new Date() })
      .where(
        orgScope
          ? and(eq(ewohSchedulingPolicy.configVersion, configVersion), orgScope)
          : eq(ewohSchedulingPolicy.configVersion, configVersion),
      );
    // T8（2026-08-28）：activeRowCache 缓存的是整行快照（含 status），
    // 本方法改写 status 后需失效，避免 TTL 窗口内读到旧行。orgId 提取
    // 对齐 policyOrgScope（ctx.primaryOrgId）。
    this.policyService?.invalidateActiveRowCache(ctx?.primaryOrgId?.trim() ?? null);
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
    // NEST-115：策略读取带 org 条件（跨租户 shadow 版本 404）。
    const orgScope = this.policyOrgScope(ctx);
    const [policyRow] = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(
        orgScope
          ? and(
              eq(ewohSchedulingPolicy.configVersion, shadowPolicyVersion),
              orgScope,
            )
          : eq(ewohSchedulingPolicy.configVersion, shadowPolicyVersion),
      )
      .limit(1);
    if (!policyRow) throw new NotFoundException(`shadow policy v${shadowPolicyVersion} not found`);
    if (policyRow.status !== 'SHADOW') {
      throw new ConflictException(
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
    // R2-SSV-03（2026-08-17）：落库与 is_shadow 标记同事务原子化——此前
    // persistPlan 成功后标记 UPDATE 失败/进程崩溃会残留一条 is_shadow=false
    // 的"裸" shadow 方案（可审批/可派工，guardShadowPlan 仅检查 is_shadow
    // 字段即被绕过）。经 RequestDatabaseContext 包裹后 persistPlan 的嵌套
    // runInTransaction 复用同一事务（一请求一事务）；无 context（直构测试）
    // 时回退补偿路径：标记失败即删除该 plan 行，绝不留裸 shadow 方案。
    const persistAndMarkShadow = async (): Promise<void> => {
      await this.planService.persistPlan({ ...shadow, planId: shadowPlanId }, ctx);
      await this.db
        .update(ewohSchedulePlan)
        .set({ isShadow: true, shadowPolicyVersion, updatedAt: new Date() })
        .where(eq(ewohSchedulePlan.planId, shadowPlanId));
    };
    if (this.requestDatabaseContext) {
      await this.requestDatabaseContext.runInTransaction(
        buildGucSettings(ctx ?? { userId: 'system', primaryOrgId: '' }),
        persistAndMarkShadow,
      );
    } else {
      try {
        await persistAndMarkShadow();
      } catch (err) {
        this.logger.error(
          `shadow plan mark failed; compensating by deleting unmarked plan ${shadowPlanId}`,
          err instanceof Error ? err.stack : String(err),
        );
        try {
          await this.db
            .delete(ewohSchedulePlan)
            .where(eq(ewohSchedulePlan.planId, shadowPlanId));
        } catch (cleanupErr) {
          this.logger.error(
            `shadow plan compensation delete failed for ${shadowPlanId}（残留未标记方案，需人工清理）`,
            cleanupErr instanceof Error ? (cleanupErr as Error).stack : String(cleanupErr),
          );
        }
        throw err;
      }
    }

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

  /**
   * Shadow Plan 服务端 hard guard（供 plan.service 调用）：is_shadow plan 拒绝业务动作。
   * NEST-115（2026-08-17）：plan 读取带 org 条件（orgId 提供时）。
   */
  async guardShadowPlan(
    planId: string,
    action: 'approve' | 'dispatch' | 'reserve',
    orgId?: string | null,
  ): Promise<void> {
    const [planRow] = await this.db
      .select()
      .from(ewohSchedulePlan)
      .where(
        orgId
          ? and(
              eq(ewohSchedulePlan.planId, planId),
              or(
                isNull(ewohSchedulePlan.orgId),
                eq(ewohSchedulePlan.orgId, orgId),
              ),
            )
          : eq(ewohSchedulePlan.planId, planId),
      )
      .limit(1);
    if (planRow && planRow.isShadow) {
      throw new ConflictException(
        `SHADOW_PLAN_GUARD: shadow plan ${planId} cannot be ${action} (shadow plans are not dispatchable/reservable)`,
      );
    }
  }

  /** NEST-115：策略表 org 作用域条件（本 org + NULL 全局行；缺省 undefined）。 */
  private policyOrgScope(ctx?: OrgContext) {
    const orgId = ctx?.primaryOrgId?.trim();
    return orgId
      ? or(
          eq(ewohSchedulingPolicy.orgId, orgId),
          isNull(ewohSchedulingPolicy.orgId),
        )
      : undefined;
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
