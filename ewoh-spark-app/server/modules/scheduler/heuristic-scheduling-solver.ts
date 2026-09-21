import { Logger } from '@nestjs/common';
import type { EmpiricalDurationPredictionProvider } from './prediction/empirical-duration-prediction-provider';
import { resolveDurationModelMap } from './prediction/duration-resolution';
import { normalizeBatteryPct } from '@shared/api.interface';
import { qualityFindingsBlockDispatch } from '@shared/quality';
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
import {
  EligibilityService,
  type EligibleDevice,
  type EligiblePerson,
  type EligibleTask,
} from './eligibility.service';
import type { CapabilityRecord } from '@shared/capability';
import { deviceCapabilityNames, personSkillNames } from './capability-projection';
import { RoutingService } from './routing.service';
import { RouteCostProvider } from './route-cost.provider';
import { createRouteCostMemo, type RouteCostMemo, type RouteCostMemoStats } from './route-cost-memo';
import { SlotIndex, type DeviceSlot, type PersonSlot, type StationSlot } from './solver-resource-index';
import { SchedulingPolicyService } from './scheduling-policy.service';
import type { SchedulerMetricsService } from './scheduler-metrics.service';
import { TaskLifecycle } from './task-lifecycle';
import { PriorityEngine } from './priority-engine';
import {
  checkConstraintSupported,
  detectDependencyCycle,
  SUPPORTED_HARD_CONSTRAINTS,
} from './constraints';
import type { SchedulingSolver, SolveOptions } from './scheduling-solver.interface';
import { SchedulingObjectiveEvaluator } from './scheduling-objective-evaluator.service';
import type { CandidateEngineService } from './candidate-engine.service';
import type { CandidateEvaluation, CandidateRejectReason } from '@shared/api.interface';
/** 未派工条目的拒绝明细上限（与规则/MILP 求解器同口径，防 trace 膨胀）。 */
const REJECTED_HARD_CAP = 12;

/**
 * P0：decisionTrace.rejectedHard / violations.alternatives 的 trace 视图上限。
 * 硬拒绝组合在 solve 内仍以紧凑列表全量计数（candidateCount / hardRejectCount /
 * rejectedHardTotal），仅 trace 装配时截断为有界视图，保证大规模（1000+ 任务）
 * 求解的内存有界（trace 不再持有 O(任务×人员×设备×工位) 的对象）。
 */
const TRACE_REJECT_CAP = 200;

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
  /** T03 / P1-2：结构化拒绝原因（hard 不满足时非空）。 */
  rejectReasons?: import('@shared/api.interface').CandidateRejectReason[];
  /** T03 / P1-4：工位换型（station 决策）。 */
  changeover?: boolean;
  /** T03 / P1-7：硬/软成本明细（可解释）。 */
  softCosts?: Record<string, number>;
}

/**
 * 紧凑拒绝记录（P0 性能）：hard-rejected (person, device, station) 组合不再
 * 物化完整 Candidate（routeGeometry/scoreBreakdown/alternatives/softCosts），
 * 仅保留 trace 所需字段；决策轨迹装配时才展开为 DecisionTrace.rejectedHard 形状。
 */
interface CompactReject {
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  rejectReasons: string[];
  /** NO-15c：能力相关拒绝的可读细节（哪个能力、谁/何时/为何停用）。 */
  capabilityNotes?: string[];
}

/**
 * P0：有界紧凑拒绝缓冲。trace 只消费前 TRACE_REJECT_CAP 条（保持枚举顺序），
 * 全量计数由调用方 taskRejectedTotal 维护——避免大规模场景（1000+ 任务，
 * ~3 千万拒绝组合）为 trace 视图物化全部条目（内存/GC 有界）。
 */
class CompactRejectBuffer {
  readonly entries: CompactReject[] = [];
  push(entry: CompactReject): void {
    if (this.entries.length < TRACE_REJECT_CAP) this.entries.push(entry);
  }
}

/** reuseBaseline fast-path 中复用的基线分配记录（SolveOptions.reuseBaseline 元素）。 */
export interface ReuseBaselineEntry {
  personId: string;
  deviceId: string | null;
  stationId: string | null;
}

/** reuseBaseline fast-path 的复验上下文（solve() 每任务装配一次，与枚举路径共享同一运行状态）。 */
interface ReuseContext {
  task: WorldStateSnapshot['tasks'][number];
  entry: ReuseBaselineEntry;
  lockedWindow: [number, number] | undefined;
  now: number;
  earliestStartMs: number;
  softDeadlineMs: number;
  mustFinishByMs: number | null;
  defaultDurationMs: number;
  /** ADR-056 消费侧：taskId → 模型时长（ms）；null = 模式 off / 提供者缺位（回退默认）。 */
  durationMsByTask: ReadonlyMap<string, number> | null;
  policy: SchedulingPolicy;
  config: SchedulingPolicyConfig;
  personById: Map<string, WorldStateSnapshot['persons'][number]>;
  deviceById: Map<string, WorldStateSnapshot['devices'][number]>;
  stationById: Map<string, WorldStateSnapshot['stations'][number]>;
  stationCapabilitiesById: Map<string, string[]>;
  /** NO-12v / ADR-045：契约形态工位能力（匹配优先）。 */
  stationCapabilityRecordsById: Map<string, CapabilityRecord[]>;
  stationCapacityById: Map<string, number | null>;
  /** R2-SCH-006：工位可用窗口（eligibility 4h3 同判据）。 */
  stationAvailableWindowsById: Map<string, Array<{ startMs: number; endMs: number }>>;
  stationMaintenanceBlockedById: Map<string, boolean>;
  stationQualityBlockedById: Map<string, boolean>;
  personPointById: Map<string, { x: number | null; y: number | null } | undefined>;
  routeCostMemo: RouteCostMemo;
  eligiblePersonById: Map<string, EligiblePerson>;
  eligibleDeviceById: Map<string, EligibleDevice>;
  bookedPerson: Map<string, number>;
  bookedDevice: Map<string, number>;
  personSlotsById: Map<string, SlotIndex<PersonSlot>>;
  deviceSlotsById: Map<string, SlotIndex<DeviceSlot>>;
  stationSlotsById: Map<string, SlotIndex<StationSlot>>;
  forbiddenZoneIds: string[];
  safetyBlockedPersonIds: string[];
  safetyBlockedDeviceIds: string[];
  /** R2-SCH-006：其他任务已锁定人员（eligibility 5 同判据）。 */
  lockedPersonIds: string[];
  /** R2-SCH-006：前置完成判定（eligibility predecessor 同判据）。 */
  predecessorDone: (id: string) => boolean;
  lockedPersonByTask: Map<string, string>;
  lockedDeviceByTask: Map<string, string>;
  excludedPersonByTask: Map<string, Set<string>>;
  excludedPersonGlobal: Set<string>;
  excludedDeviceByTask: Map<string, Set<string>>;
  excludedDeviceGlobal: Set<string>;
  excludedStationByTask: Map<string, Set<string>>;
  excludedStationGlobal: Set<string>;
  effectiveMinBattery: number;
  effectiveMaxLoad: number;
}

/**
 * 确定性启发式求解器（无 LLM）。
 * 输入世界状态快照 + 资格服务 + 路由成本提供者 + 版本化策略 + 锁定约束，
 * 执行 任务×人员×设备×工位×时间窗 的联合调度（T03：station 为决策变量），
 * 输出含可解释得分分解（ScoreBreakdown）与动态优先级说明的方案。
 * 同一 (snapshot, policy) 输入 → 同一输出（可确定性重放）。
 */
export class HeuristicSchedulingSolver implements SchedulingSolver {
  private readonly logger = new Logger(HeuristicSchedulingSolver.name);

  /**
   * NEST-048（2026-08-17）：负载等级罚系数——loadLevel 每级计 60s 等效成本
   * （原为两处散落魔数 60*1000；与 candidate-engine LOAD_PENALTY_MS_PER_LEVEL 同源）。
   */
  private static readonly LOAD_PENALTY_MS_PER_LEVEL = 60 * 1000;

