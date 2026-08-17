/* 前后端共享契约 - Scheduler 域（P2-SHARED-001 渐进拆分第一步）。
 *
 * 从 api.interface.ts 物理移出 Scheduler 域类型（调度请求/方案/求解器/资源状态/
 * 路由/冲突/策略等）。api.interface.ts 通过 `export * from './scheduler'`
 * 保持向后兼容；新代码可 `import ... from '@shared/scheduler'`。
 * 本文件类型自包含，不依赖 api.interface 其他域。
 * ADR-007：ResourceState.status 收敛为 Canonical Resource 契约枚举
 * （import type 自 './resource'，无运行时依赖）。
 */

import type { ResourceStatus } from './resource';
import type { MaintenanceConditionProjection } from './maintenance';
import type { QualityFindingProjection } from './quality';
import type { DecisionRecord } from './decision';

export type ScheduleStrategy =
  | 'keep_status'
  | 'capacity_priority'
  | 'load_balance';

// ============================================================================
// Command Map 增量（Phase 0 / P0-3，05 §6）：坐标类型统一
// ============================================================================

/** 坐标类型（P0-3：FACTORY_CARTESIAN / WGS84 / UNKNOWN，禁止混用与 0,0 冒泡）。 */
export type CoordinateType = 'FACTORY_CARTESIAN' | 'WGS84' | 'UNKNOWN';

/** 坐标判别联合（向后兼容保留 ResourceState.location.x/y 别名）。 */
export type CoordinateReference =
  | { type: 'FACTORY_CARTESIAN'; x: number; y: number; floorId: string | null }
  | { type: 'WGS84'; lat: number; lng: number }
  | { type: 'UNKNOWN' };

export type SchedulePlanStatus =
  | 'shadow'
  | 'proposed'
  | 'confirmed'
  | 'rejected';

export interface SchedulePlan {
  id: string;
  planId: string;
  planName: string;
  strategy: ScheduleStrategy | string;
  status: SchedulePlanStatus | string;
  taktImprovement: number;
  highLoadPersons: number;
  lowBatteryRisk: number;
  affectedPersons: number;
  metricsJson: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  confirmReason: string | null;
}

export interface ScheduleAudit {
  id: string;
  auditId: string;
  planId: string;
  action: string;
  operator: string | null;
  reason: string | null;
  createdAt: string | null;
}

export interface ScheduleWeights {
  w1_output: number;
  w2_on_time: number;
  w3_safety_risk: number;
  w4_body_load: number;
  w5_move_distance: number;
  w6_changeover_cost: number;
}

export type PlanStatus =
  | 'draft'
  | 'shadow'
  | 'approved'
  | 'dispatched'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'superseded';

export type AssignmentStatus =
  | 'proposed'
  | 'approved'
  | 'dispatched'
  | 'acknowledged'
  | 'executing'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'cancelled';

export type SchedulingTrigger =
  | 'MANUAL'
  | 'TASK_CREATED'
  | 'TASK_UPDATED'
  | 'PERSON_UNAVAILABLE'
  | 'DEVICE_OFFLINE'
  | 'DEVICE_LOW_BATTERY'
  | 'BOTTLENECK_DETECTED'
  | 'DEADLINE_AT_RISK'
  | 'SAFETY_EVENT'
  | 'ZONE_RESTRICTED'
  | 'ROUTE_BLOCKED'
  | 'ROUTE_CONGESTED'
  | 'RESERVATION_CONFLICT';

export type SchedulingHardConstraintType =
  | 'REQUIRED_SKILL'
  | 'REQUIRED_CERTIFICATION'
  | 'PERSON_AVAILABLE'
  | 'DEVICE_AVAILABLE'
  | 'RESOURCE_TIME_WINDOW'
  | 'NO_DOUBLE_BOOKING'
  | 'PREDECESSOR'
  | 'FORBIDDEN_ZONE'
  | 'MIN_BATTERY'
  | 'MAX_WORKLOAD'
  | 'SAFETY_BLOCK'
  | 'LOCKED_PERSON'
  | 'LOCKED_DEVICE'
  | 'LOCKED_STATION'
  | 'LOCKED_TIME'
  | 'LOCKED_ASSIGNMENT'
  // --- Command Map 增量（Phase 1 / P1-3，05 §6；仅新增成员，旧成员不动） ---
  /** 工位能力：task.requiredStationCapabilities ⊆ station.capabilities。 */
  | 'STATION_CAPABILITY'
  /** 工位容量：station 同时段任务数 ≤ capacity。 */
  | 'STATION_CAPACITY'
  /** EXCLUDED_RESOURCE 重分类为 hard（实现集为准；soft 联合保留以兼容旧调用方）。 */
  | 'EXCLUDED_RESOURCE';

export type SchedulingSoftConstraintType =
  | 'MIN_TRAVEL_TIME'
  | 'BALANCE_WORKLOAD'
  | 'MIN_CHANGE'
  | 'MIN_WAIT'
  | 'PREFER_SAME_TEAM'
  | 'PREFER_NEARBY_RESOURCE'
  | 'EXCLUDED_RESOURCE'
  | 'PREFERRED_RESOURCE'
  | 'MANUAL_BOOST'
  // --- Command Map 增量（Phase 1 / P1-3，05 §6；仅新增成员，旧成员不动） ---
  /** 换型准备成本（映射 policy.weights.station）。 */
  | 'SETUP_COST'
  /** 换产成本（映射 policy.weights.change）。 */
  | 'CHANGEOVER_COST'
  /** 工位队列均衡（映射 policy.weights.station）。 */
  | 'STATION_QUEUE_BALANCE'
  /** 生产影响偏好（映射 productionImpact 因子）。 */
  | 'PRODUCTION_IMPACT_PREFERENCE'
  /** 疲劳均衡（映射 policy.weights.workload）。 */
  | 'FATIGUE_BALANCE';

export interface SchedulingConstraint {
  id?: string;
  type: SchedulingHardConstraintType | SchedulingSoftConstraintType;
  taskId?: string;
  personId?: string;
  deviceId?: string;
  stationId?: string;
  zoneId?: string;
  teamId?: string;
  /** 时间窗/锁定时间（epoch ms）。 */
  startMs?: number;
  endMs?: number;
  /** LOCKED_TIME / MIN_BATTERY 等参数。 */
  value?: number;
  hard?: boolean;
  /** 约束操作者（人工干预来源）。 */
  operator?: string;
  /** 人工干预原因。 */
  reason?: string;
  /** 生效起始时间（epoch ms），为空表示立即生效。 */
  validFrom?: number;
  /** 失效时间（epoch ms），为空表示持续生效。 */
  expiresAt?: number;
  /** 关联方案的快照版本（人工 override 时继承自被覆盖方案）。 */
  snapshotVersion?: string;
  // --- Command Map 增量（Phase 0 / P0-2，05 §4/§6；真实列，向后兼容） ---
  /** 生效起始（真实列 valid_from_ms，epoch ms；null=立即生效）。 */
  validFromMs?: number | null;
  /** 失效时间（真实列 expires_at_ms，epoch ms；求解前过滤依据）。 */
  expiresAtMs?: number | null;
  /** 租户隔离（真实列 org_id；null=全局约束）。 */
  orgId?: string | null;
  /** 约束来源：manual / system / auto（审计区分 operator/system context）。 */
  source?: 'manual' | 'system' | 'auto' | string | null;
  /** 软删除时间（真实列 deactivated_at，ISO）。 */
  deactivatedAt?: string | null;
  /** 软删除操作人（真实列 deactivated_by）。 */
  deactivatedBy?: string | null;
}

// ============================================================================
// Command Map 增量（Phase 1 / P1-1）：统一约束 IR（归一化/审计表示）
// ============================================================================

/** 约束作用域（IR 归一化资源维度）。 */
export type ConstraintScope =
  | 'person'
  | 'device'
  | 'station'
  | 'task'
  | 'zone'
  | 'global';

/**
 * 统一约束 IR 的 type。
 * - 显式约束：SchedulingHardConstraintType | SchedulingSoftConstraintType；
 * - 派生截止约束（由任务/世界状态推导，非用户显式约束）：'MUST_FINISH_BY' / 'DUE'。
 *   这两个派生伪类型不进入 SchedulingConstraint 联合（不改变任何契约/OpenAPI/DB 语义）。
 */
export type SchedulingConstraintIRType =
  | SchedulingHardConstraintType
  | SchedulingSoftConstraintType
  | 'MUST_FINISH_BY'
  | 'DUE';

/**
 * 归一化约束参数（关键字段显式声明 + 索引签名向后兼容）。
 * IR 无独立 taskId/personId/deviceId/stationId/zoneId 字段，资源标识统一放入 params。
 */
export interface ConstraintParams {
  /** REQUIRED_SKILL：ALL=全部必需 / ANY=任一即可（缺省 ALL）。 */
  skillMatchMode?: 'ALL' | 'ANY';
  requiredSkills?: string[];
  requiredCertifications?: string[];
  requiredDeviceCapabilities?: string[];
  requiredStationCapabilities?: string[];
  candidateStations?: string[];
  /** 硬性最晚完成时间（epoch ms；违反则任务不可分配）。 */
  mustFinishByMs?: number;
  /** 软截止（epoch ms；超时仅 lateness 罚）。 */
  dueMs?: number;
  /** 前置任务 id 列表。 */
  predIds?: string[];
  /** 工位容量（同时段任务数上限）。 */
  capacity?: number;
  [key: string]: unknown;
}

/**
 * 统一约束 IR（约束语义单一事实源；纯归一化/审计表示，不参与求解决策）。
 * hardness 由 SUPPORTED_HARD_CONSTRAINTS / SUPPORTED_SOFT_CONSTRAINTS 唯一确定
 * （EXCLUDED_RESOURCE 重分类为 HARD）。
 */
export interface SchedulingConstraintIR {
  id?: string;
  type: SchedulingConstraintIRType;
  hardness: 'HARD' | 'SOFT';
  scope: ConstraintScope;
  params: Record<string, unknown>;
  /** 仅 SOFT 使用（如 due 软约束的 lateness 罚）。 */
  penalty?: number;
  /** derived=从任务/世界状态推导（非用户显式约束）。 */
  source: 'manual' | 'system' | 'auto' | 'derived';
  /** 与 eligibility 的 reason key 对齐；软约束用类型名小写蛇形。 */
  reasonCode: string;
}

export type PlanOverrideKind =
  | 'LOCK_PERSON'
  | 'LOCK_DEVICE'
  | 'LOCK_STATION'
  | 'LOCK_TIME'
  | 'LOCK_ASSIGNMENT'
  | 'EXCLUDE_RESOURCE'
  | 'PREFER_RESOURCE'
  | 'BOOST'
  | 'ADJUST_TIME'
  /** Phase 3 / P3-T4：更换分配资源（person/device/station）→ LOCKED_ASSIGNMENT 约束。 */
  | 'CHANGE_RESOURCE';

export interface PlanOverrideAction {
  kind: PlanOverrideKind;
  taskId: string;
  personId?: string;
  deviceId?: string;
  stationId?: string;
  zoneId?: string;
  /** ADJUST_TIME / LOCK_TIME 的调整后时间窗（epoch ms）。 */
  startMs?: number;
  endMs?: number;
  /**
   * CHANGE_RESOURCE 的目标资源（Phase 3 / P3-T4）。
   * 与 personId/deviceId/stationId 并存（兼容旧调用方）；actionsToConstraints 优先读本字段。
   */
  changeResource?: { personId?: string; deviceId?: string; stationId?: string };
  reason?: string;
  validFrom?: number;
  expiresAt?: number;
}

