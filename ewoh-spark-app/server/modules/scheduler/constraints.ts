/* 调度约束类型系统
 *
 * 核心目标：API 接受的任何约束要么被求解器真实执行，要么被显式报告为
 * UNSUPPORTED_CONSTRAINT，绝不静默忽略。
 *
 * 本模块为纯常量 + 纯函数模块（非 NestJS Service），供约束检查与
 * 启发式求解器共同使用。
 */

import {
  SchedulingConstraint,
  SchedulingHardConstraintType,
  SchedulingSoftConstraintType,
} from '@shared/api.interface';

/** 启发式求解器真实执行的硬约束集合（T03/P1-3：+STATION_CAPABILITY/+STATION_CAPACITY/重分类 EXCLUDED_RESOURCE）。 */
export const SUPPORTED_HARD_CONSTRAINTS: readonly SchedulingHardConstraintType[] = [
  'REQUIRED_SKILL',
  'REQUIRED_CERTIFICATION',
  'PERSON_AVAILABLE',
  'DEVICE_AVAILABLE',
  'RESOURCE_TIME_WINDOW',
  'NO_DOUBLE_BOOKING',
  'PREDECESSOR',
  'FORBIDDEN_ZONE',
  'MIN_BATTERY',
  'MAX_WORKLOAD',
  'SAFETY_BLOCK',
  'LOCKED_PERSON',
  'LOCKED_DEVICE',
  'LOCKED_STATION',
  'LOCKED_TIME',
  'LOCKED_ASSIGNMENT',
  // T03 / P1-3（需求 #7 对齐）：
  // EXCLUDED_RESOURCE 由 soft 重分类为 hard——求解器以 isExcludedResource 硬过滤实现。
  'EXCLUDED_RESOURCE',
  // 工位能力：task.requiredStationCapabilities ⊆ station.capabilities（eligibility 检查）。
  'STATION_CAPABILITY',
  // 工位容量：station 同时段任务数 ≤ capacity（eligibility/候选层硬校验）。
  'STATION_CAPACITY',
];

/** 求解器应用的软约束集合（T03/P1-3：去掉 EXCLUDED_RESOURCE（重分类 hard），+5 新软类型）。 */
export const SUPPORTED_SOFT_CONSTRAINTS: readonly SchedulingSoftConstraintType[] = [
  'MIN_TRAVEL_TIME',
  'BALANCE_WORKLOAD',
  'MIN_CHANGE',
  'MIN_WAIT',
  'PREFER_SAME_TEAM',
  'PREFER_NEARBY_RESOURCE',
  'PREFERRED_RESOURCE',
  'MANUAL_BOOST',
  // T03 / P1-3（需求 #7 软目标对齐；映射 policy.weights）：
  'SETUP_COST',
  'CHANGEOVER_COST',
  'STATION_QUEUE_BALANCE',
  'PRODUCTION_IMPACT_PREFERENCE',
  'FATIGUE_BALANCE',
];

/**
 * 硬约束的**执行档位**（V357，`CSTR-01` 的"声明与实现对齐"那一半）。
 *
 * 为什么写成 `Record<SchedulingHardConstraintType, …>` 而不是又一个数组：数组会和类型联合各抄一份、
 * 谁都能漏抄一条（`SUPPORTED_HARD_CONSTRAINTS` 自称"真实执行"却没人核对三个消费面，就是这么来的）。
 * 映射类型让编译器替你点名额——**类型联合加了成员而这里没归类，`type:check:server` 直接不过**。
 *
 * 两档的准确含义（不要读成"这一档没用"）：
 *  - `solver-consumed`：求解器读这条约束**实例自带的参数**并据此改变解；
 *  - `dimension-only`：该维度在解里确实是被保证的（候选层按资源数据过滤，或求解器构造上不会同时段重复占用），
 *    但**实例自带的参数无人读**（`constraint-loader.service.ts:156-161` 只取 personId/deviceId/stationId/
 *    zoneId/startMs/endMs 那几个键）。
 *
 * `dimension-only` **故意不进 `violations`**：`solver.service.ts:338-342` 的 `feasible` 判据是
 * "assignment 数量达标 **且 violations 为空**"，把这两档记成违规会让本来可行的方案凭空不可行——
 * 那是行为变更，不是报告修正。V357 因此只动"报什么"（决策追踪不再按注册表恒报 19 类），不动"怎么解"。
 */
export type HardConstraintEnforcement = 'solver-consumed' | 'dimension-only';

