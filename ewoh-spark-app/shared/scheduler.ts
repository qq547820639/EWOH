/* 前后端共享契约 - Scheduler 域（P2-SHARED-001 渐进拆分第一步）。
 *
 * 从 api.interface.ts 物理移出 Scheduler 域类型（调度请求/方案/求解器/资源状态/
 * 路由/冲突/策略等）。api.interface.ts 通过 `export * from './scheduler'`
 * 保持向后兼容；新代码可 `import ... from '@shared/scheduler'`。
 * 本文件类型自包含，不依赖 api.interface 其他域。
 */

export type ScheduleStrategy =
  | 'keep_status'
  | 'capacity_priority'
  | 'load_balance';

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
  | 'LOCKED_ASSIGNMENT';

export type SchedulingSoftConstraintType =
  | 'MIN_TRAVEL_TIME'
  | 'BALANCE_WORKLOAD'
  | 'MIN_CHANGE'
  | 'MIN_WAIT'
  | 'PREFER_SAME_TEAM'
  | 'PREFER_NEARBY_RESOURCE'
  | 'EXCLUDED_RESOURCE'
  | 'PREFERRED_RESOURCE'
  | 'MANUAL_BOOST';

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
  | 'ADJUST_TIME';

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
  reason?: string;
  validFrom?: number;
  expiresAt?: number;
}

export interface PlanOverrideRequest {
  actions: PlanOverrideAction[];
  operator?: string;
  reason?: string;
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
}

export type SolverStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'HEURISTIC'
  | 'FALLBACK'
  | 'INFEASIBLE'
  | 'TIMEOUT'
  | 'UNAVAILABLE';

export interface SolverRequest {
  requestId: string;
  snapshotVersion: string;
  policyVersion: number;
  solverVersion: string;
  horizonMinutes: number;
  nowMs: number;
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
    eligiblePersonIds?: string[];
    eligibleDeviceIds?: string[];
  }>;
  persons: Array<{
    id: string;
    status: string;
    locationStationId: string | null;
    x: number;
    y: number;
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
    x: number;
    y: number;
    capacity: number | null;
    executingTaskIds?: string[];
  }>;
  reservations: Array<{
    resourceId: string;
    resourceType: string;
    startMs: number;
    endMs: number;
  }>;
  forbiddenZones: string[];
  /** 原始约束透传（hard/soft 统一序列化），供 CP-SAT Worker 消费相同语义。 */
  constraints?: Array<Record<string, unknown>>;
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
  type: 'person' | 'device' | 'station' | 'tool' | 'material' | 'vehicle';
  status: string;
  capabilities: string[];
  certifications: string[];
  location: { stationId: string | null; zoneId: string | null; x: number; y: number };
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
  /** 当前任务 id（person/device 有背衬列时填充，无则 null，不虚构）。 */
  currentTask?: string | null;
  /** 班组（person 有 team_name 列，其余资源无则 null）。 */
  team?: string | null;
  /** 班次（无对应背衬列时为 null）。 */
  shift?: string | null;
  /** 最近更新时间（epoch ms）。 */
  updatedAt?: number | null;
  version: number;
}

export interface WorldStateSnapshot {
  snapshotVersion: string;
  ts: string;
  /** 全局单调递增世界版本，用于可靠新鲜度判断。 */
  worldVersion: number;
  /** 各类实体的版本摘要（entityId → version）。 */
  entityVersions: Record<string, number>;
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
    name: string;
    status: string;
    healthStatus: string | null;
    skills: string[];
    certifications: string[];
    loadLevel: number;
    fatigueLevel: number;
    stationId: string | null;
    zoneId: string | null;
    x: number;
    y: number;
    /** 人员下一次可用时间（epoch ms），由 reservation 推算；无保留则 null。 */
    availableFromMs?: number | null;
    /** 数据来源时间戳（epoch ms），用于新鲜度判定。 */
    sourceTs?: number | null;
    /** 数据新鲜度阈值（ms），超过则标 STALE。 */
    freshnessMs?: number | null;
    /** 数据质量：FRESH / STALE / UNKNOWN（STALE/UNKNOWN 不被视为可用）。 */
    dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
  }>;
  tasks: Array<{
    id: string;
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
  }>;
  devices: Array<{
    id: string;
    workerName: string | null;
    deviceModel: string | null;
    batteryPct: number;
    online: boolean;
    status: string | null;
    /** 设备能力（如 'exo-lift' / 'vacuum'），用于 capability 匹配。 */
    capabilities?: string[];
    /** 设备位置（由绑定人员/空间实体推算；未知则 null）。 */
    x?: number | null;
    y?: number | null;
    /** 设备所在工位 id。 */
    locationStationId?: string | null;
    /** 设备可用时间窗（如来自维护/排程）。 */
    availableWindows?: Array<{ startMs: number; endMs: number }>;
    /** 数据来源时间戳（epoch ms），用于新鲜度判定。 */
    sourceTs?: number | null;
    /** 数据新鲜度阈值（ms），超过则标 STALE。 */
    freshnessMs?: number | null;
    /** 数据质量：FRESH / STALE / UNKNOWN（STALE/UNKNOWN 不被视为可用）。 */
    dataQuality?: 'FRESH' | 'STALE' | 'UNKNOWN';
  }>;
  stations: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    /** 工位容量（可同时承接的任务数/单位数）；未知则 null。 */
    capacity?: number | null;
  }>;
  backlog: Array<{ taskId: string; count: number }>;
  events: Array<{
    eventId: string;
    severity: string;
    status: string;
    eventType: string | null;
  }>;
  routeStatus: Array<{
    edgeId: string;
    status: string;
    riskLevel: string | null;
  }>;
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
  createdAt: string;
}

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
  baselineDelta: Record<string, unknown>;
  violations: Array<Record<string, unknown>>;
  createdAt: string;
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
}

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
   */
  weights?: {
    workloadBalance?: number;
    stationWait?: number;
    changeCost?: number;
    energy?: number;
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
