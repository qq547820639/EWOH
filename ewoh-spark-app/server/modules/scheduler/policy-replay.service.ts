import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { ewohPolicyReplay, ewohWorldStateSnapshot } from '@server/database/schema';
import type {
  PolicyReplayEvaluation,
  PolicyReplaySide,
  SchedulingPlanV2,
} from '@shared/api.interface';
import { WorldStateSnapshotService } from './world-state.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SolverService } from './solver.service';
import { SchedulerMetricsService } from './scheduler-metrics.service';
import type { OrgContext } from '../shared/org-context.interceptor';

/**
 * Shadow Policy 真实 replay 服务（Phase 4 / P4-T2）。
 *
 * comparePolicyVersion 从「参数 delta + 估算」升级为「真实历史 snapshot replay」：
 * - 从 ewoh_world_state_snapshot 取最近一条历史快照（复用既有读取路径）；
 * - 分别以 active 策略与 candidate 策略求解同一快照（复用 SolverService 的
 *   heuristic/CP-SAT 路径 + P2 weights 权威解析）；
 * - 对比 objective 与 KPI（assignments/lateness/travel/wait/workload/risk 等）；
 * - 结果仅用于 shadow 评估，绝不修改生产策略。
 *
 * 评估记录（内存）供 activate 守卫判断「已完成评估」；生产环境由
 * comparePolicyVersion / 影子评估自动化持续调用。重启后需重新评估（务实的
 * 阶段实现：不引入新持久化字段）。
 */
