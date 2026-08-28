import { Injectable, Logger } from '@nestjs/common';
import type {
  ReplanImpact,
  ReplanPreviewResult,
  SchedulingPlanV2,
  WorldStateSnapshot,
  PlanAssignmentDiff,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ReplanCoordinatorService } from './replan-coordinator.service';
import { SolverService } from './solver.service';
import { WorldStateSnapshotService } from './world-state.service';
import { ConstraintLoaderService } from './constraint-loader.service';
import { PlanCompareService } from './plan-compare.service';
import { PlanService } from './plan.service';

/**
 * Replan Preview（Incremental Replan V2 / M03，08 §5）：dry-run readonly。
 *
 * buildSnapshot → analyzeImpactV2 → partialSnapshot（affected ∪ frozen）→
 * solveVariants（PREVIEW-* planId，**不落库**）→ PlanCompareService.compare(基线, 候选)
 * → 计数 + 指标增量。与 OverridePreviewService 语义一致：不 persist、不 dispatch、
 * 不改 run 状态。
 */
@Injectable()
export class ReplanPreviewService {
  private readonly logger = new Logger(ReplanPreviewService.name);

  constructor(
    private readonly replanCoordinatorService: ReplanCoordinatorService,
    private readonly solverService: SolverService,
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly constraintLoaderService: ConstraintLoaderService,
    private readonly planCompareService: PlanCompareService,
    private readonly planService: PlanService,
  ) {}

  /**
   * 只读预览：触发 → 影响闭包 → 局部子图求解（PREVIEW-*）→ 与基线方案对比。
   * 基线 = 当前生效方案（active plan 中最新）；无生效方案时构造空基线（仅计数候选自身）。
   */
  async previewReplan(
    triggerType: string,
    triggerIds: string[],
    ctx: OrgContext,
  ): Promise<ReplanPreviewResult> {
    // 预览不落库：使用只读快照，避免每次预览都写入全量 snapshotJson
    // 并竞争同一天的版本计数器行锁（buildSnapshot 语义供写路径使用）。
    const snapshot = await this.worldStateSnapshotService.buildSnapshotReadOnly(ctx);

    // 影响分析 V2（propagateImpact 闭包）。
    const impact = await this.replanCoordinatorService.analyzeImpactV2FromSnapshot(
      snapshot,
      triggerType,
      triggerIds,
    );

    // 局部子图 = 受影响 ∪ 冻结；无关任务不进入求解输入。
    const affectedSet = new Set(impact.affectedTaskIds);
    const frozenSet = new Set(impact.frozenAssignmentIds);
    const partialSnapshot: WorldStateSnapshot = {
      ...snapshot,
      tasks: snapshot.tasks.filter(
        (t) => affectedSet.has(t.id) || frozenSet.has(t.id),
      ),
    };

    // baselineAssignee：当前分配作为 churn/stability 罚项基线。
    const baselineAssignee = new Map<string, string | null>();
    for (const t of snapshot.tasks) {
      if (t.assigneeId) {
        if (baselineAssignee.has(t.id)) continue;
        baselineAssignee.set(t.id, t.assigneeId);
      }
    }
    for (const la of snapshot.lockedAssignments) {
      baselineAssignee.set(la.taskId, la.personId);
    }

    // 基线方案：当前生效方案（active plan 最新）；无则构造空基线。
    const baseline = await this.loadBaselinePlan(ctx);

    // PREVIEW-*：不持久化（与 OverridePreviewService 同语义）。
    const candidatePlanId = `PREVIEW-${Date.now()}`;
    const constraints = this.constraintLoaderService
      ? await this.constraintLoaderService.loadGlobalActive(ctx)
      : [];
    const plans = await this.solverService.solveVariants(partialSnapshot, constraints, {
      planId: candidatePlanId,
      planName: 'replan-preview',
      triggerType,
      triggerEntityId: triggerIds[0] ?? null,
      snapshotVersion: snapshot.snapshotVersion,
      horizonMinutes: 480,
      baselineAssignee,
      // Task B / P0：局部重排真实影响集（scheduler_partial_replan_affected 与
      // preview.affectedTaskCount 同源，均取 impact.affectedTaskIds.length）。
      affectedTaskIds: impact.affectedTaskIds,
    });
    const candidate = plans[0] ?? null;
    if (!candidate) {
      return {
        baselinePlanId: baseline?.planId ?? null,
        candidatePlanId,
        readonly: true,
        affectedTaskCount: impact.affectedTaskIds.length,
        unchangedAssignmentCount: 0,
        changedAssignmentCount: 0,
        addedAssignmentCount: 0,
        removedAssignmentCount: 0,
        latenessDelta: 0,
        travelDelta: 0,
        workloadDelta: 0,
        stationWaitDelta: 0,
        changeoverDelta: 0,
        energyRiskDelta: 0,
        riskDelta: 0,
        churnDelta: 0,
        changedAssignments: [],
      };
    }

    // R2-SCH-008（2026-08-17）：基线裁剪到局部子图（affected ∪ frozen）后再对比——
    // 此前全量 baseline 对比局部 candidate，未受影响任务全部计入 removed，
    // 污染 changed/removed 计数与 maxChangedAssignments 审批阈值判定。
    // 指标增量（metrics/scoreBreakdown）仍取全量基线（计划级聚合值，不可按任务裁剪）。
    const subgraphTaskIds = new Set(partialSnapshot.tasks.map((t) => t.id));
    const baselineForDiff = baseline
      ? {
          ...baseline,
          assignments: baseline.assignments.filter((a) => subgraphTaskIds.has(a.taskId)),
        }
      : null;
    const diff = this.planCompareService.compare(baselineForDiff ?? this.emptyPlan(candidatePlanId), candidate);
    return this.buildResult(impact, baseline ?? null, candidate, candidatePlanId, diff, snapshot);
  }