  constructor(
    private readonly policyService: SchedulingPolicyService,
    private readonly routingService: RoutingService,
    private readonly routeCostProvider: RouteCostProvider,
    private readonly eligibilityService: EligibilityService,
    private readonly priorityEngine: PriorityEngine = new PriorityEngine(),
    private readonly metricsService?: SchedulerMetricsService,
    // P0-5：统一目标评估器（默认自建；测试可注入替身）。
    private readonly objectiveEvaluator: SchedulingObjectiveEvaluator = new SchedulingObjectiveEvaluator(),
    // T03 / P1-2（G7）：候选引擎（可选注入；注入后候选生成与端点共享语义）。
    private readonly candidateEngine?: CandidateEngineService,
    // P0-bench：run-local route-cost memo 命中统计注入（默认 off；仅 benchmark 使用，
    // 不改变 route-cost 语义——未注入时 memo 行为与历史完全一致）。
    private readonly routeMemoStats?: RouteCostMemoStats,
    // ADR-056 消费侧（2026-09-13）：经验时长提供者（可选）。仅当策略
    // prediction.durationModelMode='advisory' 且本提供者已注入时才消费；
    // 缺位/未训练/置信度不足一律回退 defaultTaskDurationMs（绝不猜）。
    // ⚠️ 刻意**不用**参数装饰器注入：本类历史上零装饰器，而 benchmark 脚本以
    // ts-node（无 experimentalDecorators）重编译本文件——参数装饰器会让 benchmark
    // 直接编译失败。DI 由 SolverService（@Inject(PREDICTION_PROVIDER)）承担后
    // 位置传下来，与 candidateEngine 等既有可选参数同款。
    private readonly durationPrediction?: EmpiricalDurationPredictionProvider,
  ) {}

  /** 暴露当前激活策略（供外层组合求解器构建请求权重时复用同一策略）。 */
  async loadActivePolicy(orgId?: string | null): Promise<SchedulingPolicy> {
    return this.policyService.getActivePolicy(orgId ?? null);
  }

  /** 暴露策略配置（供外层组合求解器复用同一优先级/参数语义）。 */
  async loadConfig(orgId?: string | null): Promise<SchedulingPolicyConfig> {
    return this.policyService.getConfig(orgId ?? null);
  }

  /**
   * ADR-056 消费侧：为本 run 可调度的任务预解析模型时长（taskId → ms）。
   *
   * 判定纪律（全部回退 = 拿不到就不消费，绝不猜）：
   * - 只接受 `source === 'ml'` 且数值有限 > 0 且置信度达阈值的结果——
   *   提供者内部的确定性回退（source='deterministic'）**不采纳**：
   *   那条路的值就是默认时长的近似，采纳只会让"是否用了模型"变得不可审计；
   * - 单任务预测失败（抛错/超时由调用方 catch）→ 该任务回退默认时长；
   * - 顺序解析（每任务一次进程内查表，成本可忽略），保证遍历顺序确定。
   *
   * 返回映射只影响**没有计划窗且未锁定**的任务的时间窗（消费点见 solve 内两处
   * 与候选引擎）；有 planStart/planEnd 的任务本就继承任务级真实事实，不叠加模型。
   */
  async resolveModelDurations(
    snapshot: WorldStateSnapshot,
    config: SchedulingPolicyConfig,
    defaultDurationMs: number,
    orgId: string | null,
  ): Promise<Map<string, number>> {
    // 共享解析器（heuristic / MILP 同源同判，shadow 双跑对比公平性的前提）。
    return resolveDurationModelMap(
      this.durationPrediction!,
      snapshot,
      defaultDurationMs,
      orgId,
      this.logger,
    );
  }

  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const now = Date.now();
    const orgId = opts.orgId ?? null;
    const policy = opts.policy ?? (await this.policyService.getActivePolicy(orgId));
    const config = await this.policyService.getConfig(orgId);
    const horizonMinutes = config.horizonMinutes ?? opts.horizonMinutes;
    const horizonEndMs = now + horizonMinutes * 60 * 1000;
    const defaultDurationMs = config.defaultTaskDurationMs;
    // ADR-056 消费侧：把"没有计划窗的任务用什么时长"从写死的默认值变成
    // **可切换的模型输入**。模式缺省 'off' → 不调提供者、不建映射，
    // 求解行为与历史逐字节一致（确定性重放的默认护栏）。
    const durationModelMode = config.prediction?.durationModelMode ?? 'off';
    const durationMsByTask =
      durationModelMode === 'advisory' && this.durationPrediction
        ? await this.resolveModelDurations(
            snapshot,
            config,
            defaultDurationMs,
            opts.orgId ?? null,
          )
        : null;
    if (durationModelMode === 'advisory' && !this.durationPrediction) {
      this.logger.warn(
        'durationModelMode=advisory 但求解器未注入预测提供者：本次 run 全部回退默认时长（不猜模型）',
      );
    }

