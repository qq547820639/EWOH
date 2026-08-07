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
import type { SchedulingSolver, SolveOptions } from './scheduling-solver.interface';

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

    let response: SolverResponse | null = null;
    let reachable = false;
    try {
      const request = this.buildRequest(snapshot, constraints, opts, policy);
      response = await this.post(request);
      reachable = true;
    } catch (err) {
      this.logger.warn(
        `CP-SAT worker 不可达（${this.workerUrl}）：${(err as Error)?.message ?? err}`,
      );
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
      return this.buildCpsatPlan(response, snapshot, constraints, opts, policy);
    }

    // 否则回退到启发式：Worker 可达但结果不可用 → FALLBACK；不可达 → UNAVAILABLE。
    const fallbackStatus: SolverStatus = reachable ? 'FALLBACK' : 'UNAVAILABLE';
    this.logger.warn(`回退到启发式求解器（solverStatus=${fallbackStatus}）`);
    const plan = await this.heuristicSolver.solve(snapshot, constraints, opts);
    plan.solverStatus = fallbackStatus;
    return plan;
  }

  // ---- 内部：构建 SolverRequest ----

  private buildRequest(
    snapshot: WorldStateSnapshot,
    _constraints: SchedulingConstraint[],
    opts: SolveOptions,
    policy: SchedulingPolicy,
  ): SolverRequest {
    const nowMs = Date.now();
    const horizonMinutes = opts.horizonMinutes;

    const tasks = snapshot.tasks.map((t) => {
      const planStart = t.planStart ? Date.parse(t.planStart) : NaN;
      const planEnd = t.planEnd ? Date.parse(t.planEnd) : NaN;
      const earliestStartMs = Number.isFinite(planStart) ? planStart : nowMs;
      const dueMs = Number.isFinite(planEnd) ? planEnd : null;
      const durationMs =
        Number.isFinite(planStart) && Number.isFinite(planEnd)
          ? Math.max(planEnd - planStart, 1)
          : DEFAULT_DURATION_MS;
      return {
        taskId: t.id,
        priority: this.priorityRank(t.priority),
        earliestStartMs,
        dueMs,
        durationMs,
        requiredSkills: t.requiredSkills ?? [],
        requiredCertifications: t.requiredCertifications ?? [],
        requiredDeviceCapabilities: t.requiredDeviceCapabilities ?? [],
        candidateStationIds: t.candidateStations ?? (t.stationId ? [t.stationId] : []),
        zoneId: t.zoneId ?? null,
        predecessorIds: t.predecessorIds ?? [],
        safetyCritical: false,
        preemptible: false,
      };
    });

    const persons = snapshot.persons.map((p) => ({
      id: p.id,
      status: p.status,
      locationStationId: p.stationId ?? null,
      x: p.x,
      y: p.y,
      skills: p.skills ?? [],
      certifications: p.certifications ?? [],
      workload: p.loadLevel ?? 0,
      fatigue: p.fatigueLevel ?? 0,
      availableFromMs: null,
    }));

    const devices = snapshot.devices.map((d) => ({
      id: d.id,
      status: d.status ?? 'online',
      online: d.online,
      capabilities: d.capabilities ?? [],
      batteryPct: d.batteryPct ?? 100,
      x: 0,
      y: 0,
      availableFromMs: null,
    }));

    const stations = snapshot.stations.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      capacity: 1,
    }));

    const reservations = (snapshot.reservations ?? []).map((r) => ({
      resourceId: r.resourceId,
      resourceType: r.resourceType,
      startMs: r.startMs,
      endMs: r.endMs,
    }));

    const forbiddenZones = (snapshot.forbiddenZones ?? []).map((f) => f.zoneId);

    const frozenAssignments = this.buildFrozenAssignments(snapshot);

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
      weights: {
        lateness: policy.latenessWeight,
        travel: policy.walkingWeight,
        workloadBalance: policy.workloadBalanceWeight,
        stationWait: policy.stationWaitWeight,
        changeCost: policy.changeCostWeight,
        risk: policy.riskWeight,
        energyRisk: policy.energyWeight,
        churn: policy.changeCostWeight,
      },
      tasks,
      persons,
      devices,
      stations,
      reservations,
      forbiddenZones,
      frozenAssignments,
      baselineAssignee,
      timeLimitMs: this.timeoutMs,
    };
  }

  /** 收集 executing/locked 的 assignment 作为不可移动的冻结项。 */
  private buildFrozenAssignments(snapshot: WorldStateSnapshot): SolverRequest['frozenAssignments'] {
    const lockedByTask = new Map(
      (snapshot.lockedAssignments ?? []).map((l) => [l.taskId, l]),
    );
    const frozen: SolverRequest['frozenAssignments'] = [];
    for (const t of snapshot.tasks) {
      const locked = lockedByTask.get(t.id);
      const isExecuting = t.status === 'executing' || t.status === 'started';
      if (!locked && !isExecuting) continue;
      const startMs = t.planStart ? Date.parse(t.planStart) : NaN;
      const endMs = t.planEnd ? Date.parse(t.planEnd) : NaN;
      const s = Number.isFinite(startMs) ? startMs : Date.now();
      const e = Number.isFinite(endMs) ? Math.max(endMs, s) : s + 1;
      frozen.push({
        taskId: t.id,
        personId: locked?.personId ?? t.assigneeId ?? null,
        deviceId: locked?.deviceId ?? t.deviceId ?? null,
        stationId: locked?.stationId ?? t.stationId ?? null,
        startMs: s,
        endMs: e,
      });
    }
    return frozen;
  }

  private priorityRank(priority: string): number {
    switch ((priority ?? '').toLowerCase()) {
      case 'critical':
        return 4;
      case 'high':
      case 'urgent':
        return 3;
      case 'medium':
        return 2;
      case 'low':
        return 1;
      default:
        return 2;
    }
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
  ): Promise<SchedulingPlanV2> {
    // 复用启发式产生方案外壳（metrics / scoreBreakdown / baselineDelta 等），再叠入 CP-SAT 结果。
    const shell = await this.heuristicSolver.solve(snapshot, constraints, opts);
    const assignments = this.toAssignments(response, opts, policy);
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
  ): SchedulingAssignment[] {
    return response.assignments.map((a) => ({
      assignmentId: `ASG-CPSAT-${opts.planId}-${a.taskId}`,
      taskId: a.taskId,
      personId: a.personId,
      deviceId: a.deviceId,
      stationId: a.stationId,
      zoneId: null,
      plannedStart: a.startMs != null ? new Date(a.startMs).toISOString() : null,
      plannedEnd: a.endMs != null ? new Date(a.endMs).toISOString() : null,
      routeId: null,
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
        priority: { level: 'computed', score: 0, factors: [] },
        candidates: [],
        selectedReason: a.reasons ?? [],
        rejectedAlternatives: (a.rejectedAlternatives ?? []).map((r) => ({
          personId: (r.personId as string | null) ?? null,
          deviceId: (r.deviceId as string | null) ?? null,
          reason: Array.isArray(r.reason)
            ? (r.reason as string[])
            : typeof r.reason === 'string'
              ? [r.reason as string]
              : [],
        })),
        policyVersion: policy.version,
        solverVersion: CPSAT_VERSION,
        snapshotVersion: opts.snapshotVersion,
      },
    }));
  }
}