export const HARD_CONSTRAINT_ENFORCEMENT: Record<
  SchedulingHardConstraintType,
  HardConstraintEnforcement
> = {
  // —— 实例参数被求解器读取（heuristic 本地 switch 有 case 的九类；CP-SAT 侧是那九类的子集）——
  LOCKED_PERSON: 'solver-consumed',
  LOCKED_DEVICE: 'solver-consumed',
  LOCKED_STATION: 'solver-consumed',
  LOCKED_TIME: 'solver-consumed',
  LOCKED_ASSIGNMENT: 'solver-consumed',
  FORBIDDEN_ZONE: 'solver-consumed',
  EXCLUDED_RESOURCE: 'solver-consumed',
  MIN_BATTERY: 'solver-consumed',
  MAX_WORKLOAD: 'solver-consumed',
  // —— 维度被数据侧/构造保证，但实例自带的参数无人读 ——
  REQUIRED_SKILL: 'dimension-only', // 执行取的是 task.requiredSkills × person.skills（快照侧）
  REQUIRED_CERTIFICATION: 'dimension-only',
  PERSON_AVAILABLE: 'dimension-only',
  DEVICE_AVAILABLE: 'dimension-only',
  RESOURCE_TIME_WINDOW: 'dimension-only', // 候选层读的是快照里的资源窗口，不是这条约束的 startMs/endMs
  NO_DOUBLE_BOOKING: 'dimension-only', // 构造性保证：同一资源同时段只排一件事
  PREDECESSOR: 'dimension-only', // 编译层有 case，但只产命名/解释，不参与求解决策
  SAFETY_BLOCK: 'dimension-only', // 走的是 safetyBlocked* 两份列表（数据侧）
  STATION_CAPABILITY: 'dimension-only', // 执行取的是 task.requiredStationCapabilities × station.capabilities
  STATION_CAPACITY: 'dimension-only',
};

/** 求解器真正按实例参数执行的硬约束类型（`HARD_CONSTRAINT_ENFORCEMENT` 的第一档）。 */
export const SOLVER_CONSUMED_HARD_CONSTRAINTS: readonly SchedulingHardConstraintType[] =
  (Object.keys(HARD_CONSTRAINT_ENFORCEMENT) as SchedulingHardConstraintType[]).filter(
    (k) => HARD_CONSTRAINT_ENFORCEMENT[k] === 'solver-consumed',
  );

/** 维度成立、但实例参数无人读的硬约束类型（第二档）。 */
export const DIMENSION_ONLY_HARD_CONSTRAINTS: readonly SchedulingHardConstraintType[] =
  (Object.keys(HARD_CONSTRAINT_ENFORCEMENT) as SchedulingHardConstraintType[]).filter(
    (k) => HARD_CONSTRAINT_ENFORCEMENT[k] === 'dimension-only',
  );

/**
 * 把一批约束按执行档位分堆（纯函数，决策追踪与常驻用例共用）。
 * 软约束类型不在硬约束表里，直接跳过——本函数只回答"这一批硬约束里，哪些真的按实例参数执行了"。
 * 未知类型走不到这里：`checkConstraintSupported` 已在求解前把它记成 `unsupported_constraint` 违规。
 */
export function classifyHardConstraints(constraints: readonly SchedulingConstraint[]): {
  consumed: SchedulingHardConstraintType[];
  dimensionOnly: SchedulingHardConstraintType[];
} {
  const seen = new Set(constraints.map((c) => c.type as SchedulingHardConstraintType));
  const consumed: SchedulingHardConstraintType[] = [];
  const dimensionOnly: SchedulingHardConstraintType[] = [];
  for (const t of [...seen].sort()) {
    if (HARD_CONSTRAINT_ENFORCEMENT[t] === 'solver-consumed') consumed.push(t);
    else if (HARD_CONSTRAINT_ENFORCEMENT[t] === 'dimension-only') dimensionOnly.push(t);
  }
  return { consumed, dimensionOnly };
}


/** 约束支持性检查结果。 */
export interface ConstraintSupportResult {
  constraint: SchedulingConstraint;
  supported: boolean;
  reason?: 'UNSUPPORTED_CONSTRAINT' | 'OK';
}

/** 硬约束类型集合（用于 O(1) 判定）。 */
const SUPPORTED_HARD_SET: ReadonlySet<SchedulingHardConstraintType> = new Set(
  SUPPORTED_HARD_CONSTRAINTS,
);

