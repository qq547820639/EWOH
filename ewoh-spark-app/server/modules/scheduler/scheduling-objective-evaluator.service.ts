import { Logger } from '@nestjs/common';
import type {
  ChurnConfig,
  SchedulingAssignment,
  SchedulingConstraint,
  SchedulingPlanMetrics,
  SchedulingPolicy,
  ScoreBreakdown,
  WorldStateSnapshot,
} from '@shared/api.interface';

/**
 * P0-5：调度目标评估器（SchedulingObjectiveEvaluator）。
 *
 * 单一评估来源：给定 {snapshot, assignments, policy, constraints, baseline}，
 * 产出 metrics / scoreBreakdown / objective / baselineDelta —— 与求解器无关。
 *
 * 背景：CP-SAT 路径旧实现复用 heuristic shell 计算 metrics/scoreBreakdown
 * （基于 heuristic 自己的 assignments）——CP-SAT assignment 配 heuristic metrics
 * 属实。本评估器保证：同一 snapshot+assignments 喂入 → 输出一致，无论来自
 * heuristic 还是 CP-SAT。
 *
 * 语义（与 P0-3 due/lateness 对齐）：
 *   - lateMs：max(0, plannedEnd - softDueMs)，softDueMs = dueAtMs ?? planEnd ?? horizonEnd；
 *   - waitMs：max(0, plannedStart - earliestMs)，earliestMs = earliestStartMs ?? planStart ?? nowMs；
 *   - travel：优先 assignment.etaSeconds（heuristic 自带），否则查 candidateCostsByTask
 *     （CP-SAT 路径矩阵透传）；两者皆无 → 0（不虚构）。
 *   - workloadBalance / risk / energyCost 无法从 assignments 单独推导 → 恒 0（不虚构）。
 */
export interface EvaluatePlanInput {
  snapshot: WorldStateSnapshot;
  assignments: SchedulingAssignment[];
  policy: SchedulingPolicy;
  constraints: SchedulingConstraint[];
  /** taskId → 基线 personId（churn/changeCost 用）。 */
  baseline?: Map<string, string | null>;
  /** M04：Churn Objective V2 权重（可选；缺省=现状：person 变更按 weights.change、其余 0）。 */
  churn?: ChurnConfig;
  horizonMinutes: number;
  nowMs: number;
  /** P0-4：权威 RouteCost 矩阵索引（CP-SAT 路径用；heuristic assignments 自带 cost 字段）。 */
  candidateCostsByTask?: Map<
    string,
    Array<{
      personId: string;
      stationId: string | null;
      distanceMeters: number;
      etaSeconds: number;
    }>
  >;
}

export interface EvaluatePlanOutput {
  objective: number;
  scoreBreakdown: ScoreBreakdown;
  metrics: SchedulingPlanMetrics;
  violations: Array<Record<string, unknown>>;
  baselineDelta: Record<string, unknown>;
}

export class SchedulingObjectiveEvaluator {
  /** NEST-142：无效日期告警留痕（指标少计可观测）。 */
  private readonly logger = new Logger(SchedulingObjectiveEvaluator.name);