export interface PlanOverrideRequest {
  actions: PlanOverrideAction[];
  operator?: string;
  reason?: string;
  // --- Phase 1 / P1-E（人工干预版本 CAS，§九；可选，缺省=现状向后兼容） ---
  /** 期望的目标方案 version；提供且与当前不一致 → STALE_PLAN（409，不自动应用）。 */
  expectedPlanVersion?: number;
  /** 期望的目标方案 snapshotVersion；提供且与当前不一致 → STALE_SNAPSHOT（409，不自动应用）。 */
  expectedSnapshotVersion?: string;
}

export interface PlanOverrideDiffSummary {
  /** 分配发生变化（换人或换时机）的任务 id。 */
  changedTaskIds: string[];
  /** 新方案新增分配的任务 id。 */
  addedTaskIds: string[];
  /** 新方案移除分配的任务 id。 */
  removedTaskIds: string[];
  /** 指标增量（after - before）。 */
  metricsDelta: {
    lateMinutes: number;
    walkingMeters: number;
    stationWaitMinutes: number;
    maxWorkload: number;
    changeCost: number;
  };
}

export interface PlanOverrideResponse {
  /** 覆盖后新方案 id（＝重排产出的新方案）。 */
  planId: string;
  operator: string;
  reason?: string;
  /** 已转换为 SchedulingConstraint 并落库的约束。 */
  appliedConstraints: SchedulingConstraint[];
  before: SchedulingPlanV2;
  after: SchedulingPlanV2;
  diff: PlanOverrideDiffSummary;
  /** T04 / P1-8：指向候选 preview id（可选；纯计算预览不持久化）。 */
  preview?: string | null;
}

export type SolverStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'HEURISTIC'
  | 'FALLBACK'
  | 'INFEASIBLE'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  // NO-13d / ADR-053：rule-based 求解器（策略显式选择的确定性地板；
  // 如实标记，绝不冒充 heuristic/CP-SAT）。
  | 'RULE_BASED';

export interface SolverRequest {
  requestId: string;
  snapshotVersion: string;
  policyVersion: number;
  solverVersion: string;
  horizonMinutes: number;
  nowMs: number;
  /**
   * 确定性 replay 种子（NEST-035，2026-08-17）：policy replay 持久化记录的
   * seed 透传（缺省 undefined = 非确定性请求）。Worker 端消费以复现同一结果；
   * 不识别该字段的旧 Worker 安全忽略（可选字段）。
   */
  seed?: number;
  /** 目标权重（来自版本化 SchedulingPolicy）。 */
  weights: {
    lateness: number;
    travel: number;
    workloadBalance: number;
    stationWait: number;
    changeCost: number;
    risk: number;
    energyRisk: number;
    churn: number;
  };
  tasks: Array<{
    taskId: string;
    priority: number;
    earliestStartMs: number;
    dueMs: number | null;
    durationMs: number;
    requiredSkills: string[];
    requiredCertifications: string[];
    requiredDeviceCapabilities: string[];
    candidateStationIds: string[];
    zoneId: string | null;
    predecessorIds: string[];
    safetyCritical: boolean;
    preemptible: boolean;
    /** 技能匹配语义：ALL=全部必需，ANY=任一即可。缺省 ALL。 */
    skillMatchMode?: 'ALL' | 'ANY';
    /** 统一优先级引擎产出的有效优先级分（越小越紧急），供 CP-SAT 与 heuristic 一致消费。 */
    effectivePriorityScore?: number;
    /**
     * P0-3：硬性最晚完成时间（epoch ms；null=无硬截止）。与 dueMs（软 lateness）
     * 分离：dueMs 超时仅罚 lateness；mustFinishByMs 违反则任务不可分配（unassigned）。
     */
    mustFinishByMs?: number | null;
    eligiblePersonIds?: string[];
    eligibleDeviceIds?: string[];
    /**
     * R2-SCH-004（2026-08-17）：任务状态透传（供 worker/审计判定；可选字段，
     * 旧 Worker 安全忽略）。请求侧已过滤为可调度任务。
     */
    status?: string | null;
  }>;
  persons: Array<{
    id: string;
    status: string;
    locationStationId: string | null;
    /** 坐标 UNKNOWN 时显式 null（禁止 0,0 伪坐标；此类人员已被资格矩阵排除出候选）。 */
    x: number | null;
    y: number | null;
    skills: string[];
    certifications: string[];
    workload: number;
    fatigue: number;
    availableFromMs: number | null;
    executingTaskIds?: string[];
  }>;
  devices: Array<{
    id: string;
    status: string;
    online: boolean;
    capabilities: string[];
    batteryPct: number;
    x: number | null;
    y: number | null;
    availableFromMs: number | null;
    executingTaskIds?: string[];
  }>;
  stations: Array<{
    id: string;
    /** 坐标 UNKNOWN 时显式 null（禁止 0,0 伪坐标）。 */
    x: number | null;
    y: number | null;
    capacity: number | null;
    executingTaskIds?: string[];
  }>;
  /** 安全硬约束：这些 person/device 在本次求解中完全不可指派（fail-closed，Worker 硬过滤）。 */
  safetyBlockedPersonIds?: string[];
  safetyBlockedDeviceIds?: string[];
  reservations: Array<{
    resourceId: string;
    resourceType: string;
    startMs: number;
    endMs: number;
  }>;
  forbiddenZones: string[];
  /** 原始约束透传（hard/soft 统一序列化），供 CP-SAT Worker 消费相同语义。 */
  constraints?: Array<Record<string, unknown>>;
  /**
   * P0-4：权威 RouteCost 矩阵（Task×候选 的 distanceMeters/etaSeconds，由
   * TravelCostService 矩阵层计算后透传）。Worker 只消费本矩阵参与 travel 目标，
   * 禁止在 worker 内用坐标算欧氏距离（坐标可能 UNKNOWN）。
   */
  candidateCosts?: Array<{
    taskId: string;
    personId: string;
    stationId: string | null;
    distanceMeters: number;
    etaSeconds: number;
    dataQuality: string;
    fallbackReason?: string | null;
  }>;
  /** 冻结（executing/locked）的 assignment：求解器不可移动。 */
  frozenAssignments: Array<{
    taskId: string;
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
    startMs: number;
    endMs: number;
  }>;
  /** 基线分配（taskId → personId），用于 churn/stability penalty。 */
  baselineAssignee: Record<string, string | null>;
  /** 求解时间上限（ms）。 */
  timeLimitMs: number;
}

export interface SolverResponse {
  solverVersion: string;
  solverStatus: SolverStatus;
  solveDurationMs: number;
  objective: number;
  objectiveBreakdown: Record<string, number>;
  hardViolations: Array<Record<string, unknown>>;
  optimalityGap: number | null;
  unassignedTaskIds: string[];
  assignments: Array<{
    taskId: string;
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
    startMs: number;
    endMs: number;
    reasons: string[];
    rejectedAlternatives: Array<Record<string, unknown>>;
  }>;
}

export interface ScoreBreakdown {
  lateness: number;
  travel: number;
  workloadBalance: number;
  stationWait: number;
  changeCost: number;
  risk: number;
  energyCost: number;
  total: number;
}

export interface ResourceState {
  id: string;
  /** ADR-008：规范身份引用（person:/device:/station:<id>），与 id 并存。 */
  entityId?: string;
  type: 'person' | 'device' | 'station' | 'tool' | 'material' | 'vehicle';
  /** ADR-007：锁定为 Canonical Resource 契约六态 + UNKNOWN。 */
  status: ResourceStatus;
  capabilities: string[];
  certifications: string[];
  location: { stationId: string | null; zoneId: string | null; x: number | null; y: number | null };
  availableWindows: Array<{ startMs: number; endMs: number }>;
  reservations: Array<{ reservationId: string; startMs: number; endMs: number }>;
  telemetry: {
    batteryPct: number | null;
    loadLevel: number | null;
    fatigueLevel: number | null;
    healthStatus: string | null;
  };
  /** 数据来源时间戳（epoch ms）。 */
  sourceTs?: number | null;
  /** 数据新鲜度阈值（ms），超过则标 STALE。 */
  freshnessMs?: number | null;
  /** 数据质量：FRESH / STALE / UNKNOWN。 */
  dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
  /**
   * 字段来源维度（与 dataQuality 新鲜度正交）：AUTHORITATIVE=真实列/权威来源；
   * DERIVED=派生/兜底来源（如设备能力来自型号白名单、safetyCritical 派生等）。
   * safety-critical 候选评估对该维度 fail-close（derived_data_fail_closed）。
   */
  source?: 'AUTHORITATIVE' | 'DERIVED';
  /** 判定 dataQuality 所用的 FreshnessPolicy 版本（可审计；无则 null）。 */
  freshnessPolicyVersion?: number | null;
  /**
   * 设备维护时间窗（ewoh_device.maintenance_start_ms / maintenance_end_ms 真实列）。
   * device 专用；两列均无数据（NULL）→ 不填充/空数组（不伪造窗口，不产生约束）。
   */
  maintenanceWindows?: Array<{ startMs: number; endMs: number }>;
  /**
   * NO-05c：活跃维护状态事实（ADR-010，ewoh_maintenance_condition，status ∉
   * {resolved, closed}）。critical → status=OFFLINE，其余 → DEGRADED；资格评估对
   * 其 fail-closed 拒绝派工。无活跃条件 → null（不伪造事实）。
   */
  maintenance?: MaintenanceConditionProjection[] | null;
  /**
   * NO-05d：活跃质量发现事实（ADR-011，ewoh_quality_finding，status ∈
   * {open, under_review}，links 含本资源规范身份）。critical/high → 资格评估
   * fail-closed 拒派；medium/low 仅事实可见。质量事实不改变资源状态。
   * 无关联活跃发现 → null（不伪造事实）。
   */
  qualityFindings?: QualityFindingProjection[] | null;
  /** 当前任务 id（person/device 有背衬列时填充，无则 null，不虚构）。 */
  currentTask?: string | null;
  /** 班组（person 有 team_name 列，其余资源无则 null）。 */
  team?: string | null;
  /** 班次（person 有 shift 列，其余资源无则 null）。 */
  shift?: string | null;
  /** 最近更新时间（epoch ms）。 */
  updatedAt?: number | null;
  version: number;
  // --- 领域模型新列（Phase 1 / P1-T3，standalone_012_domain_columns） ---
  /** 人员负载 0..1（ewoh_personnel.workload 列；无则 null）。 */
  workload?: number | null;
  /** 证书到期信息（ewoh_personnel.certification_expiry 平行列，决策 D-A；无则 null）。 */
  certificationExpiry?: Array<{ name: string; expiresAtMs: number | null }> | null;
  /** 位置置信度 0..1（device 来自 location_confidence 列；person/station 无则 null）。 */
  locationConfidence?: number | null;
  /** 位置更新时间（epoch ms，device 来自 location_updated_at；无则 null）。 */
  locationUpdatedAt?: number | null;
  /** 遥测更新时间（epoch ms，device 来自 telemetry_updated_at；无则 null）。 */
  telemetryUpdatedAt?: number | null;
  /** 工位容量（station 来自 capacity 列；其余 null）。 */
  capacity?: number | null;
  /** 工位队列（station 来自 queue 列；其余 null）。 */
  queue?: string[] | null;
  /** 派生字段标记：本投影中这些字段来自派生而非真实列。 */
  derived?: string[];
  // --- Command Map 增量（Phase 0 / P0-3）：坐标判别联合（可选，向后兼容） ---
  /** 坐标引用（FACTORY_CARTESIAN/WGS84/UNKNOWN）。旧 x/y 别名保留：笛卡尔时填充，其余 null。 */
  coordinate?: CoordinateReference;
}

// ============================================================================
// Command Map 增量（Task 3 / 3.1）：差异化资源新鲜度策略
// ============================================================================

