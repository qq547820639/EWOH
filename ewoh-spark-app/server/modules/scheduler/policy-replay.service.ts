import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { desc } from 'drizzle-orm';
import { ewohWorldStateSnapshot } from '@server/database/schema';
import type {
  PolicyReplayEvaluation,
  PolicyReplaySide,
  SchedulingPlanV2,
} from '@shared/api.interface';
import { WorldStateSnapshotService } from './world-state.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { SolverService } from './solver.service';
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
    const snapshotRow = await this.latestSnapshotRow();
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

  private async latestSnapshotRow() {
    const rows = await this.db
      .select()
      .from(ewohWorldStateSnapshot)
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
}
