/**
 * 拒绝/冲突原因的唯一词表与可读文案（跨服务端与前端共享）。
 *
 * 为什么需要这个模块（2026-09-11 审计）：
 *   1. **词表漏洞**：`eligibility.service.ts` 用无类型的 `string[]` 收集原因，实际产出
 *      30 个键，而 `CandidateRejectReason` 只声明了 22 个——NO-05c/NO-05d 的维护/质量
 *      封锁（person/device/station_maintenance_blocked、*_quality_blocked）、
 *      `continuous_work_exceeded`、`device_unavailable` 都在类型之外，靠
 *      `as CandidateRejectReason[]` 断言蒙混过关。类型因此会"说谎"，前端也不可能穷尽文案。
 *   2. **文案漂移**：同一个键在 5 张前端映射表里有 3 种中文（`device_data_unavailable`
 *      分别被写成"电量数据不可用""设备电量数据不可用""设备数据不可用"），还有键根本没有
 *      文案 → 现场看到的是一串英文键。
 *   3. **命名误导**：该键在两个词表里都只表示"**电量未知**"（未上报电量），叫
 *      `device_data_unavailable` 会让人以为它覆盖所有设备数据缺口。
 *
 * 设计约束：
 *   - 运行时数组 + 类型派生：`CandidateRejectReason` 由 `CANDIDATE_REJECT_REASONS`
 *     推导，`REJECT_REASON_LABELS` 是 `Record<CandidateRejectReason, string>`——
 *     **新增原因而不补文案会直接编译失败**；
 *   - 未知键不静默：`rejectReasonLabel` 对未登记键返回"未登记原因（key）"，
 *     既不假装懂它，也不把裸键当文案丢给现场；
 *   - 历史数据可读：重命名过的旧键经 `LEGACY_REASON_LABELS` 给出与现键一致的含义
 *     （库里已有的冲突行/方案仍要能显示中文）。
 */
import type {
  SchedulingConflictType,
  SchedulingHardConstraintType,
  SchedulingSoftConstraintType,
  SchedulingTrigger,
} from './scheduler';

/**
 * 候选拒绝原因（eligibility + 候选引擎实际可能产出的全部键）。
 *
 * 分组只是为了可读性；顺序即"排查优先级"的默认展示顺序（人员 → 设备 → 工位 → 全局）。
 */
export const CANDIDATE_REJECT_REASONS = [
  // --- 人员 ---
  'missing_skill',
  'missing_certification',
  'cert_expired',
  'person_unavailable',
  'health_blocked',
  'person_maintenance_blocked',
  'person_quality_blocked',
  'continuous_work_exceeded',
  // --- 设备 ---
  'device_offline',
  'device_unavailable',
  'battery_low',
  'battery_unknown',
  'missing_device_capability',
  'capability_disabled',
  'device_reserved',
  'device_maintenance_blocked',
  'device_quality_blocked',
  /** NO-34a：设备正在进行外骨骼会话（已绑定佩戴人员）——物理上在被使用。 */
  'device_in_active_session',
  // --- 工位 ---
  'not_in_candidate_stations',
  'station_capability_mismatch',
  'station_capacity_exceeded',
  'station_reserved',
  'station_maintenance_blocked',
  'station_quality_blocked',
  // --- 全局/时空/数据可信 ---
  'time_conflict',
  'zone_forbidden',
  'predecessor_pending',
  'safety_blocked',
  'route_infeasible',
  'must_finish_by_violation',
  'stale_data',
  'derived_data_fail_closed',
] as const;

export type CandidateRejectReason = (typeof CANDIDATE_REJECT_REASONS)[number];

/**
 * 共享文案片段：同一含义在候选拒绝原因与冲突类型两个词表里必须**逐字一致**
 * （2026-09-11：`battery_unknown` 曾同时存在两种中文，解析器按顺序取值造成
 * "同一键两种说法"）。这里以常量复用，并由单测锁定跨词表一致性。
 */