/** 信号类型（同一资源可能有多种数据源信号）。 */
export type FreshnessSignalType =
  | 'location'
  | 'telemetry'
  | 'status'
  | 'reservation'
  | 'master'
  | string;

/**
 * 资源新鲜度策略：按 resourceType + signalType 差异化阈值（ms）。
 * STALE/UNKNOWN 的资源绝不被视为 AVAILABLE（fail-closed）。
 */
export interface FreshnessPolicy {
  /** 策略版本（可审计，参与 dataQuality 追溯）。 */
  policyVersion: number;
  /** key = `${resourceType}:${signalType}` → 超过该时长的 sourceTs 视为 STALE。 */
  thresholdsMs: Record<string, number>;
  /** 默认阈值（ms），未在 thresholdsMs 中命中时使用。 */
  defaultThresholdMs: number;
}

/**
 * 事件影响范围（P0-2）：事件对调度对象的影响 scope。
 * 供 PriorityEngine 只消费与任务相关的开放事件，避免无关事件无差别影响所有任务。
 */
export interface SchedulingEventImpact {
  eventId: string;
  severity: string;
  status: string;
  /** 直接受影响的任务 id（证据链 affectedTaskIds 或显式解析）。 */
  affectedTaskIds: string[];
  affectedPersonIds: string[];
  affectedDeviceIds: string[];
  affectedStationIds: string[];
  affectedZoneIds: string[];
}

// ============================================================================
// Incremental Replan V2 / M01：ReplanImpact 领域模型（08 §1）
// ============================================================================

/**
 * Replan V2 影响模型（08 §1）：直接命中 + 传播闭包后需重排的影响范围。
 *
 * 与既有 ImpactAnalyzer.analyze():ImpactResult 并存（向后兼容）；handleTrigger
 * 内部改消费 analyzeImpactV2()。全部字段为纯数据、可选/可空语义向后兼容，
 * 默认行为=现状（无配置时与现有 partial replan 一致）。
 *
 * 字段命名贴合既有风格：affectedTaskIds/frozenTaskIds 沿用 impact-analyzer.ts
 * （affectedTaskIds=直接受影响+下游闭包；frozen 语义沿用 FROZEN_STATUSES）。
 */
export interface ReplanImpact {
  /** 触发类型（SchedulingTrigger 或扩展字符串）。 */
  triggerType: SchedulingTrigger | string;
  /** 触发实体 id（事件/资源/route edge/zone；确定性排序）。 */
  triggerIds: string[];
  /** 直接受影响 + 传播闭包后需重排的任务（= 现有 ImpactAnalyzer.affectedTaskIds 语义超集）。 */
  affectedTaskIds: string[];
  /** 受影响资源（person/device/station 统一 id，投影层同 id 空间）。 */
  affectedResourceIds: string[];
  affectedPersonIds: string[];
  affectedDeviceIds: string[];
  affectedStationIds: string[];
  affectedZoneIds: string[];
  /** 冻结 assignment/task id（executing/dispatched/in_progress/LOCK/safety）。 */
  frozenAssignmentIds: string[];
  /** 可移动任务（= affected ∩ schedulable ∩ !frozen）。 */
  movableAssignmentIds: string[];
  /** 逐条原因（去重、确定性排序；与 triggerIds 对齐，如 'DEVICE_OFFLINE:D-1'）。 */
  reasons: string[];
  /** 影响分析所基于的世界快照。 */
  snapshotVersion: string;
  /** 当前生效方案 version（无则 null）。 */
  baselinePlanVersion: number | null;
}

/** Replan V2 风暴治理/传播上限配置（08 §3/§7；全可选，缺省=现状）。 */
export interface ReplanConfig {
  /** 触发去抖（ms），缺省 5000。 */
  replanDebounceMs?: number;
  /** 两次重排最小间隔（ms），缺省 30000（与既有 triggerCooldownMs 对齐）。 */
  minimumReplanIntervalMs?: number;
  /** 窗口内最大重排次数，缺省 12。 */
  maximumReplansPerWindow?: number;
  /** 冲突聚合窗口（ms），缺省 60000。 */
  conflictAggregationWindowMs?: number;
  /** 影响传播最大深度（仅 predecessor 闭包计深），缺省 3。 */
  maxPropagationDepth?: number;
  /** 影响传播最大任务数截断，缺省 200。 */
  maxAffectedTasks?: number;
  /** 冻结窗口（分钟）：计划开始时间落在 [now, now+freezeWindowMinutes] 的 assignment 并入冻结集（缺省 15）。 */
  freezeWindowMinutes?: number;
  /** 最低目标改进率：非 critical 且无冲突/硬约束待修复时，候选目标改进低于该比率则抑制重排（缺省 0.02）。 */
  minimumObjectiveImprovement?: number;
}

/** Replan V2 自动重排 vs 人工审批政策（08 §6；全可选，缺省=现状自动）。 */
export interface ReplanApprovalConfig {
  /** 受影响比例阈值（affected / 可调度任务数），超过需人工审批，缺省 0.5。 */
  autoMaxAffectedRatio?: number;
  /** 预期 churn 比例阈值（churnDelta/affected），超过需人工审批，缺省 0.4。 */
  autoMaxChurnRatio?: number;
  /** 候选方案相对基线改派 assignment 总数（changed+added+removed）上限；超过则需人工审批（缺省 20）。 */
  maxChangedAssignments?: number;
  /** 影响集合含 safetyCritical 任务时需人工审批，缺省 true。 */
  requireApprovalOnSafetyCritical?: boolean;
  /** 影响集合含人工 LOCK 时需人工审批，缺省 true。 */
  requireApprovalOnHumanLock?: boolean;
}

/** Churn Objective V2 权重（08 §4；全可选，缺省=现状回归）。 */
export interface ChurnConfig {
  /** 人员变更罚分，缺省 = weights.change（现状：仅 person 变更计 churn）。 */
  personChangePenalty?: number;
  /** 设备变更罚分，缺省 0。 */
  deviceChangePenalty?: number;
  /** 工位变更罚分，缺省 0。 */
  stationChangePenalty?: number;
  /** 起点位移罚分（每 1min），缺省 0。 */
  startTimeShiftPenalty?: number;
  /** 相对基线执行顺序变化罚，缺省 0。 */
  sequenceChangePenalty?: number;
  /** 移除 assignment 罚分，缺省 = weights.change。 */
  assignmentRemovalPenalty?: number;
  /** 新增 assignment 罚分，缺省 0。 */
  assignmentAdditionPenalty?: number;
}

/** Prediction Shadow Learning canary 配置（08 §11；全可选）。 */
export interface PredictionConfig {
  /** canary 采样比例阶梯（shadow 仅采样比例，生产输出仍为 baseline），缺省 [0,0.05,0.2,0.5,1]。 */
  canaryFractions?: number[];
  /** 自动回退条件（超阈值 canary 归 0，SSE prediction.rollback）。 */
  autoRollbackOn?: {
    /** 窗口 MAE 上限，缺省 0.25。 */
    maxAbsoluteError?: number;
    /** 回退率上限，缺省 0.5。 */
    maxFallbackRate?: number;
    /** 最小覆盖率，缺省 0.8。 */
    minCoverage?: number;
  };
}

/** 优先级决策可解释输出（P0-2 / Phase 5）：含 rank 与 reasonCodes[]。 */
export interface PriorityDecision {
  taskId: string;
  /** 有效优先级分（越小越紧急）。 */
  effectivePriority: number;
  /** 同快照内排序（1-based，越小越靠前）。 */
  rank: number;
  /** 触发原因码：base_priority/deadline_risk/waiting_age/production_impact/event_severity/downstream_blocking/manual_boost。 */
  reasonCodes: string[];
  /** 政策版本（可审计）。 */
  policyVersion: number;
  /** 兼容保留：旧字段名。 */
  factors: Array<{ name: string; weight: number; value: number; term: number }>;
  explanation: string[];
}