  evaluate(input: EvaluatePlanInput): EvaluatePlanOutput {
    const { snapshot, assignments, policy, baseline, horizonMinutes, nowMs } =
      input;
    const horizonEndMs = nowMs + Math.max(horizonMinutes, 0) * 60 * 1000;
    const taskById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const w = policy.weights;

    // M04：Churn Objective V2 权重（缺省=现状：person 变更按 weights.change、其余 0）。
    const churn = input.churn;
    const personPenalty = churn?.personChangePenalty ?? w.change;
    const devicePenalty = churn?.deviceChangePenalty ?? 0;
    const stationPenalty = churn?.stationChangePenalty ?? 0;
    const startShiftPenalty = churn?.startTimeShiftPenalty ?? 0;
    const sequencePenalty = churn?.sequenceChangePenalty ?? 0;
    const removalPenalty = churn?.assignmentRemovalPenalty ?? 0;
    const additionPenalty = churn?.assignmentAdditionPenalty ?? 0;

    // M04：候选/基线 start 顺序（sequenceChanged 用；仅当权重非 0 才计算，保证缺省=现状零开销）。
    let baselineRank = new Map<string, number>();
    let candidateRank = new Map<string, number>();
    if (sequencePenalty !== 0) {
      const baselineOrdered = [...snapshot.tasks]
        .filter((t) => t.planStart != null)
        .sort((a, b) => Date.parse(a.planStart!) - Date.parse(b.planStart!));
      baselineOrdered.forEach((t, i) => baselineRank.set(t.id, i));
      const candidateOrdered = [...assignments]
        .filter((a) => a.plannedStart != null)
        .sort(
          (a, b) => Date.parse(a.plannedStart!) - Date.parse(b.plannedStart!),
        );
      candidateOrdered.forEach((a, i) => candidateRank.set(a.taskId, i));
    }

    let totalLateMs = 0;
    let totalWalking = 0;
    let totalWaitMs = 0;
    let totalChange = 0;
    let totalChurnScore = 0;
    let totalLateScore = 0;
    let totalTravelScore = 0;
    let totalWaitScore = 0;
    let totalChangeScore = 0;
    const assignedMsByPerson = new Map<string, number>();

    for (const a of assignments) {
      const task = taskById.get(a.taskId);
      const startMs = a.plannedStart ? Date.parse(a.plannedStart) : NaN;
      const endMs = a.plannedEnd ? Date.parse(a.plannedEnd) : NaN;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        // NEST-142 修复（2026-08-17）：无效/缺失日期不再静默跳过——warn 留痕
        // （指标少计是可观测的数据质量问题，调用方需知情）。
        this.logger.warn(
          `objective evaluation: assignment ${a.taskId} has invalid dates (plannedStart=${a.plannedStart ?? 'null'}, plannedEnd=${a.plannedEnd ?? 'null'}); excluded from metrics`,
        );
        continue;
      }

      // P0-3：软 due 解析（dueAtMs → planEnd 回退 → horizonEnd）。
      const softDueMs =
        task?.dueAtMs != null
          ? task.dueAtMs
          : task?.planEnd
            ? Date.parse(task.planEnd)
            : Number.isFinite(horizonEndMs)
              ? horizonEndMs
              : endMs;
      const lateMs = Math.max(0, endMs - softDueMs);

      // 最早开始：earliestStartMs → planStart 回退 → now。
      const earliestMs =
        task?.earliestStartMs != null
          ? task.earliestStartMs
          : task?.planStart
            ? Date.parse(task.planStart)
            : Number.isFinite(nowMs)
              ? nowMs
              : startMs;
      const waitMs = Math.max(0, startMs - earliestMs);

      // travel：assignment 自带 etaSeconds（heuristic）；否则查矩阵（CP-SAT）。
      let etaSeconds = a.etaSeconds ?? 0;
      if (!(etaSeconds > 0) && a.personId) {
        const costs = input.candidateCostsByTask?.get(a.taskId) ?? [];
        const cc = costs.find(
          (c) =>
            c.personId === a.personId &&
            (c.stationId ?? null) === (a.stationId ?? null),
        );
        etaSeconds = cc?.etaSeconds ?? 0;
      }
      const travelMs = etaSeconds * 1000;
      const distanceMeters = a.distanceMeters ?? 0;

      // M04：Churn Objective V2——将 change 项细化为七项 churn 罚。
      // 基线 person 用传入 baseline 映射（缺省=现状 changeCost 语义）；
      // device/station/start 基线取自快照任务当前分配（partial replan 下即基线）。
      const baselineAssignee = baseline?.get(a.taskId) ?? null;
      const personChanged =
        baselineAssignee != null && baselineAssignee !== a.personId ? 1 : 0;
      const baselineDevice = task?.deviceId ?? null;
      const deviceChanged =
        baselineDevice != null && baselineDevice !== a.deviceId ? 1 : 0;
      const baselineStation = task?.stationId ?? null;
      const stationChanged =
        baselineStation != null && baselineStation !== a.stationId ? 1 : 0;
      const baselineStartMs = task?.planStart
        ? Date.parse(task.planStart)
        : NaN;
      const startShiftMin = Number.isFinite(baselineStartMs) &&
        Number.isFinite(startMs)
        ? Math.abs(startMs - baselineStartMs) / 60000
        : 0;
      const sequenceChanged =
        sequencePenalty !== 0 &&
        baselineRank.has(a.taskId) &&
        candidateRank.has(a.taskId) &&
        baselineRank.get(a.taskId) !== candidateRank.get(a.taskId)
          ? 1
          : 0;

      const churnScore =
        personChanged * personPenalty +
        deviceChanged * devicePenalty +
        stationChanged * stationPenalty +
        startShiftMin * startShiftPenalty +
        sequenceChanged * sequencePenalty;

      totalChange += personChanged;
      totalChurnScore += churnScore;
      totalLateMs += lateMs;
      totalWalking += distanceMeters;
      totalWaitMs += waitMs;
      totalLateScore += (w.lateness * lateMs) / 60000;
      totalTravelScore += (w.travel * travelMs) / 60000;
      totalWaitScore += (w.wait * waitMs) / 60000;
      totalChangeScore += churnScore;

      assignedMsByPerson.set(
        a.personId ?? 'unassigned',
        (assignedMsByPerson.get(a.personId ?? 'unassigned') ?? 0) +
          (endMs - startMs),
      );
    }

