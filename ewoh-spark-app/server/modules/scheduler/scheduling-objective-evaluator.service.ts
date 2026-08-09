import type {
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
  evaluate(input: EvaluatePlanInput): EvaluatePlanOutput {
    const { snapshot, assignments, policy, baseline, horizonMinutes, nowMs } =
      input;
    const horizonEndMs = nowMs + Math.max(horizonMinutes, 0) * 60 * 1000;
    const taskById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const w = policy.weights;

    let totalLateMs = 0;
    let totalWalking = 0;
    let totalWaitMs = 0;
    let totalChange = 0;
    let totalLateScore = 0;
    let totalTravelScore = 0;
    let totalWaitScore = 0;
    let totalChangeScore = 0;
    const assignedMsByPerson = new Map<string, number>();

    for (const a of assignments) {
      const task = taskById.get(a.taskId);
      const startMs = a.plannedStart ? Date.parse(a.plannedStart) : NaN;
      const endMs = a.plannedEnd ? Date.parse(a.plannedEnd) : NaN;
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

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

      // changeCost：基线 person 与当前 person 不同 → 1。
      const baselineAssignee = baseline?.get(a.taskId) ?? null;
      const change =
        baselineAssignee != null && baselineAssignee !== a.personId ? 1 : 0;

      totalLateMs += lateMs;
      totalWalking += distanceMeters;
      totalWaitMs += waitMs;
      totalChange += change;
      totalLateScore += (w.lateness * lateMs) / 60000;
      totalTravelScore += (w.travel * travelMs) / 60000;
      totalWaitScore += (w.wait * waitMs) / 60000;
      totalChangeScore += w.change * change;

      assignedMsByPerson.set(
        a.personId ?? 'unassigned',
        (assignedMsByPerson.get(a.personId ?? 'unassigned') ?? 0) +
          (endMs - startMs),
      );
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