    // 快照可能含有类型定义尚未覆盖的字段（如下游演进），通过受限联合访问。
    const snapshotExt = snapshot as WorldStateSnapshot & {
      safetyBlockedPersonIds?: string[];
      safetyBlockedDeviceIds?: string[];
    };
    const safetyBlockedPersonIds = snapshotExt.safetyBlockedPersonIds ?? [];
    const safetyBlockedDeviceIds = snapshotExt.safetyBlockedDeviceIds ?? [];

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
    // P0：任务 id → 任务 索引（替代 predecessor 处理中的线性 find）。
    const taskById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const predecessorOf = (taskId: string): string[] => {
      const t = taskById.get(taskId);
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

    // ---- P0 性能：任务无关索引一次性构建（hoist 出任务循环） ----
    // 工位 capability/capacity（原实现每任务重建）。
    const stationCapabilitiesById = new Map<string, string[]>();
    const stationCapabilityRecordsById = new Map<string, CapabilityRecord[]>();
    const stationCapacityById = new Map<string, number | null>();
    // NO-05c / NO-05d（ADR-010/011）：工位维护/质量封锁（与 candidate-engine 同源
    // 语义——活跃维护事实 / critical·high 活跃质量发现 → 封锁，fail-closed）。
    const stationMaintenanceBlockedById = new Map<string, boolean>();
    const stationQualityBlockedById = new Map<string, boolean>();
    // R2-SCH-006：工位可用窗口索引（reuse fast-path 与枚举路径同判据）。
    const stationAvailableWindowsById = new Map<
      string,
      Array<{ startMs: number; endMs: number }>
    >();
    for (const s of snapshot.stations) {
      stationCapabilitiesById.set(s.id, s.capabilities ?? []);
      stationCapabilityRecordsById.set(s.id, s.capabilityRecords ?? []);
      stationCapacityById.set(s.id, s.capacity ?? null);
      stationMaintenanceBlockedById.set(s.id, (s.maintenance?.length ?? 0) > 0);
      stationQualityBlockedById.set(
        s.id,
        qualityFindingsBlockDispatch(s.qualityFindings ?? null),
      );
      stationAvailableWindowsById.set(s.id, s.availableWindows ?? []);
    }
    // 人员技能索引（staged candidate pipeline：按技能预筛人员）。
    const personBySkill = new Map<string, WorldStateSnapshot['persons'][number][]>();
    for (const p of snapshot.persons) {
      for (const skill of personSkillNames(p)) {
        let arr = personBySkill.get(skill);
        if (!arr) {
          arr = [];
          personBySkill.set(skill, arr);
        }
        arr.push(p);
      }
    }
    // 设备能力索引（device prefilter；与 devicesForTask 同语义的预筛，见 deviceCandidatesForTask）。
    const deviceByCapability = new Map<
      string,
      WorldStateSnapshot['devices'][number][]
    >();
    for (const d of snapshot.devices) {
      for (const cap of deviceCapabilityNames(d)) {
        let arr = deviceByCapability.get(cap);
        if (!arr) {
          arr = [];
          deviceByCapability.set(cap, arr);
        }
        arr.push(d);
      }
    }
    // 人员落点（station 坐标或自身坐标；与任务无关，整个 solve 内不变）。
    const personPointById = new Map<
      string,
      { x: number | null; y: number | null } | undefined
    >();
    for (const p of snapshot.persons) {
      const personStation = p.stationId ? stationById.get(p.stationId) : undefined;
      personPointById.set(
        p.id,
        personStation
          ? { x: personStation.x, y: personStation.y }
          : p.x != null && p.y != null
            ? { x: p.x, y: p.y }
            : undefined,
      );
    }
    // 资格判定用人员/设备描述对象（solve 内不变，避免每候选重复构造）。
    const eligiblePersonById = new Map<string, EligiblePerson>();
    for (const p of snapshot.persons) {
      // 快照类型未覆盖的下游扩展字段，通过受限联合访问（与 snapshotExt 同模式）。
      const personExt = p as WorldStateSnapshot['persons'][number] & {
        availableWindows?: Array<{ startMs: number; endMs: number }> | null;
        source?: 'AUTHORITATIVE' | 'DERIVED';
      };
      eligiblePersonById.set(p.id, {
        id: p.id,
        status: p.status,
        skills: p.skills ?? [],
        certifications: p.certifications ?? [],
        stationId: p.stationId ?? null,
        loadLevel: p.loadLevel ?? 0,
        fatigueLevel: p.fatigueLevel ?? 0,
        healthStatus: p.healthStatus ?? null,
        certificationExpiry: p.certificationExpiry ?? [],
        availableWindows: personExt.availableWindows ?? null,
        dataQuality: p.dataQuality,
        source: personExt.source,
        // NO-05c / NO-05d：活跃维护/质量事实（fail-closed 拒派）。
        maintenance: p.maintenance ?? null,
        qualityFindings: p.qualityFindings ?? null,
      });
    }
    const eligibleDeviceById = new Map<string, EligibleDevice>();
    for (const d of snapshot.devices) {
      const deviceExt = d as WorldStateSnapshot['devices'][number] & {
        maintenanceWindows?: Array<{ startMs: number; endMs: number }> | null;
        source?: 'AUTHORITATIVE' | 'DERIVED';
      };
      eligibleDeviceById.set(d.id, {
        id: d.id,
        batteryPct: normalizeBatteryPct(d.batteryPct),
        online: d.online,
        status: d.status,
        capabilities: d.capabilities ?? [],
        availableWindows: d.availableWindows ?? null,
        maintenanceWindows: deviceExt.maintenanceWindows ?? null,
        dataQuality: d.dataQuality,
        source: deviceExt.source,
        // NO-05c / NO-05d：活跃维护/质量事实（fail-closed 拒派）。
        maintenance: d.maintenance ?? null,
        qualityFindings: d.qualityFindings ?? null,
      });
    }
    // run-local 确定性路径成本 memo（per-solve-call，几何点对键）。
    // 性能优化（2026-08-21）：支持跨变体共享 memo（solveVariants 传入），
    // 同几何坐标对的结果跨变体复用，避免 3x 重复 A*/euclidean 计算。
    // P0-bench：注入统计对象（可选）时累计命中/查询，供 benchmark 报告缓存命中率。
    const routeCostMemo: RouteCostMemo = opts.sharedRouteCostMemo
      ?? createRouteCostMemo(this.routeCostProvider, this.routeMemoStats);

    // P0 性能：路由成本批量预计算（消除内层循环 async 微任务开销）。
    // 原实现：每个 (person, station) 组合在内层循环中 await routeCostMemo.get()，
    // 串行等待每个 Promise 解析（~595 次 microtask 调度）。改为：在任务循环前
    // 一次性并行预热所有 (person, station) 组合的缓存 → 内层循环 await 命中
    // 已解析 Promise（零 I/O，仅 microtask 调度开销）。
    // 跨变体共享 memo 时，前一变体已预热的条目直接命中，进一步减少重复计算。
    {
      const precomputePromises: Promise<unknown>[] = [];
      for (const p of snapshot.persons) {
        const pp = personPointById.get(p.id);
        for (const s of snapshot.stations) {
          const sp = s.x != null && s.y != null ? { x: s.x, y: s.y } : undefined;
          precomputePromises.push(routeCostMemo.get(p.id, `__pre_${s.id}`, pp, sp));
        }
      }
      // 并行等待所有预计算完成（一次 event loop tick 内全部发起）。
      await Promise.all(precomputePromises);
    }
    // 禁入区域 id 数组（invariant；避免每候选 Array.from）。
    const forbiddenZoneIds = Array.from(forbiddenZones);
    // 前置完成判定闭包（doneTaskIds 运行时增长，闭包共享同一 Set 引用）。
    const predecessorDoneFn = (id: string): boolean =>
      doneTaskIds.has(id) || frozenPredEndMs.has(id);
    // 共享空槽位数组（eligibility 只读，不修改；按资源类型分型）。
    const EMPTY_PERSON_SLOTS: Array<{ personId: string; start: number; end: number }> = [];
    const EMPTY_DEVICE_SLOTS: Array<{ deviceId: string; start: number; end: number }> = [];
    const EMPTY_STATION_SLOTS: Array<{ stationId: string; start: number; end: number }> = [];

    // 预订时间片（来自快照 reservations）：person/device/station 三类都进占用
    // 槽位。此前只喂 person——device/station 预约被静默丢弃，求解器把新任务
    // 派到已被 dispatch 预占的设备/工位，方案资源不可行，dispatch 预占硬后盾
    // 409 RESOURCE_CONFLICT 使整波下发失败（E2E scheduler-upgrade F 复现）。
    // 与候选引擎端点路径（evaluateTaskCandidates 映射三类）和 CP-SAT worker
    // 契约（reservations 全量透传）对齐；snapshot.reservations 仅含
    // reserved/active 行（world-state collectState 过滤），与 reserve() 同口径。
    const baseBookedSlots: Array<{ personId: string; start: number; end: number }> =
      [];
    const baseBookedDeviceSlots: Array<{
      deviceId: string;
      start: number;
      end: number;
    }> = [];
    const baseBookedStationSlots: Array<{
      stationId: string;
      start: number;
      end: number;
    }> = [];
    for (const r of snapshot.reservations ?? []) {
      if (r.resourceType === 'person') {
        baseBookedSlots.push({
          personId: r.resourceId,
          start: r.startMs,
          end: r.endMs,
        });
      } else if (r.resourceType === 'device') {
        baseBookedDeviceSlots.push({
          deviceId: r.resourceId,
          start: r.startMs,
          end: r.endMs,
        });
      } else if (r.resourceType === 'station') {
        baseBookedStationSlots.push({
          stationId: r.resourceId,
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
          // T03 / P1-1（G4）：事件驱动优先级——开放事件（severity L2/L3 / DEADLINE_AT_RISK）
          // 触发 event_severity 分支（修复死路径）。
          events: (snapshot.events ?? [])
            .filter((e) => e.status === 'open')
            .map((e) => ({ eventType: e.eventType ?? null, severity: e.severity })),
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
    // P0：taskId → assignment 索引（替代 predecessor 处理中的线性 find）。
    const assignmentByTask = new Map<string, SchedulingAssignment>();
    const bookedPerson = new Map<string, number>(); // personId -> last end ms
    const bookedDevice = new Map<string, number>(); // deviceId -> last end ms
    // P0：单一人员槽位数组（base + run 增长），避免每候选 [...base, ...run] 展开。
    const bookedPersonSlots: Array<{
      personId: string;
      start: number;
      end: number;
    }> = [...baseBookedSlots];
    const bookedDeviceSlots: Array<{
      deviceId: string;
      start: number;
      end: number;
    }> = [...baseBookedDeviceSlots];
    const bookedStationSlots: Array<{
      stationId: string;
      start: number;
      end: number;
    }> = [...baseBookedStationSlots];
    // P0：工位占用计数增量维护（预订时 +1，替代每任务重建）。
    const bookedStationCounts = new Map<string, number>();
    // T9（审计批次 D）：资源维度槽位索引（SlotIndex：按 start 排序 + 前缀
    // max(end) + 二分 overlap 判定）。原实现每任务从全量数组重建三 Map
    // （O(T × S_total) 主导项）且每候选线性 .some() 扫描（O(C × k)）；现改为
    // solve 开始构建一次 + 接受分配时增量 insert，查询 O(log k)。
    // 语义等价性：overlap 存在性与遍历顺序无关；索引内容与「全量重建」在
    // 每任务起点的集合完全一致（槽位只在任务间追加）。见 solver-resource-index.ts。
    const personSlotsById = new Map<string, SlotIndex<PersonSlot>>();
    for (const s of bookedPersonSlots) {
      let idx = personSlotsById.get(s.personId);
      if (!idx) {
        idx = new SlotIndex<PersonSlot>();
        personSlotsById.set(s.personId, idx);
      }
      idx.insert(s);
    }
    const deviceSlotsById = new Map<string, SlotIndex<DeviceSlot>>();
    for (const s of bookedDeviceSlots) {
      let idx = deviceSlotsById.get(s.deviceId);
      if (!idx) {
        idx = new SlotIndex<DeviceSlot>();
        deviceSlotsById.set(s.deviceId, idx);
      }
      idx.insert(s);
    }
    const stationSlotsById = new Map<string, SlotIndex<StationSlot>>();
    for (const s of bookedStationSlots) {
      let idx = stationSlotsById.get(s.stationId);
      if (!idx) {
        idx = new SlotIndex<StationSlot>();
        stationSlotsById.set(s.stationId, idx);
      }
      idx.insert(s);
    }

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
        const predAsg = assignmentByTask.get(p);
        if (predAsg?.plannedEnd) {
          const e = Date.parse(predAsg.plannedEnd);
          if (Number.isFinite(e)) predEndTimesMs.push(e);
        } else {
          const predTask = taskById.get(p);
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
      // T03 / P1-4（G3）：station 为决策变量——枚举 candidateStations（有限集），
      // 回退 task.stationId；stationDecisionEnabled=false 回退基线行为（风险回滚开关）。
      const stationDecisionEnabled = config.stationCapacityEnforced !== false;
      const stationOptions = this.resolveStationOptions(
        task,
        stationById,
        stationDecisionEnabled,
      );

      // station 维度索引（P1-3/P1-4）：capability + capacity 已在 solve 开头一次性构建
      // （hoist 出任务循环，见 solve 顶部 "任务无关索引" 段）。

      // ---- P0：每任务状态（候选池 / 紧凑拒绝缓冲 / 计数） ----
      const feasibleTopK: Candidate[] = [];
      const rejectedList = new CompactRejectBuffer();
      // 技能不匹配人员每人仅记一条紧凑拒绝（跨工位去重）。
      const emittedSkillReject = new Set<string>();
      let mustFinishByViolated = false;
      let taskCandidateCount = 0;
      let taskRejectedTotal = 0;
      // 当前已占用槽位 → 资源维度索引（T9：已上移到 solve 顶部构建一次，
      // 接受分配时增量维护——见 bookedStationCounts 附近的 SlotIndex 构建段）。
      // 候选设备集合（hoist 出 person 循环：devicesForTask 与 person/station 无关）。
      const deviceCandidates = this.deviceCandidatesForTask(
        task.id,
        deviceById,
        deviceByCapability,
        lockedDeviceByTask,
        effectiveMinBattery,
        task.requiredDeviceCapabilities,
        excludedDeviceByTask,
        excludedDeviceGlobal,
      );
      // lockedPersonIds 仅依赖 task.id（hoist 出候选循环）。
      const lockedPersonIds = this.lockedPersonIdsForTask(snapshot, task.id);
      // 任务描述对象（候选评估共用，无状态）。
      const taskForEligibility: EligibleTask = {
        id: task.id,
        taskType: task.taskType,
        requiredSkills: task.requiredSkills ?? [],
        skillMatchMode: task.skillMatchMode,
        requiredCertifications: task.requiredCertifications ?? [],
        stationId: task.stationId ?? null,
        zoneId: task.zoneId ?? null,
        predIds: task.predecessorIds ?? [],
        requiredDeviceCapabilities: task.requiredDeviceCapabilities,
        requiredStationCapabilities: task.requiredStationCapabilities,
        candidateStations:
          task.candidateStations && task.candidateStations.length > 0
            ? task.candidateStations
            : undefined,
        earliestStartMs: task.earliestStartMs,
        dueAtMs: task.dueAtMs,
        safetyCritical: task.safetyCritical,
      };
      // staged pipeline：requiredSkills 非空时仅枚举共享至少一个必需技能的人员
      //（skillMatchMode ALL/ANY 下该预筛均 sound：不共享任何技能者必被拒绝）。
      const requiredSkills = task.requiredSkills ?? [];
      const skillMatchedPersonIds = new Set<string>();
      if (requiredSkills.length > 0) {
        for (const skill of requiredSkills) {
          for (const p of personBySkill.get(skill) ?? []) {
            if (
              this.personMatchesLock(p.id, task.id, lockedPersonByTask) &&
              !this.isExcludedResource(
                task.id,
                p.id,
                excludedPersonByTask,
                excludedPersonGlobal,
              )
            ) {
              skillMatchedPersonIds.add(p.id);
            }
          }
        }
      }
      const candidatePersons: WorldStateSnapshot['persons'][number][] = [];
      const skillMismatchPersons: WorldStateSnapshot['persons'][number][] = [];
      for (const p of snapshot.persons) {
        if (
          !this.personMatchesLock(p.id, task.id, lockedPersonByTask) ||
          this.isExcludedResource(
            task.id,
            p.id,
            excludedPersonByTask,
            excludedPersonGlobal,
          )
        ) {
          continue;
        }
        if (requiredSkills.length > 0 && !skillMatchedPersonIds.has(p.id)) {
          skillMismatchPersons.push(p);
        } else {
          candidatePersons.push(p);
        }
      }

      // ---- #9 reuseBaseline fast-path（flag-gated，DEFAULT OFF） ----
      // 调用方显式提供 reuseBaseline（Map<taskId, {personId, deviceId, stationId}>）时，
      // 对"当前运行状态下仍有效"的基线分配直接复用（免枚举）；任一校验失败回退完整枚举。
      // 注意：fast-path 只会在调用方显式 opt-in 时改变求解结果——未传 reuseBaseline 时
      // 行为与全量重排完全一致（确定性：结果仅由 opts 显式请求驱动，非默认路径）。
      const reuseEntry = opts.reuseBaseline?.get(task.id);
      let reuseAdopted = false;
      if (reuseEntry && reuseEntry.personId) {
        const reusedCandidate = await this.tryReuseAssignment({
          task,
          entry: reuseEntry,
          lockedWindow,
          now,
          earliestStartMs,
          softDeadlineMs,
          mustFinishByMs,
          defaultDurationMs,
          durationMsByTask,
          policy,
          config,
          personById,
          deviceById,
          stationById,
          stationCapabilitiesById,
          stationCapabilityRecordsById,
          stationCapacityById,
          stationAvailableWindowsById,
          stationMaintenanceBlockedById,
          stationQualityBlockedById,
          personPointById,
          routeCostMemo,
          eligiblePersonById,
          eligibleDeviceById,
          bookedPerson,
          bookedDevice,
          personSlotsById,
          deviceSlotsById,
          stationSlotsById,
          forbiddenZoneIds,
          safetyBlockedPersonIds,
          safetyBlockedDeviceIds,
          lockedPersonIds,
          predecessorDone: predecessorDoneFn,
          lockedPersonByTask,
          lockedDeviceByTask,
          excludedPersonByTask,
          excludedPersonGlobal,
          excludedDeviceByTask,
          excludedDeviceGlobal,
          excludedStationByTask,
          excludedStationGlobal,
          effectiveMinBattery,
          effectiveMaxLoad,
        });
        if (reusedCandidate) {
          feasibleTopK.push(reusedCandidate);
          reuseAdopted = true;
        }
      }

      // T03 / P1-2（G7）修 #17：注入 CandidateEngineService 时，候选池消费
      // buildCandidatePool（与端点 GET /tasks/:taskId/candidates 同语义）；
      // 未注入时保持现状内联（向后兼容）。routeId 由 engine 池不携带，映射为
      // routeCostId 并标注 parity 差异（见 candidate-engine parity 测试）。
      // P0：top-K 上限（SolveOptions.candidateTopK / config.candidateTopK，默认 12）。
      const topK = Math.max(
        1,
        Math.floor(
          opts.candidateTopK ??
            (config as SchedulingPolicyConfig & { candidateTopK?: number })
              .candidateTopK ??
            12,
        ),
      );
      if (reuseAdopted) {
        // reuse 已采纳：跳过候选枚举（feasibleTopK 仅含复用候选）。
      } else if (this.candidateEngine) {
        const enginePool = await this.candidateEngine.buildCandidatePool(task, snapshot, {
          nowMs: now,
          // R-6（2026-09-13）：透传本请求的租户 —— 候选引擎要为每个 (人员,任务) 组合
          // 估一次路径成本；不透传时路由层拿不到租户键、只能走"读穿不缓存"，
          // 每候选一次 route_node/route_edge 全图 SELECT（实测把 5 秒的排产拖到 3 分钟以上）。
          // 透传后按租户分桶缓存，且图查询的租户谓词与缓存键同源，不会跨租户复用。
          orgId: opts.orgId ?? null,
          // ADR-056 消费侧：候选阶段的时间窗用同一份模型时长（与指派窗一致，
          // 避免"候选阶段用默认窗、指派阶段用模型窗"的口径分裂）。
          durationMsByTask,
          // R2-SCH-002：变体策略（solveVariants 权重缩放）必须作用于 engine 候选评分。
          policy,
          config,
          // R2-SCH-001：任务最早开始下界 + 人员/设备占用顺延（与内联分支同语义）。
          earliestStartMs,
          bookedPersonFreeAt: bookedPerson,
          bookedDeviceFreeAt: bookedDevice,
          // R2-SCH-003：锁定时间/禁入区约束在 engine 路径同样生效（不再静默丢失）。
          lockedTimeByTask,
          forbiddenZoneIds,
          lockedPersonByTask,
          lockedDeviceByTask,
          excludedPersonByTask,
          excludedDeviceByTask,
          excludedStationByTask,
          excludedPersonGlobal,
          excludedDeviceGlobal,
          excludedStationGlobal,
          preferredPersonByTask,
          preferredDeviceByTask,
          preferredStationByTask,
          preferredPersonGlobal,
          preferredDeviceGlobal,
          preferredStationGlobal,
          bookedTimeSlots: bookedPersonSlots,
          bookedDeviceSlots,
          bookedStationSlots,
          bookedStationCounts,
          baselineAssignee: opts.baselineAssignee,
          minBatteryPct: effectiveMinBattery,
          maxContinuousLoad: effectiveMaxLoad,
          stationDecisionEnabled,
        });
        candidateCount += enginePool.length;
        taskCandidateCount += enginePool.length;
        for (const ev of enginePool) {
          if (!ev.eligible) hardRejectCount += 1;
          const startMs = lockedWindow ? lockedWindow[0] : ev.startMs;
          const endMs = lockedWindow ? lockedWindow[1] : ev.endMs;
          const eligible =
            ev.eligible && (mustFinishByMs == null || endMs <= mustFinishByMs);
          const candidate: Candidate = {
            personId: ev.personId,
            deviceId: ev.deviceId,
            stationId: ev.stationId,
            zoneId: task.zoneId,
            startMs,
            endMs,
            routeId: ev.routeCost?.routeCostId ?? null,
            etaSeconds: ev.routeCost?.etaSeconds ?? 0,
            distanceMeters: ev.routeCost?.distanceMeters ?? 0,
            // R2-SCH-017：riskLevel 原样透传（与内联分支 routeCost.riskLevel 同源，
            // 不再折叠为 risk>0?'high'——medium 等级不再丢失）。
            riskLevel: ev.routeCost?.riskLevel ?? null,
            routeGeometry: ev.routeCost?.geometry ?? [],
            waitMs: ev.softCosts?.waitMs ?? 0,
            lateMs: ev.softCosts?.latenessMs ?? 0,
            changeCost: ev.softCosts?.changeCost ?? 0,
            cost: eligible ? ev.scoreBreakdown.total : Number.POSITIVE_INFINITY,
            scoreBreakdown: ev.scoreBreakdown,
            reasons: eligible ? [] : ev.rejectReasons,
            alternatives: eligible ? [] : ev.rejectReasons.map((r) => ({ reasons: [r] })),
            rejectReasons: ev.rejectReasons,
            changeover: ev.changeover,
            softCosts: ev.softCosts as Record<string, number>,
          };
          if (eligible) {
            this.insertTopK(feasibleTopK, candidate, topK);
          } else {
            if (mustFinishByMs != null && endMs > mustFinishByMs) {
              mustFinishByViolated = true;
            }
            taskRejectedTotal += 1;
            rejectedList.push({
              personId: ev.personId,
              deviceId: ev.deviceId,
              stationId: ev.stationId,
              rejectReasons: ev.rejectReasons,
              ...(ev.capabilityNotes && ev.capabilityNotes.length > 0
                ? { capabilityNotes: ev.capabilityNotes }
                : {}),
            });
          }
        }
      } else {

      for (const stationId of stationOptions) {
        // stationId 可为 null（任务无工位/无候选工位时回退无工位语义，保持旧行为）。
        const station = stationId ? stationById.get(stationId) : undefined;
        if (stationId && !station) continue;
        if (stationId && this.isExcludedResource(
          task.id,
          stationId,
          excludedStationByTask,
          excludedStationGlobal,
        )) {
          continue;
        }
        // 候选工位作为任务落点（路径成本目的地）；无工位时回退 undefined（交由 routeCostProvider 解析）。
        const taskPoint = station ? { x: station.x, y: station.y } : undefined;

        // staged pipeline：技能不匹配人员不再枚举（compact reject + 等价计数：
        // 每个本应评估的 (person, device, station) 组合照常计入 candidateCount /
        // hardRejectCount；trace 每人只保留一条紧凑记录，见 P0 说明）。
        for (const person of skillMismatchPersons) {
          const skillRc = await routeCostMemo.get(
            person.id,
            task.id,
            personPointById.get(person.id),
            taskPoint,
          );
          if (skillRc.feasible === false) continue; // 原语义：route 不可行静默跳过，不计数
          candidateCount += deviceCandidates.length;
          taskCandidateCount += deviceCandidates.length;
          hardRejectCount += deviceCandidates.length;
          taskRejectedTotal += deviceCandidates.length;
          if (!emittedSkillReject.has(person.id)) {
            emittedSkillReject.add(person.id);
            rejectedList.push({
              personId: person.id,
              deviceId: null,
              stationId: null,
              rejectReasons: ['missing_skill'],
            });
          }
        }

        for (const person of candidatePersons) {
          // 真实路径成本（run-local 确定性 memo：同几何点对跨任务/跨人员复用）。
          const routeCost = await routeCostMemo.get(
            person.id,
            task.id,
            personPointById.get(person.id),
            taskPoint,
          );
          if (routeCost.feasible === false) {
            // 无可行路径（含纯手工兜底也不可行）→ 该人员不可达，跳过。
            continue;
          }

          const personElig = eligiblePersonById.get(person.id)!;
          const travelMs = routeCost.etaSeconds * 1000;
          for (const device of deviceCandidates) {
            // P2-T3：每个 (person, device, station) 候选组合计入候选数。
            candidateCount += 1;
            taskCandidateCount += 1;
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
                : (durationMsByTask?.get(task.id) ?? defaultDurationMs);
            const endMs = startMs + Math.max(durationMs, 1);

            // P0-3：mustFinishBy 硬检查——候选 endMs 违反硬截止则不可分配
            // （与 CP-SAT OnlyEnforceIf(assigned) 语义一致：无法满足的任务如实 unassigned）。
            if (mustFinishByMs != null && endMs > mustFinishByMs) {
              hardRejectCount += 1;
              taskRejectedTotal += 1;
              mustFinishByViolated = true;
              rejectedList.push({
                personId: person.id,
                deviceId: device ? device.id : null,
                stationId,
                rejectReasons: ['must_finish_by_violation'],
              });
              continue;
            }

            // P0：资源占用冲突预筛（与 eligibility 4/4b/4c 同判据、同优先级顺序；
            // 命中即该组合必被 eligibility 拒绝——直接紧凑拒绝，跳过完整资格评估）。
            // 预筛只淘汰"必拒绝"组合，绝不改变可行集/argmin；计数与 eligibility 拒绝一致。
            const personIdx = personSlotsById.get(person.id);
            const personConflict = personIdx !== undefined && personIdx.hasOverlap(startMs, endMs);
            if (personConflict) {
              hardRejectCount += 1;
              taskRejectedTotal += 1;
              rejectedList.push({
                personId: person.id,
                deviceId: device ? device.id : null,
                stationId,
                rejectReasons: ['time_conflict'],
              });
              continue;
            }
            if (device != null) {
              const deviceConflict =
                deviceSlotsById.get(device.id)?.hasOverlap(startMs, endMs) === true;
              if (deviceConflict) {
                hardRejectCount += 1;
                taskRejectedTotal += 1;
                rejectedList.push({
                  personId: person.id,
                  deviceId: device.id,
                  stationId,
                  rejectReasons: ['device_reserved'],
                });
                continue;
              }
            }
            if (stationId != null) {
              const stationConflict =
                stationSlotsById.get(stationId)?.hasOverlap(startMs, endMs) === true;
              if (stationConflict) {
                hardRejectCount += 1;
                taskRejectedTotal += 1;
                rejectedList.push({
                  personId: person.id,
                  deviceId: device ? device.id : null,
                  stationId,
                  rejectReasons: ['station_reserved'],
                });
                continue;
              }
            }

            const eligibility = this.eligibilityService.check(
              personElig,
              taskForEligibility,
              device ? eligibleDeviceById.get(device.id)! : null,
              {
                now,
                // P0：资源维度槽位索引（每任务构建一次）——扫描范围从全量槽位
                // 收窄到本资源槽位；eligibility 判定结果与全量扫描完全一致
                // （time_conflict/device_reserved/station_reserved 均按资源 id 过滤）。
                bookedTimeSlots:
                  personSlotsById.get(person.id)?.slots() ?? EMPTY_PERSON_SLOTS,
                bookedDeviceSlots:
                  device != null
                    ? deviceSlotsById.get(device.id)?.slots() ?? EMPTY_DEVICE_SLOTS
                    : EMPTY_DEVICE_SLOTS,
                bookedStationSlots:
                  stationId != null
                    ? stationSlotsById.get(stationId)?.slots() ?? EMPTY_STATION_SLOTS
                    : EMPTY_STATION_SLOTS,
                lockedPersonIds,
                forbiddenZones: forbiddenZoneIds,
                minBatteryPct: effectiveMinBattery,
                maxContinuousLoad: effectiveMaxLoad,
                safetyBlockedPersonIds,
                safetyBlockedDeviceIds,
                predecessorDone: predecessorDoneFn,
                candidateStartMs: startMs,
                candidateEndMs: endMs,
                // T03 / P1-3/P1-4：station 决策维度。
                candidateStationId: stationId,
                stationCapacityById,
                stationCapabilitiesById,
                stationCapabilityRecordsById,
                bookedStationCounts,
                // NO-05c / NO-05d：候选工位维护/质量封锁（fail-closed 拒派）。
                stationMaintenanceBlockedById,
                stationQualityBlockedById,
              },
            );

            if (!eligibility.eligible) {
              hardRejectCount += 1;
              taskRejectedTotal += 1;
              rejectedList.push({
                personId: person.id,
                deviceId: device ? device.id : null,
                stationId,
                rejectReasons: eligibility.reasons as CandidateRejectReason[],
              });
              continue;
            }

            const lateMs = Math.max(0, endMs - softDeadlineMs);
            const waitMs = Math.max(0, startMs - earliestStartMs);
            const baselineAssignee = opts.baselineAssignee?.get(task.id);
            // M04：Churn Objective V2——候选评分消费 churn 配置（person/device/station 变更罚）。
            const churnCfg = config.churn;
            const personChanged =
              baselineAssignee && baselineAssignee !== person.id ? 1 : 0;
            const deviceChanged =
              task.deviceId != null && task.deviceId !== device?.id ? 1 : 0;
            const stationChanged =
              task.stationId != null && task.stationId !== stationId ? 1 : 0;
            const churnCostScore =
              churnCfg != null
                ? personChanged * (churnCfg.personChangePenalty ?? policy.weights.change) +
                  deviceChanged * (churnCfg.deviceChangePenalty ?? 0) +
                  stationChanged * (churnCfg.stationChangePenalty ?? 0)
                : undefined;
            const changeCost = personChanged;
            const loadPenalty =
              person.loadLevel * HeuristicSchedulingSolver.LOAD_PENALTY_MS_PER_LEVEL;
            const changeCostMs = changeCost * 60 * 1000;
            // T03 / P1-4：setup/changeover 成本入评分（station 换型）。
            const changeover = task.stationId != null && task.stationId !== stationId;
            const setupMinutes = config.setupMinutes ?? 15;
            const changeoverMs = changeover ? setupMinutes * 60 * 1000 : 0;
            const riskMs =
              this.riskFactor(routeCost.riskLevel, config) * travelMs;
            const batteryPct = device ? normalizeBatteryPct(device.batteryPct) : null;
            const energyPenalty =
              device == null ? 0 : batteryPct == null ? Number.POSITIVE_INFINITY : (1 - batteryPct / 100) * 60 * 1000;

            const score = this.computeCandidateScore(
              policy,
              lateMs,
              travelMs,
              loadPenalty,
              waitMs,
              changeCostMs + changeoverMs,
              riskMs,
              energyPenalty,
              stationId,
              station?.queue?.length ?? 0,
              churnCostScore,
            );

            // 人工偏好（PREFERRED_RESOURCE）：命中偏好资源（person/device/station）时
            // 降低候选成本（软性加分）。magic number 已移入 config.preferenceBonusMinutes。
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
                )) ||
              this.isPreferredResource(
                task.id,
                stationId,
                preferredStationByTask,
                preferredStationGlobal,
              );
            if (preferred) {
              score.total = Math.max(
                0,
                score.total - (config.preferenceBonusMinutes ?? 30),
              );
            }

            const reasons = [
              ...priority.explanation,
              `effective_score=${priority.score.toFixed(2)}`,
              ...(changeover ? [`station_changeover=${stationId}`] : []),
            ];
            const candidate: Candidate = {
              personId: person.id,
              deviceId: device ? device.id : null,
              stationId,
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
              changeover,
              softCosts: {
                lateMs,
                travelMs,
                waitMs,
                changeCost,
                changeoverMs,
                riskMs,
                energyPenalty,
              },
            };
            this.insertTopK(feasibleTopK, candidate, topK);
          }
        }
      }
      } // end inline candidate path (else of candidateEngine)

      const best = feasibleTopK[0];

      if (!best) {
        // P0：violation alternatives 同样有界（trace 视图上限；
        // 全量计数经 rejectedHardTotal 透出，避免大规模场景 trace 内存爆炸）。
        const bounded = rejectedList.entries.slice(0, REJECTED_HARD_CAP);
        const violationAlternatives = bounded.map((c) => ({
          reasons: c.rejectReasons,
        }));
        violations.push({
          taskId: task.id,
          reason: mustFinishByViolated
            ? 'must_finish_by_violation'
            : 'no_eligible_resource',
          type: 'infeasible',
          alternatives: violationAlternatives,
          // NO-15c：与规则/MILP 求解器同源——方案解释不因求解器实现路径而不同。
          // （此前只有 alternatives 嵌套结构，UI 的冲突层读的是平铺 rejectReasons，
          // 于是启发式求解的方案一条原因都展示不出来。）
          rejectReasons: bounded.flatMap((c) => c.rejectReasons),
          capabilityNotes: [
            ...new Set(bounded.flatMap((c) => c.capabilityNotes ?? [])),
          ].slice(0, REJECTED_HARD_CAP),
        });
        continue;
      }

      // 预定资源。
      bookedPerson.set(best.personId, best.endMs);
      if (best.deviceId) bookedDevice.set(best.deviceId, best.endMs);
      bookedPersonSlots.push({
        personId: best.personId,
        start: best.startMs,
        end: best.endMs,
      });
      // T9：资源维度索引同步增量维护（查询 O(log k) 的前提）。
      {
        let idx = personSlotsById.get(best.personId);
        if (!idx) {
          idx = new SlotIndex<PersonSlot>();
          personSlotsById.set(best.personId, idx);
        }
        idx.insert({ personId: best.personId, start: best.startMs, end: best.endMs });
      }
      if (best.deviceId) {
        bookedDeviceSlots.push({
          deviceId: best.deviceId,
          start: best.startMs,
          end: best.endMs,
        });
        let idx = deviceSlotsById.get(best.deviceId);
        if (!idx) {
          idx = new SlotIndex<DeviceSlot>();
          deviceSlotsById.set(best.deviceId, idx);
        }
        idx.insert({ deviceId: best.deviceId, start: best.startMs, end: best.endMs });
      }
      if (best.stationId) {
        bookedStationSlots.push({
          stationId: best.stationId,
          start: best.startMs,
          end: best.endMs,
        });
        let sIdx = stationSlotsById.get(best.stationId);
        if (!sIdx) {
          sIdx = new SlotIndex<StationSlot>();
          stationSlotsById.set(best.stationId, sIdx);
        }
        sIdx.insert({ stationId: best.stationId, start: best.startMs, end: best.endMs });
        // P0：工位占用计数增量维护（预订时 +1，替代每任务重建）。
        bookedStationCounts.set(
          best.stationId,
          (bookedStationCounts.get(best.stationId) ?? 0) + 1,
        );
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
        candidates: feasibleTopK.map((c) => ({
          personId: c.personId,
          deviceId: c.deviceId,
          stationId: c.stationId,
          score: c.cost,
          reasons: c.reasons,
        })),
        selectedReason: best.reasons,
        rejectedAlternatives: feasibleTopK.slice(1).map((c) => ({
          personId: c.personId,
          deviceId: c.deviceId,
          stationId: c.stationId,
          reason: c.reasons,
        })),
        policyVersion: policy.version,
        solverVersion: policy.solverVersion,
        snapshotVersion: opts.snapshotVersion,
      };
      // T03 / P1-7：DecisionTrace 富化——结构化拒绝原因 + hard/soft 明细 + weights 快照。
      // P0：rejectedHard 由紧凑拒绝缓冲装配（不再遍历完整 Candidate 数组），
      // 有界视图（全量计数经 rejectedHardTotal 透出；1000+ 任务规模 trace 内存有界）。
      const rejectedHard: Array<{
        personId: string | null;
        deviceId: string | null;
        stationId: string | null;
        rejectReasons: string[];
      }> = rejectedList.entries.map((c) => ({
        personId: c.personId,
        deviceId: c.deviceId,
        stationId: c.stationId,
        rejectReasons: c.rejectReasons,
      }));
      const traceExt = decisionTrace as DecisionTrace & {
        rejectedHard: Array<{ personId: string | null; deviceId: string | null; stationId: string | null; rejectReasons: string[] }>;
        hardConstraints: string[];
        softCosts: Record<string, number>;
        weightsSnapshot: Record<string, number>;
        stationContribution: { stationId: string | null; queueLength: number; changeover: boolean };
        candidateCountTotal: number;
        rejectedHardTotal: number;
        reused?: boolean;
      };
      traceExt.rejectedHard = rejectedHard;
      traceExt.hardConstraints = [...SUPPORTED_HARD_CONSTRAINTS];
      traceExt.softCosts = best.softCosts ?? {};
      traceExt.weightsSnapshot = { ...policy.weights };
      traceExt.stationContribution = {
        stationId: best.stationId,
        queueLength: best.stationId
          ? stationById.get(best.stationId)?.queue?.length ?? 0
          : 0,
        changeover: best.changeover ?? false,
      };
      // P0：候选/拒绝总量（透明统计；rejectedHard 为紧凑去重后的 trace 视图）。
      traceExt.candidateCountTotal = taskCandidateCount;
      traceExt.rejectedHardTotal = taskRejectedTotal;
      // reuseBaseline fast-path 标记（仅显式 opt-in 时出现）。
      traceExt.reused = reuseAdopted || undefined;

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
      assignmentByTask.set(task.id, assignments[assignments.length - 1]);
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
      churn: config.churn,
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

  /** P0-bench：run-local route-cost memo 命中统计（未注入统计对象时全 0；诊断/benchmark 用）。 */
  routeCacheStats(): { lookups: number; hits: number; hitRatio: number } {
    const lookups = this.routeMemoStats?.lookups ?? 0;
    const hits = this.routeMemoStats?.hits ?? 0;
    return {
      lookups,
      hits,
      hitRatio: lookups > 0 ? hits / lookups : 0,
    };
  }

  /** 计算候选多目标成本（分钟归一化，total 即评分）。
   * Phase 2 / P2-T2：读取 SchedulingPolicy.weights 权威 8 权重（lateness/travel/wait/
   * workload/station/change/risk/energy）。
   * T03 / P1-4：stationWait 使用真实队列长度 × weights.station（station 决策维度）；
   * 旧字段（latenessWeight 等）仅为兼容别名，不再直接使用。 */
  private computeCandidateScore(
    policy: SchedulingPolicy,
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
    const w = policy.weights;
    const lateness = (w.lateness * lateMs) / 60000;
    const travel = (w.travel * travelMs) / 60000;
    const workloadBalance = (w.workload * loadPenalty) / 60000;
    // T03 / P1-4：stationWait = 基础等待 + 真实队列长度 × weights.station（工位排队成本）。
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

  private personMatchesLock(
    personId: string,
    taskId: string,
    locked: Map<string, string>,
  ): boolean {
    const lockedPerson = locked.get(taskId);
    return lockedPerson ? lockedPerson === personId : true;
  }

  /** T03 / P1-4：候选工位集合（station 决策变量；无工位/无候选时回退 [null] 保持旧语义）。 */
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
        normalizeBatteryPct(d.batteryPct) != null &&
        d.batteryPct! >= minBatteryPct &&
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

  /**
   * P0：候选设备集合（devicesForTask 的索引化等价实现）。
   * 设备能力索引（deviceByCapability）作为预筛：任务要求能力时，若索引中无任何
   * 设备具备首个必需能力，直接返回空集（devicesForTask 同样会拒绝）；
   * 其余语义与 devicesForTask 完全一致（online/battery/capability 超集/排除/锁定 +
   * 无能力要求时的 [null] 纯手工作业回退）。保持 devicesForTask 为权威：
   * 本方法永不返回 devicesForTask 会拒绝的设备。
   */
  private deviceCandidatesForTask(
    taskId: string,
    deviceById: Map<string, WorldStateSnapshot['devices'][number]>,
    deviceByCapability: Map<string, WorldStateSnapshot['devices'][number][]>,
    locked: Map<string, string>,
    minBatteryPct: number,
    requiredCapabilities?: string[],
    excludedPerTask?: Map<string, Set<string>>,
    excludedGlobal?: Set<string>,
  ): Array<WorldStateSnapshot['devices'][number] | null> {
    const caps = requiredCapabilities ?? [];
    if (caps.length > 0 && !deviceByCapability.has(caps[0])) return [];
    return this.devicesForTask(
      taskId,
      deviceById,
      locked,
      minBatteryPct,
      caps,
      excludedPerTask,
      excludedGlobal,
    );
  }

  /**
   * P0：稳定 top-K 插入（与 candidateCompare 全序一致）。
   * 同序（comparator === 0）元素保持插入顺序——与原实现
   * `candidates.sort(candidateCompare)` 的稳定排序语义一致，
   * 因此 argmin（feasibleTopK[0]）与原实现逐位一致。
   */
  private insertTopK(arr: Candidate[], c: Candidate, k: number): void {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.candidateCompare(arr[mid], c) <= 0) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, c);
    if (arr.length > k) arr.pop();
  }

  private intervalsOverlap(
    startA: number,
    endA: number,
    startB: number,
    endB: number,
  ): boolean {
    return startA < endB && startB < endA;
  }

  /**
   * #9 reuseBaseline fast-path：对基线分配做"当前运行状态"下的廉价复验。
   * 任一硬条件不满足（人员/设备/工位状态、技能/证书/能力、mustFinishBy、
   * 当前预订冲突、容量）→ 返回 null（调用方回退完整枚举）。
   * 返回的 Candidate 与正常枚举候选同形（含评分分解），可直接进入预订/轨迹装配；
   * 其 reasons 为 ['unchanged_assignment_reused'] 供 trace 标记。
   */
  private async tryReuseAssignment(
    ctx: ReuseContext,
  ): Promise<Candidate | null> {
    const { task, entry, lockedWindow } = ctx;
    const person = ctx.personById.get(entry.personId);
    if (!person) return null;
    const device = entry.deviceId ? ctx.deviceById.get(entry.deviceId) : undefined;
    if (entry.deviceId && !device) return null;
    const station = entry.stationId ? ctx.stationById.get(entry.stationId) : undefined;
    if (entry.stationId && !station) return null;

    // person 级校验（与 eligibility 对应原因一致；任一失败即不可复用）。
    if (person.status !== 'AVAILABLE') return null;
    if (person.loadLevel > ctx.effectiveMaxLoad) return null;
    if (ctx.safetyBlockedPersonIds.includes(person.id)) return null;
    if (!this.personMatchesLock(person.id, task.id, ctx.lockedPersonByTask)) return null;
    // NO-05c / NO-05d：活跃维护/质量事实 → 不可复用（fail-closed，与枚举路径同判据）。
    if ((person.maintenance?.length ?? 0) > 0) return null;
    if (qualityFindingsBlockDispatch(person.qualityFindings ?? null)) return null;
    if (
      this.isExcludedResource(
        task.id,
        person.id,
        ctx.excludedPersonByTask,
        ctx.excludedPersonGlobal,
      )
    ) {
      return null;
    }
    const personElig = ctx.eligiblePersonById.get(person.id)!;
    if (
      personElig.healthStatus === 'blocked' ||
      personElig.healthStatus === 'injured' ||
      personElig.healthStatus === 'unavailable'
    ) {
      return null;
    }
    // 技能 / 证书（与 eligibility 1/1b/2 同判据）。
    const requiredSkills = task.requiredSkills ?? [];
    if (requiredSkills.length > 0) {
      const matchMode = task.skillMatchMode ?? 'ALL';
      const hasSkill =
        matchMode === 'ALL'
          ? requiredSkills.every((s) => personElig.skills.includes(s))
          : requiredSkills.some((s) => personElig.skills.includes(s));
      if (!hasSkill) return null;
    }
    const requiredCerts = task.requiredCertifications ?? [];
    if (requiredCerts.length > 0) {
      const certOk = requiredCerts.every((c) => personElig.certifications.includes(c));
      if (!certOk) return null;
      const expired = (personElig.certificationExpiry ?? []).some(
        (e) =>
          e.expiresAtMs != null &&
          e.expiresAtMs < ctx.now &&
          requiredCerts.includes(e.name),
      );
      if (expired) return null;
    }

    // device 级校验（锁定/排除/在线/电量/状态/能力）。
    if (device) {
      const lockedDeviceId = ctx.lockedDeviceByTask.get(task.id);
      if (lockedDeviceId && lockedDeviceId !== device.id) return null;
      if (
        this.isExcludedResource(
          task.id,
          device.id,
          ctx.excludedDeviceByTask,
          ctx.excludedDeviceGlobal,
        )
      ) {
        return null;
      }
      if (ctx.safetyBlockedDeviceIds.includes(device.id)) return null;
      const batteryPct = normalizeBatteryPct(device.batteryPct);
      if (!device.online || batteryPct == null || batteryPct < ctx.effectiveMinBattery) return null;
      if (device.status === 'fault' || device.status === 'maintenance') return null;
      // NO-05c / NO-05d：活跃维护/质量事实 → 不可复用（fail-closed）。
      if ((device.maintenance?.length ?? 0) > 0) return null;
      if (qualityFindingsBlockDispatch(device.qualityFindings ?? null)) return null;
      const requiredCaps = task.requiredDeviceCapabilities ?? [];
      if (
        requiredCaps.length > 0 &&
        !requiredCaps.every((cap) => (device.capabilities ?? []).includes(cap))
      ) {
        return null;
      }
    } else if (ctx.lockedDeviceByTask.has(task.id)) {
      // 任务锁定设备但基线为纯手工作业 → 不匹配。
      return null;
    }

    // station 级校验（排除/能力/禁入区域）。
    if (entry.stationId) {
      if (
        this.isExcludedResource(
          task.id,
          entry.stationId,
          ctx.excludedStationByTask,
          ctx.excludedStationGlobal,
        )
      ) {
        return null;
      }
      const requiredStationCaps = task.requiredStationCapabilities ?? [];
      if (requiredStationCaps.length > 0) {
        const caps = ctx.stationCapabilitiesById.get(entry.stationId) ?? [];
        if (!requiredStationCaps.every((c) => caps.includes(c))) return null;
      }
      // NO-05c / NO-05d：候选工位维护/质量封锁 → 不可复用（fail-closed）。
      if (ctx.stationMaintenanceBlockedById.get(entry.stationId)) return null;
      if (ctx.stationQualityBlockedById.get(entry.stationId)) return null;
    }
    if (task.zoneId && ctx.forbiddenZoneIds.includes(task.zoneId)) return null;

    // 时间计算（与正常枚举完全一致）。
    const taskPoint = station ? { x: station.x, y: station.y } : undefined;
    const routeCost = await ctx.routeCostMemo.get(
      person.id,
      task.id,
      ctx.personPointById.get(person.id),
      taskPoint,
    );
    if (routeCost.feasible === false) return null;
    const travelMs = routeCost.etaSeconds * 1000;
    const rawStartMs = lockedWindow
      ? lockedWindow[0]
      : ctx.earliestStartMs + travelMs;
    const startMs = lockedWindow
      ? lockedWindow[0]
      : this.earliestStart(
          rawStartMs,
          ctx.bookedPerson.get(person.id),
          device ? ctx.bookedDevice.get(device.id) : undefined,
        );
    const durationMs = lockedWindow
      ? Math.max(lockedWindow[1] - lockedWindow[0], 1)
      : task.planEnd && task.planStart
        ? Date.parse(task.planEnd) - Date.parse(task.planStart)
        : (ctx.durationMsByTask?.get(task.id) ?? ctx.defaultDurationMs);
    const endMs = startMs + Math.max(durationMs, 1);

    // mustFinishBy 硬截止。
    if (ctx.mustFinishByMs != null && endMs > ctx.mustFinishByMs) return null;

    // 当前运行状态下的资源占用冲突。
    if (
      ctx.personSlotsById.get(person.id)?.hasOverlap(startMs, endMs) === true
    ) {
      return null;
    }
    if (
      device &&
      ctx.deviceSlotsById.get(device.id)?.hasOverlap(startMs, endMs) === true
    ) {
      return null;
    }
    // R2-SCH-006（2026-08-17）：完整 eligibility 复验（与枚举路径同判据）——补齐
    // fast-path 此前缺失的维度：资源可用窗口(4h/4h1/4h2/4h3)/Task Window(4g)/
    // 工位容量(4f)/锁定人员(5)/safetyCritical fail-close(11：STALE/UNKNOWN/DERIVED)。
    // 手工前置检查（锁定/排除/占用快筛）保留：eligibility 不感知 LOCKED_*/EXCLUDED_*。
    const reuseEligibility = this.eligibilityService.check(
      personElig,
      {
        id: task.id,
        taskType: task.taskType,
        requiredSkills: task.requiredSkills ?? [],
        skillMatchMode: task.skillMatchMode,
        requiredCertifications: task.requiredCertifications ?? [],
        stationId: task.stationId ?? null,
        zoneId: task.zoneId ?? null,
        predIds: task.predecessorIds ?? [],
        requiredDeviceCapabilities: task.requiredDeviceCapabilities,
        requiredStationCapabilities: task.requiredStationCapabilities,
        candidateStations:
          task.candidateStations && task.candidateStations.length > 0
            ? task.candidateStations
            : undefined,
        earliestStartMs: task.earliestStartMs,
        dueAtMs: task.dueAtMs,
        safetyCritical: task.safetyCritical,
      },
      device ? ctx.eligibleDeviceById.get(device.id)! : null,
      {
        now: ctx.now,
        bookedTimeSlots: ctx.personSlotsById.get(person.id)?.slots() ?? [],
        bookedDeviceSlots:
          device != null ? ctx.deviceSlotsById.get(device.id)?.slots() ?? [] : [],
        bookedStationSlots:
          entry.stationId != null
            ? ctx.stationSlotsById.get(entry.stationId)?.slots() ?? []
            : [],
        lockedPersonIds: ctx.lockedPersonIds,
        forbiddenZones: ctx.forbiddenZoneIds,
        minBatteryPct: ctx.effectiveMinBattery,
        maxContinuousLoad: ctx.effectiveMaxLoad,
        safetyBlockedPersonIds: ctx.safetyBlockedPersonIds,
        predecessorDone: ctx.predecessorDone,
        candidateStartMs: startMs,
        candidateEndMs: endMs,
        candidateStationId: entry.stationId,
        stationCapacityById: ctx.stationCapacityById,
        stationCapabilitiesById: ctx.stationCapabilitiesById,
        stationCapabilityRecordsById: ctx.stationCapabilityRecordsById,
        stationAvailableWindowsById: ctx.stationAvailableWindowsById,
        stationMaintenanceBlockedById: ctx.stationMaintenanceBlockedById,
        stationQualityBlockedById: ctx.stationQualityBlockedById,
      },
    );
    if (!reuseEligibility.eligible) return null;
    if (entry.stationId) {
      const stationIdx = ctx.stationSlotsById.get(entry.stationId);
      if (stationIdx?.hasOverlap(startMs, endMs) === true) {
        return null;
      }
      // 工位容量（与 eligibility 4f 语义一致：重叠任务数 >= capacity → 拒绝）。
      // 容量计数需全量重叠数（非存在性），保持线性计数（工位槽位规模小）。
      const capacity = ctx.stationCapacityById.get(entry.stationId) ?? null;
      if (capacity != null && capacity >= 0 && stationIdx != null) {
        const overlapCount = stationIdx
          .slots()
          .filter((s) => this.intervalsOverlap(s.start, s.end, startMs, endMs))
          .length;
        if (overlapCount >= capacity) return null;
      }
    }

    // 评分（与正常枚举一致：复用即 person 不变，churn person 分项为 0）。
    const lateMs = Math.max(0, endMs - ctx.softDeadlineMs);
    const waitMs = Math.max(0, startMs - ctx.earliestStartMs);
    const churnCfg = ctx.config.churn;
    const deviceChanged = task.deviceId != null && task.deviceId !== entry.deviceId ? 1 : 0;
    const stationChanged = task.stationId != null && task.stationId !== entry.stationId ? 1 : 0;
    const churnCostScore =
      churnCfg != null
        ? deviceChanged * (churnCfg.deviceChangePenalty ?? 0) +
          stationChanged * (churnCfg.stationChangePenalty ?? 0)
        : undefined;
    const changeCost = 0; // person 不变
    const loadPenalty =
      person.loadLevel * HeuristicSchedulingSolver.LOAD_PENALTY_MS_PER_LEVEL;
    const changeCostMs = changeCost * 60 * 1000;
    const changeover = task.stationId != null && task.stationId !== entry.stationId;
    const setupMinutes = ctx.config.setupMinutes ?? 15;
    const changeoverMs = changeover ? setupMinutes * 60 * 1000 : 0;
    const riskMs = this.riskFactor(routeCost.riskLevel, ctx.config) * travelMs;
    const batteryPct = device ? normalizeBatteryPct(device.batteryPct) : null;
    const energyPenalty =
      device == null ? 0 : batteryPct == null ? Number.POSITIVE_INFINITY : (1 - batteryPct / 100) * 60 * 1000;
    const score = this.computeCandidateScore(
      ctx.policy,
      lateMs,
      travelMs,
      loadPenalty,
      waitMs,
      changeCostMs + changeoverMs,
      riskMs,
      energyPenalty,
      entry.stationId,
      station?.queue?.length ?? 0,
      churnCostScore,
    );
    // 注：reuse 路径不做 PREFERRED_RESOURCE 偏好加分（偏好为软性加分，
    // 不影响合法性；复用语义下评分结构已与枚举路径对齐）。

    const reasons = ['unchanged_assignment_reused'];
    return {
      personId: person.id,
      deviceId: entry.deviceId,
      stationId: entry.stationId,
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
      changeover,
      softCosts: {
        lateMs,
        travelMs,
        waitMs,
        changeCost,
        changeoverMs,
        riskMs,
        energyPenalty,
      },
    };
  }

  private candidateCompare(a: Candidate, b: Candidate): number {
    if (a.cost !== b.cost) return a.cost - b.cost;
    if (a.personId !== b.personId)
      return a.personId < b.personId ? -1 : 1;
    const da = a.deviceId ?? '';
    const db = b.deviceId ?? '';
    if (da !== db) return da < db ? -1 : 1;
    const sa = a.stationId ?? '';
    const sb = b.stationId ?? '';
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }
}