export interface WorldStateSnapshot {
  snapshotVersion: string;
  ts: string;
  /** 全局单调递增世界版本，用于可靠新鲜度判断。 */
  worldVersion: number;
  /** 各类实体的版本摘要（entityId → version）。 */
  entityVersions: Record<string, number>;
  /** ADR-008 / NO-03b：快照构建时的契约自检结果（entityVersions 键/实体规范身份引用）。 */
  contractCheck?: { valid: boolean; errors: string[] };
  /** 当前生效的 reservation 列表（资源占用）。 */
  reservations: Array<{
    reservationId: string;
    resourceId: string;
    resourceType: string;
    startMs: number;
    endMs: number;
  }>;
  /** 因安全事件被禁止作业的人员 id（可空，安全模块未启用时为空）。 */
  safetyBlockedPersonIds?: string[];
  /** 因安全事件被禁止作业/启用的设备 id（可空）。 */
  safetyBlockedDeviceIds?: string[];
  persons: Array<{
    id: string;
    /** ADR-008：规范身份引用 person:<id>（与原 id 并存，逐点收敛）。 */
    entityId?: string;
    name: string;
    status: string;
    healthStatus: string | null;
    skills: string[];
    certifications: string[];
    loadLevel: number;
    fatigueLevel: number;
    stationId: string | null;
    zoneId: string | null;
    /** 人员坐标；空间实体缺失时显式 UNKNOWN（null），禁止用 0 冒充真实坐标。 */
    x: number | null;
    y: number | null;
    /** 人员下一次可用时间（epoch ms），由 reservation 推算；无保留则 null。 */
    availableFromMs?: number | null;
    /** 班次（ewoh_personnel.shift 列；无则 null）。 */
    shift?: string | null;
    /** 当前负载 0..1（ewoh_personnel.workload 列；无则 null）。 */
    workload?: number | null;
    /** 当前任务 id（ewoh_personnel.current_task_id 列；无则 null）。 */
    currentTaskId?: string | null;
    /** 证书到期信息（ewoh_personnel.certification_expiry 平行列，决策 D-A；无则 null）。 */
    certificationExpiry?: Array<{ name: string; expiresAtMs: number | null }> | null;
    /** 数据来源时间戳（epoch ms），用于新鲜度判定。 */
    sourceTs?: number | null;
    /** 数据新鲜度阈值（ms），超过则标 STALE。 */
    freshnessMs?: number | null;
    /** 数据质量：FRESH / STALE / UNKNOWN（STALE/UNKNOWN 不被视为可用）。 */
    dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
    /** NO-12u / ADR-044：能力投影（Canonical CapabilityRecord；契约合法记录）。 */
    capabilityRecords?: import('./capability').CapabilityRecord[];
    /**
     * NO-05c：活跃维护状态事实（ADR-010；status ∉ {resolved, closed}）。
     * critical → status=OFFLINE；其余 → DEGRADED；资格评估对其 fail-closed
     * 拒绝派工。无活跃条件 → null（不伪造事实）。
     */
    maintenance?: MaintenanceConditionProjection[] | null;
    /**
     * NO-05d：活跃质量发现事实（ADR-011；status ∈ {open, under_review}，
     * links 含本资源）。critical/high → 资格评估 fail-closed 拒派；
     * medium/low 仅事实可见；不改变资源状态。无关联 → null。
     */
    qualityFindings?: QualityFindingProjection[] | null;
    // --- Command Map 增量（Phase 0 / P0-3）：坐标判别联合（可选） ---
    coordinate?: CoordinateReference;
  }>;
  tasks: Array<{    id: string;
    /** ADR-008：规范身份引用 task:<id>（与原 id 并存，逐点收敛）。 */
    entityId?: string;
    title: string;
    taskType: string;
    priority: string;
    status: string;
    assigneeId: string | null;
    deviceId: string | null;
    stationId: string | null;
    zoneId: string | null;
    planStart: string | null;
    planEnd: string | null;
    progress: number;
    predecessorIds: string[];
    requiredSkills: string[];
    requiredCertifications: string[];
    /** 设备能力需求（如 'exo-lift' / 'vacuum'），真正参与筛选。 */
    requiredDeviceCapabilities?: string[];
    /** 候选工位 id（无则默认任务 stationId）。 */
    candidateStations?: string[];
    /** 资源需求量（单位数）。 */
    resourceQuantity?: number;
    /** 安全关键任务（安全约束不得被 bypass）。缺省 false。 */
    safetyCritical?: boolean;
    /** 是否可抢占。缺省 false。 */
    preemptible?: boolean;
    /** 技能匹配语义：ALL=全部必需，ANY=任一即可。缺省 ALL。 */
    skillMatchMode?: 'ALL' | 'ANY';
    /** 截止时间（epoch ms，可由 planEnd 推算）。 */
    dueAtMs?: number | null;
    /** 生产影响度 0..1（越高越影响产线节拍，越小 score 越紧急）。缺省 0，向后兼容可选。 */
    productionImpact?: number;
    // --- 领域模型新列（Phase 1 / P1-T2，standalone_012_domain_columns） ---
    /** 基础优先级（ewoh_production_task.base_priority 列；无则 null）。 */
    basePriority?: string | null;
    /** 最早开始时间（epoch ms，earliest_start_ms 列；无则 null）。 */
    earliestStartMs?: number | null;
    /** 最晚完成时间（epoch ms，latest_finish_ms 列；无则 null）。 */
    latestFinishMs?: number | null;
    /** 下游影响度 0..1（downstream_impact 列；无则 null）。 */
    downstreamImpact?: number | null;
    /** 工位能力需求（required_station_capabilities 列）。 */
    requiredStationCapabilities?: string[];
    /** 偏好资源（preferred_resources 列）。 */
    preferredResources?: string[];
    /** 排除资源（excluded_resources 列）。 */
    excludedResources?: string[];
    /** 派生字段标记：本快照中这些字段来自派生而非真实列（如 safetyCritical/preemptible/...）。 */
    derived?: string[];
  }>;
  devices: Array<{
    id: string;
    /** ADR-008：规范身份引用 device:<id>（与原 id 并存，逐点收敛）。 */
    entityId?: string;
    workerName: string | null;
    deviceModel: string | null;
    batteryPct: number;
    online: boolean;
    status: string | null;
    /** 设备能力（如 'exo-lift' / 'vacuum'），用于 capability 匹配。 */
    capabilities?: string[];
    /** 设备位置 x（location_lat 列；缺失则显式 UNKNOWN=null，绝不借用人员坐标）。 */
    x?: number | null;
    y?: number | null;
    /** 设备所在工位 id（设备自身空间实体 parentId 解析，未知则 null）。 */
    locationStationId?: string | null;
    /** 设备可用时间窗（available_windows 列；无则空数组）。 */
    availableWindows?: Array<{ startMs: number; endMs: number }>;
    /** 位置置信度 0..1（location_confidence 列；无位置则 null）。 */
    locationConfidence?: number | null;
    /** 位置更新时间（epoch ms，location_updated_at 列；无则 null）。 */
    locationUpdatedAt?: number | null;
    /** 遥测更新时间（epoch ms，telemetry_updated_at 列；无则 null）。 */
    telemetryUpdatedAt?: number | null;
    /** 数据来源时间戳（epoch ms），用于新鲜度判定。 */
    sourceTs?: number | null;
    /** 数据新鲜度阈值（ms），超过则标 STALE。 */
    freshnessMs?: number | null;
    /** 数据质量：FRESH / STALE / UNKNOWN（STALE/UNKNOWN 不被视为可用）。 */
    dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
    /** NO-12u / ADR-044：能力投影（Canonical CapabilityRecord；契约合法记录）。 */
    capabilityRecords?: import('./capability').CapabilityRecord[];
    /** 派生字段标记（如 capabilities 来自型号白名单兜底）。 */
    derived?: string[];
    /**
     * NO-05c：活跃维护状态事实（ADR-010；status ∉ {resolved, closed}）。
     * critical → status=OFFLINE + online=false；其余 → DEGRADED；资格评估对其
     * fail-closed 拒绝派工。无活跃条件 → null（不伪造事实）。
     */
    maintenance?: MaintenanceConditionProjection[] | null;
    /**
     * NO-05d：活跃质量发现事实（ADR-011；status ∈ {open, under_review}，
     * links 含本资源）。critical/high → 资格评估 fail-closed 拒派；
     * medium/low 仅事实可见；不改变资源状态。无关联 → null。
     */
    qualityFindings?: QualityFindingProjection[] | null;
    // --- Command Map 增量（Phase 0 / P0-3）：坐标判别联合（可选） ---
    coordinate?: CoordinateReference;
  }>;
  stations: Array<{
    id: string;
    /** ADR-008：规范身份引用 station:<id>（与原 id 并存，逐点收敛）。 */
    entityId?: string;
    name: string;
    /** 坐标 UNKNOWN 时显式 null（禁止 0,0 伪坐标；无坐标工位不参与定位决策）。 */
    x: number | null;
    y: number | null;
    /** 工位容量（capacity 列，替代 extra.capacity 非正式字段）；未知则 null。 */
    capacity?: number | null;
    /** 工位队列（queue 列）。 */
    queue?: string[];
    /** 工位可用窗口（available_windows 列）。 */
    availableWindows?: Array<{ startMs: number; endMs: number }>;
    /** 工位能力（P1-3：requiredStationCapabilities 匹配；来源为空间实体 entityType 基础能力）。 */
    capabilities?: string[];
    /**
     * NO-05c：活跃维护状态事实（ADR-010；status ∉ {resolved, closed}）。
     * 工位快照无 status 字段，资格评估经 candidate-engine 的
     * stationMaintenanceBlockedById 对其 fail-closed 拒绝派工。无活跃条件 → null。
     */
    maintenance?: MaintenanceConditionProjection[] | null;
    /**
     * NO-05d：活跃质量发现事实（ADR-011；status ∈ {open, under_review}，
     * links 含本工位）。critical/high → 资格评估经 candidate-engine 的
     * stationQualityBlockedById fail-closed 拒派；medium/low 仅事实可见。
     * 无关联 → null。
     */
    qualityFindings?: QualityFindingProjection[] | null;
    /** NO-12u / ADR-044：能力投影（Canonical CapabilityRecord；契约合法记录）。 */
    capabilityRecords?: import('./capability').CapabilityRecord[];
    // --- Command Map 增量（Phase 0 / P0-3）：坐标判别联合（可选） ---
    coordinate?: CoordinateReference;
  }>;
  /** NO-12u / ADR-044：能力投影缺口显式计数（certification 缺 issuer/expiry 等）。 */
  capabilityProjectionIssues?: string[];
  backlog: Array<{ taskId: string; count: number }>;
  events: Array<{
    eventId: string;
    severity: string;
    status: string;
    eventType: string | null;
  }>;
  /** P0-2：事件影响 scope（eventId → 影响对象）。PriorityEngine 据此只消费相关事件。可选字段（向后兼容）。 */
  eventImpacts?: SchedulingEventImpact[];
  routeStatus: Array<{
    edgeId: string;
    status: string;
    riskLevel: string | null;
  }>;
  /**
   * P0-6：路由边 → 受影响任务索引（edgeId → taskIds）。
   * 由世界状态构建时从 route node.stationId ↔ task.stationId 推导（边连接的工位上的任务）。
   * 供 ROUTE_BLOCKED / ROUTE_CONGESTED 影响分析使用——edgeId 是 route graph 体系，
   * 与 zoneId（空间区域体系）是两套 ID，旧实现用 zoneId 匹配 edgeId 属错配。
   * 可选字段（向后兼容）：旧快照缺失时影响分析按"无已知受影响任务"处理（fail-safe）。
   */
  routeEdgeTaskIndex?: Record<string, string[]>;
  forbiddenZones: Array<{ zoneId: string; reason: string }>;
  lockedAssignments: Array<{
    taskId: string;
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
  }>;
}

export interface SchedulingRun {
  runId: string;
  triggerType: SchedulingTrigger | string;
  triggerEntityId: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  snapshotVersion: string | null;
  planIds: string[];
  orgId: string | null;
  error: string | null;
  /** 失败原因（ewoh_scheduling_run.failure_reason 列，替代仅日志；无则 null）。 */
  failureReason?: string | null;
  /** 运行所用求解器状态（standalone_030_solver_activation；succeeded 后回填，无则 null）。 */
  solverStatus?: string | null;
  /** 运行所用求解器回退/降级原因（无回退为 null）。 */
  fallbackReason?: string | null;
  createdAt: string;
}

// ============================================================================
// Command Map 增量（Phase 0 / P0-2）：统一调度上下文（SchedulingContext）
// ============================================================================

/**
 * 统一调度上下文（Phase 0 / P0-2）：单一 org 时间切片，版本字段真实取值，禁止伪造。
 *
 * 组装方：SchedulingContextService.getContext()（GET /api/scheduler/context）。
 * 各版本字段来源（可审计）：
 * - snapshotVersion：WorldStateSnapshot.snapshotVersion（buildSnapshot 持久化快照版本）；
 * - resourceVersion：snapshot.worldVersion 字符串化（资源投影与快照同一世界版本，
 *   无独立资源版本号——与 TravelCostService 缓存 key 的 worldVersion 代理同源）；
 * - routeGraphVersion：snapshot.worldVersion 字符串化（routeGraphVersionOf 同源，
 *   见 travel-cost.service.ts：WorldStateSnapshot 无显式 route graph 版本，以
 *   全局单调递增 worldVersion 作为路由图版本代理）；
 * - policyVersion：SchedulingPolicy.version（当前生效策略版本）；
 * - eventSequence：outbox 全局最大 sequence（latestSequence；与 SSE Last-Event-ID 同源）；
 * - sourceTimestamp：snapshot.ts。
 * 前端 Command Map 必须从本接口一次性拉取，避免不同时间切片数据组合成伪"当前状态"。
 */
export interface SchedulingContext {
  snapshotVersion: string;
  resourceVersion: string;
  routeGraphVersion: string;
  policyVersion: number;
  eventSequence: number;
  sourceTimestamp: string;
  /** 任务集合（与 world-state snapshot 同源，org 过滤）。 */
  tasks: WorldStateSnapshot['tasks'];
  /** 统一资源投影（与 GET /api/scheduler/resources/state 同源，org 过滤）。 */
  resources: ResourceState[];
  /** 活跃预占（与 world-state snapshot 同源）。 */
  reservations: WorldStateSnapshot['reservations'];
  /** 全局 active 人工约束（org + 有效期过滤）。 */
  constraints: SchedulingConstraint[];
  /** 数据质量汇总（可审计；全部来自真实统计，不伪造）。 */
  dataQuality: {
    /** dataQuality === 'STALE' 的资源数（来自资源投影）。 */
    staleResourceCount: number;
    /** 位置未知资源数（location.x/y/stationId 均为 null，来自资源投影）。 */
    unknownLocationCount: number;
    /** 状态非 open 的路由边数（congested/blocked，来自 snapshot.routeStatus）。 */
    degradedRouteCount: number;
    /** 资源总数（person + device + station）。 */
    totalResources: number;
  };
}

/** GET /api/scheduler/context 响应（与 SchedulingContext 同形，保留扩展位）。 */
export interface SchedulingContextResponse extends SchedulingContext {}

