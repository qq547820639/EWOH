/* rule-based-scheduling-solver.ts — Rule-based Scheduling Solver（ADR-053 / NO-13d，§8/§9）。
 *
 * 求解器插拔阶梯第 3 类：确定性 L1 规则求解器（stdlib 零外部依赖）。
 * 语义（ADR-053 决策 1，§9 差异边界显式）：
 *  - 任务序：前置 DAG 就绪集内按 (dueAtMs 升序, priority 降序, taskId 字典序) 稳定排序；
 *  - 候选序：CandidateEngine.buildCandidatePool（与 heuristic/CP-SAT 共享同一硬约束
 *    过滤语义，§31）的 eligible 候选中按 (startMs 最早, personId, deviceId, stationId
 *    字典序) 取首个——纯规则 first-eligible，**不做软成本 argmin**（差异边界：
 *    heuristic 做 8 权重软目标优化）；
 *  - 确定性：同 snapshot+constraints+opts → 同方案（deep-equal 断言锁定，天然幂等可重放）；
 *  - 可解释：DecisionTrace.selectedReason=['rule-based:first-eligible'] +
 *    rejectedHard=候选引擎结构化拒绝原因（capped）+ hardConstraints/weightsSnapshot；
 *  - 无可行候选 → 该任务不产出 assignment + violations 显式 UNASSIGNED_RULE_BASED
 *    （§33 不伪造分配）；
 *  - 产出：status='shadow'，solverStatus='RULE_BASED'，solverVersion='rule-based-v1'；
 *    metrics/baselineDelta 经 SchedulingObjectiveEvaluator（P0-5：同一
 *    snapshot+assignments → 同一输出，与 heuristic/CP-SAT 同一评估器 §31）。
 */
import { Injectable, Logger } from '@nestjs/common';
import type {
  SchedulingConstraint,
  SchedulingPlanV2,
  SchedulingPolicy,
  WorldStateSnapshot,
} from '@shared/api.interface';
import type { CandidateEvaluation, DecisionTrace, SchedulingAssignment } from '@shared/scheduler';
import type { SchedulingSolver, SolveOptions } from './scheduling-solver.interface';
import { CandidateEngineService } from './candidate-engine.service';
import { SchedulingObjectiveEvaluator } from './scheduling-objective-evaluator.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { TaskLifecycle } from './task-lifecycle';

export const RULE_BASED_SOLVER_VERSION = 'rule-based-v1';

const PRIORITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
};

const REJECTED_HARD_CAP = 12;

function taskPriorityRank(priority: string | undefined | null): number {
  return PRIORITY_RANK[String(priority ?? '').toLowerCase()] ?? 1;
}