    // M04：removed / added 罚（缺省 removal=weights.change、addition=0）。
    // removed = 基线已分配但候选未分配的任务；added = 候选新增且基线未分配的任务。
    // 仅在传入 churn 配置且对应权重非 0 时累计（保证缺省=现状逐位一致）。
    let removedCount = 0;
    let addedCount = 0;
    if (churn) {
      const assignedTaskIds = new Set(assignments.map((a) => a.taskId));
      const baselineKeys = baseline ? new Set(baseline.keys()) : new Set<string>();
      if (removalPenalty !== 0) {
        for (const taskId of baselineKeys) {
          if (!assignedTaskIds.has(taskId)) removedCount += 1;
        }
      }
      if (additionPenalty !== 0) {
        for (const taskId of assignedTaskIds) {
          if (!baselineKeys.has(taskId)) addedCount += 1;
        }
      }
      totalChurnScore += removedCount * removalPenalty + addedCount * additionPenalty;
      totalChangeScore += removedCount * removalPenalty + addedCount * additionPenalty;
    }

    const maxWorkloadMs = Math.max(0, ...Array.from(assignedMsByPerson.values()));
    const metrics: SchedulingPlanMetrics = {
      lateMinutes: Math.round(totalLateMs / 60000),
      walkingMeters: Math.round(totalWalking),
      stationWaitMinutes: Math.round(totalWaitMs / 60000),
      maxWorkload: Math.round(maxWorkloadMs / 60000),
      changeCost: totalChange,
    };

    const scoreBreakdown: ScoreBreakdown = {
      lateness: totalLateScore,
      travel: totalTravelScore,
      workloadBalance: 0,
      stationWait: totalWaitScore,
      changeCost: totalChangeScore,
      risk: 0,
      energyCost: 0,
      total:
        totalLateScore +
        totalTravelScore +
        totalWaitScore +
        totalChangeScore,
    };

    const violations = this.computeViolations(input);

    return {
      objective: scoreBreakdown.total,
      scoreBreakdown,
      metrics,
      violations,
      baselineDelta: this.computeBaselineDelta(metrics, snapshot, nowMs),
    };
  }

  /** 从 assignments 派生硬约束 violation（与求解器违规列表互补，评估器不虚构）。 */
  private computeViolations(input: EvaluatePlanInput): Array<Record<string, unknown>> {
    const violations: Array<Record<string, unknown>> = [];
    const { snapshot, assignments } = input;
    const taskById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const assignedByTask = new Map(assignments.map((a) => [a.taskId, a]));

    // P0-1：predecessor 时间序——后继 plannedStart >= 前置 plannedEnd。
    for (const a of assignments) {
      const task = taskById.get(a.taskId);
      if (!task?.predecessorIds?.length) continue;
      for (const predId of task.predecessorIds) {
        const predAsg = assignedByTask.get(predId);
        if (!predAsg?.plannedEnd) continue;
        if (a.plannedStart && Date.parse(a.plannedStart) < Date.parse(predAsg.plannedEnd)) {
          violations.push({
            type: 'PREDECESSOR_TIME_VIOLATION',
            taskId: a.taskId,
            predecessorId: predId,
            reason: 'successor_starts_before_predecessor_ends',
          });
        }
      }
    }

    // P0-3：mustFinishBy 硬截止——assignment endMs 违反 latestFinishMs。
    for (const a of assignments) {
      const task = taskById.get(a.taskId);
      if (task?.latestFinishMs == null || !a.plannedEnd) continue;
      const endMs = Date.parse(a.plannedEnd);
      if (Number.isFinite(endMs) && endMs > task.latestFinishMs) {
        violations.push({
          type: 'MUST_FINISH_BY_VIOLATION',
          taskId: a.taskId,
          latestFinishMs: task.latestFinishMs,
          endMs,
          reason: 'assignment_exceeds_hard_deadline',
        });
      }
    }

    return violations;
  }

  private computeBaselineDelta(
    metrics: SchedulingPlanMetrics,
    snapshot: WorldStateSnapshot,
    nowMs: number,
  ): Record<string, unknown> {
    // LOW-3：使用入参 nowMs（与 evaluate 输入同源），不用 Date.now()——
    // 保证同输入两次 evaluate 输出完全相等（跨次评估确定性）。
    const baselineLate = snapshot.tasks
      .filter((t) => t.planEnd && Date.parse(t.planEnd) < nowMs)
      .length;
    return {
      lateMinutesDelta: metrics.lateMinutes - baselineLate,
      walkingMetersDelta: metrics.walkingMeters,
      stationWaitMinutesDelta: metrics.stationWaitMinutes,
      maxWorkloadDelta: metrics.maxWorkload,
    };
  }
}