const SHARED_LABELS = {
  personUnavailable: '人员不可用',
  deviceOffline: '设备离线',
  batteryLow: '电量低于下限',
  batteryUnknown: '电量未知（未上报，不派工）',
  forbiddenZone: '禁入区',
  safetyBlocked: '安全规则封锁',
  predecessorPending: '前置任务未完成',
  stationCapacityExceeded: '工位容量已满',
  routeBlocked: '无可行路径',
  staleData: '数据已过期（不可据此派工）',
} as const;

/** 候选拒绝原因 → 现场可读文案（`Record` 保证穷尽，新增键不补文案即编译失败）。 */
export const REJECT_REASON_LABELS: Record<CandidateRejectReason, string> = {
  missing_skill: '缺少技能',
  missing_certification: '缺少证书',
  cert_expired: '证书过期',
  person_unavailable: SHARED_LABELS.personUnavailable,
  health_blocked: '健康状态不允许作业',
  person_maintenance_blocked: '人员维护/维修中（需人工解除）',
  person_quality_blocked: '人员质量问题未闭环',
  continuous_work_exceeded: '连续负荷超限',
  device_offline: SHARED_LABELS.deviceOffline,
  device_unavailable: '设备故障/维护中',
  battery_low: SHARED_LABELS.batteryLow,
  battery_unknown: SHARED_LABELS.batteryUnknown,
  missing_device_capability: '缺少设备能力（设备未声明该能力）',
  capability_disabled: '所需能力已被人工停用（需复核停用决定或恢复）',
  device_reserved: '设备已被预占',
  device_maintenance_blocked: '设备维护中（需人工解除）',
  device_quality_blocked: '设备质量问题未闭环',
  device_in_active_session: '设备正在外骨骼会话中（已绑定佩戴人员）',
  not_in_candidate_stations: '不在候选工位内',
  station_capability_mismatch: '工位能力不足',
  station_capacity_exceeded: SHARED_LABELS.stationCapacityExceeded,
  station_reserved: '工位已被预占',
  station_maintenance_blocked: '工位维护中（需人工解除）',
  station_quality_blocked: '工位质量问题未闭环',
  time_conflict: '时间窗冲突',
  zone_forbidden: SHARED_LABELS.forbiddenZone,
  predecessor_pending: SHARED_LABELS.predecessorPending,
  safety_blocked: SHARED_LABELS.safetyBlocked,
  route_infeasible: SHARED_LABELS.routeBlocked,
  must_finish_by_violation: '将超出硬截止',
  stale_data: SHARED_LABELS.staleData,
  derived_data_fail_closed: '派生数据不可信',
};

/** 决策痕迹里的硬约束类型 → 可读文案（穷尽 `SchedulingHardConstraintType`）。 */
export const HARD_CONSTRAINT_LABELS: Record<SchedulingHardConstraintType, string> = {
  REQUIRED_SKILL: '缺少技能',
  REQUIRED_CERTIFICATION: '缺少证书',
  PERSON_AVAILABLE: '人员不可用',
  DEVICE_AVAILABLE: '设备不可用',
  RESOURCE_TIME_WINDOW: '时间窗冲突',
  NO_DOUBLE_BOOKING: '重复占用',
  PREDECESSOR: '前置未完成',
  FORBIDDEN_ZONE: '禁入区',
  MIN_BATTERY: '电量不足或未知',
  MAX_WORKLOAD: '负荷超限',
  SAFETY_BLOCK: '安全封锁',
  LOCKED_PERSON: '人员锁定',
  LOCKED_DEVICE: '设备锁定',
  LOCKED_STATION: '工位锁定',
  LOCKED_TIME: '时间锁定',
  LOCKED_ASSIGNMENT: '分配锁定',
  EXCLUDED_RESOURCE: '资源已排除',
  STATION_CAPABILITY: '工位能力不足',
  STATION_CAPACITY: '工位容量已满',
};