  /** 构造 ReplanPreviewResult：计数 + 指标增量 + changedAssignments（diff.reasons + impact.reasons 合并）。 */
  private buildResult(
    impact: ReplanImpact,
    baseline: SchedulingPlanV2 | null,
    candidate: SchedulingPlanV2,
    candidatePlanId: string,
    diff: ReturnType<PlanCompareService['compare']>,
    snapshot: WorldStateSnapshot,
  ): ReplanPreviewResult {
    const changedAssignments: PlanAssignmentDiff[] = diff.diffByTask.map((d) => {
      // changeReasons = diff.reasons + ReplanImpact.reasons（合并去重）。
      const impactReasons = impact.reasons ?? [];
      const reasons = Array.from(new Set([...(d.reasons ?? []), ...impactReasons]));
      return { ...d, reasons };
    });

    const baselineMetrics = baseline?.metrics ?? this.zeroMetrics();
    const candidateMetrics = candidate.metrics ?? this.zeroMetrics();
    const baselineScore = baseline?.scoreBreakdown ?? null;
    const candidateScore = candidate.scoreBreakdown ?? null;

    const num = (v: unknown): number =>
      typeof v === 'number' && Number.isFinite(v) ? v : 0;

    // 计数：changed = diff 中非 ADDED/REMOVED 的变更任务数。
    const changedAssignmentCount = diff.diffByTask.filter(
      (d) =>
        !d.changeTypes.includes('ADDED') && !d.changeTypes.includes('REMOVED'),
    ).length;
    const addedAssignmentCount = diff.added.length;
    const removedAssignmentCount = diff.removed.length;
    // NEST-153 修复（2026-08-17）：unchanged = 可影响集 ∪ 冻结集 中未出现在
    // diff 变更集（含 added/removed）的任务数——集合差运算（旧算式把 added/
    // removed 同时计入减数且与 movable/frozen 集合不交，可能为负被 clamp 0）。
    const changedOrMovedSet = new Set<string>([
      ...diff.diffByTask.map((d) => d.taskId),
    ]);
    const unchangedAssignmentCount = Array.from(
      new Set([
        ...impact.movableAssignmentIds,
        ...impact.frozenAssignmentIds,
      ]),
    ).filter((id) => !changedOrMovedSet.has(id)).length;

    return {
      baselinePlanId: baseline?.planId ?? null,
      candidatePlanId,
      readonly: true,
      affectedTaskCount: impact.affectedTaskIds.length,
      changedAssignmentCount,
      addedAssignmentCount,
      removedAssignmentCount,
      unchangedAssignmentCount,
      // 指标增量（候选 − 基线；缺失用 0，显式标注）。
      latenessDelta: this.deltaMinute(num(baselineScore?.lateness), num(candidateScore?.lateness)),
      travelDelta: this.deltaMinute(num(baselineScore?.travel), num(candidateScore?.travel)),
      workloadDelta: this.round2(
        num(candidateScore?.workloadBalance ?? candidateMetrics.maxWorkload) -
          num(baselineScore?.workloadBalance ?? baselineMetrics.maxWorkload),
      ),
      stationWaitDelta: this.deltaMinute(
        num(baselineScore?.stationWait),
        num(candidateScore?.stationWait),
      ),
      // changeover：候选与基线工位不同的任务数（STATION_CHANGED）。
      changeoverDelta: diff.changeTypeCounts.STATION_CHANGED ?? 0,
      // energyRisk：scoreBreakdown.energyCost 差值（评估器恒 0，缺数据用 0）。
      energyRiskDelta: this.round2(num(candidateScore?.energyCost) - num(baselineScore?.energyCost)),
      // risk：scoreBreakdown.risk 差值（评估器恒 0，缺数据用 0）。
      riskDelta: this.round2(num(candidateScore?.risk) - num(baselineScore?.risk)),
      churnDelta: this.round2(diff.churn),
      changedAssignments,
    };
  }

  /** 当前生效方案（active plan 最新）；无则 null。NEST-039/152：ctx 透传 org 过滤。 */
  private async loadBaselinePlan(ctx: OrgContext): Promise<SchedulingPlanV2 | null> {
    try {
      const active = await this.planService.listActivePlans(
        ctx.primaryOrgId ? ctx : undefined,
      );
      if (active && active.length > 0) return active[0];
      return null;
    } catch (err) {
      this.logger.warn(
        `replan preview baseline load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** 空基线方案（无生效方案时，仅计数候选自身）。 */
  private emptyPlan(candidatePlanId: string): SchedulingPlanV2 {
    return {
      planId: `BASELINE-${candidatePlanId}`,
      version: 0,
      status: 'shadow',
      trigger: { type: 'MANUAL', entityId: null },
      snapshotVersion: 'PREVIEW',
      policyVersion: 0,
      solverVersion: 'preview-empty',
      horizonMinutes: 480,
      assignments: [],
      metrics: this.zeroMetrics(),
      baselineDelta: {},
      violations: [],
      createdAt: new Date().toISOString(),
    };
  }

  private zeroMetrics() {
    return {
      lateMinutes: 0,
      walkingMeters: 0,
      stationWaitMinutes: 0,
      maxWorkload: 0,
      changeCost: 0,
    };
  }

  private deltaMinute(baseline: number, candidate: number): number {
    return this.round2((candidate - baseline) / 60);
  }

  private round2(v: number): number {
    return Math.round(v * 100) / 100;
  }
}
