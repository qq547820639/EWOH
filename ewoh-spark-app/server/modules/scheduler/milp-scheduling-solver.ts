/* eslint-disable @darraghor/nestjs-typed/injectable-should-be-provided -- 手工组合装配：由 SolverService 构造函数 new 实例化，不经 DI providers 注册，规则误报 */
/* milp-scheduling-solver.ts — MILP Scheduling Solver（ADR-058 / NO-13i，§8/§9）。
 *
 * 求解器插拔阶梯第 4 类：精确联合整数规划（HiGHS 1.15.2 WASM，真实 MILP 求解器，
 * MIT，进程内无外部服务依赖）。语义（ADR-058 决策 1，§9 差异边界显式）：
 *  - 候选面：CandidateEngine.buildCandidatePool（与 heuristic/rule-based/CP-SAT
 *    共享同一硬约束过滤语义，§31）；booked 数组由快照 reservations 播种（与
 *    heuristic 生产路径同语义），lockedPerson/lockedDevice 透传；
 *  - 变量：eligible 候选 → 二元 x[t][c]；
 *  - 行：每任务至多一候选 / 人员重叠互斥 / 设备重叠互斥 / 工位窗口容量
 *    （capacity K：Σ 重叠候选 ≤ K + |O(c)|·(1−x[c])；K=1 退化互斥）/
 *    DAG 闭包（Σx[b] ≤ Σx[a]）/ DAG 时序冲突对互斥；
 *  - 目标：min Σ cost·x + M·Σ(1−Σx)，cost=scoreBreakdown.total（与 heuristic
 *    同一七项线性评分 §31），M=1+⌈Σcost⌉（成本非负 → 可证明先最大化分配数、
 *    再最小化成本的字典序语义）；
 *  - 确定性：LP 文本确定性构造 + threads=1 + random_seed=0 固定（同环境重放锁定；
 *    跨平台逐位一致不在承诺内，ADR-058 差异边界显式）；
 *  - 失败显式：HiGHS 加载/求解异常或非 Optimal 状态 → 显式抛出（本模型恒可行，
 *    非 Optimal 即实现缺陷，§33 绝不静默降级/伪造方案）；
 *  - 可解释：selectedReason=['milp:exact-optimal'] + rejectedHard 结构化原因 +
 *    violations 三分（no_eligible_candidate / predecessor_unassigned /
 *    no_feasible_assignment_milp）；
 *  - 产出：status='shadow'，solverVersion='milp-v1'，solverStatus='OPTIMAL'；
 *    metrics/baselineDelta 经 SchedulingObjectiveEvaluator（§31 统一评估器）。
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PREDICTION_PROVIDER, type EmpiricalDurationPredictionProvider } from './prediction/empirical-duration-prediction-provider';
import { resolveDurationModelMap } from './prediction/duration-resolution';
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
import highsLoader from 'highs';

export const MILP_SOLVER_VERSION = 'milp-v1';

type HighsInstance = Awaited<ReturnType<typeof highsLoader>>;

/**
 * HiGHS 固定求解参数（ADR-058：确定性——单线程 + 固定种子 + 静默）。
 * R2-SCH-005（2026-08-17）：+time_limit（秒）——HiGHS WASM 为同步求解，无时限时
 * 大规模实例可无限阻塞事件循环。超时返回非 Optimal 状态 → 显式抛出（§33 不伪造）。
 */
const HIGHS_OPTIONS = {
  output_flag: false,
  log_to_console: false,
  threads: 1,
  random_seed: 0,
  time_limit: 10,
} as const;

const REJECTED_HARD_CAP = 12;
/** 有解变量判定阈值（整数解 0/1，容差内视为 1）。 */
const ASSIGNED_THRESHOLD = 0.5;

