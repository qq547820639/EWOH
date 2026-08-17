import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import type { OrgContext } from '../shared/org-context.interceptor';
import { qualityFindingsBlockDispatch } from '@shared/quality';
import type {
  CandidateEvaluation,
  CandidateRejectReason,
  CandidateRouteCost,
  ScoreBreakdown,
  TaskCandidatesResponse,
  TaskCandidateResource,
  WorldStateSnapshot,
} from '@shared/api.interface';
import { WorldStateSnapshotService } from './world-state.service';
import { ResourceProjectionService } from './resource-projection.service';
import { EligibilityService } from './eligibility.service';
import type { CapabilityRecord } from '@shared/capability';
import { RouteCostProvider } from './route-cost.provider';
import type { RouteCost } from './travel-cost.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { TaskLifecycle } from './task-lifecycle';

/** 候选池构建选项。 */
export interface CandidatePoolOptions {
  nowMs?: number;
  /** 已锁定人员（taskId → personId，来自 LOCKED_PERSON 约束）。 */
  lockedPersonByTask?: Map<string, string>;
  /** 已锁定设备（taskId → deviceId）。 */
  lockedDeviceByTask?: Map<string, string>;
  /** 人工排除（taskId → Set<resourceId>；空 taskId 视为全局）。 */
  excludedPersonByTask?: Map<string, Set<string>>;
  excludedDeviceByTask?: Map<string, Set<string>>;
  excludedStationByTask?: Map<string, Set<string>>;
  excludedPersonGlobal?: Set<string>;
  excludedDeviceGlobal?: Set<string>;
  excludedStationGlobal?: Set<string>;
  /** 人工偏好（命中则软加分）。 */
  preferredPersonByTask?: Map<string, Set<string>>;
  preferredDeviceByTask?: Map<string, Set<string>>;
  preferredStationByTask?: Map<string, Set<string>>;
  preferredPersonGlobal?: Set<string>;
  preferredDeviceGlobal?: Set<string>;
  preferredStationGlobal?: Set<string>;
  /** 本窗口内已占用的时间段（求解过程中累积）。 */
  bookedTimeSlots?: Array<{ personId: string; start: number; end: number }>;
  bookedDeviceSlots?: Array<{ deviceId: string; start: number; end: number }>;
  bookedStationSlots?: Array<{ stationId: string; start: number; end: number }>;
  bookedStationCounts?: Map<string, number>;
  /** 基线分配（taskId → personId），用于 churn/change 成本。 */
  baselineAssignee?: Map<string, string | null>;
  /** 最小电量/最大负荷覆盖（约束可覆盖 config）。 */
  minBatteryPct?: number;
  maxContinuousLoad?: number;
  /** station 决策开关（P1-4 风险回滚开关；false 回退 task.stationId）。 */
  stationDecisionEnabled?: boolean;
}

/**
 * 候选引擎（Phase 1 / P1-2，05 §3.7）：独立 Candidate Engine。
 *
 * - `evaluateTaskCandidates(taskId)`：端点 GET /tasks/:taskId/candidates（响应富化：
 *   rejectReasons / scoreBreakdown / stationOptions / timeWindows，旧字段保留）。
 * - `buildCandidatePool(task, snapshot, opts)`：求解器共享候选池——Task×Person×Device×
 *   Station×时间窗 → CandidateEvaluation[]。端点与求解器共享同一候选语义（消除双份逻辑）。
 *
 * hard 不满足的候选不进 solver feasible set 但可解释（rejectReasons 结构化）。
 */
@Injectable()
export class CandidateEngineService {
  private readonly logger = new Logger(CandidateEngineService.name);

  /**
   * NEST-048（2026-08-17）：负载等级罚系数——loadLevel 每级计 60s 等效成本
   * （与 heuristic-scheduling-solver 同源；原为散落魔数 60*1000）。
   */
  private static readonly LOAD_PENALTY_MS_PER_LEVEL = 60 * 1000;