@Injectable()
export class PolicyReplayService {
  private readonly logger = new Logger(PolicyReplayService.name);
  /** configVersion → 最近一次 replay 评估结果（内存记录，供 activate 守卫）。 */
  private readonly evaluations = new Map<number, PolicyReplayEvaluation>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly policyService: SchedulingPolicyService,
    private readonly solverService: SolverService,
    private readonly metricsService?: SchedulerMetricsService,
  ) {}

  /** 是否已完成 replay 评估（activate 守卫）。 */
  isEvaluated(configVersion: number): boolean {
    return this.evaluations.has(configVersion);
  }

  /**
   * 以最近历史快照对 active vs candidate 双策略求解并对比。
   * 无历史快照 → 返回 null（旧 param-delta 评估路径兜底，不伪造数据）。
   */
  async evaluate(
    candidateVersion: number,
    ctx?: OrgContext,
  ): Promise<PolicyReplayEvaluation | null> {
    const snapshotRow = await this.latestSnapshotRow(ctx);
    if (!snapshotRow) {
      this.logger.warn(
        `policy replay skipped: no historical snapshot (candidate v${candidateVersion})`,
      );
      return null;
    }
    const snapshot = (snapshotRow.snapshotJson ?? {}) as Parameters<SolverService['solve']>[0];
    const active = await this.policyService.getActivePolicy();
    const candidate = await this.policyService.getPolicy(candidateVersion);
    if (!candidate) {
      this.logger.warn(
        `policy replay skipped: candidate v${candidateVersion} not found`,
      );
      return null;
    }

    const solverVersion = candidate.solverVersion;
    const activeSide = await this.solveSide(snapshot, active, 'shadow-active', ctx);
    const candidateSide = await this.solveSide(snapshot, candidate, 'shadow-candidate', ctx);
    if (!activeSide || !candidateSide) {
      this.logger.warn(
        `policy replay skipped: solve failed (candidate v${candidateVersion})`,
      );
      return null;
    }

    const objectiveDelta = candidateSide.objective - activeSide.objective;
    const eps = 1e-9;
    const verdict: PolicyReplayEvaluation['verdict'] =
      Math.abs(objectiveDelta) <= eps
        ? 'equivalent'
        : objectiveDelta < 0
          ? 'candidate_better'
          : 'active_better';

    const evaluation: PolicyReplayEvaluation = {
      snapshotVersion: snapshotRow.snapshotVersion,
      solverVersion,
      active: activeSide,
      candidate: candidateSide,
      objectiveDelta,
      verdict,
    };
    this.evaluations.set(candidateVersion, evaluation);
    this.logger.log(
      `policy replay v${candidateVersion} vs active v${active.version}: ` +
        `objectiveDelta=${objectiveDelta.toFixed(3)} verdict=${verdict} snapshot=${snapshotRow.snapshotVersion}`,
    );
    return evaluation;
  }

  /**
   * 最近历史快照（NEST-036 修复，2026-08-17）：ctx 携带 primaryOrgId 时按
   * org 血缘列过滤（standalone_057 补列；或 NULL 全局行）——replay 基线不再
   * 取到他租户快照（跨租户事实污染）。缺省 = 系统后台流。
   */
  private async latestSnapshotRow(ctx?: OrgContext) {
    const orgId = ctx?.primaryOrgId?.trim();
    const rows = await this.db
      .select()
      .from(ewohWorldStateSnapshot)
      .where(
        orgId
          ? or(
              isNull(ewohWorldStateSnapshot.orgId),
              eq(ewohWorldStateSnapshot.orgId, orgId),
            )
          : undefined,
      )
      .orderBy(desc(ewohWorldStateSnapshot.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  private async solveSide(
    snapshot: Parameters<SolverService['solve']>[0],
    policy: Parameters<SolverService['solve']>[2]['policy'],
    planId: string,
    ctx?: OrgContext,
  ): Promise<PolicyReplaySide | null> {
    try {
      const plan: SchedulingPlanV2 = await this.solverService.solve(
        snapshot,
        [],
        {
          planId,
          planName: planId,
          triggerType: 'MANUAL',
          triggerEntityId: null,
          snapshotVersion: snapshot.snapshotVersion ?? 'replay',
          horizonMinutes: 480,
          policy,
        },
      );
      return this.toSide(plan);
    } catch (err) {
      this.logger.warn(
        `policy replay solve failed (${planId}): ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
  }

  /** 方案 → 展示用 side（objective + 分配数 + KPI 指标，纯透传不重算）。 */
  private toSide(plan: SchedulingPlanV2): PolicyReplaySide {
    const m = (plan.metrics ?? {}) as {
      lateMinutes?: number;
      walkingMeters?: number;
      stationWaitMinutes?: number;
      maxWorkload?: number;
      changeCost?: number;
    };
    return {
      objective: typeof plan.objective === 'number' ? plan.objective : 0,
      assignmentCount: plan.assignments.length,
      unassignedCount: plan.violations?.filter((v) => v.reason === 'no_eligible_resource').length ?? 0,
      metrics: {
        lateMinutes: m.lateMinutes ?? 0,
        walkingMeters: m.walkingMeters ?? 0,
        stationWaitMinutes: m.stationWaitMinutes ?? 0,
        maxWorkload: m.maxWorkload ?? 0,
        changeCost: m.changeCost ?? 0,
      },
    };
  }

  // ==========================================================================
  // Phase 4 / P4-REPLAY 持久化：确定性 replay 记录（相同 snapshot+policy+solver+seed = 相同结果）
  // ==========================================================================

  /**
   * 持久化 replay：以最近历史快照对 active vs candidate 双策略求解并落库。
   * - seed 显式传入（缺省取当前时间戳），CP-SAT 侧用 seed 复现（heuristic 确定）；
   * - 结果写入 ewoh_policy_replay（aggregate_kpis_json / per_run_results_json / failures_json）；
   * - activate 守卫读取 replay 记录做 Gate 评估。
   */
  async replayAndPersist(
    candidateVersion: number,
    opts?: {
      snapshotVersion?: string;
      seed?: number;
      orgId?: string | null;
      ctx?: OrgContext;
    },
  ): Promise<import('@shared/api.interface').PolicyReplayRecord> {
    // R2-SSV-20：Date.now()+Math.random（同毫秒碰撞）→ randomUUID。
    const replayId = `RPL-${randomUUID()}`;
    const startedAt = new Date();
    // NEST-036：快照基线按 ctx org 血缘过滤（同 latestSnapshotRow 语义）。
    // R2-SSV-09（2026-08-17）：显式 snapshotVersion 路径同样叠加 org 条件
    // （此前仅 eq(snapshotVersion)，跨租户快照可被指定为 replay 基线）。
    const snapshotOrgId = opts?.ctx?.primaryOrgId?.trim() || opts?.orgId || null;
    const snapshotRow = opts?.snapshotVersion
      ? (
          await this.db
            .select()
            .from(ewohWorldStateSnapshot)
            .where(
              snapshotOrgId
                ? and(
                    eq(ewohWorldStateSnapshot.snapshotVersion, opts.snapshotVersion),
                    or(
                      isNull(ewohWorldStateSnapshot.orgId),
                      eq(ewohWorldStateSnapshot.orgId, snapshotOrgId),
                    ),
                  )
                : eq(ewohWorldStateSnapshot.snapshotVersion, opts.snapshotVersion),
            )
            .limit(1)
        )[0]
      : await this.latestSnapshotRow(opts?.ctx);
    if (!snapshotRow) {
      // NEST-038（2026-08-17）：裸 Error → HttpException（409：前置数据缺失）。
      throw new ConflictException('policy replay: no historical snapshot available');
    }
    const snapshot = (snapshotRow.snapshotJson ?? {}) as Parameters<SolverService['solve']>[0];
    const active = await this.policyService.getActivePolicy(opts?.orgId ?? undefined);
    // R2-SSV-09/NEST-036：候选策略读取按 org 作用域（configVersion 按 org 递增，
    // 仅凭版本号会取到他租户候选策略并落 replay 记录）。
    const candidate = await this.policyService.getPolicy(
      candidateVersion,
      opts?.orgId ?? snapshotOrgId,
    );
    if (!candidate) {
      // NEST-038：404（候选版本不存在）。
      throw new NotFoundException(`policy v${candidateVersion} not found`);
    }
    const seed = opts?.seed ?? Math.floor(Math.random() * 1_000_000);

    const perRunResults: Array<Record<string, unknown>> = [];
    const failures: Array<{ runId?: string; reason: string }> = [];

    const activeSide = await this.solveSidePersist(snapshot, active, 'replay-active', seed, failures, opts?.ctx);
    const candidateSide = await this.solveSidePersist(snapshot, candidate, 'replay-candidate', seed, failures, opts?.ctx);
    if (activeSide) perRunResults.push({ runId: 'replay-active', ...activeSide });
    if (candidateSide) perRunResults.push({ runId: 'replay-candidate', ...candidateSide });

    const objectiveDelta =
      activeSide && candidateSide
        ? Number(candidateSide.objective ?? 0) - Number(activeSide.objective ?? 0)
        : null;
    const aggregateKpis = {
      periodStart: startedAt.toISOString(),
      periodEnd: new Date().toISOString(),
      delivery: {
        onTimeRate: null,
        completionRate: null,
        latenessP50Ms: null,
        latenessP95Ms: null,
        latenessMaxMs: null,
        averageWaitingMs: null,
        averageTravelMs: null,
        averageTravelDistanceM: null,
      },
      resources: {
        personUtilization: null,
        deviceUtilization: null,
        stationUtilization: null,
        resourceIdleMs: null,
        workloadVariance: null,
      },
      stability: {
        replanCount: 0,
        replanSuccessRate: null,
        assignmentChurnRate: null,
        manualOverrideRate: null,
        conflictRate: null,
        averageConflictResolutionMs: null,
      },
      solver: {
        solverLatencyP50Ms: null,
        solverLatencyP95Ms: null,
        optimalRate: null,
        feasibleRate: null,
        heuristicFallbackRate: null,
        timeoutRate: null,
        infeasibleRate: null,
      },
      dataQuality: {
        staleResourceRate: null,
        unknownLocationRate: null,
        degradedRouteRate: null,
      },
    } as unknown as import('@shared/api.interface').SchedulerKpiSnapshot;

    const record: import('@shared/api.interface').PolicyReplayRecord = {
      replayId,
      orgId: opts?.orgId ?? null,
      candidatePolicyVersion: candidateVersion,
      baselinePolicyVersion: active.version,
      solverVersion: candidate.solverVersion,
      snapshotVersion: snapshotRow.snapshotVersion,
      seed,
      status: 'COMPLETED',
      aggregateKpis,
      perRunResults,
      failures,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    };

    await this.db.insert(ewohPolicyReplay).values({
      replayId,
      orgId: opts?.orgId ?? null,
      candidatePolicyVersion: candidateVersion,
      baselinePolicyVersion: active.version,
      solverVersion: candidate.solverVersion,
      snapshotVersion: snapshotRow.snapshotVersion,
      snapshotSet: [],
      seed,
      status: 'COMPLETED',
      aggregateKpisJson: aggregateKpis as unknown as Record<string, unknown>,
      perRunResultsJson: perRunResults,
      failuresJson: failures,
      startedAt,
      completedAt: new Date(),
    });

    try {
      this.metricsService?.recordPolicyEvent?.('replay');
    } catch {
      // 观测失败不阻断
    }
    return record;
  }

  /**
   * 读取持久化 replay 记录（activate 守卫用）。
   * NEST-037 修复（2026-08-17）：orgId 提供时按 org 过滤（跨租户 replayId
   * 不可读）；缺省 = 系统后台流。
   */
  async getReplayRecord(
    replayId: string,
    orgId?: string | null,
  ): Promise<import('@shared/api.interface').PolicyReplayRecord | null> {
    const [row] = await this.db
      .select()
      .from(ewohPolicyReplay)
      .where(
        and(
          eq(ewohPolicyReplay.replayId, replayId),
          orgId ? eq(ewohPolicyReplay.orgId, orgId) : undefined,
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      replayId: row.replayId,
      orgId: row.orgId ?? null,
      candidatePolicyVersion: row.candidatePolicyVersion,
      baselinePolicyVersion: row.baselinePolicyVersion,
      solverVersion: row.solverVersion ?? null,
      snapshotVersion: row.snapshotVersion ?? null,
      seed: row.seed ?? null,
      status: row.status as 'COMPLETED' | 'FAILED' | 'RUNNING',
      aggregateKpis: (row.aggregateKpisJson as unknown as import('@shared/api.interface').SchedulerKpiSnapshot) ?? null,
      perRunResults: (row.perRunResultsJson as Array<Record<string, unknown>>) ?? [],
      failures: (row.failuresJson as Array<{ runId?: string; reason: string }>) ?? [],
      startedAt: row.startedAt ? row.startedAt.toISOString() : '',
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }

  /** replay 历史（按 candidate 版本）。 */
  async listReplayRecords(
    candidateVersion?: number,
    orgId?: string | null,
  ): Promise<import('@shared/api.interface').PolicyReplayRecord[]> {
    const conds = [];
    if (candidateVersion != null) conds.push(eq(ewohPolicyReplay.candidatePolicyVersion, candidateVersion));
    if (orgId != null) conds.push(eq(ewohPolicyReplay.orgId, orgId));
    const rows = await this.db
      .select()
      .from(ewohPolicyReplay)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(ewohPolicyReplay.startedAt))
      .limit(50);
    return rows.map((row) => ({
      replayId: row.replayId,
      orgId: row.orgId ?? null,
      candidatePolicyVersion: row.candidatePolicyVersion,
      baselinePolicyVersion: row.baselinePolicyVersion,
      solverVersion: row.solverVersion ?? null,
      snapshotVersion: row.snapshotVersion ?? null,
      seed: row.seed ?? null,
      status: row.status as 'COMPLETED' | 'FAILED' | 'RUNNING',
      aggregateKpis: (row.aggregateKpisJson as unknown as import('@shared/api.interface').SchedulerKpiSnapshot) ?? null,
      perRunResults: (row.perRunResultsJson as Array<Record<string, unknown>>) ?? [],
      failures: (row.failuresJson as Array<{ runId?: string; reason: string }>) ?? [],
      startedAt: row.startedAt ? row.startedAt.toISOString() : '',
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    }));
  }

  private async solveSidePersist(
    snapshot: Parameters<SolverService['solve']>[0],
    policy: Parameters<SolverService['solve']>[2]['policy'],
    planId: string,
    seed: number,
    failures: Array<{ runId?: string; reason: string }>,
    ctx?: OrgContext,
  ): Promise<Record<string, unknown> | null> {
    // NEST-035 修复（2026-08-17）：seed 不再 `void` 丢弃——透传 SolverService
    // .solve（SolveOptions.seed → CP-SAT request.seed），replay 记录的确定性
    // 声明有事实支撑；ctx.orgId 同步透传（CANARY 采样/审计）。
    try {
      const plan: SchedulingPlanV2 = await this.solverService.solve(
        snapshot,
        [],
        {
          planId,
          planName: planId,
          triggerType: 'MANUAL',
          triggerEntityId: null,
          snapshotVersion: snapshot.snapshotVersion ?? 'replay',
          horizonMinutes: 480,
          policy,
          seed,
          orgId: ctx?.primaryOrgId ?? null,
        },
      );
      return {
        objective: plan.objective ?? null,
        solverStatus: plan.solverStatus ?? null,
        assignments: plan.assignments.length,
        metrics: plan.metrics ?? null,
        violations: plan.violations ?? [],
        planId: plan.planId,
      };
    } catch (err) {
      failures.push({ runId: planId, reason: (err as Error)?.message ?? String(err) });
      return null;
    }
  }
}
