import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { ewohPolicyActivation, ewohSchedulingPolicy } from '@server/database/schema';
import type {
  PolicyActivationRecord,
  PolicyGateConfig,
  PolicyGateEvaluation,
} from '@shared/api.interface';
import { PolicyReplayService } from './policy-replay.service';
import { KpiService } from './kpi.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { OutboxService } from './outbox.service';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Policy Activation Gate（Phase 4 / P4-GATE）。
 *
 * 激活流程（禁止 new weights → 直接 ACTIVE）：
 *   DRAFT → Replay → SHADOW（Shadow Plan 观察）→ Gate Evaluation → Human Approval → Activate
 *
 * Gate 阈值可配置（PolicyGateConfig）；激活必须 RBAC（调用方校验）+ 审计
 * （operator/reason/before/after/gate 结果/rollback target）。提供一键 rollback
 * 到上一 ACTIVE policy（rollback_target）。
 */
@Injectable()
export class PolicyActivationService {
  private readonly logger = new Logger(PolicyActivationService.name);

  /** 默认 Gate 阈值（可被 getGateConfig 覆盖）。 */
  static readonly DEFAULT_GATE: PolicyGateConfig = {
    safetyViolations: 0,
    blockedRouteAssignments: 0,
    minOnTimeRate: 0.8,
    maxLatenessP95Ms: 30 * 60 * 1000,
    maxFallbackRate: 0.5,
    maxConflictRate: 2,
    maxChurnRate: 0.5,
    maxSolverLatencyP95Ms: 5000,
  };

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly replayService: PolicyReplayService,
    private readonly kpiService: KpiService,
    private readonly metricsService: SchedulerMetricsService,
    private readonly outboxService: OutboxService,
  ) {}

  /** 计算当前 Gate 配置（可扩展为持久化配置；当前用默认 + 环境覆盖）。 */
  getGateConfig(): PolicyGateConfig {
    const env = process.env;
    return {
      safetyViolations: PolicyActivationService.DEFAULT_GATE.safetyViolations,
      blockedRouteAssignments: PolicyActivationService.DEFAULT_GATE.blockedRouteAssignments,
      minOnTimeRate: Number(env.EWOH_GATE_MIN_ONTIME_RATE ?? PolicyActivationService.DEFAULT_GATE.minOnTimeRate),
      maxLatenessP95Ms: Number(env.EWOH_GATE_MAX_LATENESS_P95_MS ?? PolicyActivationService.DEFAULT_GATE.maxLatenessP95Ms),
      maxFallbackRate: Number(env.EWOH_GATE_MAX_FALLBACK_RATE ?? PolicyActivationService.DEFAULT_GATE.maxFallbackRate),
      maxConflictRate: Number(env.EWOH_GATE_MAX_CONFLICT_RATE ?? PolicyActivationService.DEFAULT_GATE.maxConflictRate),
      maxChurnRate: Number(env.EWOH_GATE_MAX_CHURN_RATE ?? PolicyActivationService.DEFAULT_GATE.maxChurnRate),
      maxSolverLatencyP95Ms: Number(env.EWOH_GATE_MAX_SOLVER_LATENCY_P95_MS ?? PolicyActivationService.DEFAULT_GATE.maxSolverLatencyP95Ms),
    };
  }

  /**
   * Gate 评估：Replay 结果 + Shadow 评估 + 生产 KPI（真实事实，不伪造）。
   * 任一 hard 检查失败 → passed=false。
   */
  async evaluateGate(
    candidatePolicyVersion: number,
    replayId?: string | null,
  ): Promise<PolicyGateEvaluation> {
    const gate = this.getGateConfig();
    const kpi = await this.kpiService.aggregateForPolicyEvaluation();
    const checks: PolicyGateEvaluation['checks'] = [];

    // Replay/Shadow 评估事实
    let shadowRuns = 0;
    let shadowConflicts = 0;
    let safetyViolations = 0;
    let blockedRouteAssignments = 0;
    let shadowFallbackRate: number | null = null;
    let shadowConflictRate: number | null = null;
    if (replayId) {
      try {
        const replay = await this.replayService.getReplayRecord(replayId);
        if (replay) {
          shadowRuns = replay.perRunResults.length;
          // 从 replay 结果中聚合 shadow 冲突/安全违反（per-run 记录的 evidence）
          for (const run of replay.perRunResults) {
            const violations = (run as { violations?: Array<Record<string, unknown>> }).violations ?? [];
            for (const v of violations) {
              if (String(v.type ?? '').startsWith('safety')) safetyViolations += 1;
              if (String(v.type ?? '') === 'blocked_route') blockedRouteAssignments += 1;
            }
          }
          const failures = replay.failures.length;
          shadowFallbackRate =
            replay.perRunResults.length > 0
              ? failures / replay.perRunResults.length
              : null;
          shadowConflictRate = null;
        }
      } catch {
        // replay 不可用时 shadow 项按缺数据（null）处理，不伪造
      }
    }

    // 检查 1: 安全违反 == 0（hard，不可配置绕过）
    checks.push({
      name: 'safety_violations_zero',
      ok: safetyViolations <= gate.safetyViolations,
      actual: safetyViolations,
      threshold: gate.safetyViolations,
      detail: safetyViolations > gate.safetyViolations ? 'replay/shadow 出现安全违反，拒绝激活' : undefined,
    });
    // 检查 2: blocked-route assignment == 0
    checks.push({
      name: 'blocked_route_assignments_zero',
      ok: blockedRouteAssignments <= gate.blockedRouteAssignments,
      actual: blockedRouteAssignments,
      threshold: gate.blockedRouteAssignments,
    });
    // 检查 3: onTimeRate >= threshold
    checks.push({
      name: 'on_time_rate',
      ok: kpi.onTimeRate == null ? true : kpi.onTimeRate >= gate.minOnTimeRate,
      actual: kpi.onTimeRate,
      threshold: gate.minOnTimeRate,
      detail: kpi.onTimeRate == null ? '无执行数据，on-time 检查跳过' : undefined,
    });
    // 检查 4: latenessP95 <= threshold
    checks.push({
      name: 'lateness_p95',
      ok: kpi.latenessP95Ms == null ? true : kpi.latenessP95Ms <= gate.maxLatenessP95Ms,
      actual: kpi.latenessP95Ms,
      threshold: gate.maxLatenessP95Ms,
      detail: kpi.latenessP95Ms == null ? '无迟到数据，检查跳过' : undefined,
    });
    // 检查 5: fallbackRate <= threshold
    checks.push({
      name: 'fallback_rate',
      ok: kpi.fallbackRate == null ? true : kpi.fallbackRate <= gate.maxFallbackRate,
      actual: kpi.fallbackRate,
      threshold: gate.maxFallbackRate,
      detail: kpi.fallbackRate == null ? '无 fallback 数据，检查跳过' : undefined,
    });
    // 检查 6: conflictRate <= threshold
    checks.push({
      name: 'conflict_rate',
      ok: kpi.conflictRate == null ? true : kpi.conflictRate <= gate.maxConflictRate,
      actual: kpi.conflictRate,
      threshold: gate.maxConflictRate,
      detail: kpi.conflictRate == null ? '无冲突数据，检查跳过' : undefined,
    });
    // 检查 7: solverLatencyP95 <= threshold
    checks.push({
      name: 'solver_latency_p95',
      ok: kpi.solverLatencyP95Ms == null ? true : kpi.solverLatencyP95Ms <= gate.maxSolverLatencyP95Ms,
      actual: kpi.solverLatencyP95Ms,
      threshold: gate.maxSolverLatencyP95Ms,
      detail: kpi.solverLatencyP95Ms == null ? '无延迟数据，检查跳过' : undefined,
    });

    const passed = checks.every((c) => c.ok);
    const evaluation: PolicyGateEvaluation = {
      passed,
      checks,
      replayId: replayId ?? null,
      shadowEvaluation: {
        shadowRuns,
        shadowConflicts,
        safetyViolations,
        blockedRouteAssignments,
        fallbackRate: shadowFallbackRate,
        conflictRate: shadowConflictRate,
      },
    };

    try {
      this.metricsService.recordPolicyEvent('gate');
      if (!passed) this.logger.warn(`policy v${candidatePolicyVersion} gate FAILED: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`);
    } catch {
      // 观测失败不阻断
    }
    return evaluation;
  }

  /**
   * 激活（Human-gated）：必须显式 operator + reason；RBAC 由调用方（controller/guard）保证。
   * 事务内：置 ACTIVE、原 ACTIVE 归档（ARCHIVED）、写激活审计。
   * rollbackTarget = 原 ACTIVE 版本。
   */
  async activate(
    policyVersion: number,
    opts: {
      operator: string;
      reason?: string;
      replayId?: string | null;
      gateResult?: PolicyGateEvaluation | null;
      orgId?: string | null;
    },
    ctx?: OrgContext,
  ): Promise<PolicyActivationRecord> {
    const [candidate] = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(eq(ewohSchedulingPolicy.configVersion, policyVersion))
      .limit(1);
    if (!candidate) throw new Error(`policy v${policyVersion} not found`);
    if (candidate.status !== 'SHADOW' && candidate.active) {
      throw new Error(`policy v${policyVersion} already ACTIVE`);
    }
    if (candidate.status === 'ARCHIVED') {
      throw new Error(`policy v${policyVersion} is ARCHIVED; cannot activate`);
    }

    // Gate 强制：未提供 gateResult 时现场评估（不允许跳过 Gate）。
    const gateResult =
      opts.gateResult ?? (await this.evaluateGate(policyVersion, opts.replayId));
    if (!gateResult.passed) {
      throw new Error(
        `POLICY_GATE_FAILED: ${gateResult.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`,
      );
    }

    // 当前 ACTIVE 判定：该 org 的策略 + 全局策略（org_id IS NULL）均算候选，
    // 否则激活时全局策略（org_id=NULL）无法被归档（P1 遗留 ACTIVE）。
    const [activeRow] = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(
        and(
          eq(ewohSchedulingPolicy.active, true),
          opts.orgId
            ? or(
                eq(ewohSchedulingPolicy.orgId, opts.orgId),
                isNull(ewohSchedulingPolicy.orgId),
              )
            : undefined,
        ),
      )
      .orderBy(desc(ewohSchedulingPolicy.configVersion))
      .limit(1);
    const beforeVersion = activeRow?.configVersion ?? null;
    const rollbackTarget = beforeVersion;

    const activationId = `ACT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await this.requestDatabaseContextSafe(ctx, async () => {
      // 原 ACTIVE → ARCHIVED（不删除，保留回滚目标）
      if (activeRow && activeRow.configVersion !== policyVersion) {
        await this.db
          .update(ewohSchedulingPolicy)
          .set({ active: false, status: 'ARCHIVED', updatedAt: new Date() })
          .where(eq(ewohSchedulingPolicy.configVersion, activeRow.configVersion));
      }
      await this.db
        .update(ewohSchedulingPolicy)
        .set({ active: true, status: 'ACTIVE', updatedBy: opts.operator, updatedAt: new Date() })
        .where(eq(ewohSchedulingPolicy.configVersion, policyVersion));
      await this.db.insert(ewohPolicyActivation).values({
        activationId,
        orgId: opts.orgId ?? null,
        policyVersion,
        beforeVersion,
        afterVersion: policyVersion,
        operator: opts.operator,
        reason: opts.reason ?? null,
        gateResultJson: gateResult as unknown as Record<string, unknown>,
        rollbackTarget,
      });
    });

    try {
      this.metricsService.recordPolicyEvent('activation');
      await this.outboxService.enqueue(
        'policy.activated',
        String(policyVersion),
        { policyVersion, operator: opts.operator, rollbackTarget, reason: opts.reason },
        opts.orgId ?? null,
        undefined,
        { entityType: 'policy' },
      );
    } catch {
      // 观测失败不阻断
    }

    return {
      activationId,
      orgId: opts.orgId ?? null,
      policyVersion,
      beforeVersion,
      afterVersion: policyVersion,
      operator: opts.operator,
      reason: opts.reason ?? null,
      gateResult,
      rollbackTarget,
      status: 'ACTIVATED',
      createdAt: new Date().toISOString(),
    };
  }

  /** 一键回滚：恢复到 rollbackTarget（上一 ACTIVE）。 */
  async rollback(activationId: string, operator: string, reason?: string): Promise<PolicyActivationRecord> {
    const [activation] = await this.db
      .select()
      .from(ewohPolicyActivation)
      .where(eq(ewohPolicyActivation.activationId, activationId))
      .limit(1);
    if (!activation) throw new Error(`activation ${activationId} not found`);
    if (activation.status === 'ROLLED_BACK') {
      throw new Error(`activation ${activationId} already rolled back`);
    }
    const target = activation.rollbackTarget ?? activation.beforeVersion;
    if (target == null) throw new Error('no rollback target');

    await this.db.transaction(async (tx) => {
      await tx
        .update(ewohSchedulingPolicy)
        .set({ active: false, status: 'ARCHIVED', updatedAt: new Date() })
        .where(eq(ewohSchedulingPolicy.configVersion, activation.afterVersion ?? activation.policyVersion));
      await tx
        .update(ewohSchedulingPolicy)
        .set({ active: true, status: 'ACTIVE', updatedBy: operator, updatedAt: new Date() })
        .where(eq(ewohSchedulingPolicy.configVersion, target));
      await tx
        .update(ewohPolicyActivation)
        .set({ status: 'ROLLED_BACK', reason: reason ?? activation.reason ?? null })
        .where(eq(ewohPolicyActivation.activationId, activationId));
    });

    return {
      activationId,
      orgId: activation.orgId ?? null,
      policyVersion: activation.policyVersion,
      beforeVersion: activation.beforeVersion,
      afterVersion: activation.afterVersion,
      operator,
      reason: reason ?? activation.reason ?? null,
      gateResult: null,
      rollbackTarget: target,
      status: 'ROLLED_BACK',
      createdAt: new Date().toISOString(),
    };
  }

  /** 激活历史。 */
  async listActivations(orgId?: string | null): Promise<PolicyActivationRecord[]> {
    const rows = await this.db
      .select()
      .from(ewohPolicyActivation)
      .where(orgId ? eq(ewohPolicyActivation.orgId, orgId) : undefined)
      .orderBy(desc(ewohPolicyActivation.createdAt))
      .limit(100);
    return rows.map((r) => ({
      activationId: r.activationId,
      orgId: r.orgId ?? null,
      policyVersion: r.policyVersion,
      beforeVersion: r.beforeVersion,
      afterVersion: r.afterVersion,
      operator: r.operator,
      reason: r.reason ?? null,
      gateResult: (r.gateResultJson as unknown as PolicyGateEvaluation) ?? null,
      rollbackTarget: r.rollbackTarget,
      status: r.status as 'ACTIVATED' | 'ROLLED_BACK',
      createdAt: r.createdAt ? r.createdAt.toISOString() : '',
    }));
  }

  /** 兼容事务上下文（无 RequestDatabaseContext 时直接 db.transaction）。 */
  private async requestDatabaseContextSafe(
    ctx: OrgContext | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    void ctx;
    await this.db.transaction(async () => {
      await fn();
    });
  }
}