/** 确定性任务序（与 rule-based 同序，保证 LP 文本与 violations 顺序稳定）：due→priority→id。 */
function compareTasksByRule(a: WorldStateSnapshot['tasks'][number], b: WorldStateSnapshot['tasks'][number]): number {
  const dueA = a.dueAtMs ?? (a.planEnd ? Date.parse(a.planEnd) : Number.MAX_SAFE_INTEGER);
  const dueB = b.dueAtMs ?? (b.planEnd ? Date.parse(b.planEnd) : Number.MAX_SAFE_INTEGER);
  if (dueA !== dueB) return dueA - dueB;
  const rank: Record<string, number> = { critical: 5, high: 4, medium: 3, low: 2 };
  const rankA = rank[String(a.priority ?? '').toLowerCase()] ?? 1;
  const rankB = rank[String(b.priority ?? '').toLowerCase()] ?? 1;
  if (rankA !== rankB) return rankB - rankA;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 确定性候选序：startMs → 资源键字典序。 */
function compareCandidatesByRule(a: CandidateEvaluation, b: CandidateEvaluation): number {
  if (a.startMs !== b.startMs) return a.startMs - b.startMs;
  const keyA = `${a.personId}|${a.deviceId ?? ''}|${a.stationId ?? ''}`;
  const keyB = `${b.personId}|${b.deviceId ?? ''}|${b.stationId ?? ''}`;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 数值格式化：整数直出，浮点去尾零小数（LP 文本不使用科学计数法）。 */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** 带符号项：首个无前导符号；负数以 `- <abs> <var>` 形式（CPLEX LP 兼容）。 */
function signedTerm(coeff: number, varName: string): string {
  if (coeff < 0) return `- ${fmt(-coeff)} ${varName}`;
  return `+ ${fmt(coeff)} ${varName}`;
}

interface MilpVariable {
  taskId: string;
  candidate: CandidateEvaluation;
}

interface PoolEntry {
  task: WorldStateSnapshot['tasks'][number];
  eligible: CandidateEvaluation[];
  rejected: CandidateEvaluation[];
}

/**
 * MILP Scheduling Solver（ADR-058）：HiGHS 精确联合整数规划。
 * 消费 CandidateEngine 共享候选池（§31 单一硬约束语义），产出可重放的
 * SchedulingPlanV2（shadow）；策略显式选择（policy.solverVersion='milp-v1'）。
 */
@Injectable()
export class MilpSchedulingSolver implements SchedulingSolver {
  private readonly logger = new Logger(MilpSchedulingSolver.name);
  private highsPromise: Promise<HighsInstance> | null = null;

  constructor(
    private readonly policyService: SchedulingPolicyService,
    private readonly candidateEngine: CandidateEngineService,
    private readonly objectiveEvaluator: SchedulingObjectiveEvaluator,
    // 可注入加载器（测试注入失败态；生产缺省 = 真实 HiGHS WASM 加载）。
    private readonly highsLoaderFn: () => Promise<HighsInstance> = highsLoader,
    // ADR-056 消费侧（2026-09-13）：经验时长提供者（可选；与 heuristic 同款纪律——
    // 仅 durationModelMode='advisory' 且已注入时消费；缺位/未训练回退默认时长）。
    @Optional() @Inject(PREDICTION_PROVIDER)
    private readonly durationPrediction?: EmpiricalDurationPredictionProvider,
  ) {}

  /** HiGHS WASM 惰性加载（单例缓存；失败清除缓存并显式抛出，§33 不静默）。 */
  private loadHighs(): Promise<HighsInstance> {
    if (!this.highsPromise) {
      this.highsPromise = this.highsLoaderFn().catch((err: unknown) => {
        this.highsPromise = null;
        throw new Error(
          `milp-v1: HiGHS WASM 加载失败：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    return this.highsPromise;
  }

  async solve(
    snapshot: WorldStateSnapshot,
    constraints: SchedulingConstraint[],
    opts: SolveOptions,
  ): Promise<SchedulingPlanV2> {
    const now = Date.now();
    const policy: SchedulingPolicy = opts.policy ?? (await this.policyService.getActivePolicy());
    const config = await this.policyService.getConfig();
    // ADR-056 消费侧：与 heuristic 同源同判（共享解析器）——shadow 双跑对比的公平性前提。
    const durationMsByTask =
      config.prediction?.durationModelMode === 'advisory' && this.durationPrediction
        ? await resolveDurationModelMap(
            this.durationPrediction,
            snapshot,
            config.defaultTaskDurationMs,
            opts.orgId ?? null,
            this.logger,
          )
        : null;
    const horizonMinutes = config.horizonMinutes ?? opts.horizonMinutes;

    const doneTaskIds = new Set<string>(
      snapshot.tasks.filter((t) => TaskLifecycle.isTerminal(t.status)).map((t) => t.id),
    );

    // 已锁定分配（快照真实事实：锁定任务的人员/设备不得更换）。
    const lockedPersonByTask = new Map<string, string>();
    const lockedDeviceByTask = new Map<string, string>();
    for (const locked of snapshot.lockedAssignments ?? []) {
      if (locked.personId) lockedPersonByTask.set(locked.taskId, locked.personId);
      if (locked.deviceId) lockedDeviceByTask.set(locked.taskId, locked.deviceId);
    }

    // R2-SCH-003（2026-08-17）：解析输入约束（LOCKED_*/EXCLUDED/FORBIDDEN_ZONE/
    // MIN_BATTERY/MAX_W 等经共享候选引擎真实执行；不支持的类型显式记
    // violations=UNSUPPORTED_CONSTRAINT，绝不静默失效）。
    const ir = compileConstraintOverrides(constraints);
    for (const [taskId, personId] of ir.lockedPersonByTask) {
      lockedPersonByTask.set(taskId, personId);
    }
    for (const [taskId, deviceId] of ir.lockedDeviceByTask) {
      lockedDeviceByTask.set(taskId, deviceId);
    }
    const unsupportedViolations: Array<Record<string, unknown>> = ir.unsupported.map(
      (c) => ({
        type: 'unsupported_constraint',
        constraintType: c.type,
        reason: 'UNSUPPORTED_CONSTRAINT',
      }),
    );

    // 快照 reservations → 初始占用（与 heuristic 生产路径同语义，ADR-058 决策 1）。
    const baseBookedTimeSlots: Array<{ personId: string; start: number; end: number }> = [];
    const baseBookedDeviceSlots: Array<{ deviceId: string; start: number; end: number }> = [];
    const baseBookedStationSlots: Array<{ stationId: string; start: number; end: number }> = [];
    for (const r of snapshot.reservations ?? []) {
      if (r.resourceType === 'person' && r.resourceId) {
        baseBookedTimeSlots.push({ personId: r.resourceId, start: r.startMs, end: r.endMs });
      } else if (r.resourceType === 'device' && r.resourceId) {
        baseBookedDeviceSlots.push({ deviceId: r.resourceId, start: r.startMs, end: r.endMs });
      } else if (r.resourceType === 'station' && r.resourceId) {
        baseBookedStationSlots.push({ stationId: r.resourceId, start: r.startMs, end: r.endMs });
      }
    }

    const tasks = snapshot.tasks
      .filter((t) => !TaskLifecycle.isTerminal(t.status))
      .sort(compareTasksByRule);

    // 1) 静态候选池（共享候选引擎，§31）。
    // R2-SCH-001/002/003：变体策略 + 资源占用顺延 + 约束 IR 全量透传候选引擎。
    const personFreeAt = this.freeAtByResource(baseBookedTimeSlots, (s) => s.personId);
    const deviceFreeAt = this.freeAtByResource(baseBookedDeviceSlots, (s) => s.deviceId);
    const entries: PoolEntry[] = [];
    for (const task of tasks) {
      const pool = await this.candidateEngine.buildCandidatePool(task, snapshot, {
        nowMs: now,
        // R-6（2026-09-13）：透传本请求租户，让路径成本估算复用按租户分桶的路由图缓存
        // （不透传则每候选一次全图 SELECT，见 candidate-engine 的同一注释）。
        orgId: opts.orgId ?? null,
        // ADR-056 消费侧：候选阶段时间窗与指派阶段同源（同 heuristic）。
        durationMsByTask,
        policy,
        bookedPersonFreeAt: personFreeAt,
        bookedDeviceFreeAt: deviceFreeAt,
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
        bookedTimeSlots: baseBookedTimeSlots,
        bookedDeviceSlots: baseBookedDeviceSlots,
        bookedStationSlots: baseBookedStationSlots,
        bookedStationCounts: new Map<string, number>(),
        baselineAssignee: opts.baselineAssignee,
        minBatteryPct: ir.minBatteryOverride ?? config.minBatteryPct,
        maxContinuousLoad: ir.maxLoadOverride ?? config.maxContinuousLoad,
      });
      entries.push({
        task,
        eligible: pool.filter((c) => c.eligible).sort(compareCandidatesByRule),
        rejected: pool.filter((c) => !c.eligible),
      });
    }

    // 2) 变量表（确定性顺序：任务序 × 候选序）。
    const vars: MilpVariable[] = [];
    const varsByTask = new Map<string, MilpVariable[]>();
    for (const e of entries) {
      const list = e.eligible.map((candidate) => ({ taskId: e.task.id, candidate }));
      // 逐个 push：spread（vars.push(...list)）在候选数大时超出 V8 参数栈上限
      // → RangeError: Maximum call stack size exceeded（2026-09-15 三族基准实测）。
      for (const v of list) vars.push(v);
      varsByTask.set(e.task.id, list);
    }
    const varIndex = new Map<MilpVariable, number>();
    vars.forEach((v, i) => varIndex.set(v, i));

    const assignedByTask = new Map<string, CandidateEvaluation>();

    if (vars.length === 0) {
      // 无任何可行候选：全部任务显式 UNASSIGNED（§33 不伪造，不调用求解器）。
      const violations = [
        ...unsupportedViolations,
        ...entries.map((e) => this.buildViolation(e, assignedByTask, snapshot)),
      ];
      return this.buildPlan({
        snapshot, constraints, policy, opts, config, horizonMinutes, now,
        assignments: [], violations,
      });
    }

    // 3) 构造 LP 文本（Minimize + 行 + Bounds + General，确定性顺序）。
    const lp = this.buildLpModel(entries, vars, varsByTask, varIndex, snapshot, doneTaskIds);

    // 4) 求解（真实 HiGHS；非 Optimal → 显式抛错）。
    const highs = await this.loadHighs();
    const solution = highs.solve(lp, HIGHS_OPTIONS);
    if (solution.Status !== 'Optimal') {
      throw new Error(
        `milp-v1: HiGHS 返回非 Optimal 状态 "${solution.Status}"（本模型恒可行，视为实现缺陷，§33 不伪造方案）`,
      );
    }

    for (const v of vars) {
      const column = solution.Columns[`v${varIndex.get(v)}`];
      if (column && column.Primal > ASSIGNED_THRESHOLD) {
        assignedByTask.set(v.taskId, v.candidate);
      }
    }

    // 5) 产出分配 + 显式违例。
    const assignments: SchedulingAssignment[] = [];
    for (const e of entries) {
      const chosen = assignedByTask.get(e.task.id);
      if (chosen) {
        assignments.push(this.buildAssignment(e.task, chosen, policy, opts, e));
      }
    }
    const violations = [
      ...unsupportedViolations,
      ...entries
        .filter((e) => !assignedByTask.has(e.task.id))
        .map((e) => this.buildViolation(e, assignedByTask, snapshot)),
    ];

    return this.buildPlan({
      snapshot, constraints, policy, opts, config, horizonMinutes, now,
      assignments, violations,
    });
  }

  /**
   * R2-SCH-001：booked 槽位 → 资源空闲时刻（resourceId → max end）。候选 startMs
   * 按占用顺延，与 heuristic 内联 earliestStart 语义一致（经候选引擎消费）。
   */
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

  /** LP 文本构造（ADR-058 决策 1：变量/行/目标全确定性顺序）。 */
  private buildLpModel(
    entries: PoolEntry[],
    vars: MilpVariable[],
    varsByTask: Map<string, MilpVariable[]>,
    varIndex: Map<MilpVariable, number>,
    snapshot: WorldStateSnapshot,
    doneTaskIds: Set<string>,
  ): string {
    const lines: string[] = ['Minimize'];

    // 目标：Σ cost·x + M·Σ(1−Σx)。展开后每变量系数 = cost − M
    // （常数项 Σ_t M 不影响最优解，省略——ObjectiveValue 偏移无语义暴露）。
    // 成本非负 → M = 1 + ⌈Σcost⌉ 严格大于任一可行解的总成本差：
    // 可证明"先最大化分配数、再最小化成本"的字典序语义（ADR-058 决策 1）。
    const m = 1 + Math.ceil(
      vars.reduce((a, v) => a + Math.max(0, v.candidate.scoreBreakdown.total), 0),
    );
    const objectiveTerms: string[] = [];
    for (const v of vars) {
      const idx = varIndex.get(v);
      const coeff = Math.max(0, v.candidate.scoreBreakdown.total) - m;
      objectiveTerms.push(signedTerm(coeff, `v${idx}`));
    }
    if (objectiveTerms.length > 0) {
      // 首个项去掉前导 "+ "（CPLEX LP 首项不带符号）。
      objectiveTerms[0] = objectiveTerms[0].replace(/^\+ /, '');
    }
    lines.push(` obj: ${objectiveTerms.length > 0 ? objectiveTerms.join(' ') : '0'}`);

    const rows: string[] = [];
    let rowId = 0;

    // 行 A：每任务至多一候选。
    for (const e of entries) {
      const terms = varsByTaskTerms(e, vars, varIndex);
      if (terms.length > 0) {
        rows.push(` r${rowId++}: ${terms.map((t) => `v${t}`).join(' + ')} <= 1`);
      }
    }

    // 行 B/C：人员/设备重叠互斥（跨任务两两冲突）。
    // R2-SCH-005（2026-08-17）：按资源分组后组内配对——替代全变量 O(V²) 交叉扫描
    //（只有共享同一人员/设备的变量对才可能冲突；组间配对必然无冲突）。
    // 语义与旧全扫完全一致（同冲突对集合）；行序按资源分组确定性排列。
    const emittedMutexPairs = new Set<string>();
    const emitMutex = (a: MilpVariable, b: MilpVariable) => {
      const ia = varIndex.get(a)!;
      const ib = varIndex.get(b)!;
      const lo = Math.min(ia, ib);
      const hi = Math.max(ia, ib);
      const key = `${lo}:${hi}`;
      if (emittedMutexPairs.has(key)) return;
      emittedMutexPairs.add(key);
      rows.push(` r${rowId++}: v${lo} + v${hi} <= 1`);
    };
    const groupsByResource = (
      keyOf: (v: MilpVariable) => string | null,
    ): Map<string, MilpVariable[]> => {
      const groups = new Map<string, MilpVariable[]>();
      for (const v of vars) {
        const key = keyOf(v);
        if (key == null) continue;
        let group = groups.get(key);
        if (!group) {
          group = [];
          groups.set(key, group);
        }
        group.push(v);
      }
      return groups;
    };
    const pairwiseMutexWithinGroup = (group: MilpVariable[]): void => {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (a.taskId === b.taskId) continue;
          if (
            intervalsOverlap(
              a.candidate.startMs,
              a.candidate.endMs,
              b.candidate.startMs,
              b.candidate.endMs,
            )
          ) {
            emitMutex(a, b);
          }
        }
      }
    };
    for (const group of groupsByResource((v) => v.candidate.personId).values()) {
      pairwiseMutexWithinGroup(group);
    }
    for (const group of groupsByResource((v) => v.candidate.deviceId).values()) {
      pairwiseMutexWithinGroup(group);
    }

    // 行 D：工位窗口容量（K=1 → 成对互斥；K>1 → 大 M 线性化 Σ 重叠 ≤ K + |O|·(1−x[c])）。
    // R2-SCH-005：工位分组索引（替代每变量全量 vars.filter 扫描；语义不变）。
    const stationCapacityById = new Map<string, number | null>();
    for (const s of snapshot.stations) stationCapacityById.set(s.id, s.capacity ?? null);
    const varsByStation = groupsByResource((v) => v.candidate.stationId);
    for (const v of vars) {
      const stationId = v.candidate.stationId;
      if (!stationId) continue;
      const capacity = stationCapacityById.get(stationId);
      if (capacity == null || capacity < 0) continue;
      const overlapping = (varsByStation.get(stationId) ?? []).filter(
        (o) =>
          intervalsOverlap(v.candidate.startMs, v.candidate.endMs, o.candidate.startMs, o.candidate.endMs),
      );
      const idx = varIndex.get(v);
      if (capacity === 1) {
        // 成对互斥（已由行 B/C 覆盖 person/device；工位独占需显式）。
        for (const o of overlapping) {
          const oIdx = varIndex.get(o);
          if (oIdx !== undefined && oIdx > idx!) {
            rows.push(` r${rowId++}: v${idx} + v${oIdx} <= 1`);
          }
        }
      } else {
        // Σ_{o∈O(v)} v[o] ≤ K + |O(v)|·(1 − v[idx]) ⇔ Σ v[o] + |O(v)|·v[idx] ≤ K + |O(v)|。
        const sumTerms = overlapping.map((o) => `v${varIndex.get(o)}`).join(' + ');
        const rhs = fmt(capacity + overlapping.length);
        rows.push(
          ` r${rowId++}: ${sumTerms} + ${overlapping.length} v${idx} <= ${rhs}`,
        );
      }
    }

    // 行 E：DAG 闭包（Σx[b] ≤ Σx[a]，边 a→b；前置不在快照且未终态 → 视为不可分配，
    // 与 rule-based 同语义：后继显式封锁，§31）。
    for (const e of entries) {
      for (const predId of e.task.predecessorIds ?? []) {
        if (doneTaskIds.has(predId)) continue; // 前置已终态 → 不约束
        const predVars = varsByTask.get(predId) ?? [];
        const succVars = varsByTask.get(e.task.id) ?? [];
        if (succVars.length === 0) continue;
        const lhs = succVars.map((v) => `v${varIndex.get(v)}`).join(' + ');
        if (predVars.length === 0) {
          // 前置无可行候选/不在快照 → 后继不得分配（显式封锁）。
          rows.push(` r${rowId++}: ${lhs} <= 0`);
          continue;
        }
        const rhs = predVars.map((v) => `v${varIndex.get(v)}`).join(' + ');
        rows.push(` r${rowId++}: ${lhs} - ${rhs} <= 0`);
      }
    }

    // 行 F：DAG 时序冲突对（c_a.endMs > c_b.startMs → 互斥）。
    for (const e of entries) {
      for (const predId of e.task.predecessorIds ?? []) {
        if (doneTaskIds.has(predId)) continue;
        const predVars = varsByTask.get(predId) ?? [];
        const succVars = varsByTask.get(e.task.id) ?? [];
        for (const pv of predVars) {
          for (const sv of succVars) {
            if (pv.candidate.endMs > sv.candidate.startMs) {
              rows.push(
                ` r${rowId++}: v${varIndex.get(pv)} + v${varIndex.get(sv)} <= 1`,
              );
            }
          }
        }
      }
    }

    if (rows.length > 0) {
      lines.push('Subject To');
      // 逐个 push（同上：大规模实例的 rows 数十万行，spread 必爆参数栈）
      for (const row of rows) lines.push(row);
    }
    lines.push('Bounds');
    for (const v of vars) {
      lines.push(` 0 <= v${varIndex.get(v)} <= 1`);
    }
    lines.push('General');
    const generalLine = vars.map((v) => `v${varIndex.get(v)}`).join(' ');
    lines.push(` ${generalLine}`);
    lines.push('End');
    return lines.join('\n');
  }

  /** 违例构造（ADR-058 决策 1：原因三分，§33 不伪造）。 */
  private buildViolation(
    entry: PoolEntry,
    assignedByTask: Map<string, CandidateEvaluation>,
    snapshot: WorldStateSnapshot,
  ): Record<string, unknown> {
    if (entry.eligible.length === 0) {
      return {
        type: 'UNASSIGNED_MILP',
        taskId: entry.task.id,
        reason: 'no_eligible_candidate',
        rejectReasons: entry.rejected
          .slice(0, REJECTED_HARD_CAP)
          .flatMap((c) => c.rejectReasons),
        // NO-15c：能力细节与规则求解器同源（方案解释不因求解器而不同）
        capabilityNotes: [
          ...new Set(entry.rejected.slice(0, REJECTED_HARD_CAP).flatMap((c) => c.capabilityNotes ?? [])),
        ].slice(0, REJECTED_HARD_CAP),
      };
    }
    const unassignedPreds = (entry.task.predecessorIds ?? []).filter(
      (p) => !snapshot.tasks.some((t) => t.id === p && TaskLifecycle.isTerminal(t.status)) &&
        !assignedByTask.has(p),
    );
    if (unassignedPreds.length > 0) {
      return {
        type: 'UNASSIGNED_MILP',
        taskId: entry.task.id,
        reason: 'predecessor_unassigned',
        predecessorIds: unassignedPreds,
      };
    }
    return {
      type: 'UNASSIGNED_MILP',
      taskId: entry.task.id,
      reason: 'no_feasible_assignment_milp',
      eligibleCandidateCount: entry.eligible.length,
    };
  }

  private buildAssignment(
    task: WorldStateSnapshot['tasks'][number],
    chosen: CandidateEvaluation,
    policy: SchedulingPolicy,
    opts: SolveOptions,
    entry: PoolEntry,
  ): SchedulingAssignment {
    const candidates: DecisionTrace['candidates'] = entry.eligible
      .slice(0, 12)
      .map((c) => ({
        personId: c.personId,
        deviceId: c.deviceId,
        stationId: c.stationId,
        score: Number.isFinite(c.scoreBreakdown.total) ? c.scoreBreakdown.total : null,
        reasons: [],
      }));
    const rejectedHard: NonNullable<DecisionTrace['rejectedHard']> = entry.rejected
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
      selectedReason: ['milp:exact-optimal'],
      rejectedAlternatives: [],
      policyVersion: policy.version,
      solverVersion: MILP_SOLVER_VERSION,
      snapshotVersion: opts.snapshotVersion,
      rejectedHard,
      hardConstraints: ['skill-match', 'certification-valid', 'capacity', 'safety', 'eligibility', 'milp-joint-feasibility'],
      weightsSnapshot: { ...policy.weights },
    };
    return {
      assignmentId: `ASG-MILP-${opts.planId}-${task.id}`,
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
      reasons: ['milp:exact-optimal'],
      alternatives: [],
      scoreBreakdown: chosen.scoreBreakdown,
      decisionTrace,
    };
  }

  private buildPlan(input: {
    snapshot: WorldStateSnapshot;
    constraints: SchedulingConstraint[];
    policy: SchedulingPolicy;
    opts: SolveOptions;
    config: Awaited<ReturnType<SchedulingPolicyService['getConfig']>>;
    horizonMinutes: number;
    now: number;
    assignments: SchedulingAssignment[];
    violations: Array<Record<string, unknown>>;
  }): SchedulingPlanV2 {
    const evaluated = this.objectiveEvaluator.evaluate({
      snapshot: input.snapshot,
      assignments: input.assignments,
      policy: input.policy,
      constraints: input.constraints,
      baseline: input.opts.baselineAssignee,
      churn: input.config.churn,
      horizonMinutes: input.horizonMinutes,
      nowMs: input.now,
    });
    return {
      planId: input.opts.planId,
      planName: input.opts.planName,
      version: 1,
      status: 'shadow',
      trigger: { type: input.opts.triggerType, entityId: input.opts.triggerEntityId },
      snapshotVersion: input.opts.snapshotVersion,
      policyVersion: input.policy.version,
      solverVersion: MILP_SOLVER_VERSION,
      solverStatus: 'OPTIMAL',
      objective: evaluated.objective,
      scoreBreakdown: evaluated.scoreBreakdown,
      solveDurationMs: Math.max(Date.now() - input.now, 0),
      horizonMinutes: input.horizonMinutes,
      assignments: input.assignments,
      metrics: evaluated.metrics,
      baselineDelta: evaluated.baselineDelta,
      violations: input.violations,
      createdAt: new Date().toISOString(),
    };
  }
}

function varsByTaskTerms(
  entry: PoolEntry,
  vars: MilpVariable[],
  varIndex: Map<MilpVariable, number>,
): number[] {
  const out: number[] = [];
  for (const v of vars) {
    if (v.taskId === entry.task.id) out.push(varIndex.get(v)!);
  }
  return out;
}
