/* eslint-disable @darraghor/nestjs-typed/injectable-should-be-provided -- 手工组合装配：由 SolverService 构造函数 new 实例化，不经 DI providers 注册，规则误报 */
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
import { compileConstraintOverrides } from './constraints';

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
    const orgId = opts.orgId ?? null;
    const policy: SchedulingPolicy = opts.policy ?? (await this.policyService.getActivePolicy(orgId));
    const config = await this.policyService.getConfig(orgId);
    const horizonMinutes = config.horizonMinutes ?? opts.horizonMinutes;
    const doneTaskIds = new Set<string>(
      snapshot.tasks.filter((t) => TaskLifecycle.isTerminal(t.status)).map((t) => t.id),
    );

    // 已锁定分配（快照真实事实：executing/locked 的任务人员不再可分配）。
    const lockedPersonByTask = new Map<string, string>();
    for (const locked of snapshot.lockedAssignments ?? []) {
      if (locked.personId) lockedPersonByTask.set(locked.taskId, locked.personId);
    }

    // R2-SCH-003（2026-08-17）：解析输入约束（LOCKED_*/EXCLUDED/FORBIDDEN_ZONE/
    // MIN_BATTERY/MAX_W 等经共享候选引擎真实执行；不支持的类型显式记
    // violations=UNSUPPORTED_CONSTRAINT，绝不静默失效）。
    const ir = compileConstraintOverrides(constraints);
    // 快照锁定事实为底、显式约束覆盖（约束是更近的人工意图）。
    for (const [taskId, personId] of ir.lockedPersonByTask) {
      lockedPersonByTask.set(taskId, personId);
    }
    const lockedDeviceByTask = new Map<string, string>(ir.lockedDeviceByTask);
    for (const locked of snapshot.lockedAssignments ?? []) {
      if (locked.deviceId && !lockedDeviceByTask.has(locked.taskId)) {
        lockedDeviceByTask.set(locked.taskId, locked.deviceId);
      }
    }
    const unsupportedViolations: Array<Record<string, unknown>> = ir.unsupported.map(
      (c) => ({
        type: 'unsupported_constraint',
        constraintType: c.type,
        reason: 'UNSUPPORTED_CONSTRAINT',
      }),
    );

    const assignments: SchedulingAssignment[] = [];
    const violations: Array<Record<string, unknown>> = [...unsupportedViolations];
    // 预订时间片：快照 reservations（person/device/station）+ 本 solve 内新增
    // 占用统一进槽位。此前只喂本 solve 新增占用——快照里已被 dispatch 预占的
    // 设备/工位对求解器不可见，方案把新任务派上已占资源，dispatch 预占硬后盾
    // 409 RESOURCE_CONFLICT 整波失败（与 heuristic 同根因，同口径修复）。
    const baseBookedSlots: Array<{ personId: string; start: number; end: number }> = [];
    const baseBookedDeviceSlots: Array<{ deviceId: string; start: number; end: number }> = [];
    const baseBookedStationSlots: Array<{ stationId: string; start: number; end: number }> = [];
    for (const r of snapshot.reservations ?? []) {
      if (r.resourceType === 'person') {
        baseBookedSlots.push({ personId: r.resourceId, start: r.startMs, end: r.endMs });
      } else if (r.resourceType === 'device') {
        baseBookedDeviceSlots.push({ deviceId: r.resourceId, start: r.startMs, end: r.endMs });
      } else if (r.resourceType === 'station') {
        baseBookedStationSlots.push({ stationId: r.resourceId, start: r.startMs, end: r.endMs });
      }
    }
    const bookedTimeSlots: Array<{ personId: string; start: number; end: number }> = [
      ...baseBookedSlots,
    ];
    const bookedDeviceSlots: Array<{ deviceId: string; start: number; end: number }> = [
      ...baseBookedDeviceSlots,
    ];
    const bookedStationSlots: Array<{ stationId: string; start: number; end: number }> = [
      ...baseBookedStationSlots,
    ];
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
          // R-6（2026-09-13）：透传本请求租户，让路径成本估算复用按租户分桶的路由图缓存
          // （不透传则每候选一次全图 SELECT，见 candidate-engine 的同一注释）。
          orgId: opts.orgId ?? null,
          // R2-SCH-002：变体策略透传（候选评分消费变体权重缩放）。
          policy,
          // Same tenant config must drive the primary pool and constraints; a
          // second read could observe a concurrent policy activation.
          config,
          // R2-SCH-001：人员/设备占用顺延（booked 槽位推得的资源空闲时刻）。
          bookedPersonFreeAt: this.freeAtByResource(bookedTimeSlots, (s) => s.personId),
          bookedDeviceFreeAt: this.freeAtByResource(bookedDeviceSlots, (s) => s.deviceId),
          // R2-SCH-003：约束 IR 透传（锁定/排除/偏好/禁入区/电量/负荷全覆盖）。
          lockedPersonByTask,
          lockedDeviceByTask,
          lockedStationByTask: ir.lockedStationByTask,
          lockedTimeByTask: ir.lockedTimeByTask,
          forbiddenZoneIds: ir.forbiddenZoneIds,
          excludedPersonByTask: ir.excludedPersonByTask,
          excludedDeviceByTask: ir.excludedDeviceByTask,
          excludedStationByTask: ir.excludedStationByTask,
          excludedPersonGlobal: ir.excludedPersonGlobal,
          excludedDeviceGlobal: ir.excludedDeviceGlobal,
          excludedStationGlobal: ir.excludedStationGlobal,
          preferredPersonByTask: ir.preferredPersonByTask,
          preferredDeviceByTask: ir.preferredDeviceByTask,
          preferredStationByTask: ir.preferredStationByTask,
          preferredPersonGlobal: ir.preferredPersonGlobal,
          preferredDeviceGlobal: ir.preferredDeviceGlobal,
          preferredStationGlobal: ir.preferredStationGlobal,
          bookedTimeSlots,
          bookedDeviceSlots,
          bookedStationSlots,
          bookedStationCounts,
          baselineAssignee: opts.baselineAssignee,
          minBatteryPct: ir.minBatteryOverride ?? config.minBatteryPct,
          maxContinuousLoad: ir.maxLoadOverride ?? config.maxContinuousLoad,
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
            // NO-15c：把候选层的**能力细节**带上方案（哪个能力、谁/何时/为何停用）。
            // 只带拒绝原因键时，班组长在方案上只能看到"capability_disabled ×2"，
            // 仍不知道是哪个能力、谁停的、为什么——那正是处置所需的全部信息。
            capabilityNotes: this.collectCapabilityNotes(pool),
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

  /**
   * R2-SCH-001：booked 槽位 → 资源空闲时刻（resourceId → max end）。候选 startMs
   * 按占用顺延，与 heuristic 内联 earliestStart(raw, personFreeAt, deviceFreeAt) 同语义。
   */
  /**
   * 方案级能力说明聚合（NO-15c）。
   *
   * 从候选池收集能力相关细节（缺哪些能力、哪些被人停用及其留痕），去重后限量返回——
   * 方案层不重复候选层的全部噪音，但**关键处置信息一条都不能少**。
   */
  private collectCapabilityNotes(pool: CandidateEvaluation[]): string[] {
    const notes = pool
      .slice(0, REJECTED_HARD_CAP)
      .flatMap((c) => c.capabilityNotes ?? []);
    return [...new Set(notes)].slice(0, REJECTED_HARD_CAP);
  }

  private freeAtByResource<T extends { start: number; end: number }>(
    slots: T[],
    resourceIdOf: (slot: T) => string,
  ): Map<string, number> {
    const freeAt = new Map<string, number>();
    for (const s of slots) {
      const id = resourceIdOf(s);
      freeAt.set(id, Math.max(freeAt.get(id) ?? 0, s.end));
    }
    return freeAt;
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
      // NEST-169 修复（2026-08-17）：hardConstraints 不再纯硬编码——由本次候选池
      // 实际执行/触发的硬约束（rejectReasons）派生并集固定执行类，随方案可审计；
      // 后续接入 constraintIR（run-orchestrator 已在 assignment 级透传）。
      hardConstraints: Array.from(
        new Set([
          'skill-match',
          'certification-valid',
          'capacity',
          'safety',
          'eligibility',
          ...pool.flatMap((c) =>
            c.eligible ? [] : c.rejectReasons.map((r) => `eligibility:${String(r)}`),
          ),
        ]),
      ).sort(),
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
      // R2-SCH-017：riskLevel 原样透传（不再折叠为 risk>0?'high'，medium 不丢失）。
      riskLevel: chosen.routeCost?.riskLevel ?? null,
      status: 'proposed',
      reasons: ['rule-based:first-eligible'],
      alternatives: [],
      scoreBreakdown: chosen.scoreBreakdown,
      decisionTrace,
    };
  }
}