/** 软约束/成本项 → 可读文案（穷尽 `SchedulingSoftConstraintType`）。 */
export const SOFT_CONSTRAINT_LABELS: Record<SchedulingSoftConstraintType, string> = {
  MIN_TRAVEL_TIME: '行走时间',
  BALANCE_WORKLOAD: '负荷均衡',
  MIN_CHANGE: '变更最小化',
  MIN_WAIT: '等待最小化',
  PREFER_SAME_TEAM: '同班组偏好',
  PREFER_NEARBY_RESOURCE: '就近资源偏好',
  // 与硬约束词表同义（同一含义只能有一种说法）
  EXCLUDED_RESOURCE: HARD_CONSTRAINT_LABELS.EXCLUDED_RESOURCE,
  PREFERRED_RESOURCE: '优先资源',
  MANUAL_BOOST: '人工加权',
  SETUP_COST: '换型准备成本',
  CHANGEOVER_COST: '换产成本',
  STATION_QUEUE_BALANCE: '工位队列均衡',
  PRODUCTION_IMPACT_PREFERENCE: '生产影响偏好',
  FATIGUE_BALANCE: '疲劳均衡',
};

/** 冲突类型 → 可读文案（穷尽 `SchedulingConflictType`）。 */
export const CONFLICT_TYPE_LABELS: Record<SchedulingConflictType, string> = {
  double_booking: '资源重复预占',
  resource_stale: SHARED_LABELS.staleData,
  person_unavailable: SHARED_LABELS.personUnavailable,
  device_offline: SHARED_LABELS.deviceOffline,
  low_battery: SHARED_LABELS.batteryLow,
  battery_unknown: SHARED_LABELS.batteryUnknown,
  predecessor_violation: SHARED_LABELS.predecessorPending,
  station_capacity: SHARED_LABELS.stationCapacityExceeded,
  forbidden_zone: SHARED_LABELS.forbiddenZone,
  safety_block: SHARED_LABELS.safetyBlocked,
  blocked_route: SHARED_LABELS.routeBlocked,
  stale_plan: '方案已过期',
  reservation_conflict: '预占资源不可用',
  reservation_expiring: '预占即将过期',
  /** NO-58b：感知融合门控不允许强建议（提示层，不阻断调度）。 */
  perception_inconsistent: '感知融合不可信',
};

/** 调度触发/影响类型 → 可读文案（穷尽 `SchedulingTrigger`；`CHURN` 见下）。 */
export const SCHEDULING_TRIGGER_LABELS: Record<SchedulingTrigger, string> = {
  MANUAL: '手动触发',
  TASK_CREATED: '任务创建',
  TASK_UPDATED: '任务更新',
  PERSON_UNAVAILABLE: SHARED_LABELS.personUnavailable,
  DEVICE_OFFLINE: SHARED_LABELS.deviceOffline,
  DEVICE_LOW_BATTERY: SHARED_LABELS.batteryLow,
  BOTTLENECK_DETECTED: '瓶颈检测',
  DEADLINE_AT_RISK: '交期风险',
  SAFETY_EVENT: '安全事件',
  ZONE_RESTRICTED: '区域受限',
  ROUTE_BLOCKED: '路线阻断',
  ROUTE_CONGESTED: '路线拥塞',
  RESERVATION_CONFLICT: '资源预占冲突',
};

/**
 * 触发码表的扩展码（`SchedulingTrigger` 之外、由重排/影响分析实际产出的码）。
 * 单独放一张表：它们不是调度触发枚举的成员，但必须可读（否则现场看到裸英文码）。
 */
export const EXTRA_TRIGGER_LABELS: Record<string, string> = {
  /** 重排器用于表达"分配搅动最小化"的伪触发码。 */
  CHURN: '分配搅动最小化',
  /** 影响分析的类型（impact-analyzer `ImpactType`）。 */
  RESOURCE_OFFLINE: SHARED_LABELS.deviceOffline,
  PLAN_STALE: REJECT_REASON_LABELS.stale_data,
};