export interface SchedulingAssignment {
  assignmentId: string;
  taskId: string;
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  zoneId: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  routeId: string | null;
  /** 路线 ETA（秒），来自与地图一致的 route graph。 */
  etaSeconds?: number;
  /** 路线距离（米）。 */
  distanceMeters?: number;
  /**
   * 路径几何（P0）：route_graph 为真实 A* 折线；euclidean 为起终点两点。
   * 地图渲染与 Solver 使用同一 RouteCost 几何，禁止前端自行连直线。
   */
  routeGeometry?: Array<{ x: number; y: number }>;
  /** 路线风险摘要。 */
  riskLevel?: string | null;
  status: AssignmentStatus;
  reasons: string[];
  alternatives: Array<Record<string, unknown>>;
  /** 该 assignment 的目标评分分解（可解释）。 */
  scoreBreakdown?: ScoreBreakdown;
  /** 可解释决策轨迹：为何选中该候选，以及主要未选候选的排除原因。 */
  decisionTrace?: DecisionTrace;
}

export interface DecisionTrace {
  taskId: string;
  selected: {
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
  };
  /** 任务动态优先级信息。 */
  priority: {
    level: string;
    /** 真实优先级分；无法获得时可为 null（禁止伪造 0 冒充真实计算，P0-SCHED-002）。 */
    score: number | null;
    factors: Array<{ key: string; label: string; value: number }>;
  };
  /** 参与评分的候选（person/device 组合）。 */
  candidates: Array<{
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
    /** 候选评分；无法获得时可为 null。 */
    score: number | null;
    reasons: string[];
  }>;
  selectedReason: string[];
  /** 主要未选候选及其排除原因。 */
  rejectedAlternatives: Array<{
    personId: string | null;
    deviceId: string | null;
    stationId?: string | null;
    reason: string[];
  }>;
  policyVersion: number;
  solverVersion: string;
  snapshotVersion: string;
  // --- Command Map 增量（Phase 1 / P1-7，05 §3.12；可解释调度富化） ---
  /** 硬约束拒绝的候选（结构化原因；不进 feasible set 但可解释）。 */
  rejectedHard?: Array<{
    personId: string | null;
    deviceId: string | null;
    stationId: string | null;
    rejectReasons: string[];
  }>;
  /** 本次求解执行的硬约束集合。 */
  hardConstraints?: string[];
  /** 选中候选的软成本明细。 */
  softCosts?: Record<string, number>;
  /** 目标权重快照（确定性 replay）。 */
  weightsSnapshot?: Record<string, number>;
  /** 工位决策贡献（P1-4）。 */
  stationContribution?: {
    stationId: string | null;
    queueLength: number;
    changeover: boolean;
  };
  /** 本次求解执行的约束统一 IR（P1-1；审计/解释用，可选，向后兼容）。 */
  constraintIR?: SchedulingConstraintIR[];
}

export interface SchedulingPlanMetrics {
  lateMinutes: number;
  walkingMeters: number;
  stationWaitMinutes: number;
  maxWorkload: number;
  changeCost: number;
}

export interface SchedulingPlanV2 {
  planId: string;
  planName?: string;
  /** 方案归属租户（ADR-071；ewoh_schedule_plan.org_id；缺省=standalone_025 存量/全局过渡行）。 */
  orgId?: string;
  version: number;
  status: PlanStatus;
  trigger: { type: SchedulingTrigger | string; entityId: string | null };
  snapshotVersion: string;
  /** 求解所用策略版本（对应 SchedulingPolicy.version）。 */
  policyVersion: number;
  /** 求解器版本（对应 SchedulingPolicy.solverVersion）。 */
  solverVersion: string;
  /** 实际使用的求解器状态（CP-SAT / fallback / infeasible 等）。 */
  solverStatus?: SolverStatus;
  /** 回退/降级原因（如 worker 不可达、超时、返回非最优），供 UI 展示 HEURISTIC/FALLBACK 等。 */
  fallbackReason?: string;
  /** 求解耗时（ms）。 */
  solveDurationMs?: number;
  /** 目标函数值（求解器输出，可解释）。 */
  objective?: number;
  /** 目标函数分解（求解器输出各分量，可解释）。 */
  objectiveBreakdown?: Record<string, number>;
  horizonMinutes: number;
  assignments: SchedulingAssignment[];
  metrics: SchedulingPlanMetrics;
  /** 方案级目标评分分解（可解释）。 */
  scoreBreakdown?: ScoreBreakdown;
  /** 目标权重快照（Phase 2 / P2-T2）：persistPlan 落库实际使用的 8 权重，保证确定性 replay。 */
  weights?: ObjectiveWeights;
  // --- Command Map 增量（Phase 1 / P1-C，§六）：版本化目标 Profile（可审计/确定性 replay） ---
  /** 求解所用版本化目标 Profile id（如 ON_TIME / WORKLOAD_BALANCE / BALANCED；缺省不标注）。 */
  profileId?: string;
  /** 求解所用 Profile 版本（对应 policy version / configVersion；与 weights 一起确定性重放）。 */
  profileVersion?: number;
  // --- Command Map 增量（Phase 0 / P0-2）：计划约束快照（确定性 replay + 审计） ---
  /** 求解所用 effective constraints 快照（standalone_023 constraints_json）。 */
  constraints?: SchedulingConstraint[];
  /** constraints 稳定哈希（SHA-256；replay 校验）。 */
  effectiveConstraintsHash?: string | null;
  baselineDelta: Record<string, unknown>;
  violations: Array<Record<string, unknown>>;
  createdAt: string;
  /**
   * NO-12s / ADR-042：审批前自动布局仿真预验证结果（advisory，绝不阻断
   * 审批）。runId 确定性 = `plan-approval:${planId}`（台账幂等回读）；
   * 无多工位移动链 → skippedReason 显式留痕；仿真失败 → error 显式。
   */
  preApprovalSimulation?: {
    runId: string;
    status: string;
    totalTravelDistanceM?: number;
    routesCount?: number;
    engineVersion?: string;
    error?: string;
    skippedReason?: string;
  };
  /**
   * NO-12y / ADR-048：Canonical DecisionRecord[]（ADR-047 契约形态）——
   * persistPlan 唯一投影点产出，随方案持久化（决策历史单一事实源，§12/§18）。
   * 缺省 = 未投影（存量行/测试构造）。
   */
  decisionRecords?: DecisionRecord[];
  /**
   * NO-12y / ADR-048：决策投影显式缺口（§33 绝不静默丢弃）——
   * decision_tenant_unknown / decision_no_selected_reason /
   * decision_invalid:<errorCode> 等；空 = 无缺口。
   */
  decisionProjectionIssues?: Array<{ assignmentId: string; reason: string }>;
}

export interface SchedulingFeedbackResource {
  personId?: string | null;
  deviceId?: string | null;
  stationId?: string | null;
}

/**
 * 回填任务执行实际值请求（v0.7 D1 反馈闭环）。
 * 由任务执行方（移动端/边缘/外部系统）在任务 start / complete 时提交，
 * 调度侧按 assignmentId/planId/taskId 匹配 feedback 行回填 actual 数据。
 * 匹配语义：至少提供一个匹配键；重复回填为覆盖式更新（天然幂等）。
 */
export interface RecordActualsRequest {
  /** 派工分配 id（优先级最高匹配键）。 */
  assignmentId?: string;
  planId?: string;
  taskId?: string;
  actualStart?: string | null;
  actualEnd?: string | null;
  actualTravel?: number | null;
  actualWait?: number | null;
  actualResource?: SchedulingFeedbackResource | null;
}

export interface SchedulingFeedback {
  feedbackId: string;
  runId: string | null;
  planId: string;
  taskId: string | null;
  assignmentId: string | null;
  plannedStart: string | null;
  actualStart: string | null;
  plannedEnd: string | null;
  actualEnd: string | null;
  plannedTravel: number | null;
  actualTravel: number | null;
  plannedWait: number | null;
  actualWait: number | null;
  originalResource: SchedulingFeedbackResource | null;
  actualResource: SchedulingFeedbackResource | null;
  replanCount: number;
  conflictCount: number;
  overrideCount: number;
  solverRuntime: number | null;
  solverFallback: boolean;
  /** 审批结果：approved=true，rejected=false，未决=null。 */
  accepted: boolean | null;
  ts: string;
}

export interface SchedulingFeedbackKpis {
  totalFeedback: number;
  accepted: number;
  rejected: number;
  pendingAcceptance: number;
  /** accepted / (accepted + rejected)，无已决数据时为 0。 */
  acceptanceRate: number;
  /** overrideCount>0 的反馈行占比。 */
  overrideRate: number;
  /** solverFallback=true 的反馈行占比。 */
  fallbackRate: number;
  /** 反馈行 solver_runtime 均值（ms）。 */
  solverRuntimeMs: number;
  replanCount: number;
  conflictCount: number;
  // --- Phase 4 / P4-T1 扩展（02 文档公式；输入缺省时显式 null 标注缺数据，不伪造） ---
  /** 按时完成率：actualEnd<=plannedEnd 的行数 / 有 planned+actual end 的行数；无数据 null。 */
  onTimeRate?: number | null;
  /** 迟到均值（ms，actualEnd - plannedEnd）；无数据 null。 */
  meanLatenessMs?: number | null;
  /** 迟到 P95（ms）；无数据 null。 */
  p95LatenessMs?: number | null;
  /** 总行程时间（ms，Σ plannedTravel[etaSeconds] * 1000）；无数据 null。 */
  totalTravelMs?: number | null;
  /** 人员间任务数不均衡（max per-person 任务数 - min）；少于 2 人数据 null。 */
  workloadImbalance?: number | null;
  /** 方案 churn（Σ replanCount，重排次数代理）；无数据 null。 */
  planChurn?: number | null;
  /** 冲突率（Σ conflictCount / totalFeedback，每方案平均冲突数）；total=0 null。 */
  conflictRate?: number | null;
  /** 重排成功率（replanCount>0 且 accepted=true / replanCount>0）；无重排数据 null。 */
  replanSuccessRate?: number | null;
}

/** 求解目标 8 权重（02 §11.1：W_lateness/W_travel/W_wait/W_workload/W_station/W_change/W_risk/W_energy）。 */
export interface ObjectiveWeights {
  lateness: number;
  travel: number;
  wait: number;
  workload: number;
  station: number;
  change: number;
  risk: number;
  energy: number;
}

export interface SchedulingPolicy {
  version: number;
  latenessWeight: number;
  walkingWeight: number;
  workloadBalanceWeight: number;
  stationWaitWeight: number;
  changeCostWeight: number;
  riskWeight: number;
  energyWeight: number;
  /** 求解器版本，保证同版本可确定性重放。 */
  solverVersion: string;
  /**
   * 目标权重权威对象（Phase 2 / P2-T2）：8 项完整权重，来自 ewoh_scheduling_policy.weights_json；
   * 缺省时用默认常量（消除 buildPolicy 魔法数派生）。旧字段（latenessWeight/walkingWeight 等）
   * 保留为兼容别名，内部统一读取本字段。
   */
  weights: ObjectiveWeights;
}

/**
 * 求解器激活阶梯（Solver Activation Ladder）唯一事实源（Task A P0）。
 * - OFF（缺省）：仅 heuristic 生产（CP-SAT 不参与任何路径）；
 * - SHADOW：heuristic 生产 + CP-SAT 双跑（isShadow 标记，绝不作为生产方案返回/落库）；
 * - CANARY：按 org allowlist / 确定性哈希采样放量 CP-SAT 为生产路径（失败自动回滚采样至 0）；
 * - PRODUCTION：CP-SAT 为生产首选手（仅当 feature-status.yaml cpSat.productionEnabled=true
 *   或环境变量 EWOH_SOLVER_PRODUCTION_ENABLED=1 允许；否则 fail-closed 回退 heuristic）。
 * 解析优先级：EWOH_SOLVER_ACTIVATION 环境变量 > SchedulingPolicyConfig.cpSat.activation > 'OFF'。
 */