/** 确定性任务序（ADR-053 决策 1）：due 升序 → priority 降序 → taskId 字典序。 */
function compareTasksByRule(a: WorldStateSnapshot['tasks'][number], b: WorldStateSnapshot['tasks'][number]): number {
  const dueA = a.dueAtMs ?? (a.planEnd ? Date.parse(a.planEnd) : Number.MAX_SAFE_INTEGER);
  const dueB = b.dueAtMs ?? (b.planEnd ? Date.parse(b.planEnd) : Number.MAX_SAFE_INTEGER);
  if (dueA !== dueB) return dueA - dueB;
  const rankA = taskPriorityRank(a.priority);
  const rankB = taskPriorityRank(b.priority);
  if (rankA !== rankB) return rankB - rankA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 确定性候选序（ADR-053 决策 1）：startMs 最早 → 资源 id 字典序。 */
function compareCandidatesByRule(a: CandidateEvaluation, b: CandidateEvaluation): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  const keyA = `${a.personId}|${a.deviceId ?? ''}|${a.stationId ?? ''}`;
  const keyB = `${b.personId}|${b.deviceId ?? ''}|${b.stationId ?? ''}`;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

/**
 * Rule-based Scheduling Solver（ADR-053）：确定性地板求解器。
 * 消费 CandidateEngine 共享候选池（§31 单一硬约束语义），产出可重放的
 * SchedulingPlanV2（shadow）；策略显式选择（policy.solverVersion='rule-based-v1'）。
 */
@Injectable()
export class RuleBasedSchedulingSolver implements SchedulingSolver {
  private readonly logger = new Logger(RuleBasedSchedulingSolver.name);

  constructor(
    private readonly policyService: SchedulingPolicyService,
    private readonly candidateEngine: CandidateEngineService,
    private readonly objectiveEvaluator: SchedulingObjectiveEvaluator,
  ) {}

  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const now = Date.now();
    const policy: SchedulingPolicy = opts.policy ?? (await this.policyService.getActivePolicy());
    const config = await this.policyService.getConfig();
    const horizonMinutes = config.horizonMinutes ?? opts.horizonMinutes;
    const doneTaskIds = new Set<string>(
      snapshot.tasks.filter((t) => TaskLifecycle.isTerminal(t.status)).map((t) => t.id),
    );

    // 已锁定分配（快照真实事实：executing/locked 的任务人员不再可分配）。
    const lockedPersonByTask = new Map<string, string>();
    for (const locked of snapshot.lockedAssignments ?? []) {
      if (locked.personId) lockedPersonByTask.set(locked.taskId, locked.personId);
    }

    const assignments: SchedulingAssignment[] = [];
    const violations: Array<Record<string, unknown>> = [];
    const bookedTimeSlots: Array<{ personId: string; start: number; end: number }> = [];
    const bookedDeviceSlots: Array<{ deviceId: string; start: number; end: number }> = [];
    const bookedStationSlots: Array<{ stationId: string; start: number; end: number }> = [];
    const bookedStationCounts = new Map<string, number>();

    // 任务序：前置 DAG 就绪集内按确定性规则推进（未就绪任务轮空）。
    const remaining = snapshot.tasks
      .filter((t) => !TaskLifecycle.isTerminal(t.status))
      .sort(compareTasksByRule);
    const assignedTaskIds = new Set<string>(doneTaskIds);

    let progressed = true;
    while (progressed && remaining.length > 0) {
      progressed = false;
      const next: typeof remaining = [];
      for (const task of remaining) {
        const predecessorsDone = (task.predecessorIds ?? []).every((p) => assignedTaskIds.has(p));
        if (!predecessorsDone) {
          next.push(task);
          continue;
        }
        progressed = true;
        const pool = await this.candidateEngine.buildCandidatePool(task, snapshot, {
          nowMs: now,
          lockedPersonByTask,
          bookedTimeSlots,
          bookedDeviceSlots,
          bookedStationSlots,
          bookedStationCounts,
          baselineAssignee: opts.baselineAssignee,
        });
        const eligible = pool.filter((c) => c.eligible).sort(compareCandidatesByRule);
        const chosen = eligible[0];
        if (!chosen) {
          violations.push({
            type: 'UNASSIGNED_RULE_BASED',
            taskId: task.id,
            reason: 'no_eligible_candidate',
            rejectReasons: pool
              .slice(0, REJECTED_HARD_CAP)
              .flatMap((c) => c.rejectReasons),
          });
          continue;
        }
        const assignment = this.buildAssignment(task, chosen, policy, opts, pool);
        assignments.push(assignment);
        assignedTaskIds.add(task.id);
        if (chosen.personId) {
          bookedTimeSlots.push({ personId: chosen.personId, start: chosen.startMs, end: chosen.endMs });
        }
        if (chosen.deviceId) {
          bookedDeviceSlots.push({ deviceId: chosen.deviceId, start: chosen.startMs, end: chosen.endMs });
        }
        if (chosen.stationId) {
          bookedStationSlots.push({ stationId: chosen.stationId, start: chosen.startMs, end: chosen.endMs });
          bookedStationCounts.set(
            chosen.stationId,
            (bookedStationCounts.get(chosen.stationId) ?? 0) + 1,
          );
        }
      }
      remaining.splice(0, remaining.length, ...next);
    }

    // 前置未就绪（predecessor 未完成或未可行分配）的任务显式 UNASSIGNED（§33 不伪造）。
    for (const task of remaining) {
      violations.push({
        type: 'UNASSIGNED_RULE_BASED',
        taskId: task.id,
        reason: 'predecessor_unassigned',
        predecessorIds: task.predecessorIds ?? [],
      });
    }

    const evaluated = this.objectiveEvaluator.evaluate({
      snapshot,
      assignments,
      policy,
      constraints,
      baseline: opts.baselineAssignee,
      churn: config.churn,
      horizonMinutes,
      nowMs: now,
    });

    return {
      planId: opts.planId,
      planName: opts.planName,
      version: 1,
      status: 'shadow',
      trigger: { type: opts.triggerType, entityId: opts.triggerEntityId },
      snapshotVersion: opts.snapshotVersion,
      policyVersion: policy.version,
      solverVersion: RULE_BASED_SOLVER_VERSION,
      // Phase C 同纪律：状态如实标记，绝不冒充 heuristic/CP-SAT 成功。
      solverStatus: 'RULE_BASED',
      objective: evaluated.objective,
      scoreBreakdown: evaluated.scoreBreakdown,
      solveDurationMs: Math.max(Date.now() - now, 0),
      horizonMinutes,
      assignments,
      metrics: evaluated.metrics,
      baselineDelta: evaluated.baselineDelta,
      violations,
      createdAt: new Date().toISOString(),
    };
  }

  private buildAssignment(
    task: WorldStateSnapshot['tasks'][number],
    chosen: CandidateEvaluation,
    policy: SchedulingPolicy,
    opts: SolveOptions,
    pool: CandidateEvaluation[],
  ): SchedulingAssignment {
    const candidates: DecisionTrace['candidates'] = pool
      .filter((c) => c.eligible)
      .sort(compareCandidatesByRule)
      .slice(0, 12)
      .map((c) => ({
        personId: c.personId,
        deviceId: c.deviceId,
        stationId: c.stationId,
        score: Number.isFinite(c.scoreBreakdown.total) ? c.scoreBreakdown.total : null,
        reasons: [],
      }));
    const rejectedHard: NonNullable<DecisionTrace['rejectedHard']> = pool
      .filter((c) => !c.eligible)
      .slice(0, REJECTED_HARD_CAP)
      .map((c) => ({
        personId: c.personId,
        deviceId: c.deviceId,
        stationId: c.stationId,
        rejectReasons: c.rejectReasons.map((r) => String(r)),
      }));
    const decisionTrace: DecisionTrace = {
      taskId: task.id,
      selected: {
        personId: chosen.personId,
        deviceId: chosen.deviceId,
        stationId: chosen.stationId,
      },
      priority: { level: String(task.priority ?? 'unknown'), score: null, factors: [] },
      candidates,
      selectedReason: ['rule-based:first-eligible'],
      rejectedAlternatives: [],
      policyVersion: policy.version,
      solverVersion: RULE_BASED_SOLVER_VERSION,
      snapshotVersion: opts.snapshotVersion,
      rejectedHard,
      hardConstraints: ['skill-match', 'certification-valid', 'capacity', 'safety', 'eligibility'],
      weightsSnapshot: { ...policy.weights },
    };
    return {
      assignmentId: `ASG-RB-${opts.planId}-${task.id}`,
      taskId: task.id,
      personId: chosen.personId,
      deviceId: chosen.deviceId,
      stationId: chosen.stationId,
      zoneId: task.zoneId ?? null,
      plannedStart: new Date(chosen.startMs).toISOString(),
      plannedEnd: new Date(chosen.endMs).toISOString(),
      routeId: null,
      etaSeconds: chosen.routeCost?.etaSeconds ?? undefined,
      distanceMeters: chosen.routeCost?.distanceMeters ?? undefined,
      riskLevel: chosen.routeCost && chosen.routeCost.risk > 0 ? 'high' : null,
      status: 'proposed',
      reasons: ['rule-based:first-eligible'],
      alternatives: [],
      scoreBreakdown: chosen.scoreBreakdown,
      decisionTrace,
    };
  }
}
