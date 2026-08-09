import { Logger } from '@nestjs/common';
import type {
  SchedulingAssignment,
  SchedulingConstraint,
  SchedulingPlanV2,
  SchedulingPolicy,
  SolverRequest,
  SolverResponse,
  SolverStatus,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { HeuristicSchedulingSolver } from './heuristic-scheduling-solver';
import type { TravelCostService } from './travel-cost.service';
import type { SchedulerMetricsService } from './scheduler-metrics.service';
import type { SchedulingSolver, SolveOptions } from './scheduling-solver.interface';
import {
  computeEffectivePriorityResults,
  type PriorityResult,
} from './priority-engine';
import { checkConstraintSupported } from './constraints';

/** CP-SAT 求解器版本标识。 */
const CPSAT_VERSION = 'cpsat-v1';
/** 默认缺省时长（无 planStart/planEnd 时），与策略默认一致（30 分钟）。 */
const DEFAULT_DURATION_MS = 1_800_000;

/** CP-SAT Worker 配置。 */
export interface CpSatSolverConfig {
  /** Worker 基础 URL（默认取 env CPSAT_WORKER_URL 或 127.0.0.1:8000）。 */
  workerUrl?: string;
  /** HTTP 超时（ms）。 */
  timeoutMs?: number;
  logger?: Logger;
  /** 可注入的 fetch（测试替身用）。默认为全局 fetch。 */
  fetch?: typeof globalThis.fetch;
}

/**
 * CP-SAT 组合求解器：优先调用 Python OR-Tools CP-SAT Worker，
 * 并在 Worker 不可达 / 超时 / 返回非最优可行结果时，安全回退到确定性启发式求解器。
 * 返回的方案始终携带实际使用的求解器版本与状态（solverVersion / solverStatus），
 * 回退结果绝不会被标记为 CP-SAT 的 OPTIMAL/FEASIBLE。
 */
export class CpSatSchedulingSolver {
  private readonly logger: Logger;
  private readonly workerUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    private readonly heuristicSolver: HeuristicSchedulingSolver,
    config: CpSatSolverConfig = {},
    private readonly travelCostService?: TravelCostService,
    private readonly metricsService?: SchedulerMetricsService,
  ) {
    this.logger = config.logger ?? new Logger(CpSatSchedulingSolver.name);
    this.workerUrl =
      config.workerUrl ?? process.env.CPSAT_WORKER_URL ?? 'http://127.0.0.1:8000';
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const policy = opts.policy ?? (await this.heuristicSolver.loadActivePolicy());
    const config = await this.heuristicSolver.loadConfig();
    const nowMs = Date.now();
    const horizonEndMs = nowMs + (opts.horizonMinutes ?? 60) * 60 * 1000;
    // 统一优先级：CP-SAT 与 heuristic 消费同一 PriorityEngine 结果（含完整解释）。
    const priorityResults = computeEffectivePriorityResults(
      policy,
      config,
      snapshot,
      constraints,
      nowMs,
      horizonEndMs,
    );
    const effectiveScores = new Map<string, number>();
    for (const [id, r] of priorityResults) effectiveScores.set(id, r.score);

    let response: SolverResponse | null = null;
    let reachable = false;
    // P2-T1：候选可行性矩阵（TravelCostService SSOT）——只有矩阵判定 feasible 的
    // person/device 候选才进入求解请求（eligiblePersonIds/eligibleDeviceIds）；
    // 缺坐标候选在矩阵层已被排除（绝不把 UNKNOWN 坐标当作 0,0 伪坐标送入 Worker）。
    // P0：矩阵构建失败 → fail-closed。禁止把未过滤候选送入 Worker（会静默绕过
    // 安全/资格/路由硬约束），也不得把 fail-open 结果当作正常求解——
    // 直接回退启发式并显式标记 degraded/fallback，绝不伪装 OPTIMAL。
    let eligibleByTask:
      | Map<string, { personIds: string[]; deviceIds: string[] }>
      | undefined;
    // P4-GEOM：taskId → (candidateKey → geometry)，CP-SAT assignment 装配时恢复真实路线。
    let geometryIndex: Map<string, Map<string, Array<{ x: number; y: number }>>> | undefined;
    let eligibilityMatrixFailed = false;
    if (
      this.travelCostService &&
      typeof (this.travelCostService as TravelCostService).buildEligibilityMatrix ===
        'function'
    ) {
      try {
        eligibleByTask = await this.travelCostService.buildEligibilityMatrix(snapshot);
        // P4-GEOM：按 eligible 候选构建 geometry 索引（与求解请求同源 RouteCost）。
        geometryIndex = new Map();
        for (const [taskId, elig] of eligibleByTask) {
          const task = snapshot.tasks.find((t) => t.id === taskId);
          if (!task) continue;
          const candidates = elig.personIds.map((pid) => ({ personId: pid, deviceId: null, stationId: task.stationId }));
          try {
            const matrix = await this.travelCostService.buildMatrix(snapshot, task, candidates);
            const byKey = new Map<string, Array<{ x: number; y: number }>>();
            for (const c of matrix.candidates) {
              if (!c.feasible) continue;
              byKey.set(`${c.personId ?? 'any'}|${c.deviceId ?? 'any'}|${c.stationId ?? 'any'}`, c.geometry ?? []);
            }
            geometryIndex.set(taskId, byKey);
          } catch {
            // 单个 task 几何不可用不影响主流程（地图回退起终点直线）
          }
        }
      } catch (err) {
        eligibilityMatrixFailed = true;
        this.logger.error(
          `eligibility matrix build failed; fail-closed → degraded heuristic fallback: ${(err as Error)?.message ?? err}`,
        );
        if (this.metricsService) {
          try {
            this.metricsService.recordFallback();
          } catch {
            // 指标记录失败不影响主路径
          }
        }
      }
    }
    if (eligibilityMatrixFailed) {
      const degraded = await this.heuristicSolver.solve(snapshot, constraints, opts);
      return {
        ...degraded,
        solverStatus:
          degraded.solverStatus === 'OPTIMAL' ? 'HEURISTIC' : degraded.solverStatus,
        fallbackReason: 'eligibility_matrix_build_failed',
        baselineDelta: {
          ...(degraded.baselineDelta ?? {}),
          degraded: {
            reason: 'eligibility_matrix_build_failed',
            detail:
              '资格/路由可行性矩阵构建失败，已 fail-closed 回退启发式求解（未使用未过滤候选，无安全/资格绕过）',
          },
        },
      };
    }
    try {
      const request = this.buildRequest(
        snapshot,
        constraints,
        opts,
        policy,
        nowMs,
        effectiveScores,
        eligibleByTask,
      );
      response = await this.post(request);
      reachable = true;
    } catch (err) {
      this.logger.warn(
        `CP-SAT worker 不可达（${this.workerUrl}）：${(err as Error)?.message ?? err}`,
      );
      // Phase 2 / P2-T3：Solver 可观测埋点（fallback / timeout；失败仅记日志）。
      if (this.metricsService) {
        try {
          this.metricsService.recordFallback();
          if (err instanceof Error && /abort|timeout/i.test(err.message)) {
            this.metricsService.recordSolverTimeout();
          }
        } catch (metricsErr) {
          this.logger.warn(
            `solver fallback metrics recording failed: ${metricsErr instanceof Error ? metricsErr.message : String(metricsErr)}`,
          );
        }
      }
      reachable = false;
    }

    // 成功且为最优/可行 → 采用 CP-SAT 结果。
    if (
      response &&
      (response.solverStatus === 'OPTIMAL' || response.solverStatus === 'FEASIBLE')
    ) {
      this.logger.log(
        `使用 CP-SAT 求解器（${response.solverStatus}），objective=${response.objective}`,
      );
      return this.buildCpsatPlan(
        response,
        snapshot,
        constraints,
        opts,
        policy,
        priorityResults,
        geometryIndex,
      );
    }

    // 否则回退到启发式：Worker 可达但结果不可用 → FALLBACK；不可达 → UNAVAILABLE。
    const fallbackStatus: SolverStatus = reachable ? 'FALLBACK' : 'UNAVAILABLE';
    const fallbackReason = reachable
      ? `CP-SAT worker 返回非最优/不可用状态（${response?.solverStatus ?? 'unknown'}），回退启发式`
      : `CP-SAT worker 不可达（${this.workerUrl}），回退启发式`;
    this.logger.warn(
      `回退到启发式求解器（solverStatus=${fallbackStatus}）：${fallbackReason}`,
    );
    const plan = await this.heuristicSolver.solve(snapshot, constraints, opts);
    plan.solverStatus = fallbackStatus;
    plan.fallbackReason = fallbackReason;
    return plan;
  }

  // ---- 内部：构建 SolverRequest ----

  private buildRequest(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
    policy: SchedulingPolicy,
    nowMs: number,
    effectiveScores: Map<string, number>,
    eligibleByTask?: Map<string, { personIds: string[]; deviceIds: string[] }>,
  ): SolverRequest {
    const horizonMinutes = opts.horizonMinutes;

    // ---- 约束拆解：与 heuristic 语义一致，CP-SAT 主路径同样真实执行 ----
    const lockedPersonByTask = new Map<string, string>();
    const lockedDeviceByTask = new Map<string, string>();
    const lockedStationByTask = new Map<string, string>();
    const lockedTimeByTask = new Map<string, [number, number]>();
    const extraForbiddenZones = new Set<string>();
    for (const c of constraints) {
      const support = checkConstraintSupported(c);
      if (!support.supported) {
        continue;
      }
      switch (c.type) {
        case 'LOCKED_PERSON':
          if (c.taskId && c.personId) lockedPersonByTask.set(c.taskId, c.personId);
          break;
        case 'LOCKED_DEVICE':
          if (c.taskId && c.deviceId) lockedDeviceByTask.set(c.taskId, c.deviceId);
          break;
        case 'LOCKED_STATION':
          if (c.taskId && c.stationId)
            lockedStationByTask.set(c.taskId, c.stationId);
          break;
        case 'LOCKED_TIME':
          if (c.taskId && c.startMs != null && c.endMs != null)
            lockedTimeByTask.set(c.taskId, [c.startMs, c.endMs]);
          break;
        case 'LOCKED_ASSIGNMENT':
          if (c.taskId && c.personId) lockedPersonByTask.set(c.taskId, c.personId);
          if (c.taskId && c.deviceId) lockedDeviceByTask.set(c.taskId, c.deviceId);
          if (c.taskId && c.stationId)
            lockedStationByTask.set(c.taskId, c.stationId);
          break;
        case 'FORBIDDEN_ZONE':
          if (c.zoneId) extraForbiddenZones.add(c.zoneId);
          break;
        default:
          break;
      }
    }

    const tasks = snapshot.tasks.map((t) => {
      const eligible = eligibleByTask?.get(t.id);
      const planStart = t.planStart ? Date.parse(t.planStart) : NaN;
      const planEnd = t.planEnd ? Date.parse(t.planEnd) : NaN;
      const earliestStartMs = Number.isFinite(planStart) ? planStart : nowMs;
      const dueMs =
        t.dueAtMs != null
          ? t.dueAtMs
          : Number.isFinite(planEnd)
            ? planEnd
            : null;
      const durationMs =
        Number.isFinite(planStart) && Number.isFinite(planEnd)
          ? Math.max(planEnd - planStart, 1)
          : DEFAULT_DURATION_MS;
      return {
        taskId: t.id,
        // 统一优先级：来自共享 PriorityEngine（越小越紧急），禁止独立 priorityRank。
        priority: effectiveScores.get(t.id) ?? nowMs,
        effectivePriorityScore: effectiveScores.get(t.id) ?? null,
        earliestStartMs,
        dueMs,
        durationMs,
        requiredSkills: t.requiredSkills ?? [],
        requiredCertifications: t.requiredCertifications ?? [],
        requiredDeviceCapabilities: t.requiredDeviceCapabilities ?? [],
        candidateStationIds: t.candidateStations ?? (t.stationId ? [t.stationId] : []),
        zoneId: t.zoneId ?? null,
        predecessorIds: t.predecessorIds ?? [],
        safetyCritical: t.safetyCritical ?? false,
        preemptible: t.preemptible ?? false,
        skillMatchMode: t.skillMatchMode ?? 'ALL',
        // P2-T1：矩阵判定 feasible 的候选才允许进入求解请求（缺坐标候选已被矩阵层排除）。
        eligiblePersonIds: eligible?.personIds,
        eligibleDeviceIds: eligible?.deviceIds,
      };
    });

    const persons = snapshot.persons.map((p) => ({
      id: p.id,
      status: p.status,
      locationStationId: p.stationId ?? null,
      // P0：坐标 UNKNOWN 显式 null 直传 Worker（禁止 0,0 伪坐标）。
      // 无坐标人员已被资格矩阵排除出所有任务候选（eligiblePersonIds 不含），
      // Worker 对 null 坐标不做 travel 计算（见 worker solver.py）。
      x: p.x ?? null,
      y: p.y ?? null,
      skills: p.skills ?? [],
      certifications: p.certifications ?? [],
      workload: p.loadLevel ?? 0,
      fatigue: p.fatigueLevel ?? 0,
      availableFromMs: p.availableFromMs ?? null,
    }));

    const devices = snapshot.devices.map((d) => ({
      id: d.id,
      status: d.status ?? 'online',
      online: d.online,
      capabilities: d.capabilities ?? [],
      batteryPct: d.batteryPct ?? 100,
      x: d.x ?? null,
      y: d.y ?? null,
      availableFromMs: null,
    }));

    const stations = snapshot.stations.map((s) => ({
      id: s.id,
      // P0：工位坐标 UNKNOWN 显式 null（不再映射 0,0）。
      x: s.x ?? null,
      y: s.y ?? null,
      capacity: s.capacity ?? null,
    }));

    const reservations = (snapshot.reservations ?? []).map((r) => ({
      resourceId: r.resourceId,
      resourceType: r.resourceType,
      startMs: r.startMs,
      endMs: r.endMs,
    }));

    const forbiddenZones = [
      ...new Set([
        ...(snapshot.forbiddenZones ?? []).map((f) => f.zoneId),
        ...Array.from(extraForbiddenZones),
      ]),
    ];

    const frozenAssignments = this.buildFrozenAssignments(
      snapshot,
      lockedPersonByTask,
      lockedDeviceByTask,
      lockedStationByTask,
      lockedTimeByTask,
    );

    const baselineAssignee: Record<string, string | null> = {};
    if (opts.baselineAssignee) {
      for (const [k, v] of opts.baselineAssignee) baselineAssignee[k] = v;
    }

    return {
      requestId: opts.planId,
      snapshotVersion: opts.snapshotVersion,
      policyVersion: policy.version,
      solverVersion: CPSAT_VERSION,
      horizonMinutes,
      nowMs,
      // Phase 2 / P2-T2：权重来自 SchedulingPolicy.weights 权威 8 权重。
      // Worker 契约字段映射：travel←weights.travel；workloadBalance←weights.workload；
      // stationWait←weights.wait；changeCost←weights.change；energyRisk←weights.energy；
      // churn←weights.change（churn/stability 罚项与变更罚共用同一权重）。
      weights: {
        lateness: policy.weights.lateness,
        travel: policy.weights.travel,
        workloadBalance: policy.weights.workload,
        stationWait: policy.weights.wait,
        changeCost: policy.weights.change,
        risk: policy.weights.risk,
        energyRisk: policy.weights.energy,
        churn: policy.weights.change,
      },
      tasks,
      persons,
      devices,
      stations,
      reservations,
      forbiddenZones,
      // 原始约束统一透传（含 MIN_BATTERY / MAX_WORKLOAD / RESOURCE_TIME_WINDOW 等），
      // 不支持的约束显式标记，不静默忽略。
      constraints: constraints.map((c) => ({
        ...c,
        supported: checkConstraintSupported(c).supported,
      })),
      frozenAssignments,
      baselineAssignee,
      timeLimitMs: this.timeoutMs,
      // P0：安全硬约束直达 Worker——safety blocked 的 person/device 在候选生成层
      // 被硬过滤（fail-closed），不依赖权重或启发式偏好，且拒绝理由可解释。
      safetyBlockedPersonIds: snapshot.safetyBlockedPersonIds ?? [],
      safetyBlockedDeviceIds: snapshot.safetyBlockedDeviceIds ?? [],
    };
  }

  /** 收集 executing/locked 的 assignment 作为不可移动的冻结项（合并 LOCKED_* 约束）。 */
  private buildFrozenAssignments(
    snapshot: WorldStateSnapshot,
    lockedPersonByTask: Map<string, string>,
    lockedDeviceByTask: Map<string, string>,
    lockedStationByTask: Map<string, string>,
    lockedTimeByTask: Map<string, [number, number]>,
  ): SolverRequest['frozenAssignments'] {
    const lockedByTask = new Map(
      (snapshot.lockedAssignments ?? []).map((l) => [l.taskId, l]),
    );
    const frozen: SolverRequest['frozenAssignments'] = [];
    const seen = new Set<string>();
    for (const t of snapshot.tasks) {
      const locked = lockedByTask.get(t.id);
      const isExecuting = t.status === 'executing' || t.status === 'started';
      const hasLockedPerson =
        lockedPersonByTask.has(t.id) ||
        lockedDeviceByTask.has(t.id) ||
        lockedStationByTask.has(t.id) ||
        lockedTimeByTask.has(t.id);
      if (!locked && !isExecuting && !hasLockedPerson) continue;
      const planStart = t.planStart ? Date.parse(t.planStart) : NaN;
      const planEnd = t.planEnd ? Date.parse(t.planEnd) : NaN;
      const lockedTime = lockedTimeByTask.get(t.id);
      const s = lockedTime
        ? lockedTime[0]
        : Number.isFinite(planStart)
          ? planStart
          : Date.now();
      const e = lockedTime
        ? lockedTime[1]
        : Number.isFinite(planEnd)
          ? Math.max(planEnd, s)
          : s + 1;
      const key = `${t.id}:${lockedPersonByTask.get(t.id) ?? locked?.personId ?? t.assigneeId ?? ''}:${lockedDeviceByTask.get(t.id) ?? locked?.deviceId ?? t.deviceId ?? ''}:${lockedStationByTask.get(t.id) ?? locked?.stationId ?? t.stationId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      frozen.push({
        taskId: t.id,
        personId: lockedPersonByTask.get(t.id) ?? locked?.personId ?? t.assigneeId ?? null,
        deviceId: lockedDeviceByTask.get(t.id) ?? locked?.deviceId ?? t.deviceId ?? null,
        stationId: lockedStationByTask.get(t.id) ?? locked?.stationId ?? t.stationId ?? null,
        startMs: s,
        endMs: e,
      });
    }
    return frozen;
  }

  private async post(request: SolverRequest): Promise<SolverResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.workerUrl}/api/scheduler/v2/solve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`CP-SAT worker responded ${res.status}`);
      }
      if (!res.body) {
        throw new Error('CP-SAT worker returned empty body');
      }
      return (await res.json()) as SolverResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- 内部：把 SolverResponse 叠入方案 ----

  private async buildCpsatPlan(
    response: SolverResponse,
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
    policy: SchedulingPolicy,
    priorityResults: Map<string, PriorityResult>,
    geometryIndex?: Map<string, Map<string, Array<{ x: number; y: number }>>>,
  ): Promise<SchedulingPlanV2> {
    // 复用启发式产生方案外壳（metrics / scoreBreakdown / baselineDelta 等），再叠入 CP-SAT 结果。
    const shell = await this.heuristicSolver.solve(snapshot, constraints, opts);
    const assignments = this.toAssignments(response, opts, policy, priorityResults, geometryIndex);
    return {
      ...shell,
      solverVersion: CPSAT_VERSION,
      solverStatus: response.solverStatus,
      solveDurationMs: response.solveDurationMs,
      objective: response.objective,
      objectiveBreakdown: response.objectiveBreakdown,
      assignments,
      violations: response.hardViolations ?? [],
    };
  }

  private toAssignments(
    response: SolverResponse,
    opts: SolveOptions,
    policy: SchedulingPolicy,
    priorityResults: Map<string, PriorityResult>,
    geometryIndex?: Map<string, Map<string, Array<{ x: number; y: number }>>>,
  ): SchedulingAssignment[] {
    return response.assignments.map((a) => {
      // P4-GEOM：从矩阵恢复真实路线几何（与 Solver 成本同一条 RouteCost）。
      let routeGeometry: Array<{ x: number; y: number }> | undefined;
      if (geometryIndex) {
        const byKey = geometryIndex.get(a.taskId);
        if (byKey) {
          routeGeometry = byKey.get(`${a.personId ?? 'any'}|${a.deviceId ?? 'any'}|${a.stationId ?? 'any'}`);
        }
      }
      const pri = priorityResults.get(a.taskId);
      // P0-SCHED-002：禁止伪造 DecisionTrace。无真实 priority 结果时显式标记
      // UNKNOWN/UNAVAILABLE，不得填 0/[] 冒充真实计算。
      const priority =
        pri != null
          ? {
              level: String(pri.level),
              score: pri.score,
              factors: pri.factors.map((f) => ({
                key: f.name,
                label: f.name,
                value: f.term,
              })),
            }
          : { level: 'UNKNOWN', score: null, factors: [] };
      const rejectedAlternatives = (a.rejectedAlternatives ?? []).map((r) => ({
        personId: (r.personId as string | null) ?? null,
        deviceId: (r.deviceId as string | null) ?? null,
        stationId: (r.stationId as string | null) ?? null,
        reason: Array.isArray(r.reason)
          ? (r.reason as string[])
          : typeof r.reason === 'string'
            ? [r.reason as string]
            : [],
      }));
      // 候选：CP-SAT worker 返回的被拒候选 + 被选中项。无 rejectedAlternatives
      // 数据时不填 0/[] 冒充，保留空数组并让 selectedReason 说明实际依据。
      const candidates = [
        ...(a.rejectedAlternatives ?? []).map((r) => ({
          personId: (r.personId as string | null) ?? null,
          deviceId: (r.deviceId as string | null) ?? null,
          stationId: (r.stationId as string | null) ?? null,
          score: null,
          reasons: Array.isArray(r.reason)
            ? (r.reason as string[])
            : typeof r.reason === 'string'
              ? [r.reason as string]
              : [],
        })),
      ];
      return {
        assignmentId: `ASG-CPSAT-${opts.planId}-${a.taskId}`,
        taskId: a.taskId,
        personId: a.personId,
        deviceId: a.deviceId,
        stationId: a.stationId,
        zoneId: null,
        plannedStart: a.startMs != null ? new Date(a.startMs).toISOString() : null,
        plannedEnd: a.endMs != null ? new Date(a.endMs).toISOString() : null,
        routeId: null,
        // P4-GEOM：CP-SAT 路线几何由 Nest Plan Assembler 从 RouteCost 矩阵恢复
        //（Worker 不负责 geometry；地图与 Solver 共享同一 RouteCost identity）。
        routeGeometry,
        status: 'proposed' as const,
        reasons: a.reasons ?? [],
        alternatives: a.rejectedAlternatives ?? [],
        decisionTrace: {
          taskId: a.taskId,
          selected: {
            personId: a.personId,
            deviceId: a.deviceId,
            stationId: a.stationId,
          },
          priority,
          candidates,
          selectedReason: a.reasons ?? [],
          rejectedAlternatives,
          policyVersion: policy.version,
          solverVersion: CPSAT_VERSION,
          snapshotVersion: opts.snapshotVersion,
        },
      };
    });
  }
}