export type SolverActivationState = 'OFF' | 'SHADOW' | 'CANARY' | 'PRODUCTION' | 'RULE_BASED'
  // NO-13i / ADR-058：MILP（HiGHS 精确联合整数规划；策略显式选择 milp-v1，
  // 不参与 CP-SAT 激活阶梯；solverActivation 如实标记）。
  | 'MILP';

export interface SchedulingPolicyConfig {
  configVersion: number;
  /** 硬约束参数。 */
  minBatteryPct: number;
  maxContinuousLoad: number;
  defaultTaskDurationMs: number;
  horizonMinutes: number;
  /** 步行/移动默认速度（m/s），仅在无 route graph 时兜底。 */
  walkingSpeedMps: number;
  /** 路线成本系数（route graph 关闭时欧氏距离兜底的权重）。 */
  euclideanDistanceWeight: number;
  /** 拥堵/风险系数。 */
  congestedFactor: number;
  blockedFactor: number;
  highRiskFactor: number;
  mediumRiskFactor: number;
  /** 触发 cooldown（ms）。 */
  triggerCooldownMs: number;
  /** 动态优先级权重。 */
  priority: {
    deadlineRiskWeight: number;
    waitingAgeWeight: number;
    eventSeverityWeight: number;
    productionImpactWeight: number;
    downstreamBlockingWeight: number;
    manualBoostWeight: number;
    agingBaseMs: number;
  };
  /**
   * v0.7 Batch5.1：求解器目标权重（可选，缺省回退 buildPolicy 的既有默认值，
   * 保证旧配置向后兼容）。全量可配后策略调参不再需要改代码。
   *
   * Phase 2 / P2-T2 权威化：完整 8 权重对象（lateness/travel/wait/workload/station/
   * change/risk/energy）。旧配置若只含 workloadBalance/stationWait/changeCost/energy
   * 子集，缺失项以默认常量补齐（向后兼容，不再魔法数派生）。
   */
  weights?: ObjectiveWeights | {
    workloadBalance?: number;
    stationWait?: number;
    changeCost?: number;
    energy?: number;
  };
  // --- Command Map 增量（Phase 1 / P1-C，§六）：版本化目标 Profile（可选，缺省=内置 6 预设） ---
  /**
   * 版本化目标 Profile：profileId → 权重缩放（soft objective 专用，绝不改变 hard constraints）。
   * 预设：ON_TIME / PRODUCTION_IMPACT / WORKLOAD_BALANCE / TRAVEL_MIN / MIN_CHURN / BALANCED；
   * BALANCED=不缩放（缺省兜底）。solveVariants 缺省投放 A=ON_TIME、B=WORKLOAD_BALANCE、C=BALANCED。
   */
  profiles?: Record<string, { label: string; scale: Partial<ObjectiveWeights> }>;
  // --- RouteCost 三级策略（§5.4；可选，缺省 DEGRADED=现状行为，保证回归） ---
  /** 路线成本模式（§5.4 三级策略）：STRICT=route graph 不可达即候选 infeasible；DEGRADED=euclidean 显式降级+标记+惩罚（缺省）；ADVISORY=降级仅参考，safety-critical 不得自动 dispatch 降级路径。 */
  routeCostMode?: RouteCostMode;
  // --- Command Map 增量（Phase 1 / P1-4，05 §3.9/G3；可选，向后兼容） ---
  /** 人工偏好折算分值（分钟，默认 30；替代 solver 内 magic number）。 */
  preferenceBonusMinutes?: number;
  /** 换型准备时间（分钟，station/changeover 成本入评分）。 */
  setupMinutes?: number;
  /** 工位容量硬校验开关（默认 true；false 回退基线行为）。 */
  stationCapacityEnforced?: boolean;
  // --- Incremental Replan V2（08 §3/§6/§7/§11；全可选，缺省=现状） ---
  /** Replan V2 风暴治理/传播上限（08 §3/§7）。 */
  replan?: ReplanConfig;
  /** Replan V2 自动重排 vs 人工审批政策（08 §6）。 */
  replanApproval?: ReplanApprovalConfig;
  /** Churn Objective V2 权重（08 §4；缺省=现状回归）。 */
  churn?: ChurnConfig;
  /** Prediction Shadow Learning canary（08 §11）。 */
  prediction?: PredictionConfig;
  // --- CP-SAT 生产激活阶梯（Task A / P0）：OFF → SHADOW → CANARY → PRODUCTION（全可选，缺省=现状） ---
  /**
   * CP-SAT 激活阶梯配置（OFF→SHADOW→CANARY→PRODUCTION；见 docs/runtime-gates.md）。
   * 当前 feature-status.yaml cpSat.productionEnabled=false → 生产禁止 PRODUCTION 阶梯
   * （EWOH_SOLVER_ACTIVATION=PRODUCTION 时 fail-closed 回退 heuristic，fallbackReason=production_not_gated）。
   * 缺省 activation='OFF'：仅 heuristic 生产（CP-SAT 不参与任何路径）。
   */
  cpSat?: {
    /**
     * 激活阶梯唯一事实源：OFF（缺省，仅 heuristic）/ SHADOW（heuristic 生产 + CP-SAT 双跑 isShadow）/ CANARY（采样放量）/ PRODUCTION（仅 feature-status productionEnabled=true 允许）。
     */
    activation?: SolverActivationState;
    /** CANARY 采样比例 0..1（缺省 0）。 */
    canaryFraction?: number;
    /** CANARY org allowlist（可选；命中即采样）。 */
    orgAllowlist?: string[];
    shadowCompare?: boolean; // 保持兼容
  };
}

export interface SchedulingPolicyVersionSummary {
  configVersion: number;
  active: boolean;
  updatedBy: string | null;
  createdAt: string;
}

export interface SchedulingPolicyComparison {
  candidateVersion: number;
  activeVersion: number;
  /** 反馈驱动的离线 KPI 评估基础（由 SchedulingFeedback 派生）。 */
  feedbackKpis: SchedulingFeedbackKpis;
  /** 候选与生效版本的参数差异（仅含相异字段，键为 config 标量字段或 priority.* 子字段）。 */
  paramDeltas: Record<string, { active: unknown; candidate: unknown }>;
  /** 基于求解目标权重（buildPolicy）的归一化 composite objective 估计。 */
  objective: {
    active: number;
    candidate: number;
  };
  verdict: string;
  /** 恒为 true：本接口为 shadow/只读，绝不修改生产策略。 */
  readOnly: true;
  // --- Phase 4 / P4-T2：真实历史 snapshot replay 评估（无历史快照时为 null） ---
  replay?: PolicyReplayEvaluation | null;
}

/** Phase 4 / P4-T2：Shadow Policy 真实 replay 结果（历史快照 × active/candidate 双策略求解对比）。 */
export interface PolicyReplayEvaluation {
  /** 使用的历史快照版本。 */
  snapshotVersion: string;
  /** 求解器版本（确定性重放保证同版本可复现）。 */
  solverVersion: string;
  active: PolicyReplaySide;
  candidate: PolicyReplaySide;
  /** candidate.objective - active.objective（负=候选更优）。 */
  objectiveDelta: number;
  verdict: 'active_better' | 'candidate_better' | 'equivalent' | 'no_data';
}

export interface PolicyReplaySide {
  objective: number;
  assignmentCount: number;
  unassignedCount: number;
  metrics: {
    lateMinutes: number;
    walkingMeters: number;
    stationWaitMinutes: number;
    maxWorkload: number;
    changeCost: number;
  };
}

export interface SchedulingEvent {
  eventId: string;
  eventType: string;
  entityId: string;
  version: number;
  sequence: number;
  payload: Record<string, unknown>;
  sourceTs: string;
  serverTs: string;
  /** 实体类型（device / person / task / route / zone ...）。 */
  entityType?: string;
  /** 该实体在触发时的版本。 */
  entityVersion?: number;
  // --- SSE envelope 增强（Phase 3 / P3-T2，02 §7.1；兼容旧字段） ---
  /** 关联快照版本（无则 null）。 */
  snapshotVersion?: string | null;
  /** 关联方案 id（无则 null）。 */
  planId?: string | null;
  /** 业务发生时间（ISO；无则取 serverTs）。 */
  occurredAt?: string | null;
  // --- 统一 Scheduler Event Envelope（Phase 4 / P4-SSE） ---
  /** 组织隔离（orgId；无则 null/ALL）。 */
  orgId?: string | null;
  /** 全链路关联 ID（run/plan/execution/policy），与 outbox.correlation_id 同源。 */
  correlationId?: string | null;
}

export interface RouteGraphNode {
  nodeId: string;
  nodeType: string | null;
  x: number;
  y: number;
  floor: string | null;
  stationId: string | null;
  zoneId: string | null;
}

export interface RouteGraphEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceMeters: number;
  expectedTimeSeconds: number;
  direction: string | null;
  capacity: number | null;
  riskLevel: string | null;
  status: 'open' | 'congested' | 'blocked';
  accessibleFor: string[];
}

export interface RouteGraph {
  nodes: RouteGraphNode[];
  edges: RouteGraphEdge[];
}

export interface Route {
  routeId: string;
  personId: string;
  taskId: string;
  distanceMeters: number;
  etaSeconds: number;
  nodes: string[];
  geometry: Array<{ x: number; y: number }>;
  /** 路径来源：route_graph 表示真实 route graph A*；euclidean_fallback 表示欧氏兜底。 */
  source?: 'route_graph' | 'euclidean_fallback';
  /** 路径风险摘要（沿路风险等级：high/medium/low）。 */
  riskLevel?: string | null;
  /** 计算时使用的路由图版本。 */
  graphVersion?: number | null;
  /** 计算时间（ISO）。 */
  calculatedAt?: string;
  /** 是否可行（起终点坐标齐全且可通行）。 */
  feasible?: boolean;
  // --- RouteCost 明细（Phase 2 / P2-T1，02 §10） ---
  /** 回退原因（euclidean_fallback 时必填）。coords_unknown=坐标缺失；no_route_edge=图不可达；graph_unavailable=图加载失败。 */
  fallbackReason?: 'coords_unknown' | 'no_route_edge' | 'graph_unavailable' | null;
  /** 数据质量：FRESH / STALE / UNKNOWN（坐标或图新鲜度）。 */
  dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
}

/** 欧氏兜底回退原因（02 §10：Euclidean 仅显式 fallback）。 */
export type RouteCostFallbackReason =
  | 'no_route_edge'
  | 'coords_unknown'
  | 'graph_unavailable'
  | 'infeasible';

/** 路径成本数据质量（02 §13：未知/缺失字段必须显式标记）。 */
export type RouteCostDataQuality = 'FRESH' | 'STALE' | 'UNKNOWN';

/** 路线成本三级策略模式（§5.4）：STRICT=route graph 不可达即候选 infeasible；DEGRADED=euclidean 显式降级+标记+惩罚（缺省）；ADVISORY=降级仅参考，safety-critical 不得自动 dispatch 降级路径。 */
export type RouteCostMode = 'STRICT' | 'DEGRADED' | 'ADVISORY';