  constructor(
    private readonly worldStateSnapshotService: WorldStateSnapshotService,
    private readonly resourceProjectionService: ResourceProjectionService,
    private readonly eligibilityService: EligibilityService,
    private readonly routeCostProvider: RouteCostProvider,
    private readonly policyService: SchedulingPolicyService,
  ) {}

  /** 端点：GET /tasks/:taskId/candidates（响应富化，旧字段保留）。NEST-101/111：ctx 透传。 */
  async evaluateTaskCandidates(
    taskId: string,
    actor?: OrgContext,
  ): Promise<TaskCandidatesResponse> {
    const state = await this.worldStateSnapshotService.getCurrentWorldState(actor);
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);

    const policy = await this.policyService.getActivePolicy(actor?.primaryOrgId || null);
    const config = await this.policyService.getConfig(actor?.primaryOrgId || null);
    const now = Date.now();

    const lockedByTask = (state.lockedAssignments ?? []).find(
      (la) => la.taskId === taskId,
    );
    const assigned = Boolean(task.assigneeId || lockedByTask?.personId);
    const lockedAssigneeId = task.assigneeId ?? lockedByTask?.personId ?? null;
    const lockedDeviceId = task.deviceId ?? lockedByTask?.deviceId ?? null;

    const doneTaskIds = new Set<string>(
      state.tasks
        .filter((t) => TaskLifecycle.isTerminal(t.status))
        .map((t) => t.id),
    );
    const bookedTimeSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'person')
      .map((r) => ({ personId: r.resourceId, start: r.startMs, end: r.endMs }));
    const bookedDeviceSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'device')
      .map((r) => ({ deviceId: r.resourceId, start: r.startMs, end: r.endMs }));
    const bookedStationSlots = (state.reservations ?? [])
      .filter((r) => r.resourceType === 'station')
      .map((r) => ({ stationId: r.resourceId, start: r.startMs, end: r.endMs }));

    const fullState: WorldStateSnapshot = {
      ...state,
      snapshotVersion: 'CURRENT',
      ts: new Date().toISOString(),
    };
    const pool = await this.buildCandidatePool(task, fullState, {
      nowMs: now,
      bookedTimeSlots,
      bookedDeviceSlots,
      bookedStationSlots,
      minBatteryPct: config.minBatteryPct,
      maxContinuousLoad: config.maxContinuousLoad,
      stationDecisionEnabled: config.stationCapacityEnforced !== false,
    });

    const stationOptions = this.buildStationOptions(task, fullState, pool);
    const timeWindows = this.buildTimeWindows(task, fullState, config.horizonMinutes);

    const candidates: TaskCandidateResource[] = pool.map((c) => ({
      personId: c.personId,
      personName: state.persons.find((p) => p.id === c.personId)?.name ?? c.personId,
      deviceId: c.deviceId,
      stationId: c.stationId,
      eligible: c.eligible,
      etaSeconds: c.routeCost?.etaSeconds ?? 0,
      distanceMeters: c.routeCost?.distanceMeters ?? 0,
      skillMatch: !c.rejectReasons.includes('missing_skill'),
      workload: state.persons.find((p) => p.id === c.personId)?.loadLevel ?? 0,
      batteryPct: c.deviceId
        ? state.devices.find((d) => d.id === c.deviceId)?.batteryPct ?? null
        : null,
      reservationConflict: c.rejectReasons.some((r) =>
        ['time_conflict', 'device_reserved', 'station_reserved'].includes(r),
      ),
      score: c.eligible ? c.scoreBreakdown.total : Number.POSITIVE_INFINITY,
      reasons: c.eligible
        ? []
        : [...new Set(c.rejectReasons)],
      rejectReasons: c.rejectReasons,
      scoreBreakdown: c.scoreBreakdown,
      stationOptions: stationOptions.filter((s) => s.stationId === c.stationId),
      timeWindows,
    }));

    candidates.sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.score !== b.score) return a.score - b.score;
      if (a.personId !== b.personId) return a.personId < b.personId ? -1 : 1;
      const da = a.deviceId ?? '';
      const db = b.deviceId ?? '';
      return da < db ? -1 : da > db ? 1 : 0;
    });

    return {
      taskId: task.id,
      taskTitle: task.title ?? null,
      taskStatus: task.status ?? null,
      assigned,
      lockedAssigneeId,
      lockedDeviceId,
      solverVersion: policy.solverVersion,
      candidates,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 求解器共享候选池：Task×Person×Device×Station×时间窗 → CandidateEvaluation[]。
   * hard 不满足的候选 eligible=false + rejectReasons（不进 feasible set 但可解释）。
   */
  async buildCandidatePool(
    task: WorldStateSnapshot['tasks'][number],
    snapshot: WorldStateSnapshot,
    opts: CandidatePoolOptions = {},
  ): Promise<CandidateEvaluation[]> {
    const policy = await this.policyService.getActivePolicy();
    const config = await this.policyService.getConfig();
    const nowMs = opts.nowMs ?? Date.now();
    const stationDecisionEnabled = opts.stationDecisionEnabled !== false;

    const stationById = new Map(snapshot.stations.map((s) => [s.id, s]));
    const taskStation = task.stationId ? stationById.get(task.stationId) : undefined;
    const taskPoint = taskStation
      ? { x: taskStation.x, y: taskStation.y }
      : undefined;

    const softDeadlineMs =
      task.dueAtMs != null
        ? task.dueAtMs
        : task.planEnd
          ? Date.parse(task.planEnd)
          : nowMs + (config.horizonMinutes ?? 480) * 60 * 1000;
    const mustFinishByMs = task.latestFinishMs != null ? task.latestFinishMs : null;

    const doneTaskIds = new Set<string>(
      snapshot.tasks
        .filter((t) => TaskLifecycle.isTerminal(t.status))
        .map((t) => t.id),
    );

    // station 决策变量：candidateStations（有限集）→ 回退 task.stationId → 空。
    const stationOptions = this.resolveStationOptions(task, stationById, stationDecisionEnabled);

    const bookedTimeSlots = opts.bookedTimeSlots ?? [];
    const bookedDeviceSlots = opts.bookedDeviceSlots ?? [];
    const bookedStationSlots = opts.bookedStationSlots ?? [];
    const bookedStationCounts = opts.bookedStationCounts ?? new Map<string, number>();

    const lockedPersonByTask = opts.lockedPersonByTask ?? new Map<string, string>();
    const lockedDeviceByTask = opts.lockedDeviceByTask ?? new Map<string, string>();

    const excludedPersonGlobal = opts.excludedPersonGlobal ?? new Set<string>();
    const excludedDeviceGlobal = opts.excludedDeviceGlobal ?? new Set<string>();
    const excludedStationGlobal = opts.excludedStationGlobal ?? new Set<string>();
    const excludedPersonByTask = opts.excludedPersonByTask ?? new Map<string, Set<string>>();
    const excludedDeviceByTask = opts.excludedDeviceByTask ?? new Map<string, Set<string>>();
    const excludedStationByTask = opts.excludedStationByTask ?? new Map<string, Set<string>>();

    const preferredPersonGlobal = opts.preferredPersonGlobal ?? new Set<string>();
    const preferredDeviceGlobal = opts.preferredDeviceGlobal ?? new Set<string>();
    const preferredStationGlobal = opts.preferredStationGlobal ?? new Set<string>();
    const preferredPersonByTask = opts.preferredPersonByTask ?? new Map<string, Set<string>>();
    const preferredDeviceByTask = opts.preferredDeviceByTask ?? new Map<string, Set<string>>();
    const preferredStationByTask = opts.preferredStationByTask ?? new Map<string, Set<string>>();

    const minBattery = opts.minBatteryPct ?? config.minBatteryPct;
    const maxLoad = opts.maxContinuousLoad ?? config.maxContinuousLoad;
    const safetyBlockedPersonIds = snapshot.safetyBlockedPersonIds ?? [];
    const forbiddenZones = (snapshot.forbiddenZones ?? []).map((f) => f.zoneId);

    // station 维度索引（capability + capacity + P1-A availableWindows + NO-05c 维护
    // 封锁 + NO-05d 质量封锁）。
    const stationCapabilitiesById = new Map<string, string[]>();
    // NO-12v / ADR-045：契约形态工位能力（匹配优先）。
    const stationCapabilityRecordsById = new Map<string, CapabilityRecord[]>();
    const stationCapacityById = new Map<string, number | null>();
    const stationAvailableWindowsById = new Map<
      string,
      Array<{ startMs: number; endMs: number }>
    >();
    const stationMaintenanceBlockedById = new Map<string, boolean>();
    const stationQualityBlockedById = new Map<string, boolean>();
    for (const s of snapshot.stations) {
      stationCapabilitiesById.set(s.id, s.capabilities ?? []);
      stationCapabilityRecordsById.set(s.id, s.capabilityRecords ?? []);
      stationCapacityById.set(s.id, s.capacity ?? null);
      stationAvailableWindowsById.set(s.id, s.availableWindows ?? []);
      // NO-05c（ADR-010）：活跃维护事实 → 工位封锁（fail-closed）。
      stationMaintenanceBlockedById.set(s.id, (s.maintenance?.length ?? 0) > 0);
      // NO-05d（ADR-011）：critical/high 活跃质量发现 → 工位封锁（fail-closed）。
      stationQualityBlockedById.set(
        s.id,
        qualityFindingsBlockDispatch(s.qualityFindings ?? null),
      );
    }

    const candidatePersons = snapshot.persons.filter(
      (p) =>
        this.matchesLock(p.id, task.id, lockedPersonByTask) &&
        !this.isExcluded(task.id, p.id, excludedPersonByTask, excludedPersonGlobal),
    );

    const evaluations: CandidateEvaluation[] = [];
    for (const person of candidatePersons) {
      const personStation = person.stationId
        ? stationById.get(person.stationId)
        : undefined;
      const personPoint = personStation
        ? { x: personStation.x, y: personStation.y }
        : person.x != null && person.y != null
          ? { x: person.x, y: person.y }
          : undefined;

      const routeCost = await this.routeCostProvider.estimate(
        person.id,
        task.id,
        personPoint,
        taskPoint,
      );
      const routeInfeasible = routeCost.feasible === false;

      const deviceCandidates = this.devicesForTask(
        task.id,
        snapshot.devices,
        lockedDeviceByTask,
        minBattery,
        task.requiredDeviceCapabilities,
        excludedDeviceByTask,
        excludedDeviceGlobal,
      );

      for (const device of deviceCandidates) {
        for (const stationId of stationOptions) {
          // stationId 可为 null（任务无工位/无候选工位时回退无工位语义）。
          const station = stationId ? stationById.get(stationId) : undefined;
          if (stationId && !station) continue;
          if (stationId && this.isExcluded(task.id, stationId, excludedStationByTask, excludedStationGlobal)) {
            continue;
          }
          const stationPoint = station ? { x: station.x, y: station.y } : undefined;
          // 每个 (person, device, station) 组合用候选工位作为任务落点。
          const candRouteCost = await this.routeCostProvider.estimate(
            person.id,
            task.id,
            personPoint,
            stationPoint,
          );
          const stationRouteInfeasible = candRouteCost.feasible === false;

          const travelMs = (candRouteCost.etaSeconds ?? 0) * 1000;
          const startMs = nowMs + travelMs;
          const durationMs = task.planEnd && task.planStart
            ? Date.parse(task.planEnd) - Date.parse(task.planStart)
            : config.defaultTaskDurationMs;
          const endMs = startMs + Math.max(durationMs, 1);

          const rejectReasons = this.collectRejectReasons({
            person,
            task,
            device,
            ctx: {
              now: nowMs,
              bookedTimeSlots,
              bookedDeviceSlots,
              bookedStationSlots,
              lockedPersonIds: this.lockedPersonIdsForTask(snapshot, task.id),
              forbiddenZones,
              minBatteryPct: minBattery,
              maxContinuousLoad: maxLoad,
              safetyBlockedPersonIds,
              predecessorDone: (id) => doneTaskIds.has(id),
              candidateStartMs: startMs,
              candidateEndMs: endMs,
              candidateStationId: stationId,
              stationCapacityById,
              stationCapabilitiesById,
              stationCapabilityRecordsById,
              bookedStationCounts,
              // P1-A：候选工位可用窗口（正空间交集；无数据不限制）。
              stationAvailableWindowsById,
              // NO-05c（ADR-010）：候选工位维护封锁（fail-closed 拒派）。
              stationMaintenanceBlockedById,
              // NO-05d（ADR-011）：候选工位质量封锁（critical/high 拒派）。
              stationQualityBlockedById,
            },
            routeInfeasible: stationRouteInfeasible,
            mustFinishByMs,
            endMs,
          });

          const eligible = rejectReasons.length === 0;
          const lateMs = Math.max(0, endMs - softDeadlineMs);
          const waitMs = Math.max(0, startMs - nowMs);
          const baselineAssignee = opts.baselineAssignee?.get(task.id);
          // M04：Churn Objective V2——候选评分消费 churn 配置（person/device/station 变更罚）。
          const personChanged =
            baselineAssignee && baselineAssignee !== person.id ? 1 : 0;
          const deviceChanged =
            task.deviceId != null && task.deviceId !== device?.id ? 1 : 0;
          const changeover =
            task.stationId != null && task.stationId !== stationId;
          const stationChanged = changeover ? 1 : 0;
          const churnCostScore =
            config.churn != null
              ? personChanged * (config.churn.personChangePenalty ?? policy.weights.change) +
                deviceChanged * (config.churn.deviceChangePenalty ?? 0) +
                stationChanged * (config.churn.stationChangePenalty ?? 0)
              : undefined;
          const changeCost = personChanged;
          // NEST-048（2026-08-17）：负载罚常量（loadLevel 每级 60s，与 heuristic
          // 同源；提取命名常量替代裸 60*1000 魔数）。
          const loadPenalty = person.loadLevel * CandidateEngineService.LOAD_PENALTY_MS_PER_LEVEL;
          // NEST-006 修复（2026-08-17）：换型成本（station 变更 → setupMinutes
          // 换型时间入 changeCost 维度，与 heuristic computeCandidateScore 对齐）。
          const setupMinutes = config.setupMinutes ?? 15;
          const changeoverMs = changeover ? setupMinutes * 60 * 1000 : 0;
          // NEST-005 修复（2026-08-17）：riskFactor 对齐 heuristic——medium 风险
          // 也乘 config.mediumRiskFactor（此前仅判 high，medium 罚丢失）。
          const riskMs =
            this.riskFactor(candRouteCost.riskLevel, config) * travelMs;
          const batteryPct = device ? device.batteryPct : 100;
          const energyPenalty =
            device != null ? (1 - batteryPct / 100) * 60 * 1000 : 0;

          const scoreBreakdown = this.computeScore(
            policy,
            lateMs,
            travelMs,
            loadPenalty,
            waitMs,
            changeCost * 60 * 1000 + changeoverMs,
            riskMs,
            energyPenalty,
            stationId,
            // NEST-007 修复（2026-08-17）：station 队列等待成本入评分
            // （w.station × queueLength × waitMs，与 heuristic 同源）。
            station?.queue?.length ?? 0,
            churnCostScore,
          );

          const preferred =
            this.isExcluded(task.id, person.id, preferredPersonByTask, preferredPersonGlobal) ||
            (device != null &&
              this.isExcluded(task.id, device.id, preferredDeviceByTask, preferredDeviceGlobal)) ||
            this.isExcluded(task.id, stationId, preferredStationByTask, preferredStationGlobal);
          if (preferred && eligible) {
            const bonus = config.preferenceBonusMinutes ?? 30;
            scoreBreakdown.total = Math.max(0, scoreBreakdown.total - bonus);
          }

          evaluations.push({
            personId: person.id,
            deviceId: device ? device.id : null,
            stationId,
            startMs,
            endMs,
            eligible,
            rejectReasons,
            scoreBreakdown,
            routeCost: this.toCandidateRouteCost(candRouteCost, person.id, device ? device.id : null, stationId),
            preferred,
            changeover,
            softCosts: {
              latenessMs: lateMs,
              travelMs,
              waitMs,
              changeCost,
              riskMs,
              energyPenalty,
            },
          });
        }
      }
    }

    return evaluations;
  }

  // ===== 内部 =====

  /** 候选工位集合（P1-4：station 决策变量；关闭开关/无工位时回退 null 保持旧语义）。 */
  private resolveStationOptions(
    task: WorldStateSnapshot['tasks'][number],
    stationById: Map<string, WorldStateSnapshot['stations'][number]>,
    stationDecisionEnabled: boolean,
  ): Array<string | null> {
    if (!stationDecisionEnabled) {
      return task.stationId && stationById.has(task.stationId)
        ? [task.stationId]
        : [null];
    }
    const candidates =
      task.candidateStations && task.candidateStations.length > 0
        ? task.candidateStations
        : task.stationId
          ? [task.stationId]
          : [null];
    return candidates.filter((id) => id === null || stationById.has(id));
  }

  /** 端点 stationOptions 明细（含容量/队列/可行性/原因）。 */
  private buildStationOptions(
    task: WorldStateSnapshot['tasks'][number],
    state: WorldStateSnapshot,
    pool: CandidateEvaluation[],
  ): TaskCandidateResource['stationOptions'] {
    const stationById = new Map(state.stations.map((s) => [s.id, s]));
    const ids = new Set(pool.map((c) => c.stationId).filter(Boolean) as string[]);
    if (ids.size === 0 && task.stationId) ids.add(task.stationId);
    const options: NonNullable<TaskCandidateResource['stationOptions']> = [];
    for (const id of ids) {
      const s = stationById.get(id);
      const evaluationsForStation = pool.filter((c) => c.stationId === id);
      const feasible = evaluationsForStation.some((c) => c.eligible);
      const reasons = Array.from(
        new Set(evaluationsForStation.flatMap((c) => c.rejectReasons)),
      );
      options.push({
        stationId: id,
        capacity: s?.capacity ?? null,
        queueLength: s?.queue?.length ?? 0,
        feasible,
        reasons,
      });
    }
    return options;
  }

  /**
   * 任务级时间窗（P1-A 真实交集起点）：Task Window ∩ Horizon。
   * - Task Window：earliestStartMs / dueAtMs（P1-T2 真实列）优先，回退 planStart/planEnd；
   * - Horizon：config.horizonMinutes（缺省 480min）。
   * 交集为空（如任务窗口已过 horizon）→ 返回空数组（不可派，不伪造窗口）。
   * 资源维度的逐候选交集（Person/Device/Station 窗口、维护窗、容量）在
   * EligibilityService.check（4g/4h）中按候选判定；shift 无时间语义（schema 仅 nullable
   * 字符串）不参与硬交集——禁止用字符串猜班次。
   */
  private buildTimeWindows(
    task: WorldStateSnapshot['tasks'][number],
    state: WorldStateSnapshot,
    horizonMinutes?: number,
  ): Array<{ startMs: number; endMs: number }> {
    const now = Date.now();
    const horizonEnd = now + (horizonMinutes ?? 480) * 60 * 1000;
    const taskLo =
      task.earliestStartMs ??
      (task.planStart ? Date.parse(task.planStart) : null) ??
      now;
    const taskHi =
      task.dueAtMs ?? (task.planEnd ? Date.parse(task.planEnd) : null) ?? horizonEnd;
    const lo = Math.max(now, taskLo);
    const hi = Math.min(horizonEnd, taskHi);
    if (hi <= lo) return [];
    return [{ startMs: lo, endMs: hi }];
  }

  /** 汇总结构化拒绝原因（eligibility + 路由 + mustFinishBy 硬截止）。 */
  private collectRejectReasons(input: {
    person: WorldStateSnapshot['persons'][number];
    task: WorldStateSnapshot['tasks'][number];
    device: WorldStateSnapshot['devices'][number] | null;
    ctx: Parameters<EligibilityService['check']>[3];
    routeInfeasible: boolean;
    mustFinishByMs: number | null;
    endMs: number;
  }): CandidateRejectReason[] {
    const { person, task, device, ctx, routeInfeasible, mustFinishByMs, endMs } = input;
    // P1-B：投影层 source 为可选超集字段（WorldStateSnapshot 形状未含）；此处类型断言透传。
    const personSource = (
      person as WorldStateSnapshot['persons'][number] & {
        source?: 'AUTHORITATIVE' | 'DERIVED';
        availableWindows?: Array<{ startMs: number; endMs: number }>;
        maintenance?: import('@shared/maintenance').MaintenanceConditionProjection[] | null;
      }
    );
    const deviceSource = device
      ? (device as WorldStateSnapshot['devices'][number] & {
          source?: 'AUTHORITATIVE' | 'DERIVED';
          maintenanceWindows?: Array<{ startMs: number; endMs: number }>;
          maintenance?: import('@shared/maintenance').MaintenanceConditionProjection[] | null;
        })
      : null;
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
        certificationExpiry: person.certificationExpiry ?? [],
        // P1-A/P1-B：可用窗口 + 新鲜度 + 来源维度（缺数据不伪造/不误伤）。
        availableWindows: personSource.availableWindows ?? [],
        dataQuality: person.dataQuality,
        source: personSource.source,
        // NO-05c（ADR-010）：活跃维护事实（fail-closed 拒派）。
        maintenance: personSource.maintenance ?? null,
        // NO-05d（ADR-011）：活跃质量发现事实（critical/high 拒派）。
        qualityFindings: person.qualityFindings ?? null,
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
        requiredStationCapabilities: task.requiredStationCapabilities,
        candidateStations: task.candidateStations,
        // P1-A/P1-B：Task Window 边界 + safety-critical fail-close 开关。
        earliestStartMs: task.earliestStartMs ?? null,
        dueAtMs: task.dueAtMs ?? null,
        safetyCritical: task.safetyCritical,
      },
      device
        ? {
            id: device.id,
            batteryPct: device.batteryPct,
            online: device.online,
            status: device.status,
            capabilities: device.capabilities ?? [],
            // P1-A/P1-B：可用/维护窗口 + 新鲜度 + 来源维度。
            availableWindows: device.availableWindows ?? [],
            maintenanceWindows: deviceSource?.maintenanceWindows ?? [],
            dataQuality: device.dataQuality,
            source: deviceSource?.source,
            // NO-05c（ADR-010）：活跃维护事实（fail-closed 拒派）。
            maintenance: deviceSource?.maintenance ?? null,
            // NO-05d（ADR-011）：活跃质量发现事实（critical/high 拒派）。
            qualityFindings: device?.qualityFindings ?? null,
          }
        : null,
      ctx,
    );
    const reasons = [...eligibility.reasons] as CandidateRejectReason[];
    if (routeInfeasible) reasons.push('route_infeasible');
    if (mustFinishByMs != null && endMs > mustFinishByMs) {
      reasons.push('must_finish_by_violation');
    }
    return Array.from(new Set(reasons));
  }

  /**
   * 评分（与 heuristic solver computeCandidateScore 同源：policy.weights 权威 8 权重）。
   * NEST-005/006/007（2026-08-17）：补齐 medium risk 罚、changeoverMs、
   * station 队列等待成本三项（stationWait = 基础等待 + w.station×queue×waitMs），
   * 消除与 heuristic 的评分语义漂移。
   */
  private computeScore(
    policy: import('@shared/api.interface').SchedulingPolicy,
    lateMs: number,
    travelMs: number,
    loadPenalty: number,
    waitMs: number,
    changeCostMs: number,
    riskMs: number,
    energyPenalty: number,
    stationId?: string | null,
    stationQueueLength = 0,
    churnCostScore?: number,
  ): ScoreBreakdown {
    void stationId; // 语义锚点：station 维度经 queueLength 入 stationWait（与 heuristic 同源）
    const w = policy.weights;
    const lateness = (w.lateness * lateMs) / 60000;
    const travel = (w.travel * travelMs) / 60000;
    const workloadBalance = (w.workload * loadPenalty) / 60000;
    // NEST-007：stationWait = 基础等待 + 真实队列长度 × weights.station（工位排队成本）。
    const stationWait =
      (w.wait * waitMs) / 60000 + (w.station * stationQueueLength * waitMs) / 60000;
    // M04：Churn Objective V2——传入 churnCostScore 时以 churn 罚直接计入（缺省=现状）。
    const changeCost =
      churnCostScore != null ? churnCostScore : (w.change * changeCostMs) / 60000;
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

  /** NEST-005：riskLevel → 策略风险系数（high/medium 分级，与 heuristic riskFactor 同源）。 */
  private riskFactor(
    riskLevel: string | null,
    config: import('@shared/api.interface').SchedulingPolicyConfig,
  ): number {
    if (riskLevel === 'high') return config.highRiskFactor;
    if (riskLevel === 'medium') return config.mediumRiskFactor;
    return 1;
  }

  private devicesForTask(
    taskId: string,
    devices: WorldStateSnapshot['devices'],
    locked: Map<string, string>,
    _minBatteryPct: number,
    requiredCapabilities?: string[],
    excludedPerTask?: Map<string, Set<string>>,
    excludedGlobal?: Set<string>,
  ): Array<WorldStateSnapshot['devices'][number] | null> {
    const lockedDevice = locked.get(taskId);
    if (lockedDevice) {
      const d = devices.find((x) => x.id === lockedDevice);
      return d ? [d] : [];
    }
    // 端点/候选池：不过滤 online/battery/capability——由 eligibility 产生结构化
    // rejectReason（device_offline/battery_low/missing_device_capability 可解释）。
    // 仅按 EXCLUDED_RESOURCE 排除；任务要求设备能力时不回退纯手工（null）。
    const caps = requiredCapabilities ?? [];
    const nonExcluded = devices.filter(
      (d) => !this.isExcluded(taskId, d.id, excludedPerTask ?? new Map(), excludedGlobal ?? new Set()),
    );
    return caps.length > 0 ? nonExcluded : [...nonExcluded, null];
  }

  private matchesLock(
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

  /** RouteCost → CandidateRouteCost（补齐候选维元数据；矩阵层显式标记）。 */
  private toCandidateRouteCost(
    c: RouteCost,
    personId: string,
    deviceId: string | null,
    stationId: string | null,
  ): CandidateRouteCost {
    return {
      personId,
      deviceId,
      stationId,
      etaSeconds: c.etaSeconds,
      distanceMeters: c.distanceMeters,
      congestion: c.congestionCost > 0 ? c.congestionCost : 1,
      blocked: false,
      forbiddenZone: false,
      risk: c.riskCost,
      energy: 0,
      routeCostMode: c.source,
      fallbackReason: c.fallbackReason,
      dataQuality: c.dataQuality,
      feasible: c.feasible,
      geometry: c.geometry ?? [],
      routeCostId: `RC-${personId}-${deviceId ?? 'any'}-${stationId ?? 'any'}`,
    };
  }

  private isExcluded(
    taskId: string,
    resourceId: string,
    perTask: Map<string, Set<string>>,
    globalSet: Set<string>,
  ): boolean {
    return globalSet.has(resourceId) || perTask.get(taskId)?.has(resourceId) === true;
  }
}
