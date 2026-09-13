import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import type { OrgContext } from '../shared/org-context.interceptor';
import { qualityFindingsBlockDispatch } from '@shared/quality';
import { normalizeBatteryPct } from '@shared/api.interface';
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
import { normalizePersonRef } from '@shared/identity';
import type { CapabilityRecord } from '@shared/capability';
import { RouteCostProvider } from './route-cost.provider';
import type { RouteCost } from './travel-cost.service';
import { SchedulingPolicyService } from './scheduling-policy.service';
import { TaskLifecycle } from './task-lifecycle';
import { deviceCapabilityNames } from './capability-projection';
import { capabilityRiskLevel } from '@shared/device-capability';

/** 候选池构建选项。 */
export interface CandidatePoolOptions {
  nowMs?: number;
  /**
   * ADR-056 消费侧（2026-09-13）：taskId → 模型时长（ms）。
   * heuristic 求解器在 durationModelMode='advisory' 时把预解析的映射传进来，
   * 使**候选阶段的时间窗**与指派阶段同源（否则会出现"候选用默认窗判定可行、
   * 指派用模型窗"的口径分裂）。缺省 null = 用 config.defaultTaskDurationMs（历史行为）。
   */
  durationMsByTask?: ReadonlyMap<string, number> | null;
  /**
   * NO-35a：任务**已锁定的人员**（task.assigneeId 或方案级锁定）。
   *
   * 用途：佩戴中的外骨骼只对该佩戴者的任务可用——人机同体是物理上可行的，
   * 而"把别人的外骨骼派给他"不是。未锁定时资格判定一律拒绝（不猜配对）。
   */
  lockedAssigneeId?: string | null;
  /**
   * R2-SCH-002（2026-08-17）：显式策略覆盖（solveVariants 变体权重缩放透传）。
   * 缺省回退 getActivePolicy()——端点等无变体上下文的调用保持旧语义。
   */
  policy?: import('@shared/api.interface').SchedulingPolicy;
  /**
   * R2-SCH-001（2026-08-17）：任务级最早开始下界（含 planStart / 前置结束时间，
   * 与 heuristic 内联分支 earliestStartMs 同源）。缺省 nowMs。
   */
  earliestStartMs?: number;
  /**
   * R2-SCH-001（2026-08-17）：人员占用顺延（personId → 本次运行内最后占用结束时刻，
   * 与 heuristic bookedPerson 同源）。候选 startMs 顺延到该时刻之后。
   */
  bookedPersonFreeAt?: Map<string, number>;
  /** R2-SCH-001：设备占用顺延（deviceId → 最后占用结束时刻，与 heuristic bookedDevice 同源）。 */
  bookedDeviceFreeAt?: Map<string, number>;
  /** R2-SCH-003（2026-08-17）：LOCKED_TIME 锁定窗（taskId → [startMs, endMs]）。 */
  lockedTimeByTask?: Map<string, [number, number]>;
  /** R2-SCH-003（2026-08-17）：LOCKED_STATION（taskId → stationId）。 */
  lockedStationByTask?: Map<string, string>;
  /** R2-SCH-003（2026-08-17）：FORBIDDEN_ZONE 约束补充禁入区（与快照禁入区取并集）。 */
  forbiddenZoneIds?: string[];
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
  /**
   * R-6（2026-09-13 性能回归修复）：调用方租户 org id，透传给
   * routeCostProvider.estimate 的第 5 参 opts.orgId。
   *
   * 为什么必须显式传：estimate 不传 orgId 时 RoutingService.loadGraph 拿不到
   * 可安全隔离的租户键，只能"读穿不缓存"——候选池 O(persons×stations) 次
   * estimate 每次都全图 SELECT route_node/route_edge（典型数百次/请求）。
   * 传了 orgId 后路由图按 `tenant:<orgId>` 分桶 TTL 复用，桶内容与该租户
   * 一一对应，不会与其它租户混用。
   *
   * 缺省 null ≠ "随便挑一个 org"：它表示调用方**确实没有**具体租户（深层内部流），
   * 此时保持读穿不缓存（诚实缺失，绝不伪造 org 去换取命中率）。
   */
  orgId?: string | null;
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
      policy,
      bookedTimeSlots,
      bookedDeviceSlots,
      bookedStationSlots,
      minBatteryPct: config.minBatteryPct,
      maxContinuousLoad: config.maxContinuousLoad,
      stationDecisionEnabled: config.stationCapacityEnforced !== false,
      // NO-35a：任务锁定人员透传（佩戴中的外骨骼只对该佩戴者可用）
      lockedAssigneeId,
      // R-6（2026-09-13）：端点把 actor 的租户透传进候选池 → 路由图按租户缓存。
      // actor 缺失（系统后台流/函数式调用）时为 null → 读穿不缓存，不伪造 org。
      orgId: actor?.primaryOrgId ?? null,
    });

    const stationOptions = this.buildStationOptions(task, fullState, pool);
    const timeWindows = this.buildTimeWindows(task, fullState, config.horizonMinutes);

    // NO-17a：无合格候选且原因是能力要求时，给出**反事实放宽分析**——
    // "放宽某一项要求会多出几个候选、那些设备还具备什么能力"。
    // 只建议、不自动放宽（原则 4/6）：改要求仍是人工动作，且需重新生成方案。
    const capabilityRelaxationSuggestions = await this.buildCapabilityRelaxationSuggestions({
      task,
      snapshot: fullState,
      pool,
      poolOpts: {
        nowMs: now,
        policy,
        bookedTimeSlots,
        bookedDeviceSlots,
        bookedStationSlots,
        minBatteryPct: config.minBatteryPct,
        maxContinuousLoad: config.maxContinuousLoad,
        stationDecisionEnabled: config.stationCapacityEnforced !== false,
        // NO-35a：反事实放宽分析必须用同一约束（否则会"建议放宽"到佩戴中的设备上）
        lockedAssigneeId,
        // R-6（2026-09-13）：反事实评估同样透传租户（与主池同口径的缓存/隔离）。
        orgId: actor?.primaryOrgId ?? null,
      },
    });

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
        ? normalizeBatteryPct(state.devices.find((d) => d.id === c.deviceId)?.batteryPct)
        : null,
      reservationConflict: c.rejectReasons.some((r) =>
        ['time_conflict', 'device_reserved', 'station_reserved'].includes(r),
      ),
      score: c.eligible ? c.scoreBreakdown.total : Number.POSITIVE_INFINITY,
      reasons: c.eligible
        ? []
        : [...new Set(c.rejectReasons)],
      rejectReasons: c.rejectReasons,
      // NO-15b：能力拒绝的可读细节（引擎生成，前端只透传）
      ...(c.capabilityNotes && c.capabilityNotes.length > 0
        ? { capabilityNotes: c.capabilityNotes }
        : {}),
      // NO-38b：会话相关的正向说明（人机同体配对；前端只透传）
      ...(c.sessionNotes && c.sessionNotes.length > 0 ? { sessionNotes: c.sessionNotes } : {}),
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
      requiredDeviceCapabilities: task.requiredDeviceCapabilities ?? [],
      requiredStationCapabilities: task.requiredStationCapabilities ?? [],
      ...(capabilityRelaxationSuggestions.length > 0
        ? { capabilityRelaxationSuggestions }
        : {}),
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
    // R2-SCH-002：显式 policy 优先（solveVariants 变体权重缩放必须作用于候选评分，
    // 不再内部全局取用 getActivePolicy() 导致变体丢失）；缺省保持端点旧语义。
    const policy = opts.policy ?? (await this.policyService.getActivePolicy());
    const config = await this.policyService.getConfig();
    const nowMs = opts.nowMs ?? Date.now();
    const stationDecisionEnabled = opts.stationDecisionEnabled !== false;
    // NO-35a：任务锁定人员（佩戴中设备的合法使用前提）；缺省 null = 未锁定。
    const lockedAssigneeId = opts.lockedAssigneeId ?? null;

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
    // R2-SCH-003：LOCKED_STATION 约束优先——锁定工位外无候选。
    const lockedStation = opts.lockedStationByTask?.get(task.id);
    const stationOptions = lockedStation
      ? stationById.has(lockedStation)
        ? [lockedStation]
        : []
      : this.resolveStationOptions(task, stationById, stationDecisionEnabled);

    const bookedTimeSlots = opts.bookedTimeSlots ?? [];
    const bookedDeviceSlots = opts.bookedDeviceSlots ?? [];
    const bookedStationSlots = opts.bookedStationSlots ?? [];
    const bookedStationCounts = opts.bookedStationCounts ?? new Map<string, number>();
    // T9（审计批次 D）：按资源 id 一次性分组（原实现把全量槽位数组塞进每个
    // 候选的 eligibility ctx，eligibility.slotIndexFor 对每个新 ctx 重新分组
    // 全量数组 → O(C × S_total) 二次项）。改为每组一次、每候选只携带本资源
    // 行：eligibility 的冲突判定按 personId/deviceId/stationId 取本资源槽位，
    // 传入预分组行与传全量数组在 slotIndexFor 分组后集合完全一致（同果）。
    const slotsByPerson = new Map<string, Array<{ personId: string; start: number; end: number }>>();
    for (const s of bookedTimeSlots) {
      const list = slotsByPerson.get(s.personId);
      if (list) list.push(s);
      else slotsByPerson.set(s.personId, [s]);
    }
    const slotsByDevice = new Map<string, Array<{ deviceId: string; start: number; end: number }>>();
    for (const s of bookedDeviceSlots) {
      const list = slotsByDevice.get(s.deviceId);
      if (list) list.push(s);
      else slotsByDevice.set(s.deviceId, [s]);
    }
    const slotsByStation = new Map<string, Array<{ stationId: string; start: number; end: number }>>();
    for (const s of bookedStationSlots) {
      const list = slotsByStation.get(s.stationId);
      if (list) list.push(s);
      else slotsByStation.set(s.stationId, [s]);
    }

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
    // R2-SCH-003：快照禁入区 ∪ FORBIDDEN_ZONE 约束补充（与 heuristic 内联语义一致）。
    const forbiddenZones = Array.from(
      new Set([
        ...(snapshot.forbiddenZones ?? []).map((f) => f.zoneId),
        ...(opts.forbiddenZoneIds ?? []),
      ]),
    );

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
        // R-6（2026-09-13）：透传调用方租户，恢复路由图按租户分桶缓存
        // （此前不传 → loadGraph 读穿不缓存 → 每候选一次全图 SELECT）。
        { orgId: opts.orgId ?? null },
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
            // R-6（2026-09-13）：同 person×task 候选（每 station 一次）也须透传租户。
            { orgId: opts.orgId ?? null },
          );
          const stationRouteInfeasible = candRouteCost.feasible === false;

          const travelMs = (candRouteCost.etaSeconds ?? 0) * 1000;
          // R2-SCH-001：startMs 与 heuristic 内联分支语义等价——
          //   锁定窗（LOCKED_TIME）→ [start, end] 原样；
          //   否则 max(任务最早开始下界 + travel, 人员占用顺延, 设备占用顺延)。
          // （此前固定 now+travel，同一人员第二个任务直接 time_conflict 拒绝。）
          const lockedWindow = opts.lockedTimeByTask?.get(task.id);
          const earliestLowerMs = opts.earliestStartMs ?? nowMs;
          const startMs = lockedWindow
            ? lockedWindow[0]
            : Math.max(
                earliestLowerMs + travelMs,
                opts.bookedPersonFreeAt?.get(person.id) ?? 0,
                device != null
                  ? opts.bookedDeviceFreeAt?.get(device.id) ?? 0
                  : 0,
              );
          const durationMs = lockedWindow
            ? Math.max(lockedWindow[1] - lockedWindow[0], 1)
            : task.planEnd && task.planStart
              ? Date.parse(task.planEnd) - Date.parse(task.planStart)
              : (opts.durationMsByTask?.get(task.id) ?? config.defaultTaskDurationMs);
          const endMs = lockedWindow
            ? lockedWindow[1]
            : startMs + Math.max(durationMs, 1);

          const rejectReasons = this.collectRejectReasons({
            person,
            task,
            device,
            lockedAssigneeId,
            ctx: {
              now: nowMs,
              // T9：每候选仅携带本资源槽位（见上方一次性分组注释）；
              // eligibility 按 personId/deviceId/stationId 过滤 → 同果。
              bookedTimeSlots: slotsByPerson.get(person.id) ?? [],
              bookedDeviceSlots: device
                ? slotsByDevice.get(device.id) ?? []
                : [],
              bookedStationSlots: (stationId ?? task.stationId)
                ? slotsByStation.get((stationId ?? task.stationId) as string) ?? []
                : [],
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
          // R2-SCH-001：waitMs 相对同一最早开始下界（与内联分支
          // max(0, startMs - earliestStartMs) 同源；端点缺省下界=now 不变）。
          const waitMs = Math.max(0, startMs - (opts.earliestStartMs ?? nowMs));
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
          const batteryPct = device ? normalizeBatteryPct(device.batteryPct) : null;
          const energyPenalty =
            device == null
              ? 0
              : batteryPct == null
                ? Number.POSITIVE_INFINITY
                : (1 - batteryPct / 100) * 60 * 1000;

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

          const capabilityNotes = this.buildCapabilityNotes(task, device, rejectReasons);
          const sessionNotes = this.buildSessionNotes(device, person.id);
          evaluations.push({
            personId: person.id,
            deviceId: device ? device.id : null,
            stationId,
            startMs,
            endMs,
            eligible,
            rejectReasons,
            ...(capabilityNotes.length > 0 ? { capabilityNotes } : {}),
            ...(sessionNotes.length > 0 ? { sessionNotes } : {}),
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
  /**
   * 能力要求的**反事实放宽分析**（NO-17a）。
   *
   * 为什么：能力要求写错/写多时任务永远没有候选，而现场只知道"匹配不到"，不知道该放宽哪一项、
   * 放宽之后会得到什么资源。这里对每个要求做一次反事实评估（把它去掉后重新判定资格），
   * 报告"新增候选数 + 那些候选设备还具备什么能力"，让调度员自己判断是否可替代。
   *
   * 边界（重要）：
   * - **只建议，不自动放宽**：要求保持不变，平台绝不为了"派出去"而擅自降低执行边界；
   * - 只有在**当前零合格候选**时才计算（有候选就别制造噪音）；
   * - 安全/硬约束不参与建议：放宽后仍需通过全部其他硬约束（复用同一资格判定）。
   */
  private async buildCapabilityRelaxationSuggestions(input: {
    task: WorldStateSnapshot['tasks'][number];
    snapshot: WorldStateSnapshot;
    pool: CandidateEvaluation[];
    poolOpts: CandidatePoolOptions;
  }): Promise<
    Array<{
      /** 建议放宽的能力集合（组合建议时 >1 项）。 */
      capabilities: string[];
      /** 展示标签（单项 = 能力名；组合 = `a + b`）。 */
      label: string;
      kind: 'single' | 'combination';
      /** 兼容字段：单项建议 = 唯一能力名；组合建议 = 展示标签。 */
      capability: string;
      /** 涉及能力中的最高风险等级（未登记等级的能力 → null，不假装低风险）。 */
      risk: 'low' | 'medium' | 'high' | null;
      /** true = 放宽涉及高风险能力，必须由安全负责人确认（原则 4/6）。 */
      requiresSafetyReview: boolean;
      addedEligibleCount: number;
      sampleDeviceCapabilities: string[];
      note: string;
    }>
  > {
    const { task, snapshot, pool, poolOpts } = input;
    const requiredDeviceCaps = task.requiredDeviceCapabilities ?? [];
    if (requiredDeviceCaps.length === 0) return [];
    if (pool.some((c) => c.eligible)) return [];
    // 只在"确实因为能力被挡"时给建议（否则原因在别处，放宽能力也没用）
    const blockedByCapability = pool.some((c) =>
      c.rejectReasons.includes('missing_device_capability') ||
      c.rejectReasons.includes('capability_disabled'),
    );
    if (!blockedByCapability) return [];

    const evaluate = async (dropped: string[]) => {
      const relaxedTask = {
        ...task,
        requiredDeviceCapabilities: requiredDeviceCaps.filter((c) => !dropped.includes(c)),
      };
      const relaxedPool = await this.buildCandidatePool(relaxedTask, snapshot, poolOpts);
      const newlyEligible = relaxedPool.filter((c) => c.eligible);
      if (newlyEligible.length === 0) return null;
      const deviceIds = [...new Set(newlyEligible.map((c) => c.deviceId).filter(Boolean))] as string[];
      const sampleDeviceCapabilities = [
        ...new Set(
          deviceIds.flatMap((id) => snapshot.devices.find((d) => d.id === id)?.capabilities ?? []),
        ),
      ].sort();
      const label = dropped.join(' + ');
      // NO-19a：风险分级——放宽"吊装/助力"与放宽"温度观测"不是一回事。
      //   high：需**安全负责人**确认（调度员不得单独决定放宽执行边界）
      //   medium：需与安全/工艺负责人确认（含人员观测的隐私面）
      //   low：现场确认可替代性即可；未知等级按"未知"如实说明，不假装低风险
      const risks = dropped.map((name) => capabilityRiskLevel(name));
      const highestRisk = risks.includes('high')
        ? ('high' as const)
        : risks.includes('medium')
          ? ('medium' as const)
          : risks.includes('low')
            ? ('low' as const)
            : null;
      const requiresSafetyReview = highestRisk === 'high';
      const reviewNote = requiresSafetyReview
        ? '；**该要求涉及高风险能力（直接作用于人体或吊装载荷），放宽必须由安全负责人确认**，调度员不得单独决定'
        : highestRisk === 'medium'
          ? '；该要求为中风险（执行动作或人员观测），请与安全/工艺负责人确认后放宽'
          : highestRisk === null
            ? '；该能力未登记风险等级（无法判断风险），放宽前请人工确认'
            : '';
      return {
        capabilities: dropped,
        label,
        // 兼容字段：单项建议时 = 唯一能力名（历史调用方/文案用 `capability`）
        capability: dropped.length === 1 ? dropped[0] : label,
        kind: dropped.length > 1 ? ('combination' as const) : ('single' as const),
        risk: highestRisk,
        requiresSafetyReview,
        addedEligibleCount: newlyEligible.length,
        sampleDeviceCapabilities: sampleDeviceCapabilities.slice(0, 8),
        note:
          `仅建议（不会自动放宽）：去掉要求「${label}」后可多出 ${newlyEligible.length} 个合格候选` +
          (deviceIds.length > 0 ? `（涉及 ${deviceIds.length} 台设备）` : '') +
          (dropped.length > 1 ? `；注意需要**同时**放宽这 ${dropped.length} 项才有效` : '') +
          reviewNote +
          '。是否可替代需现场确认；确认后请修改能力要求并重新生成方案。',
      };
    };

    const suggestions: Awaited<ReturnType<typeof evaluate>>[] = [];
    for (const capability of requiredDeviceCaps) {
      suggestions.push(await evaluate([capability]));
    }
    const singles = suggestions.filter(
      (s): s is NonNullable<typeof s> => s !== null,
    );
    // 收益大的排前面（帮助现场先看最值得放宽的那一项）
    if (singles.length > 0) {
      return singles.sort((a, b) => b.addedEligibleCount - a.addedEligibleCount).slice(0, 5);
    }

    // NO-18b：单项都无效 → 试**组合**（"同时放宽两项才出候选"是真实现场常见情形：
    // 例如任务同时要求两种专用设备能力，而现场只有一种替代资源）。
    // 成本有界：仅在单项全零时触发，要求数 ≤ 5、评估对数 ≤ 6，命中即停。
    if (requiredDeviceCaps.length < 2 || requiredDeviceCaps.length > 5) return [];
    let evaluatedPairs = 0;
    for (let i = 0; i < requiredDeviceCaps.length && evaluatedPairs < 6; i += 1) {
      for (let j = i + 1; j < requiredDeviceCaps.length && evaluatedPairs < 6; j += 1) {
        evaluatedPairs += 1;
        const combo = await evaluate([requiredDeviceCaps[i], requiredDeviceCaps[j]]);
        if (combo) return [combo];
      }
    }
    return [];
  }

  /**
   * 能力相关拒绝的可读细节（NO-15b）。
   *
   * 只在拒绝原因与设备能力有关时才生成：把"缺哪些能力"与"哪些能力被人停用
   * （谁/何时/为什么）"写清楚——现场据此判断该换设备、加装，还是复核停用决定。
   * 无相关事实返回空数组（不拼凑、不猜测）。
   */
  private buildCapabilityNotes(
    task: WorldStateSnapshot['tasks'][number],
    device: WorldStateSnapshot['devices'][number] | null,
    rejectReasons: CandidateRejectReason[],
  ): string[] {
    const capabilityRelated =
      rejectReasons.includes('capability_disabled') || rejectReasons.includes('missing_device_capability');
    if (!capabilityRelated || !device) return [];
    const required = task.requiredDeviceCapabilities ?? [];
    if (required.length === 0) return [];
    const available = new Set(deviceCapabilityNames(device));
    const disabledLifecycle = new Map(
      (device.disabledCapabilityLifecycle ?? []).map((entry) => [entry.name, entry]),
    );
    const notes: string[] = [];
    const missing = required.filter((cap) => !available.has(cap));
    if (missing.length > 0) {
      notes.push(`任务要求的能力：${missing.join('、')}；该设备当前可用能力：${available.size > 0 ? [...available].join('、') : '（无）'}`);
    }
    for (const cap of missing) {
      const lifecycle = disabledLifecycle.get(cap);
      if (!lifecycle) continue;
      const who = lifecycle.operator ?? '未知操作者';
      const when = lifecycle.at ? new Date(lifecycle.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未知';
      const why = lifecycle.reason ?? '未填写理由';
      notes.push(`能力 ${cap} 已被人工停用：${who} · ${when} · 理由：${why}`);
    }
    return notes;
  }

  /**
   * NO-38b：外骨骼会话的**正向**说明（只解释，不参与判定）。
   *
   * 什么时候给：候选设备正处于外骨骼会话中，且**候选人员就是佩戴者**——
   * 这是唯一物理可行的组合（人机同体）。现场此前只看到"这台设备没被拒"，却不知道
   * 为什么只有这个人能接；说明里必须写清"换人需先结束会话或改派佩戴者"。
   *
   * 判定仍由资格服务的 `device_in_active_session` 负责（佩戴者放行、他人拒绝），
   * 本方法绝不改变 eligible。
   */
  private buildSessionNotes(
    device: WorldStateSnapshot['devices'][number] | null | undefined,
    personId: string,
  ): string[] {
    const session = device?.activeExoSession;
    if (!device || !session) return [];
    const wearer = normalizePersonRef(session.personId);
    const candidate = normalizePersonRef(personId);
    if (!wearer || !candidate || wearer !== candidate) return [];
    const deviceLabel = device.deviceId ?? device.id;
    const started = session.startedAt
      ? new Date(session.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
      : '开始时间未记录';
    return [
      `设备 ${deviceLabel} 正由该人员佩戴（外骨骼会话 ${session.sessionId}，开始于 ${started}）：`
        + '本候选是人机同体配对（同一台外骨骼不能同时给两个人用）；'
        + '若要改派他人，需先结束会话或由现场改派佩戴者。',
    ];
  }

  private collectRejectReasons(input: {
    person: WorldStateSnapshot['persons'][number];
    task: WorldStateSnapshot['tasks'][number];
    device: WorldStateSnapshot['devices'][number] | null;
    /** NO-35a：本任务的锁定人员（见 `CandidatePoolOptions.lockedAssigneeId`）。 */
    lockedAssigneeId?: string | null;
    ctx: Parameters<EligibilityService['check']>[3];
    routeInfeasible: boolean;
    mustFinishByMs: number | null;
    endMs: number;
  }): CandidateRejectReason[] {
    const { person, task, device, ctx, routeInfeasible, mustFinishByMs, endMs } = input;
    const lockedAssigneeId = input.lockedAssigneeId ?? null;
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
        // NO-35a：佩戴中的外骨骼只对"锁定给该佩戴者"的任务可用
        lockedAssigneeId,
      },
      device
        ? {
            id: device.id,
            batteryPct: normalizeBatteryPct(device.batteryPct),
            online: device.online,
            status: device.status,
            capabilities: device.capabilities ?? [],
            // NO-15b：停用能力事实（用于区分"缺能力"与"能力被停用"）
            disabledCapabilities: device.disabledCapabilities ?? [],
            // NO-34a：活跃外骨骼会话（佩戴中的设备是硬约束，不是提示）
            activeExoSession: device.activeExoSession ?? null,
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
    // eligibility 现在直接返回词表类型，无需 `as` 断言（断言会掩盖未登记键）。
    const reasons: CandidateRejectReason[] = [...eligibility.reasons];
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
    const energyCost = Number.isFinite(energyPenalty)
      ? (w.energy * energyPenalty) / 60000
      : Number.POSITIVE_INFINITY;
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
      // R2-SCH-017：riskLevel 原样透传（不再折叠为 risk>0?'high'）。
      riskLevel: c.riskLevel ?? null,
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