/**
 * 决策痕迹 `softCosts` 的键 → 可读文案。
 *
 * 注意这是**第六个词表**：它与策略权重词表（UPPER_SNAKE，如 `MIN_TRAVEL_TIME`）
 * 不是同一套键——候选引擎实际写入的是 camelCase 成本项（`latenessMs`/`travelMs`/
 * `waitMs`/`changeCost`/`riskMs`/`energyPenalty`）。此前前端直接渲染裸键，
 * 现场看到 `软成本 · latenessMs 12.00`。
 */
export const TRACE_SOFT_COST_LABELS: Record<string, string> = {
  latenessMs: '迟到',
  travelMs: '行走',
  waitMs: '等待',
  changeCost: '变更',
  riskMs: '风险',
  energyPenalty: '能耗罚',
};

/**
 * 求解器违反项的类型码 → 可读文案。
 *
 * 这些码由三套求解器写入 `plan.violations[].type/kind`（大小写混用是既有事实：
 * 规则/MILP 用 UPPER_SNAKE，启发式用 snake），现场此前看到的是
 * `违反约束 · UNASSIGNED_RULE_BASED：no_eligible_candidate` 这样的英文串。
 */
export const VIOLATION_TYPE_LABELS: Record<string, string> = {
  UNASSIGNED_RULE_BASED: '无法派工（规则求解器）',
  UNASSIGNED_MILP: '无法派工（MILP 求解器）',
  UNSUPPORTED_CONSTRAINT: '约束不受支持（未生效）',
  unsupported_constraint: '约束不受支持（未生效）',
  infeasible: '无可行解',
  PREDECESSOR_CYCLE: '前置依赖成环',
  predecessor_cycle: '前置依赖成环',
  violation: '约束违反',
};

/** 求解器违反项的原因码 → 可读文案（`violations[].reason`）。 */
export const VIOLATION_REASON_LABELS: Record<string, string> = {
  no_eligible_candidate: '没有合格候选资源（逐条原因见下）',
  no_feasible_assignment_milp: '没有可行分配（MILP 判定）',
  eligibility_matrix_build_failed: '资格矩阵构建失败（内部错误，需排查）',
  predecessor_unassigned: '前置任务本身未能派工',
  predecessor_pending: REJECT_REASON_LABELS.predecessor_pending,
  predecessor_cycle: '前置依赖成环',
  UNSUPPORTED_CONSTRAINT: '约束类型不受支持',
  mustFinishByViolated: '将超出硬截止',
};

/**
 * 历史键 → 文案（仅用于**读旧数据**）。
 *
 * 旧库里的冲突行/方案痕迹可能带这些键；它们与新键含义一致，因此给出同样的中文，
 * 而不是让历史数据退化成"未登记原因"。
 */
export const LEGACY_REASON_LABELS: Record<string, string> = {
  // 2026-09-11 重命名：device_data_unavailable 只表示"电量未上报"，改名 battery_unknown。
  device_data_unavailable: CONFLICT_TYPE_LABELS.battery_unknown,
  // 早期前端映射表里出现过的等价写法（同一含义的不同键名）。
  low_battery: SHARED_LABELS.batteryLow,
  unavailable: REJECT_REASON_LABELS.person_unavailable,
  reservation_conflict: CONFLICT_TYPE_LABELS.reservation_conflict,
  coords_unknown: '坐标未知（无法计算路径）',
};

/**
 * 统一解析拒绝/冲突原因的可读文案。
 *
 * 顺序：候选拒绝原因 → 冲突类型 → 硬约束类型 → 历史键 → **未登记原因（key）**。
 * 未知键必须显式暴露（原则 7：缺失/不可信信息不得被静默伪装），
 * 同时保留原始 key 供排查与后续登记。
 */