/** 软约束类型集合（用于 O(1) 判定）。 */
const SUPPORTED_SOFT_SET: ReadonlySet<SchedulingSoftConstraintType> = new Set(
  SUPPORTED_SOFT_CONSTRAINTS,
);

/**
 * R2-SCH-010（2026-08-17）：按类型判定软约束（持久化反序列化 hard 标记的
 * 权威来源——软类型集合内的约束 hard=false，不再一律 hard:true）。
 */
export function isSoftConstraintType(type: string): boolean {
  return SUPPORTED_SOFT_SET.has(type as SchedulingSoftConstraintType);
}

/**
 * 检查单个约束是否被求解器支持。
 * 硬约束命中 SUPPORTED_HARD_CONSTRAINTS、软约束命中 SUPPORTED_SOFT_CONSTRAINTS
 * 即视为支持；否则返回 supported=false 且 reason='UNSUPPORTED_CONSTRAINT'。
 */
export function checkConstraintSupported(
  constraint: SchedulingConstraint,
): ConstraintSupportResult {
  const { type } = constraint;
  const supported =
    SUPPORTED_HARD_SET.has(type as SchedulingHardConstraintType) ||
    SUPPORTED_SOFT_SET.has(type as SchedulingSoftConstraintType);

  return {
    constraint,
    supported,
    reason: supported ? 'OK' : 'UNSUPPORTED_CONSTRAINT',
  };
}

/**
 * 将每个约束映射到其支持性检查结果，仅返回不支持的约束。
 * 用于在求解前一次性识别所有无法被执行、必须显式拒绝的约束。
 */
export function determineUnsupported(
  constraints: SchedulingConstraint[],
): ConstraintSupportResult[] {
  return constraints
    .map((constraint) => checkConstraintSupported(constraint))
    .filter((result) => !result.supported);
}

/**
 * 在给定任务集合上，利用 predecessorOf 探测前置依赖环。
 * 使用 DFS + visiting 集合（灰/黑两态）找环。
 * 若存在环，返回环路径（任务 ID 数组，首尾相同）；否则返回 null。
 */
export function detectDependencyCycle(
  taskIds: string[],
  predecessorOf: (taskId: string) => string[],
): string[] | null {
  // 白=未访问，灰=访问中（当前 DFS 栈）、黑=已完成。
  const white = new Set(taskIds);
  const gray = new Set<string>();
  const black = new Set<string>();

  const dfs = (node: string, path: string[]): string[] | null => {
    gray.add(node);
    white.delete(node);
    path.push(node);

    for (const pred of predecessorOf(node)) {
      if (!white.has(pred) && !gray.has(pred) && !black.has(pred)) {
        // 前置任务不在给定集合内，忽略（仅检测集合内部环）。
        continue;
      }
      if (gray.has(pred)) {
        // 找到环：从 pred 到 node 的路径段即环。
        const start = path.indexOf(pred);
        return [...path.slice(start), pred];
      }
      if (white.has(pred)) {
        const cycle = dfs(pred, path);
        if (cycle) {
          return cycle;
        }
      }
    }

    path.pop();
    gray.delete(node);
    black.add(node);
    return null;
  };

  for (const taskId of taskIds) {
    if (white.has(taskId)) {
      const cycle = dfs(taskId, []);
      if (cycle) {
        return cycle;
      }
    }
  }

  return null;
}

/**
 * R2-SCH-003（2026-08-17）：求解器共享约束编译 IR。
 *
 * 将输入 SchedulingConstraint[] 拆解为求解器可执行的锁定/排除/偏好/禁入区/
 * 电量·负荷覆盖结构（与 heuristic 内联 switch 同语义），供 rule-based / MILP /
 * heuristic（engine 路径）统一消费——消除"静默忽略输入约束"。
 * 不支持的约束显式返回 unsupported 列表（调用方须写入 violations，绝不静默失效）。
 */
export interface CompiledConstraintOverrides {
  lockedPersonByTask: Map<string, string>;
  lockedDeviceByTask: Map<string, string>;
  lockedStationByTask: Map<string, string>;
  lockedTimeByTask: Map<string, [number, number]>;
  forbiddenZoneIds: string[];
  excludedPersonByTask: Map<string, Set<string>>;
  excludedDeviceByTask: Map<string, Set<string>>;
  excludedStationByTask: Map<string, Set<string>>;
  excludedPersonGlobal: Set<string>;
  excludedDeviceGlobal: Set<string>;
  excludedStationGlobal: Set<string>;
  preferredPersonByTask: Map<string, Set<string>>;
  preferredDeviceByTask: Map<string, Set<string>>;
  preferredStationByTask: Map<string, Set<string>>;
  preferredPersonGlobal: Set<string>;
  preferredDeviceGlobal: Set<string>;
  preferredStationGlobal: Set<string>;
  minBatteryOverride: number | null;
  maxLoadOverride: number | null;
  manualBoostTasks: Set<string>;
  /** 支持性检查未通过的约束（调用方必须显式上报，绝不静默忽略）。 */
  unsupported: SchedulingConstraint[];
}

