import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException, ConflictException, Optional } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { ewohPolicyActivation, ewohSchedulingPolicy } from '@server/database/schema';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type {
  PolicyActivationRecord,
  PolicyGateConfig,
  PolicyGateEvaluation,
} from '@shared/api.interface';
import { PolicyReplayService } from './policy-replay.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { KpiService } from './kpi.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import { OutboxService } from './outbox.service';
import { AuditService } from '../shared/audit.service';
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
    // NEST-033（2026-08-17）：策略写路径经 RequestDatabaseContext 事务 + GUC
    // （RLS 生效）；@Optional 保持既有直构测试（无 DB context）兼容。
    @Optional() private readonly requestDatabaseContext?: RequestDatabaseContext,
    // R2-SSV-24（2026-08-17）：rollback 审计留痕（@Optional 兼容直构测试）。
    @Optional() private readonly auditService?: AuditService,
    // T8（2026-08-28）：activate/rollback 会改写 ewohSchedulingPolicy.active，
    // 写后必须失效 SchedulingPolicyService 的 activeRowCache（30s TTL），
    // 否则其它请求最长 30s 读到旧 active 策略。@Optional 保持直构测试兼容。
    @Optional() private readonly policyService?: SchedulingPolicyService,
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
    orgId?: string | null,
  ): Promise<PolicyGateEvaluation> {
    const gate = this.getGateConfig();
    // R2-SSV-02（2026-08-17）：KPI 输入透传 orgId——HTTP gate 评估与 activate
    // 现场评估按调用租户作用域（此前无 org：HTTP 必 400 / 系统流全租户聚合）。
    const kpi = await this.kpiService.aggregateForPolicyEvaluation(orgId ?? null);
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
    // NEST-031 修复（2026-08-17）：HTTP 路径强制 orgId（无 org 的 ACTIVE 判定
    // 会跨租户选中他 org 行并归档）；系统后台流（无 request context）保持可选。
    // NEST-165 配套：configVersion 已按 org 作用域递增——candidate 查找也必须
    // 带 org 条件（否则可能命中他租户同版本号行）。
    const orgScope = opts.orgId
      ? or(
          eq(ewohSchedulingPolicy.orgId, opts.orgId),
          isNull(ewohSchedulingPolicy.orgId),
        )
      : isNull(ewohSchedulingPolicy.orgId);
    const [candidate] = await this.db
      .select()
      .from(ewohSchedulingPolicy)
      .where(
        and(eq(ewohSchedulingPolicy.configVersion, policyVersion), orgScope),
      )
      .limit(1);
    if (!candidate) throw new NotFoundException(`policy v${policyVersion} not found`);
    if (candidate.status !== 'SHADOW' && candidate.active) {
      throw new ConflictException(`policy v${policyVersion} already ACTIVE`);
    }
    if (candidate.status === 'ARCHIVED') {
      throw new ConflictException(`policy v${policyVersion} is ARCHIVED; cannot activate`);
    }

    // Gate 强制：未提供 gateResult 时现场评估（不允许跳过 Gate）。
    // R2-SSV-02：现场评估按 opts.orgId 作用域。
    const gateResult =
      opts.gateResult ??
      (await this.evaluateGate(policyVersion, opts.replayId, opts.orgId ?? null));
    if (!gateResult.passed) {
      throw new ConflictException(
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
            : isNull(ewohSchedulingPolicy.orgId),
        ),
      )
      .orderBy(desc(ewohSchedulingPolicy.configVersion))
      .limit(1);
    const beforeVersion = activeRow?.configVersion ?? null;
    const rollbackTarget = beforeVersion;

    // NEST-047（2026-08-17）：Date.now()+Math.random → randomUUID。
    const activationId = `ACT-${randomUUID()}`;
    await this.requestDatabaseContextSafe(ctx, async () => {
      // 原 ACTIVE → ARCHIVED（不删除，保留回滚目标）
      // R2-SSV-10：归档 UPDATE 叠加 active=true 谓词（并发激活下 0 行=他人
      // 已处理，不重复归档）。
      if (activeRow && activeRow.configVersion !== policyVersion) {
        await this.db
          .update(ewohSchedulingPolicy)
          .set({ active: false, status: 'ARCHIVED', updatedAt: new Date() })
          .where(
            and(
              eq(ewohSchedulingPolicy.configVersion, activeRow.configVersion),
              eq(ewohSchedulingPolicy.active, true),
              orgScope,
            ),
          );
      }
      // R2-SSV-10（2026-08-17）：激活 UPDATE CAS——目标行必须仍为
      // active=false（检查与更新之间并发双激活时，后到者 0 行命中）。
      // 0 行 → 409 并发激活（不再产生重复 activation 记录/审计/outbox）。
      const activatedRows = await this.db
        .update(ewohSchedulingPolicy)
        .set({ active: true, status: 'ACTIVE', updatedBy: opts.operator, updatedAt: new Date() })
        .where(
          and(
            eq(ewohSchedulingPolicy.configVersion, policyVersion),
            eq(ewohSchedulingPolicy.active, false),
            orgScope,
          ),
        )
        .returning({ id: ewohSchedulingPolicy.id });
      if (activatedRows.length === 0) {
        throw new ConflictException(
          `POLICY_CONCURRENT_ACTIVATION: v${policyVersion} concurrently activated（R2-SSV-10 CAS）`,
        );
      }
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

    // T8（2026-08-28）：activate 事务内已改写 ewohSchedulingPolicy.active
    // （归档旧 ACTIVE 行 + CAS 激活新行），写后主动失效 activeRowCache，
    // 避免其它请求在 TTL 窗口内读到旧 active 策略。
    this.policyService?.invalidateActiveRowCache(opts.orgId ?? null);

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

  /**
   * 一键回滚：恢复到 rollbackTarget（上一 ACTIVE）。
   * NEST-032 修复（2026-08-17）：activation 读取与策略 UPDATE 全部带 org 条件
   * （跨租户 activationId → 404；策略版本号按 org 作用域，仅凭 configVersion
   * 更新会命中他租户同版本行）。ctx 透传 GUC（NEST-033）。
   */
  async rollback(
    activationId: string,
    operator: string,
    reason?: string,
    ctx?: OrgContext,
  ): Promise<PolicyActivationRecord> {
    const orgId = ctx?.primaryOrgId || null;
    const [activation] = await this.db
      .select()
      .from(ewohPolicyActivation)
      .where(
        and(
          eq(ewohPolicyActivation.activationId, activationId),
          orgId
            ? or(
                eq(ewohPolicyActivation.orgId, orgId),
                isNull(ewohPolicyActivation.orgId),
              )
            : undefined,
        ),
      )
      .limit(1);
    if (!activation) throw new NotFoundException(`activation ${activationId} not found`);
    if (activation.status === 'ROLLED_BACK') {
      throw new ConflictException(`activation ${activationId} already rolled back`);
    }
    const target = activation.rollbackTarget ?? activation.beforeVersion;
    if (target == null) throw new ConflictException('no rollback target');

    // NEST-032/165：策略行更新按 org 作用域（本 org + NULL 全局行）。
    const policyOrgScope = orgId
      ? or(
          eq(ewohSchedulingPolicy.orgId, orgId),
          isNull(ewohSchedulingPolicy.orgId),
        )
      : undefined;
    await this.requestDatabaseContextSafe(ctx, async () => {
      // R2-SSV-10（2026-08-17）：rollback 串行化点——activation 行先以
      // status=ACTIVATED 谓词 CAS 置 ROLLED_BACK；0 行 = 并发 rollback/转移，
      // 409 终止（不再双发翻转生产策略）。策略翻转仅在其后执行。
      const casRows = await this.db
        .update(ewohPolicyActivation)
        .set({ status: 'ROLLED_BACK', reason: reason ?? activation.reason ?? null })
        .where(
          and(
            eq(ewohPolicyActivation.activationId, activationId),
            eq(ewohPolicyActivation.status, 'ACTIVATED'),
          ),
        )
        .returning({ id: ewohPolicyActivation.id });
      if (casRows.length === 0) {
        throw new ConflictException(
          `activation ${activationId} concurrently rolled back（R2-SSV-10 CAS）`,
        );
      }
      await this.db
        .update(ewohSchedulingPolicy)
        .set({ active: false, status: 'ARCHIVED', updatedAt: new Date() })
        .where(
          and(
            eq(
              ewohSchedulingPolicy.configVersion,
              activation.afterVersion ?? activation.policyVersion,
            ),
            policyOrgScope,
          ),
        );
      await this.db
        .update(ewohSchedulingPolicy)
        .set({ active: true, status: 'ACTIVE', updatedBy: operator, updatedAt: new Date() })
        .where(
          and(eq(ewohSchedulingPolicy.configVersion, target), policyOrgScope),
        );
    });

    // T8（2026-08-28）：rollback 事务内已改写 ewohSchedulingPolicy.active
    // （归档当前 ACTIVE + 重激活 rollback target），写后主动失效 activeRowCache。
    this.policyService?.invalidateActiveRowCache(orgId);

    // R2-SSV-24（2026-08-17）：rollback 与 activate 对称留痕——outbox 事件
    // policy.rolled_back + 审计 + metrics（此前回滚在事件流/审计面不可见）。
    try {
      this.metricsService.recordPolicyEvent('rollback');
      await this.outboxService.enqueue(
        'policy.rolled_back',
        String(activation.policyVersion),
        {
          activationId,
          policyVersion: activation.policyVersion,
          rollbackTarget: target,
          operator,
          reason: reason ?? null,
        },
        orgId,
        undefined,
        { entityType: 'policy' },
      );
    } catch {
      // 观测失败不阻断
    }
    try {
      await this.auditService?.appendAuditLog({
        actorId: operator,
        orgId: orgId ?? 'system',
        action: 'scheduler.policy.rollback',
        entityType: 'scheduling_policy',
        entityId: String(activation.policyVersion),
        before: { status: 'ACTIVATED', version: activation.policyVersion },
        after: { status: 'ROLLED_BACK', rollbackTarget: target },
        reason: reason ?? null,
      });
    } catch (err) {
      this.logger.warn(
        `policy rollback audit failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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

  /**
   * 兼容事务上下文（NEST-033 修复，2026-08-17）：有 RequestDatabaseContext 时
   * 经 runInTransaction + buildGucSettings（RLS 生效，策略写不绕过租户隔离）；
   * 无 ctx/无 context（直构测试）回退裸事务（原行为）。
   */
  private async requestDatabaseContextSafe(
    ctx: OrgContext | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (this.requestDatabaseContext) {
      await this.requestDatabaseContext.runInTransaction(
        ctx ? buildGucSettings(ctx) : [],
        fn,
      );
      return;
    }
    await this.db.transaction(async () => {
      await fn();
    });
  }
}