/** 单个候选的路径成本明细（RouteCostMatrix 条目）。 */
export interface CandidateRouteCost {
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  /** 估算耗时（秒）。 */
  etaSeconds: number;
  /** 估算距离（米）。 */
  distanceMeters: number;
  /** 拥塞系数（≥1；无拥塞明细默认 1）。 */
  congestion: number;
  /** 路径是否被 blocked 边阻断（矩阵层显式标记，读 routeStatus）。 */
  blocked: boolean;
  /** 候选/任务是否穿越禁入区（矩阵层显式标记，读 forbiddenZones）。 */
  forbiddenZone: boolean;
  /** 沿路最高风险折算。 */
  risk: number;
  /** 能量消耗（无数据为 0，不伪造）。 */
  energy: number;
  /** 成本模式：route_graph 或显式 euclidean_fallback。 */
  routeCostMode: 'route_graph' | 'euclidean_fallback';
  /** 回退原因（route_graph 时为 null；euclidean_fallback 必须带原因）。 */
  fallbackReason: RouteCostFallbackReason | null;
  /** 数据质量：FRESH / STALE / UNKNOWN（坐标/图新鲜度）。 */
  dataQuality: RouteCostDataQuality;
  /** 是否可行（坐标齐全且可通行）；false 时 eta/distance 仅供参考。 */
  feasible: boolean;
  /**
   * 路径几何（P4-GEOM）：route_graph 为真实 A* 折线；euclidean 为起终点两点。
   * 地图渲染与 Solver 使用同一 RouteCost 几何——禁止前端自行连直线。
   */
  geometry?: Array<{ x: number; y: number }>;
  /**
   * RouteCost 标识（P4-GEOM）：Task×Candidate 的唯一成本引用（deterministic）。
   * 同一 snapshot+task+person/device/station 组合的 routeCostId 稳定，供
   * Solver → Plan → Command Map 共享同一 RouteCost identity。
   */
  routeCostId?: string;
  /**
   * R2-SCH-017（2026-08-17）：路径风险等级原样透传（high/medium/low；无数据 null）。
   * 此前消费方把 risk>0 折叠为 'high'，medium 等级在方案产物中丢失。
   * 可选字段（additive），旧消费方安全忽略。
   */
  riskLevel?: string | null;
}

/** 任务 × 候选的 RouteCostMatrix（02 §10；决策 D-D 落库缓存，支撑确定性 replay）。 */
export interface RouteCostMatrix {
  matrixId: string;
  snapshotVersion: string;
  policyVersion: number;
  solverVersion: string;
  /** 路由图版本（route graph version），用于成本矩阵缓存判读。 */
  routeGraphVersion?: string | number | null;
  /** 候选集合哈希（确定性），用于区分不同候选集的矩阵。 */
  candidateSetHash?: string | null;
  taskId: string;
  candidates: CandidateRouteCost[];
  generatedAt: string;
}

export interface TaskCandidateResource {
  personId: string;
  personName: string;
  deviceId: string | null;
  stationId: string | null;
  /** 是否通过资格与路径可行性综合判定。 */
  eligible: boolean;
  /** 到任务工位的估算耗时（秒）。 */
  etaSeconds: number;
  /** 到任务工位的估算距离（米）。 */
  distanceMeters: number;
  /** 技能是否满足任务要求。 */
  skillMatch: boolean;
  /** 人员当前负荷（0-1）。 */
  workload: number;
  /** 设备电量百分比；纯手工作业（无设备）时为 null。 */
  batteryPct: number | null;
  /** 是否存在时间/设备/工位 reservation 冲突。 */
  reservationConflict: boolean;
  /** 候选评分（越小越优；不可行/不合格为 Infinity），供 UI 排序。 */
  score: number;
  /** 排除原因（来自资格判定 + 路径可行性，如 missing_skill / route_infeasible）。 */
  reasons: string[];
  // --- Command Map 增量（Phase 1 / P1-2，05 §6；可选字段，向后兼容） ---
  /** 结构化拒绝原因（与 solver 共享同一枚举；eligible=false 时非空）。 */
  rejectReasons?: CandidateRejectReason[];
  /** 候选评分分解（可解释；不可行候选为 null/全 0）。 */
  scoreBreakdown?: ScoreBreakdown | null;
  /** 工位维度候选明细（station 决策变量，P1-4）。 */
  stationOptions?: Array<{
    stationId: string;
    capacity: number | null;
    queueLength: number;
    feasible: boolean;
    reasons: string[];
  }>;
  /** 可行时间窗（epoch ms 区间）。 */
  timeWindows?: Array<{ startMs: number; endMs: number }>;
}

// ============================================================================
// Command Map 增量（Phase 1 / P1-2，05 §3.7）：Candidate Engine
// ============================================================================

/** 结构化候选拒绝原因（端点与求解器共享同一枚举）。 */
export type CandidateRejectReason =
  | 'missing_skill'
  | 'missing_certification'
  | 'cert_expired'
  | 'person_unavailable'
  | 'health_blocked'
  | 'device_offline'
  | 'battery_low'
  | 'missing_device_capability'
  | 'station_capability_mismatch'
  | 'station_capacity_exceeded'
  | 'station_reserved'
  | 'device_reserved'
  | 'time_conflict'
  | 'zone_forbidden'
  | 'predecessor_pending'
  | 'safety_blocked'
  | 'must_finish_by_violation'
  | 'route_infeasible'
  | 'not_in_candidate_stations'
  | 'stale_data'
  | 'derived_data_fail_closed';

/** 候选评估（Task×Person×Device×Station×时间窗 → hard 是否满足 + 可解释拒绝）。 */
export interface CandidateEvaluation {
  personId: string;
  deviceId: string | null;
  stationId: string | null;
  startMs: number;
  endMs: number;
  /** hard 全部满足才 true（不满足则不进 solver feasible set 但可解释）。 */
  eligible: boolean;
  /** 结构化拒绝原因（eligible=true 时为空数组）。 */
  rejectReasons: CandidateRejectReason[];
  /** 评分分解（eligible=false 时 total=Infinity）。 */
  scoreBreakdown: ScoreBreakdown;
  /** 路径成本（无可行路径为 null）。 */
  routeCost: CandidateRouteCost | null;
  /** 是否命中人工偏好资源（软加分项，P1-4）。 */
  preferred?: boolean;
  /** 是否发生工位换型（station 决策，P1-4）。 */
  changeover?: boolean;
  /** 该候选的软成本明细（可解释，P1-7）。 */
  softCosts?: Record<string, number>;
}

// ============================================================================
// Command Map 增量（Phase 1 / P1-8，05 §3.13）：Override Preview
// ============================================================================

/** Override Preview 响应（纯计算，不落库不触发正式重排）。 */
export interface OverridePreviewResponse {
  planId: string;
  readonly: true;
  /** 受影响 assignment/task id。 */
  affectedAssignments: string[];
  /** 预览引入的新冲突（conflictId/type/message）。 */
  conflictsIntroduced: Array<{ conflictId: string; type: string; message: string }>;
  /** 迟到增量（分钟，after-before）。 */
  latenessDeltaMinutes: number;
  /** 路程增量（分钟，after-before）。 */
  travelDeltaMinutes: number;
  /** 最大负荷增量（after-before）。 */
  workloadDelta: number;
  /** 工位等待增量（分钟，after-before）。 */
  stationWaitDeltaMinutes: number;
  /** 改派任务数（churn）。 */
  planChurn: number;
  /** 候选方案 id（PREVIEW-*，未持久化）。 */
  candidatePlanId: string;
}

export interface TaskCandidatesResponse {
  taskId: string;
  taskTitle: string | null;
  taskStatus: string | null;
  /** 任务已分配/锁定（仍返回候选，但标记当前受让人）。 */
  assigned: boolean;
  lockedAssigneeId: string | null;
  lockedDeviceId: string | null;
  /** 当前策略求解器版本。 */
  solverVersion: string;
  candidates: TaskCandidateResource[];
  generatedAt: string;
}

export type ConflictSeverity = 'critical' | 'high' | 'medium' | 'low';

export type SchedulingConflictScope = 'task' | 'resource' | 'plan' | 'route' | 'global';

export type SchedulingConflictType =
  | 'double_booking'
  | 'resource_stale'
  | 'person_unavailable'
  | 'device_offline'
  | 'low_battery'
  | 'predecessor_violation'
  | 'station_capacity'
  | 'forbidden_zone'
  | 'safety_block'
  | 'blocked_route'
  | 'stale_plan'
  | 'reservation_conflict'
  /** v0.7 A2：预占即将过期（倒计时 < 阈值），需提前续约/重排，避免执行中断。 */
  | 'reservation_expiring';

/** 冲突生命周期状态（02 §6.1 状态机）。 */
export type ConflictLifecycleStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'SUPPRESSED';

export interface SchedulingConflict {
  /** 稳定冲突 id（基于内容哈希，跨查询一致）。 */
  conflictId: string;
  type: SchedulingConflictType;
  severity: ConflictSeverity;
  scope: SchedulingConflictScope;
  resourceId: string | null;
  resourceType: string | null;
  taskIds: string[];
  message: string;
  /** 建议处置动作（改派 / 释放预占 / 绕行 / 重排等），无则 null。 */
  resolution: string | null;
  /** ISO 时间戳。 */
  createdAt: string;
  /** 冲突所基于的快照版本；当前实时状态为 'CURRENT'。 */
  snapshotVersion: string | null;
  /** 附加证据（预占 id、电量、状态等）。 */
  data?: Record<string, unknown>;
  // --- Conflict Lifecycle（Phase 3 / P3-T1，02 §6；旧字段向后兼容） ---
  /** 生命周期状态（缺省推导态为 OPEN）。 */
  status?: ConflictLifecycleStatus;
  /** 首次检测时间（ISO）。 */
  detectedAt?: string | null;
  /** 确认人（acknowledge）。 */
  acknowledgedBy?: string | null;
  /** 确认时间（ISO）。 */
  acknowledgedAt?: string | null;
  /** 解决人（resolve / 自动 auto_cleared 为 system）。 */
  resolvedBy?: string | null;
  /** 解决时间（ISO）。 */
  resolvedAt?: string | null;
  /** 抑制截止时间（ISO；到期自动回 OPEN）。 */
  suppressUntil?: string | null;
  /** 关联方案 id（无则 null）。 */
  planId?: string | null;
}

export interface ConflictsListRequest {
  type?: SchedulingConflictType;
  severity?: ConflictSeverity;
  scope?: SchedulingConflictScope;
  resourceId?: string;
}

export interface ConflictsListResponse {
  conflicts: SchedulingConflict[];
  total: number;
}

// ============================================================================
// Phase 4 / P4-SSE：统一 Scheduler Event Envelope（所有 Scheduler SSE 走该模型）
// ============================================================================

/** Scheduler 统一事件模型（sequence / Last-Event-ID / gap / org isolation / correlation）。 */
export interface SchedulerEventEnvelope<T = unknown> {
  eventId: string;
  sequence: number;
  orgId: string;
  eventType: string;
  entityType?: string;
  entityId?: string;
  occurredAt: string;
  snapshotVersion?: string;
  entityVersion?: number;
  correlationId?: string;
  payload: T;
}

// ============================================================================
// Phase 4 / P4-EXEC：正式执行领域
// ============================================================================

export type SchedulingExecutionStatus =
  | 'PLANNED'
  | 'DISPATCHED'
  | 'STARTED'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type SchedulingDeviationType =
  | 'START_DELAY'
  | 'END_DELAY'
  | 'TRAVEL_DELAY'
  | 'PERSON_CHANGED'
  | 'DEVICE_CHANGED'
  | 'STATION_CHANGED'
  | 'ROUTE_DEVIATION'
  | 'PERSON_UNAVAILABLE'
  | 'DEVICE_FAILURE'
  | 'TASK_CANCELLED'
  | 'SAFETY_INTERRUPTION'
  | 'MANUAL_OVERRIDE'
  | null;