export function rejectReasonLabel(reason: string): string {
  const key = reason.trim();
  if (key.length === 0) return '未提供原因';
  if (Object.prototype.hasOwnProperty.call(REJECT_REASON_LABELS, key)) {
    return REJECT_REASON_LABELS[key as CandidateRejectReason];
  }
  if (Object.prototype.hasOwnProperty.call(CONFLICT_TYPE_LABELS, key)) {
    return CONFLICT_TYPE_LABELS[key as SchedulingConflictType];
  }
  if (Object.prototype.hasOwnProperty.call(HARD_CONSTRAINT_LABELS, key)) {
    return HARD_CONSTRAINT_LABELS[key as SchedulingHardConstraintType];
  }
  if (Object.prototype.hasOwnProperty.call(SCHEDULING_TRIGGER_LABELS, key)) {
    return SCHEDULING_TRIGGER_LABELS[key as SchedulingTrigger];
  }
  if (Object.prototype.hasOwnProperty.call(EXTRA_TRIGGER_LABELS, key)) {
    return EXTRA_TRIGGER_LABELS[key];
  }
  if (Object.prototype.hasOwnProperty.call(TRACE_SOFT_COST_LABELS, key)) {
    return TRACE_SOFT_COST_LABELS[key];
  }
  if (Object.prototype.hasOwnProperty.call(SOFT_CONSTRAINT_LABELS, key)) {
    return SOFT_CONSTRAINT_LABELS[key as SchedulingSoftConstraintType];
  }
  if (Object.prototype.hasOwnProperty.call(VIOLATION_TYPE_LABELS, key)) {
    return VIOLATION_TYPE_LABELS[key];
  }
  if (Object.prototype.hasOwnProperty.call(VIOLATION_REASON_LABELS, key)) {
    return VIOLATION_REASON_LABELS[key];
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_REASON_LABELS, key)) {
    return LEGACY_REASON_LABELS[key];
  }
  // 未登记键分两类，处理方式不同（2026-09-11 实测：把自由文本也套上"未登记原因"
  // 会让"负荷均衡：选中 P-Li"这种**已经可读**的原因看起来像故障）：
  //   · 码型（ASCII 标识符/带实体后缀，无空格）→ 显式标注未登记 + 保留原码；
  //   · 自由文本（含空格/中文/标点）→ 原样展示（它本身就是给人读的说明）。
  return isCodeLikeReason(key) ? `未登记原因（${key}）` : key;
}

/** 码型原因（`snake_code` / `UPPER_CODE` / `CODE:entity`）；自由文本不算码。 */
export function isCodeLikeReason(reason: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(reason);
}

/** 软约束/成本项键的可读文案（成本段展示用）。 */
export function softConstraintLabel(key: string): string {
  return rejectReasonLabel(key);
}

/** 调度触发/影响码的可读文案（重排解释链用）。 */
export function schedulingTriggerLabel(code: string): string {
  return rejectReasonLabel(code);
}

/** 冲突类型的可读文案（列表/详情用；未知类型同样显式暴露）。 */
export function conflictTypeLabel(type: string): string {
  return rejectReasonLabel(type);
}

/** 该键是否为已登记原因（未知键需要显式标记，例如列表里加"待登记"角标）。 */
export function isRegisteredReason(reason: string): boolean {
  const key = reason.trim();
  return (
    Object.prototype.hasOwnProperty.call(REJECT_REASON_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(CONFLICT_TYPE_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(HARD_CONSTRAINT_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(SCHEDULING_TRIGGER_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(EXTRA_TRIGGER_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(TRACE_SOFT_COST_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(SOFT_CONSTRAINT_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(VIOLATION_TYPE_LABELS, key) ||
    Object.prototype.hasOwnProperty.call(VIOLATION_REASON_LABELS, key)
  );
}