/** R2-SCH-003：编译输入约束为求解器可执行 IR（纯函数，无副作用）。 */
export function compileConstraintOverrides(
  constraints: SchedulingConstraint[],
): CompiledConstraintOverrides {
  const ir: CompiledConstraintOverrides = {
    lockedPersonByTask: new Map(),
    lockedDeviceByTask: new Map(),
    lockedStationByTask: new Map(),
    lockedTimeByTask: new Map(),
    forbiddenZoneIds: [],
    excludedPersonByTask: new Map(),
    excludedDeviceByTask: new Map(),
    excludedStationByTask: new Map(),
    excludedPersonGlobal: new Set(),
    excludedDeviceGlobal: new Set(),
    excludedStationGlobal: new Set(),
    preferredPersonByTask: new Map(),
    preferredDeviceByTask: new Map(),
    preferredStationByTask: new Map(),
    preferredPersonGlobal: new Set(),
    preferredDeviceGlobal: new Set(),
    preferredStationGlobal: new Set(),
    minBatteryOverride: null,
    maxLoadOverride: null,
    manualBoostTasks: new Set(),
    unsupported: [],
  };
  const forbiddenSet = new Set<string>();
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
      ir.unsupported.push(c);
      continue;
    }
    switch (c.type) {
      case 'LOCKED_PERSON':
        if (c.taskId && c.personId) ir.lockedPersonByTask.set(c.taskId, c.personId);
        break;
      case 'LOCKED_DEVICE':
        if (c.taskId && c.deviceId) ir.lockedDeviceByTask.set(c.taskId, c.deviceId);
        break;
      case 'LOCKED_STATION':
        if (c.taskId && c.stationId) ir.lockedStationByTask.set(c.taskId, c.stationId);
        break;
      case 'LOCKED_TIME':
        if (c.taskId && c.startMs != null && c.endMs != null)
          ir.lockedTimeByTask.set(c.taskId, [c.startMs, c.endMs]);
        break;
      case 'LOCKED_ASSIGNMENT':
        if (c.taskId) {
          if (c.personId) ir.lockedPersonByTask.set(c.taskId, c.personId);
          if (c.deviceId) ir.lockedDeviceByTask.set(c.taskId, c.deviceId);
          if (c.stationId) ir.lockedStationByTask.set(c.taskId, c.stationId);
        }
        break;
      case 'FORBIDDEN_ZONE':
        if (c.zoneId) forbiddenSet.add(c.zoneId);
        break;
      case 'MIN_BATTERY':
        if (c.value != null) ir.minBatteryOverride = c.value;
        break;
      case 'MAX_WORKLOAD':
        if (c.value != null) ir.maxLoadOverride = c.value;
        break;
      case 'EXCLUDED_RESOURCE':
        if (c.personId)
          addPerTask(ir.excludedPersonByTask, ir.excludedPersonGlobal, c.taskId, c.personId);
        if (c.deviceId)
          addPerTask(ir.excludedDeviceByTask, ir.excludedDeviceGlobal, c.taskId, c.deviceId);
        if (c.stationId)
          addPerTask(ir.excludedStationByTask, ir.excludedStationGlobal, c.taskId, c.stationId);
        break;
      case 'PREFERRED_RESOURCE':
        if (c.personId)
          addPerTask(ir.preferredPersonByTask, ir.preferredPersonGlobal, c.taskId, c.personId);
        if (c.deviceId)
          addPerTask(ir.preferredDeviceByTask, ir.preferredDeviceGlobal, c.taskId, c.deviceId);
        if (c.stationId)
          addPerTask(ir.preferredStationByTask, ir.preferredStationGlobal, c.taskId, c.stationId);
        break;
      default:
        break;
    }
    if (c.type === 'MANUAL_BOOST' && c.taskId) {
      ir.manualBoostTasks.add(c.taskId);
    }
  }
  ir.forbiddenZoneIds = Array.from(forbiddenSet);
  return ir;
}