/** 正式执行记录：Plan Assignment → Execution（planned vs actual，deviation 事实）。 */
export interface SchedulingExecution {
  id: string;
  executionId: string;
  orgId: string | null;
  runId: string | null;
  planId: string;
  assignmentId: string;
  taskId: string;
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  actualStartAt: string | null;
  actualEndAt: string | null;
  plannedTravelMs: number | null;
  actualTravelMs: number | null;
  plannedDistanceM: number | null;
  actualDistanceM: number | null;
  plannedWaitingMs: number | null;
  actualWaitingMs: number | null;
  status: SchedulingExecutionStatus;
  deviationType: SchedulingDeviationType;
  deviationReason: string | null;
  snapshotVersion: string | null;
  policyVersion: number | null;
  solverVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionUpdateRequest {
  /** 目标状态；终态转换（STARTED/COMPLETED/FAILED/CANCELLED）幂等。 */
  status?: SchedulingExecutionStatus;
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  actualTravelMs?: number | null;
  actualDistanceM?: number | null;
  actualWaitingMs?: number | null;
  deviationType?: SchedulingDeviationType;
  deviationReason?: string | null;
  /** 是否触发 replan（deviation 符合规则时由服务端自动判定，可选强制关闭）。 */
  triggerReplan?: boolean;
}

export interface ExecutionListResponse {
  executions: SchedulingExecution[];
  total: number;
}

// ============================================================================
// Phase 4 / P4-KPI：生产指标聚合
// ============================================================================

export interface SchedulerKpiSnapshot {
  periodStart: string;
  periodEnd: string;
  delivery: {
    onTimeRate: number | null;
    completionRate: number | null;
    latenessP50Ms: number | null;
    latenessP95Ms: number | null;
    latenessMaxMs: number | null;
    averageWaitingMs: number | null;
    averageTravelMs: number | null;
    averageTravelDistanceM: number | null;
  };
  resources: {
    personUtilization: number | null;
    deviceUtilization: number | null;
    stationUtilization: number | null;
    resourceIdleMs: number | null;
    workloadVariance: number | null;
  };
  stability: {
    replanCount: number;
    replanSuccessRate: number | null;
    assignmentChurnRate: number | null;
    manualOverrideRate: number | null;
    conflictRate: number | null;
    averageConflictResolutionMs: number | null;
    // --- Replan V2 KPI（08 §8；全可选，向后兼容） ---
    /** 受影响任务占比（Σ affectedTaskIds / Σ 可调度任务，窗口均值）。 */
    affectedAssignmentRatio?: number | null;
    /** 未变更 assignment 占比（= 1 − assignmentChurnRate）。 */
    unchangedAssignmentRate?: number | null;
    /** 方案搅动（Σ (changed+added+removed) assignments / 窗口）。 */
    scheduleChurn?: number | null;
    /** 重排耗时（solve + persist，ms）。 */
    replanDuration?: number | null;
    /** 非 MANUAL 触发创建的 run 数 / 窗口。 */
    replanTriggerCount?: number | null;
    /** 风暴守卫抑制数 / 窗口。 */
    replanSuppressedCount?: number | null;
  };
  solver: {
    solverLatencyP50Ms: number | null;
    solverLatencyP95Ms: number | null;
    optimalRate: number | null;
    feasibleRate: number | null;
    heuristicFallbackRate: number | null;
    timeoutRate: number | null;
    infeasibleRate: number | null;
  };
  dataQuality: {
    staleResourceRate: number | null;
    unknownLocationRate: number | null;
    degradedRouteRate: number | null;
  };
}

// ============================================================================
// Phase 4 / P4-REPLAY：Policy Replay 记录
// ============================================================================

export interface PolicyReplayRecord {
  replayId: string;
  orgId: string | null;
  candidatePolicyVersion: number;
  baselinePolicyVersion: number;
  solverVersion: string | null;
  snapshotVersion: string | null;
  seed: number | null;
  status: 'COMPLETED' | 'FAILED' | 'RUNNING';
  aggregateKpis: SchedulerKpiSnapshot | null;
  perRunResults: Array<Record<string, unknown>>;
  failures: Array<{ runId?: string; reason: string }>;
  startedAt: string;
  completedAt: string | null;
}

export interface PolicyReplayRequest {
  candidatePolicyVersion: number;
  /** 快照集：不传则取最近一次历史快照。 */
  snapshotVersion?: string;
  /** 确定性种子（相同 snapshot+policy+solver+seed = 相同结果）。 */
  seed?: number;
  limit?: number;
}

// ============================================================================
// Phase 4 / P4-GATE：策略生命周期 + 激活
// ============================================================================

export type SchedulingPolicyStatus = 'DRAFT' | 'SHADOW' | 'ACTIVE' | 'ARCHIVED';

export interface PolicyGateConfig {
  safetyViolations: number;
  blockedRouteAssignments: number;
  minOnTimeRate: number;
  maxLatenessP95Ms: number;
  maxFallbackRate: number;
  maxConflictRate: number;
  maxChurnRate: number;
  maxSolverLatencyP95Ms: number;
}

export interface PolicyGateEvaluation {
  passed: boolean;
  checks: Array<{ name: string; ok: boolean; actual: number | null; threshold: number | null; detail?: string }>;
  replayId: string | null;
  shadowEvaluation: {
    shadowRuns: number;
    shadowConflicts: number;
    safetyViolations: number;
    blockedRouteAssignments: number;
    fallbackRate: number | null;
    conflictRate: number | null;
  };
}

export interface PolicyActivationRecord {
  activationId: string;
  orgId: string | null;
  policyVersion: number;
  beforeVersion: number | null;
  afterVersion: number | null;
  operator: string;
  reason: string | null;
  gateResult: PolicyGateEvaluation | null;
  rollbackTarget: number | null;
  status: 'ACTIVATED' | 'ROLLED_BACK';
  createdAt: string;
}

export interface PolicyLifecycleUpdateRequest {
  policyVersion: number;
  /** DRAFT → SHADOW / SHADOW → DRAFT / ARCHIVED 回退等。 */
  status: SchedulingPolicyStatus;
  operator?: string;
  reason?: string;
}

// ============================================================================
// Phase 4 / P4-COMPARE：Plan Compare 权威 Diff
// ============================================================================

export type PlanDiffChangeType =
  | 'ADDED'
  | 'REMOVED'
  | 'PERSON_CHANGED'
  | 'DEVICE_CHANGED'
  | 'STATION_CHANGED'
  | 'TIME_CHANGED'
  | 'ROUTE_CHANGED'
  | 'ETA_CHANGED'
  | 'DISTANCE_CHANGED'
  | 'WORKLOAD_CHANGED'
  | 'LATENESS_CHANGED'
  | 'RISK_CHANGED'
  | 'CONFLICT_CHANGED'
  | 'CHURN';

export interface AssignmentSnapshot {
  taskId: string;
  personId: string | null;
  deviceId: string | null;
  stationId: string | null;
  plannedStart: string | null;
  plannedEnd: string | null;
  etaSeconds?: number;
  distanceMeters?: number;
  riskLevel?: string | null;
  routeGeometry?: Array<{ x: number; y: number }>;
}

export interface PlanAssignmentDiff {
  taskId: string;
  changeTypes: PlanDiffChangeType[];
  before?: AssignmentSnapshot;
  after?: AssignmentSnapshot;
  reasons: string[];
}

export interface PlanCompareResult {
  baselinePlanId: string;
  candidatePlanId: string;
  added: string[];
  removed: string[];
  diffByTask: PlanAssignmentDiff[];
  changeTypeCounts: Record<PlanDiffChangeType, number>;
  churn: number;
  aggregate: {
    baselineKpi?: SchedulerKpiSnapshot | null;
    candidateKpi?: SchedulerKpiSnapshot | null;
  };
}

// ============================================================================
// Phase 4 / P4-PREVIEW：Conflict Preview Replan
// ============================================================================

export interface ConflictPreviewResult {
  conflictId: string;
  baselinePlanId: string | null;
  candidatePlanId: string | null;
  diff: PlanCompareResult | null;
  affectedTasks: string[];
  affectedResources: string[];
  remainingConflicts: Array<{ conflictId: string; type: string; message: string }>;
  expectedKpiImpact: Record<string, unknown> | null;
  readonly: true;
}

export interface ConflictPreviewRequest {
  /** 建议动作（来自 conflict.resolution 建议处置），如 reallocate / release_reservation / reroute。 */
  action?: string;
  /** 对动作的候选资源覆盖（可选）。 */
  resourceIds?: string[];
}

// ============================================================================
// Incremental Replan V2 / M01：Replan Preview 契约（08 §5）
// ============================================================================

/**
 * Replan V2 预览结果（08 §5）：dry-run 候选方案 + PlanCompareService.compare
 * 派生的指标增量。只读、不落库、不派工（同 OverridePreviewService 语义）。
 * candidatePlanId 为 PREVIEW-*，不持久化。
 */
export interface ReplanPreviewResult {
  baselinePlanId: string | null;
  /** PREVIEW-*，不持久化。 */
  candidatePlanId: string | null;
  readonly: true;
  affectedTaskCount: number;
  unchangedAssignmentCount: number;
  changedAssignmentCount: number;
  addedAssignmentCount: number;
  removedAssignmentCount: number;
  /** 指标增量（候选 − 基线；均为 number，可为 0）。 */
  latenessDelta: number;
  travelDelta: number;
  workloadDelta: number;
  stationWaitDelta: number;
  changeoverDelta: number;
  energyRiskDelta: number;
  riskDelta: number;
  churnDelta: number;
  /** 逐任务 diff（复用 PlanAssignmentDiff；reasons = diff.reasons + ReplanImpact.reasons）。 */
  changedAssignments: PlanAssignmentDiff[];
}

/** Replan Preview 请求（08 §5；readonly，不落库）。 */
export interface ReplanPreviewRequest {
  triggerType: SchedulingTrigger | string;
  /** 触发实体 id 并集（事件/资源/route edge/zone）；缺省空数组。 */
  triggerIds?: string[];
}

/** Replan V2 自动重排 vs 人工审批判定（08 §6）。 */
export interface ReplanApprovalDecision {
  decision: 'AUTO_REPLAN' | 'HUMAN_APPROVAL_REQUIRED';
  /** 命中原因（critical_event / affected_ratio / safety_critical / human_lock / churn_ratio / max_changed_assignments / lateness_risk_delta）。 */
  reasons: string[];
}

// ============================================================================
// Incremental Replan V2 / M01：Prediction Shadow Learning 契约（08 §11）
// ============================================================================

/**
 * Prediction Shadow Learning 单条样本（08 §11）：记录预测 vs 确定性 baseline，
 * 待 ExecutionService/SchedulingFeedback 回填 actual 后计算误差。advisory-only，
 * 不写生产调度。
 */
export interface PredictionShadowSample {
  modelVersion: string;
  predictionType: string;
  inputVersion: string;
  /** 模型预测值。 */
  prediction: number;
  /** 确定性 baseline 值。 */
  baseline: number;
  /** 置信度 0..1。 */
  confidence: number;
  createdAt: string;
  /** 实际值（feedback 回填前为 null）。 */
  actual: number | null;
  /** 绝对误差 |prediction − actual|（actual 未回填为 null）。 */
  absoluteError: number | null;
  /** 相对误差 |prediction − actual| / |actual|（actual 未回填或为 0 时为 null）。 */
  relativeError: number | null;
}

/** Prediction Shadow Learning 窗口聚合指标（08 §11）。 */
export interface PredictionShadowAggregate {
  /** 平均绝对误差。 */
  mae: number;
  /** 均方根误差。 */
  rmse: number;
  /** 绝对误差 p50。 */
  p50: number;
  /** 绝对误差 p95。 */
  p95: number;
  /** 校准度（预测误差分布与置信度的匹配度，0..1）。 */
  calibration: number;
  /** 回退率（provider 不可用/低置信度 → baseline 的比例）。 */
  fallbackRate: number;
  /** 覆盖率（有 actual 回填样本占比，0..1）。 */
  coverage: number;
}
