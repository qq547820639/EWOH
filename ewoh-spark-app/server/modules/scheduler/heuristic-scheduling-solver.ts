import { Logger } from '@nestjs/common';
import type {
  DecisionTrace,
  SchedulingAssignment,
  SchedulingConstraint,
  SchedulingPlanV2,
  SchedulingPolicy,
  SchedulingPolicyConfig,
  ScoreBreakdown,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { EligibilityService } from './eligibility.service';
import { RoutingService } from './routing.service';
import { RouteCostProvider, type RouteCost } from './route-cost.provider';
import { SchedulingPolicyService } from './scheduling-policy.service';
import type { SchedulerMetricsService } from './scheduler-metrics.service';
import { TaskLifecycle } from './task-lifecycle';
import { PriorityEngine } from './priority-engine';
import {
  checkConstraintSupported,
  detectDependencyCycle,
} from './constraints';
import type { SchedulingSolver, SolveOptions } from './scheduling-solver.interface';
import { SchedulingObjectiveEvaluator } from './scheduling-objective-evaluator.service';

/** 内部候选方案。 */
interface Candidate {
  personId: string;
  deviceId: string | null;
  stationId: string | null;
  zoneId: string | null;
  startMs: number;
  endMs: number;
  routeId: string | null;
  etaSeconds: number;
  distanceMeters: number;
  riskLevel: string | null;
  /** P0：路径几何（route_graph A* / euclidean 两点），与地图同源。 */
  routeGeometry?: Array<{ x: number; y: number }>;
  waitMs: number;
  lateMs: number;
  changeCost: number;
  cost: number;
  scoreBreakdown: ScoreBreakdown;
  reasons: string[];
  alternatives: Array<Record<string, unknown>>;
}

/** PREFERRED_RESOURCE 软性偏好折算的分值（分钟，越小越优）。 */
const PREFERENCE_BONUS_MINUTES = 30;

/**
 * 确定性启发式求解器（无 LLM）。
 * 输入世界状态快照 + 资格服务 + 路由成本提供者 + 版本化策略 + 锁定约束，
 * 执行 任务×人员×设备×时间窗 的联合调度，
 * 输出含可解释得分分解（ScoreBreakdown）与动态优先级说明的方案。
 * 同一 (snapshot, policy) 输入 → 同一输出（可确定性重放）。
 */
export class HeuristicSchedulingSolver implements SchedulingSolver {
  private readonly logger = new Logger(HeuristicSchedulingSolver.name);

  constructor(
    private readonly policyService: SchedulingPolicyService,
    private readonly routingService: RoutingService,
    private readonly routeCostProvider: RouteCostProvider,
    private readonly eligibilityService: EligibilityService,
    private readonly priorityEngine: PriorityEngine = new PriorityEngine(),
    private readonly metricsService?: SchedulerMetricsService,
    // P0-5：统一目标评估器（默认自建；测试可注入替身）。
    private readonly objectiveEvaluator: SchedulingObjectiveEvaluator = new SchedulingObjectiveEvaluator(),
  ) {}

  /** 暴露当前激活策略（供外层组合求解器构建请求权重时复用同一策略）。 */
  async loadActivePolicy(): Promise<SchedulingPolicy> {
    return this.policyService.getActivePolicy();
  }

  /** 暴露策略配置（供外层组合求解器复用同一优先级/参数语义）。 */
  async loadConfig(): Promise<SchedulingPolicyConfig> {
    return this.policyService.getConfig();
  }

  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const now = Date.now();
    const policy = opts.policy ?? (await this.policyService.getActivePolicy());
    const config = await this.policyService.getConfig();
    const horizonMinutes = config.horizonMinutes ?? opts.horizonMinutes;
    const horizonEndMs = now + horizonMinutes * 60 * 1000;
    const defaultDurationMs = config.defaultTaskDurationMs;

    // 快照可能含有类型定义尚未覆盖的字段（如下游演进），通过受限联合访问。
    const snapshotExt = snapshot as WorldStateSnapshot & {
      safetyBlockedPersonIds?: string[];
    };
    const safetyBlockedPersonIds = snapshotExt.safetyBlockedPersonIds ?? [];

    const violations: Array<Record<string, unknown>> = [];

    // ---- Phase 2 / P2-T3：Solver 可观测（候选数 / 硬约束拒绝数） ----
    let candidateCount = 0;
    let hardRejectCount = 0;

    // ---- 约束支持性检查 + 拆解可执行约束 ----
    const lockedPersonByTask = new Map<string, string>();
    const lockedDeviceByTask = new Map<string, string>();
    const lockedTimeByTask = new Map<string, [number, number]>();
    const forbiddenZones = new Set<string>(
      snapshot.forbiddenZones.map((f) => f.zoneId),
    );
    const manualBoostTasks = new Set<string>();
    let minBatteryOverride: number | null = null;
    let maxLoadOverride: number | null = null;

    // 人工资源排除/偏好（EXCLUDED_RESOURCE / PREFERRED_RESOURCE，软约束）。
    // 记录 taskId -> Set<resourceId>；taskId 为空时视为全局排除/偏好。
    const excludedPersonByTask = new Map<string, Set<string>>();
    const excludedDeviceByTask = new Map<string, Set<string>>();
    const excludedStationByTask = new Map<string, Set<string>>();
    const preferredPersonByTask = new Map<string, Set<string>>();
    const preferredDeviceByTask = new Map<string, Set<string>>();
    const preferredStationByTask = new Map<string, Set<string>>();
    const excludedPersonGlobal = new Set<string>();
    const excludedDeviceGlobal = new Set<string>();
    const excludedStationGlobal = new Set<string>();
    const preferredPersonGlobal = new Set<string>();
    const preferredDeviceGlobal = new Set<string>();
    const preferredStationGlobal = new Set<string>();

    const addPerTask = (
      map: Map<string, Set<string>>,
      globalSet: Set<string>,
      taskId: string | undefined,
      resourceId: string,
    ) => {
      if (taskId) {
        let s = map.get(taskId);
        if (!s) {
          s = new Set();
          map.set(taskId, s);
        }
        s.add(resourceId);
      } else {
        globalSet.add(resourceId);
      }
    };

    for (const c of constraints) {
      const support = checkConstraintSupported(c);
      if (!support.supported) {
        violations.push({
          type: 'unsupported_constraint',
          constraintType: c.type,
          reason: 'UNSUPPORTED_CONSTRAINT',
        });
        continue;
      }
      switch (c.type) {
        case 'LOCKED_PERSON':
          if (c.taskId && c.personId) lockedPersonByTask.set(c.taskId, c.personId);
          break;
        case 'LOCKED_DEVICE':
          if (c.taskId && c.deviceId) lockedDeviceByTask.set(c.taskId, c.deviceId);
          break;
        case 'LOCKED_TIME':
          if (c.taskId && c.startMs != null && c.endMs != null)
            lockedTimeByTask.set(c.taskId, [c.startMs, c.endMs]);
          break;
        case 'LOCKED_ASSIGNMENT':
          if (c.taskId && c.personId && c.deviceId) {
            lockedPersonByTask.set(c.taskId, c.personId);
            lockedDeviceByTask.set(c.taskId, c.deviceId);
          }
          break;
        case 'FORBIDDEN_ZONE':
          if (c.zoneId) forbiddenZones.add(c.zoneId);
          break;
        case 'MIN_BATTERY':
          if (c.value != null) minBatteryOverride = c.value;
          break;
        case 'MAX_WORKLOAD':
          if (c.value != null) maxLoadOverride = c.value;
          break;
        case 'EXCLUDED_RESOURCE':
          if (c.personId) addPerTask(excludedPersonByTask, excludedPersonGlobal, c.taskId, c.personId);
          if (c.deviceId) addPerTask(excludedDeviceByTask, excludedDeviceGlobal, c.taskId, c.deviceId);
          if (c.stationId) addPerTask(excludedStationByTask, excludedStationGlobal, c.taskId, c.stationId);
          break;
        case 'PREFERRED_RESOURCE':
          if (c.personId) addPerTask(preferredPersonByTask, preferredPersonGlobal, c.taskId, c.personId);
          if (c.deviceId) addPerTask(preferredDeviceByTask, preferredDeviceGlobal, c.taskId, c.deviceId);
          if (c.stationId) addPerTask(preferredStationByTask, preferredStationGlobal, c.taskId, c.stationId);
          break;
        default:
          break;
      }
      // MANUAL_BOOST 作为软性人工加急（约束类型已进入软约束联合）。
      if (c.type === 'MANUAL_BOOST' && c.taskId) {
        manualBoostTasks.add(c.taskId);
      }
    }

    const effectiveMinBattery = minBatteryOverride ?? config.minBatteryPct;
    const effectiveMaxLoad = maxLoadOverride ?? config.maxContinuousLoad;

    // ---- 前置任务 + 环检测 ----
    const doneTaskIds = new Set<string>(
      snapshot.tasks
        .filter((t) => TaskLifecycle.isTerminal(t.status))
        .map((t) => t.id),
    );
    // P0-1：frozen/executing/locked 前置任务有已知结束时间（与 CP-SAT frozen interval
    // 语义一致）：后继可排在其 planEnd 之后，而不是视为 pending 完全跳过。
    // 来源：snapshot.lockedAssignments + 执行中状态任务的 planEnd。
    const frozenPredEndMs = new Map<string, number>();
    for (const t of snapshot.tasks) {
      const isExecutingOrLocked =
        TaskLifecycle.isExecuting(t.status) ||
        t.status === 'dispatched' ||
        (snapshot.lockedAssignments ?? []).some((la) => la.taskId === t.id);
      if (!isExecutingOrLocked) continue;
      const planEnd = t.planEnd ? Date.parse(t.planEnd) : NaN;
      if (Number.isFinite(planEnd)) frozenPredEndMs.set(t.id, planEnd);
    }
    const allTaskIds = snapshot.tasks.map((t) => t.id);
    const predecessorOf = (taskId: string): string[] => {
      const t = snapshot.tasks.find((x) => x.id === taskId);
      return t ? t.predecessorIds : [];
    };
    const cyclePath = detectDependencyCycle(allTaskIds, predecessorOf);
    const cycleTaskIds = new Set<string>(cyclePath ?? []);
    if (cyclePath) {
      violations.push({
        type: 'PREDECESSOR_CYCLE',
        reason: 'predecessor_cycle',
        cycle: cyclePath,
      });
    }

    // ---- 下游阻塞计数（动态优先级用） ----
    const downstreamCount = new Map<string, number>();
    for (const t of snapshot.tasks) {
      for (const pred of t.predecessorIds) {
        downstreamCount.set(pred, (downstreamCount.get(pred) ?? 0) + 1);
      }
    }

    // ---- 资源索引 ----
    const personById = new Map(snapshot.persons.map((p) => [p.id, p]));
    const deviceById = new Map(snapshot.devices.map((d) => [d.id, d]));
    const stationById = new Map(snapshot.stations.map((s) => [s.id, s]));

    // 预订时间片（来自快照 reservations，person 类型映射为 personId 区间）。
    const baseBookedSlots: Array<{ personId: string; start: number; end: number }> =
      [];
    for (const r of snapshot.reservations ?? []) {
      if (r.resourceType === 'person') {
        baseBookedSlots.push({
          personId: r.resourceId,
          start: r.startMs,
          end: r.endMs,
        });
      }
    }

    // ---- 可调度任务排序（动态优先级 + critical/urgent 硬地板） ----
    // 已锁定/执行中的分配（snapshot.lockedAssignments）必须冻结，不得重排/移动。
    const lockedAssignmentTaskIds = new Set<string>(
      (snapshot.lockedAssignments ?? []).map((la) => la.taskId),
    );
    const ranked = snapshot.tasks
      .filter((t) => TaskLifecycle.isSchedulable(t.status))
      .filter((t) => !cycleTaskIds.has(t.id))
      .filter((t) => !lockedAssignmentTaskIds.has(t.id))
      .map((t) => ({
        task: t,
        priority: this.priorityEngine.compute(policy, {
          task: {
            id: t.id,
            priority: t.priority,
            planStart: t.planStart,
            planEnd: t.planEnd,
            // P0：透传生产影响因子——heuristic 与 CP-SAT 消费同一 PriorityEngine 完整输入，
            // 避免 productionImpact 因子在 heuristic 路径静默失效（结果不一致）。
            productionImpact: t.productionImpact,
          },
          config,
          now,
          horizonEndMs,
          downstreamCount,
          manualBoostIds: manualBoostTasks,
        }),
      }))
      .sort((a, b) => {
        if (a.priority.urgent !== b.priority.urgent)
          return a.priority.urgent ? -1 : 1;
        if (a.priority.score !== b.priority.score)
          return a.priority.score - b.priority.score;
        return a.task.id < b.task.id ? -1 : a.task.id > b.task.id ? 1 : 0;
      });

    const assignments: SchedulingAssignment[] = [];
    const bookedPerson = new Map<string, number>(); // personId -> last end ms
    const bookedDevice = new Map<string, number>(); // deviceId -> last end ms
    const runBookedSlots: Array<{ personId: string; start: number; end: number }> =
      [];
    const bookedDeviceSlots: Array<{
      deviceId: string;
      start: number;
      end: number;
    }> = [];
    const bookedStationSlots: Array<{
      stationId: string;
      start: number;
      end: number;
    }> = [];

    for (const { task, priority } of ranked) {
      // P0-3：due/lateness 语义分离（与 CP-SAT 一致：due 软、mustFinishBy 硬）。
      // softDeadlineMs 仅用于 lateness 软目标（超时允许但 penalty）；优先读
      // dueAtMs，其次 planEnd（向后兼容），最后 horizonEndMs（永不 late）。
      const softDeadlineMs =
        task.dueAtMs != null
          ? task.dueAtMs
          : task.planEnd
            ? Date.parse(task.planEnd)
            : horizonEndMs;
      // mustFinishByMs 为硬截止：候选 endMs 违反则不可分配（与 CP-SAT OnlyEnforceIf 语义一致）。
      const mustFinishByMs = task.latestFinishMs != null ? task.latestFinishMs : null;
      let earliestStartMs = Math.max(
        now,
        task.planStart ? Date.parse(task.planStart) : now,
      );

      // P0-1：predecessor 显式时间约束——后继 earliestStart >= 每个已安排/冻结前置的结束时间。
      // 旧实现只检查 doneTaskIds（完成集合），跨人员并行场景下后继可能排到前置结束之前。
      const predEndTimesMs: number[] = [];
      for (const p of task.predecessorIds ?? []) {
        if (frozenPredEndMs.has(p)) {
          predEndTimesMs.push(frozenPredEndMs.get(p)!);
          continue;
        }
        if (!doneTaskIds.has(p)) continue; // 其余未完成前置在 predPending 分支处理
        const predAsg = assignments.find((a) => a.taskId === p);
        if (predAsg?.plannedEnd) {
          const e = Date.parse(predAsg.plannedEnd);
          if (Number.isFinite(e)) predEndTimesMs.push(e);
        } else {
          const predTask = snapshot.tasks.find((x) => x.id === p);
          if (predTask?.planEnd) {
            const e = Date.parse(predTask.planEnd);
            if (Number.isFinite(e)) predEndTimesMs.push(e);
          }
        }
      }
      if (predEndTimesMs.length > 0) {
        earliestStartMs = Math.max(earliestStartMs, ...predEndTimesMs);
      }

      // 前置任务未全部完成 → 记 violation 并跳过。
      // P0-1：frozen/executing/locked 前置视为"已知结束时间"，不再计入 pending。
      const predPending = (task.predecessorIds ?? []).some(
        (p) => !doneTaskIds.has(p) && !frozenPredEndMs.has(p),
      );
      if (predPending) {
        violations.push({
          taskId: task.id,
          reason: 'predecessor_pending',
          type: 'infeasible',
        });
        continue;
      }

      const lockedWindow = lockedTimeByTask.get(task.id);
      const taskStation = task.stationId ? stationById.get(task.stationId) : undefined;
      const taskPoint = taskStation
        ? { x: taskStation.x, y: taskStation.y }
        : undefined;

      const candidates: Candidate[] = [];

      const candidatePersons = snapshot.persons.filter((p) =>
        this.personMatchesLock(p.id, task.id, lockedPersonByTask) &&
        !this.isExcludedResource(
          task.id,
          p.id,
          excludedPersonByTask,
          excludedPersonGlobal,
        ),
      );

      for (const person of candidatePersons) {
        const personStation = person.stationId
          ? stationById.get(person.stationId)
          : undefined;
        // 人员无工位且坐标缺失（UNKNOWN）时传 undefined 点，交由 routeCostProvider
        // 走空间实体解析/不可行判定；绝不把 null 当作 0,0 伪坐标（见 02 §13）。
        const personPoint = personStation
          ? { x: personStation.x, y: personStation.y }
          : person.x != null && person.y != null
            ? { x: person.x, y: person.y }
            : undefined;

        // 真实路径成本（与地图一致的 route graph）。
        const routeCost = await this.routeCostProvider.estimate(
          person.id,
          task.id,
          personPoint,
          taskPoint,
        );
        if (routeCost.feasible === false) {
          // 无可行路径（含纯手工兜底也不可行）→ 该人员不可达，跳过。
          continue;
        }

        const deviceCandidates = this.devicesForTask(
          task.id,
          deviceById,
          lockedDeviceByTask,
          effectiveMinBattery,
          task.requiredDeviceCapabilities,
          excludedDeviceByTask,
          excludedDeviceGlobal,
        );
        for (const device of deviceCandidates) {
          // P2-T3：每个 (person, device) 候选组合计入候选数。
          candidateCount += 1;
          const travelMs = routeCost.etaSeconds * 1000;
          const rawStartMs = lockedWindow
            ? lockedWindow[0]
            : earliestStartMs + travelMs;
          const startMs = lockedWindow
            ? lockedWindow[0]
            : this.earliestStart(
                rawStartMs,
                bookedPerson.get(person.id),
                device ? bookedDevice.get(device.id) : undefined,
              );
          const durationMs = lockedWindow
            ? Math.max(lockedWindow[1] - lockedWindow[0], 1)
            : task.planEnd && task.planStart
              ? Date.parse(task.planEnd) - Date.parse(task.planStart)
              : defaultDurationMs;
          const endMs = startMs + Math.max(durationMs, 1);

          // P0-3：mustFinishBy 硬检查——候选 endMs 违反硬截止则不可分配
          // （与 CP-SAT OnlyEnforceIf(assigned) 语义一致：无法满足的任务如实 unassigned）。
          if (mustFinishByMs != null && endMs > mustFinishByMs) {
            hardRejectCount += 1;
            candidates.push({
              personId: person.id,
              deviceId: device ? device.id : null,
              stationId: task.stationId,
              zoneId: task.zoneId,
              startMs,
              endMs,
              routeId: routeCost.routeId,
              etaSeconds: routeCost.etaSeconds,
              distanceMeters: routeCost.distanceMeters,
              riskLevel: routeCost.riskLevel,
              routeGeometry: routeCost.geometry ?? [],
              waitMs: 0,
              lateMs: 0,
              changeCost: 0,
              cost: Number.POSITIVE_INFINITY,
              scoreBreakdown: this.zeroBreakdown(),
              reasons: ['must_finish_by_violation'],
              alternatives: [{ reasons: ['must_finish_by_violation'] }],
            });
            continue;
          }

          const eligibility = this.eligibilityService.check(
            {
              id: person.id,
              status: person.status,
              skills: person.skills,
              certifications: person.certifications,
              stationId: person.stationId,
              loadLevel: person.loadLevel,
              fatigueLevel: person.fatigueLevel,
              healthStatus: person.healthStatus,
            },
            {
              id: task.id,
              taskType: task.taskType,
              requiredSkills: task.requiredSkills,
              skillMatchMode: task.skillMatchMode,
              requiredCertifications: task.requiredCertifications,
              stationId: task.stationId,
              zoneId: task.zoneId,
              predIds: task.predecessorIds,
              requiredDeviceCapabilities: task.requiredDeviceCapabilities,
            },
            device
              ? {
                  id: device.id,
                  batteryPct: device.batteryPct,
                  online: device.online,
                  status: device.status,
                  capabilities: device.capabilities ?? [],
                }
              : null,
            {
              now,
              bookedTimeSlots: [...baseBookedSlots, ...runBookedSlots],
              bookedDeviceSlots,
              bookedStationSlots,
              lockedPersonIds: this.lockedPersonIdsForTask(snapshot, task.id),
              forbiddenZones: Array.from(forbiddenZones),
              minBatteryPct: effectiveMinBattery,
              maxContinuousLoad: effectiveMaxLoad,
              safetyBlockedPersonIds,
              predecessorDone: (id) =>
                doneTaskIds.has(id) || frozenPredEndMs.has(id),
              candidateStartMs: startMs,
              candidateEndMs: endMs,
            },
          );

          if (!eligibility.eligible) {
            hardRejectCount += 1;
            candidates.push({
              personId: person.id,
              deviceId: device ? device.id : null,
              stationId: task.stationId,
              zoneId: task.zoneId,
              startMs,
              endMs,
              routeId: routeCost.routeId,
              etaSeconds: routeCost.etaSeconds,
              distanceMeters: routeCost.distanceMeters,
              riskLevel: routeCost.riskLevel,
              routeGeometry: routeCost.geometry ?? [],
              waitMs: 0,
              lateMs: 0,
              changeCost: 0,
              cost: Number.POSITIVE_INFINITY,
              scoreBreakdown: this.zeroBreakdown(),
              reasons: eligibility.reasons,
              alternatives: [{ reasons: eligibility.reasons }],
            });
            continue;
          }

          const lateMs = Math.max(0, endMs - softDeadlineMs);
          const waitMs = Math.max(0, startMs - earliestStartMs);
          const baselineAssignee = opts.baselineAssignee?.get(task.id);
          const changeCost =
            baselineAssignee && baselineAssignee !== person.id ? 1 : 0;
          const loadPenalty = person.loadLevel * 60 * 1000;
          const changeCostMs = changeCost * 60 * 1000;
          const riskMs =
            this.riskFactor(routeCost.riskLevel, config) * travelMs;
          const batteryPct = device ? device.batteryPct : 100;
          const energyPenalty =
            device != null ? (1 - batteryPct / 100) * 60 * 1000 : 0;

          const score = this.computeCandidateScore(
            policy,
            lateMs,
            travelMs,
            loadPenalty,
            waitMs,
            changeCostMs,
            riskMs,
            energyPenalty,
          );

          // 人工偏好（PREFERRED_RESOURCE）：命中偏好资源时降低候选成本（软性加分）。
          const preferred =
            this.isPreferredResource(
              task.id,
              person.id,
              preferredPersonByTask,
              preferredPersonGlobal,
            ) ||
            (device != null &&
              this.isPreferredResource(
                task.id,
                device.id,
                preferredDeviceByTask,
                preferredDeviceGlobal,
              ));
          if (preferred) {
            score.total = Math.max(0, score.total - PREFERENCE_BONUS_MINUTES);
          }

          const reasons = [
            ...priority.explanation,
            `effective_score=${priority.score.toFixed(2)}`,
          ];
          candidates.push({
            personId: person.id,
            deviceId: device ? device.id : null,
            stationId: task.stationId,
            zoneId: task.zoneId,
            startMs,
            endMs,
            routeId: routeCost.routeId,
            etaSeconds: routeCost.etaSeconds,
            distanceMeters: routeCost.distanceMeters,
            riskLevel: routeCost.riskLevel,
            routeGeometry: routeCost.geometry ?? [],
            waitMs,
            lateMs,
            changeCost,
            cost: score.total,
            scoreBreakdown: score,
            reasons,
            alternatives: [],
          });
        }
      }

      const feasible = candidates
        .filter((c) => c.cost !== Number.POSITIVE_INFINITY)
        .sort(this.candidateCompare);
      const best = feasible[0];

      if (!best) {
        const mustFinishByViolated = candidates.some((c) =>
          c.reasons.includes('must_finish_by_violation'),
        );
        violations.push({
          taskId: task.id,
          reason: mustFinishByViolated
            ? 'must_finish_by_violation'
            : 'no_eligible_resource',
          type: 'infeasible',
          alternatives: candidates.map((c) => ({ reasons: c.reasons })),
        });
        continue;
      }

      // 预定资源。
      bookedPerson.set(best.personId, best.endMs);
      if (best.deviceId) bookedDevice.set(best.deviceId, best.endMs);
      runBookedSlots.push({
        personId: best.personId,
        start: best.startMs,
        end: best.endMs,
      });
      if (best.deviceId) {
        bookedDeviceSlots.push({
          deviceId: best.deviceId,
          start: best.startMs,
          end: best.endMs,
        });
      }
      if (best.stationId) {
        bookedStationSlots.push({
          stationId: best.stationId,
          start: best.startMs,
          end: best.endMs,
        });
      }
      // P0-5：metrics 由 SchedulingObjectiveEvaluator 统一计算（见 solve 末尾），
      // 此处不再累积内部计数（避免 CP-SAT/heuristic 双源不一致）。

      // 选中 + 未选候选的决策轨迹（可解释）。
      const decisionTrace: DecisionTrace = {
        taskId: task.id,
        selected: {
          personId: best.personId,
          deviceId: best.deviceId,
          stationId: best.stationId,
        },
        priority: {
          level: String(priority.level),
          score: priority.score,
          factors: priority.factors.map((f) => ({
            key: f.name,
            label: f.name,
            value: f.term,
          })),
        },
        candidates: feasible.map((c) => ({
          personId: c.personId,
          deviceId: c.deviceId,
          stationId: c.stationId,
          score: c.cost,
          reasons: c.reasons,
        })),
        selectedReason: best.reasons,
        rejectedAlternatives: feasible.slice(1).map((c) => ({
          personId: c.personId,
          deviceId: c.deviceId,
          stationId: c.stationId,
          reason: c.reasons,
        })),
        policyVersion: policy.version,
        solverVersion: policy.solverVersion,
        snapshotVersion: opts.snapshotVersion,
      };

      assignments.push({
        assignmentId: `ASG-${opts.planId}-${task.id}`,
        taskId: task.id,
        personId: best.personId,
        deviceId: best.deviceId,
        stationId: best.stationId,
        zoneId: best.zoneId,
        plannedStart: new Date(best.startMs).toISOString(),
        plannedEnd: new Date(best.endMs).toISOString(),
        routeId: best.routeId,
        etaSeconds: best.etaSeconds,
        distanceMeters: best.distanceMeters,
        riskLevel: best.riskLevel,
        status: 'proposed',
        reasons: best.reasons,
        alternatives: best.alternatives,
        scoreBreakdown: best.scoreBreakdown,
        decisionTrace,
      });
      doneTaskIds.add(task.id);
    }

    // P0-5：metrics / scoreBreakdown / objective / baselineDelta 由统一评估器计算
    //（评估器与求解器无关：同一 snapshot+assignments → 同一输出，CP-SAT 与 heuristic
    // 共用同一套评估语义，禁止 CP-SAT assignment 配 heuristic metrics）。
    const evaluated = this.objectiveEvaluator.evaluate({
      snapshot,
      assignments,
      policy,
      constraints,
      baseline: opts.baselineAssignee,
      horizonMinutes,
      nowMs: now,
    });

    // Phase 2 / P2-T3：Solver 可观测埋点（候选数 / 硬约束拒绝数；失败仅记日志，不影响求解）。
    if (this.metricsService) {
      try {
        this.metricsService.recordCandidateCount(candidateCount);
        if (hardRejectCount > 0) this.metricsService.recordHardReject(hardRejectCount);
      } catch (err) {
        this.logger.warn(
          `metrics recording failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      planId: opts.planId,
      planName: opts.planName,
      version: 1,
      status: 'shadow',
      trigger: { type: opts.triggerType, entityId: opts.triggerEntityId },
      snapshotVersion: opts.snapshotVersion,
      policyVersion: policy.version,
      solverVersion: policy.solverVersion,
      // Phase C：heuristic 作为当前 Production Canonical Solver，状态如实标记为
      // HEURISTIC；当作为 CP-SAT fallback 时由 CpSatSchedulingSolver 覆盖为
      // UNAVAILABLE/FALLBACK，绝不把 heuristic 结果冒充 CP-SAT 成功。
      solverStatus: 'HEURISTIC',
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

  /** 计算候选多目标成本（分钟归一化，total 即评分）。
   * Phase 2 / P2-T2：读取 SchedulingPolicy.weights 权威 8 权重（lateness/travel/wait/
   * workload/station/change/risk/energy）。station 权重对应工位队列项，当前无队列指标
   * 时不虚构（不贡献分数）；旧字段（latenessWeight 等）仅为兼容别名，不再直接使用。 */
  private computeCandidateScore(
    policy: SchedulingPolicy,
    lateMs: number,
    travelMs: number,
    loadPenalty: number,
    waitMs: number,
    changeCostMs: number,
    riskMs: number,
    energyPenalty: number,
  ): ScoreBreakdown {
    const w = policy.weights;
    const lateness = (w.lateness * lateMs) / 60000;
    const travel = (w.travel * travelMs) / 60000;
    const workloadBalance = (w.workload * loadPenalty) / 60000;
    const stationWait = (w.wait * waitMs) / 60000;
    const changeCost = (w.change * changeCostMs) / 60000;
    const risk = (w.risk * riskMs) / 60000;
    const energyCost = (w.energy * energyPenalty) / 60000;
    return {
      lateness,
      travel,
      workloadBalance,
      stationWait,
      changeCost,
      risk,
      energyCost,
      total: lateness + travel + workloadBalance + stationWait + changeCost + risk + energyCost,
    };
  }

  private zeroBreakdown(): ScoreBreakdown {
    return {
      lateness: 0,
      travel: 0,
      workloadBalance: 0,
      stationWait: 0,
      changeCost: 0,
      risk: 0,
      energyCost: 0,
      total: 0,
    };
  }

  private personMatchesLock(
    personId: string,
    taskId: string,
    locked: Map<string, string>,
  ): boolean {
    const lockedPerson = locked.get(taskId);
    return lockedPerson ? lockedPerson === personId : true;
  }

  private lockedPersonIdsForTask(
    snapshot: WorldStateSnapshot,
    taskId: string,
  ): string[] {
    const ids = snapshot.lockedAssignments
      .filter((la) => la.taskId !== taskId)
      .map((la) => la.personId ?? '')
      .filter(Boolean);
    return Array.from(new Set(ids));
  }

  private devicesForTask(
    taskId: string,
    deviceById: Map<string, WorldStateSnapshot['devices'][number]>,
    locked: Map<string, string>,
    minBatteryPct: number,
    requiredCapabilities?: string[],
    excludedPerTask?: Map<string, Set<string>>,
    excludedGlobal?: Set<string>,
  ): Array<WorldStateSnapshot['devices'][number] | null> {
    const lockedDevice = locked.get(taskId);
    if (lockedDevice) {
      const d = deviceById.get(lockedDevice);
      return d ? [d] : [];
    }
    const caps = requiredCapabilities ?? [];
    const onlineDevices = Array.from(deviceById.values()).filter(
      (d) =>
        d.online &&
        d.batteryPct >= minBatteryPct &&
        caps.every((cap) => (d.capabilities ?? []).includes(cap)) &&
        !this.isExcludedResource(
          taskId,
          d.id,
          excludedPerTask ?? new Map(),
          excludedGlobal ?? new Set(),
        ),
    );
    // 任务要求设备能力时：仅返回具备全部能力的设备，绝不回退到纯手工作业（null）。
    // 无能力要求时允许 null（人员纯手工作业）。
    return caps.length > 0
      ? onlineDevices
      : onlineDevices.length > 0
        ? onlineDevices
        : [null];
  }

  /** 判断资源是否被 EXCLUDED_RESOURCE 排除（命中任务级或全局排除集）。 */
  private isExcludedResource(
    taskId: string,
    resourceId: string,
    perTask: Map<string, Set<string>>,
    globalSet: Set<string>,
  ): boolean {
    return globalSet.has(resourceId) || perTask.get(taskId)?.has(resourceId) === true;
  }

  /** 判断资源是否被 PREFERRED_RESOURCE 标记为偏好（命中任务级或全局偏好集）。 */
  private isPreferredResource(
    taskId: string,
    resourceId: string,
    perTask: Map<string, Set<string>>,
    globalSet: Set<string>,
  ): boolean {
    return globalSet.has(resourceId) || perTask.get(taskId)?.has(resourceId) === true;
  }

  private earliestStart(
    lowerBoundMs: number,
    personFreeAtMs: number | undefined,
    deviceFreeAtMs: number | undefined,
  ): number {
    return Math.max(
      lowerBoundMs,
      personFreeAtMs ?? 0,
      deviceFreeAtMs ?? 0,
    );
  }

  private riskFactor(
    riskLevel: string | null,
    config: SchedulingPolicyConfig,
  ): number {
    if (riskLevel === 'high') return config.highRiskFactor;
    if (riskLevel === 'medium') return config.mediumRiskFactor;
    return 1;
  }

  private candidateCompare(a: Candidate, b: Candidate): number {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.personId !== b.personId)
      return a.personId < b.personId ? -1 : 1;
    const da = a.deviceId ?? '';
    const db = b.deviceId ?? '';
    return da < db ? -1 : da > db ? 1 : 0;
  }
}