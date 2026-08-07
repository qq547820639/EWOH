/* 前后端共享的类型定义 */

export interface DeviceInfo {
  id: string;
  deviceId: string;
  workerName: string;
  deviceModel: string;
  batteryPct: number;
  online: boolean;
  lastTelemetryAt: string | null;
  /** 空间实体 ID（关联 ewoh_spatial_entity） */
  entityId?: string;
  /** 父级空间实体 ID（设备实体的 parentId） */
  parentId?: string | null;
  /** X 坐标（毫米） */
  x?: number;
  /** Y 坐标（毫米） */
  y?: number;
  // 真机扩展字段
  sourceType?: string;
  firmwareVersion?: string | null;
  hardwareVersion?: string | null;
  protocolVersion?: string | null;
  temperatureC?: number | null;
  faultCode?: string | null;
  lastRawRef?: string | null;
  /** 绑定的人员实体 ID */
  boundPersonId?: string | null;
  /** 绑定的人员姓名 */
  boundPersonName?: string | null;
}

/** 设备搜索查询参数 */
export interface DeviceSearchQuery {
  keyword?: string;
  online?: boolean;
  batteryMin?: number;
  batteryMax?: number;
  sourceType?: string;
  model?: string;
  firmwareVersion?: string;
  protocolVersion?: string;
  faultCode?: string;
  bindingStatus?: 'bound' | 'unbound';
  page?: number;
  pageSize?: number;
  orderby?: string; // battery / batteryDesc / lastTelemetryAt / lastTelemetryAtDesc / deviceId / deviceIdDesc
}

export interface DeviceSearchResult {
  items: DeviceInfo[];
  total: number;
  page: number;
  pageSize: number;
}

/** 创建设备 DTO */
export interface CreateDeviceDto {
  deviceId: string;
  workerName?: string;
  deviceModel?: string;
  batteryPct?: number;
  online?: boolean;
  sourceType?: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  protocolVersion?: string;
}

/** 更新设备 DTO（部分字段） */
export interface UpdateDeviceDto {
  workerName?: string;
  deviceModel?: string;
  batteryPct?: number;
  online?: boolean;
  faultCode?: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  protocolVersion?: string;
  temperatureC?: number;
}

/** 设备绑定关系 */
export interface DeviceBinding {
  deviceId: string;
  /** 绑定的空间实体 ID（工位/产线/车间/工厂） */
  spatialEntityId?: string | null;
  /** 建筑层级路径（从根到叶的实体名称数组） */
  hierarchyPath: Array<{ entityId: string; name: string; entityType: string }>;
  /** 绑定的人员实体 ID */
  boundPersonId?: string | null;
  /** 绑定的人员姓名 */
  boundPersonName?: string | null;
}

/** 绑定设备请求 */
export interface BindDeviceRequest {
  /** 目标空间实体 ID（工位/产线/车间/工厂） */
  spatialEntityId?: string | null;
  /** 目标人员实体 ID */
  personEntityId?: string | null;
}

export interface EventInfo {
  id: string;
  eventId: string;
  deviceId: string;
  eventCode: string;
  eventType: string;
  severity: string;
  title: string;
  status: string;
  createdAt: string | null;
  handlerAction: string | null;
  // 真机扩展字段（证据链）
  sourceType?: string;
  triggerRecordId?: string | null;
  evidenceJson?: Record<string, unknown> | null;
}

export interface TelemetryInfo {
  id: string;
  deviceId: string;
  ts: string;
  pitchDeg: number | null;
  loadScore: number | null;
  fatigueTrend: number | null;
  batteryPct: number | null;
  qualityStatus: string | null;
  // 真机外骨骼扩展字段（UnifiedExoFrame 映射）
  sourceType?: string;
  recordId?: string | null;
  ingestedAt?: string | null;
  rawRef?: string | null;
  jointAngles?: Record<string, number> | null;
  angularVelocityDps?: number | null;
  assistLevel?: string | null;
  torqueNm?: number | null;
  cumulativeLoadScore?: number | null;
  temperatureC?: number | null;
  faultCode?: string | null;
  packetLossPct?: number | null;
  dataConfidence?: number | null;
  dataQuality?: string;
}

export interface OverviewStats {
  deviceTotal: number;
  deviceOnline: number;
  eventOpen: number;
  eventCritical: number;
  avgLoad: number;
  workerCount: number;
}

export interface EventStats {
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  trend: { time: string; count: number }[];
}

/** 文件服务记录（`/api/files`） */
export interface FileRecord {
  id: string;
  orgId: string;
  uploadedBy: string;
  filename: string;
  contentType: string;
  size: number;
  note?: string;
  createdAt: string;
  scanStatus?: 'pending' | 'clean' | 'infected';
  idempotencyKey?: string;
}

export interface WorkerLoad {
  deviceId: string;
  workerName: string;
  avgLoad: number;
  maxLoad: number;
  fatigueTrend: number;
  batteryPct: number;
  online: boolean;
  telemetryCount: number;
}

// ===== Organization / Personnel =====

export interface OrganizationInfo {
  id: string;
  name: string;
  orgType: string;
  parentId: string | null;
  status: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationTreeNode extends OrganizationInfo {
  children: OrganizationTreeNode[];
}

export interface PersonnelInfo {
  id: string;
  name: string;
  employeeNo: string;
  orgId: string | null;
  teamName: string | null;
  position: string | null;
  skills: string[] | null;
  status: string | null;
  riskLevel?: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
}

export interface PersonnelQuery {
  keyword?: string;
  orgId?: string;
  status?: string;
}

// ===== 空间实体与拓扑 =====

/** 空间实体类型 */
export type SpatialEntityType =
  | 'factory'
  | 'workshop'
  | 'production_line'
  | 'zone'
  | 'workstation'
  | 'device'
  | 'person'
  | 'camera'
  | 'uwb_station'
  | 'route'
  | 'restricted_zone'
  | string;

/** 空间实体（ewoh_spatial_entity） */
export interface SpatialEntity {
  id: string;
  entityId: string;
  entityType: SpatialEntityType;
  parentId: string | null;
  name: string;
  x: number;
  y: number;
  yaw: number;
  bboxW: number;
  bboxH: number;
  status: string;
  sourceType: string;
  confidence: number;
  version: number;
  extra: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** 空间拓扑关系（ewoh_topology） */
export interface Topology {
  id: string;
  fromEntity: string;
  toEntity: string;
  relation: string;
  distance: number;
  createdAt: string;
}

/** 层级树节点 */
export interface SpatialHierarchyNode {
  entity: SpatialEntity;
  children: SpatialHierarchyNode[];
}

// ===== 世界模型 =====

/** 世界状态快照（ewoh_world_state） */
export interface WorldState {
  id: string;
  entityId: string;
  stateJson: Record<string, unknown>;
  ts: string;
}

/** 事件因果链节点（ewoh_event_chain） */
export interface EventChainNode {
  id: string;
  eventId: string;
  parentEventId: string | null;
  causalType: string;
  description: string | null;
  createdAt: string;
}

/** 当前世界状态聚合（人员位置/设备状态/工位占用/任务进度） */
export interface CurrentWorldState {
  persons: Array<{
    entityId: string;
    name: string;
    x: number;
    y: number;
    status: string;
    confidence: number;
    deviceId?: string;
    task?: string;
    loadScore?: number;
  }>;
  devices: Array<{
    entityId: string;
    name: string;
    x: number;
    y: number;
    status: string;
    deviceId?: string;
    workerId?: string;
  }>;
  workstations: Array<{
    entityId: string;
    name: string;
    x: number;
    y: number;
    status: string;
    occupancy: number;
  }>;
  events: Array<{
    eventId: string;
    title: string;
    severity: string;
    status: string;
    createdAt: string | null;
  }>;
  ts: string;
}

/** 时间轴回放数据 */
export interface ReplaySnapshot {
  ts: string;
  persons: Array<{
    entityId: string;
    x: number;
    y: number;
    status: string;
    loadScore?: number;
  }>;
  devices: Array<{ entityId: string; x: number; y: number; status: string }>;
  events: Array<{
    eventId: string;
    severity: string;
    title: string;
    lane?: string;
    entityId?: string;
    sourceType?: string;
    status?: string;
    eventCode?: string;
  }>;
}

// ===== 调度方案与审计 =====

/** 调度方案策略 */
export type ScheduleStrategy =
  | 'keep_status'
  | 'capacity_priority'
  | 'load_balance';

/** 调度方案状态 */
export type SchedulePlanStatus =
  | 'shadow'
  | 'proposed'
  | 'confirmed'
  | 'rejected';

/** 调度方案（ewoh_schedule_plan） */
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

/** 调度审计（ewoh_schedule_audit） */
export interface ScheduleAudit {
  id: string;
  auditId: string;
  planId: string;
  action: string;
  operator: string | null;
  reason: string | null;
  createdAt: string | null;
}

/** 调度权重配置 */
export interface ScheduleWeights {
  w1_output: number;
  w2_on_time: number;
  w3_safety_risk: number;
  w4_body_load: number;
  w5_move_distance: number;
  w6_changeover_cost: number;
}

/** 生成方案请求体 */
export interface GeneratePlansRequest {
  trigger?: string;
  idempotencyKey?: string;
}

/** 确认方案请求体 */
export interface ConfirmPlanRequest {
  reason: string;
  operator?: string;
}

// ===== 模型注册 =====

export interface ModelRegistry {
  id: string;
  modelId: string;
  modelName: string;
  version: string;
  type: string;
  status: string;
  cardJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

// ===== 环境传感器 =====

export interface EnvironmentReading {
  id: string;
  sensorId: string;
  entityId: string | null;
  temperature: number | null;
  vibration: number | null;
  noise: number | null;
  airQuality: number | null;
  ts: string;
  // 真机扩展字段
  sourceType?: string;
  recordId?: string | null;
  dataConfidence?: number | null;
}

// ===== 模拟器 =====

export interface SimulatorStatus {
  running: boolean;
  startedAt: string | null;
  tickCount: number;
  lastTickAt: string | null;
  deviceCount: number;
  personCount: number;
  eventCount: number;
  simulationErrorCount: number;
}

// ===== Ingestion 真机接入网关 DTO =====

/** 数据来源类型（页面与 API 必须明确标注，禁止模拟数据伪装为真实状态） */
export type DataSourceType =
  | 'real'
  | 'controlled_test'
  | 'simulated'
  | 'replayed'
  | 'stale'
  | 'offline';

/** 数据质量等级 */
export type DataQuality = 'good' | 'degraded' | 'invalid';

/** 统一外骨骼帧 DTO（对齐 Python UnifiedExoFrame.to_storage_dict） */
export interface ExoskeletonFrameDto {
  /** 外骨骼设备ID（兼容别名，规范格式使用 entity_id） */
  device_id?: string;
  /** 关联空间实体ID（UnifiedExoFrame.to_storage_dict 规范字段） */
  entity_id: string;
  /** 设备时间戳（ISO8601） */
  event_time: string;
  /** 工人姓名（可选，upsert 时更新） */
  worker_name?: string;
  /** 设备型号（可选） */
  device_model?: string;
  /** 固件版本（可选） */
  firmware_version?: string;
  /** 硬件版本（可选） */
  hardware_version?: string;
  /** 协议版本（可选） */
  protocol_version?: string;
  /** 电池百分比 0-100 */
  battery_pct?: number;
  /** 躯干俯仰角（度） */
  pose?: {
    trunk_pitch_deg?: number;
    trunk_roll_deg?: number;
    angular_velocity_dps?: number;
    joint_angles_deg?: Record<string, number>;
  };
  /** 关节角度（度） */
  joint_angles?: Record<string, number>;
  /** 角速度（度/秒） */
  angular_velocity_dps?: number | Record<string, number>;
  /** 辅助等级 0-1 */
  assist_level?: number;
  /** 关节力矩（Nm） */
  torque_nm?: number | Record<string, number>;
  /** 负荷评分 0-1 */
  load_score?: number;
  /** 累计负荷评分 */
  cumulative_load_score?: number;
  /** 疲劳趋势 */
  fatigue_trend?: number;
  /** 质量状态 */
  quality_status?: string;
  /** 躯干俯仰角（扁平兼容字段） */
  pitch_deg?: number;
  /** 设备温度（℃） */
  temperature_c?: number;
  /** 故障码 */
  fault_code?: string;
  /** 丢包率百分比 */
  packet_loss_pct?: number;
  /** 数据置信度 0-1 */
  data_confidence?: number;
  /** 数据来源（默认 real） */
  source_type?: DataSourceType;
  /** 原始记录ID（UUID，幂等用） */
  record_id?: string;
  /** 原始报文哈希（SHA256，幂等用） */
  raw_ref?: string;
  /** 负荷分组（规范格式） */
  load?: {
    assist_level?: number;
    torque_nm?: number;
    cumulative_load_score?: number;
    [k: string]: number | undefined;
  };
  /** 设备分组（规范格式） */
  device?: {
    battery_pct?: number;
    temperature_c?: number;
    fault_code?: string | null;
    health?: string;
    [k: string]: number | string | null | undefined;
  };
  /** 数据质量分组（规范格式） */
  quality?: {
    packet_loss_pct?: number;
    confidence?: number;
    status?: string;
    reason?: string | null;
    [k: string]: number | string | null | undefined;
  };
}

/** 环境传感器帧 DTO */
export interface EnvironmentFrameDto {
  sensor_id: string;
  entity_id?: string;
  event_time: string;
  temperature?: number;
  vibration?: number;
  noise?: number;
  air_quality?: number;
  source_type?: DataSourceType;
  record_id?: string;
  data_confidence?: number;
}

/** 摄像头结构化检测帧 DTO（写 ewoh_world_state） */
export interface CameraFrameDto {
  camera_id: string;
  entity_id?: string;
  event_time: string;
  detections: Array<{
    track_id?: string;
    class_name: string;
    confidence: number;
    bbox?: { x: number; y: number; w: number; h: number };
    skeleton?: Record<string, number[]>;
    action?: string;
  }>;
  source_type?: DataSourceType;
  record_id?: string;
}

/** MES 工单事件 DTO */
export interface MesOrderDto {
  order_id: string;
  product_code?: string;
  quantity?: number;
  priority?: string;
  planned_start?: string;
  planned_end?: string;
  status?: string;
  source_type?: DataSourceType;
  record_id?: string;
}

/** Ingestion 响应 */
export interface IngestResponse {
  accepted: boolean;
  skipped: boolean;
  record_id?: string;
  data_quality: DataQuality;
  events_triggered: number;
  error?: string;
}

/** 批量 Ingestion 响应 */
export interface BatchIngestResponse {
  total: number;
  accepted: number;
  skipped: number;
  results: IngestResponse[];
}

// ===== 场景直接建模 DTO（多源融合） =====

/** source_type 扩展取值（spatial_entity） */
export type SpatialSourceType =
  | 'seed'
  | 'simulated'
  | 'lidar_scan'
  | 'gaussian_splat'
  | 'uwb_located'
  | 'visual_slam';

/** 空间扫描产物 DTO（3DGS/LiDAR/视觉SLAM 建模数据接入） */
export interface SpatialScanDto {
  entity_id: string;
  entity_type?: string;
  name?: string;
  parent_id?: string;
  x?: number;
  y?: number;
  yaw?: number;
  bbox_w?: number;
  bbox_h?: number;
  source_type: SpatialSourceType;
  confidence?: number;
  capture_at?: string;
  scan_device?: string;
  alignment_error_mm?: number;
  splat_url?: string;
  pointcloud_url?: string;
}

/** 定位坐标流 DTO（UWB/Wi-Fi/视觉融合定位） */
export interface LocationFrameDto {
  entity_id: string;
  locator: 'uwb' | 'wifi' | 'visual' | 'fusion';
  confidence: number;
  x: number;
  y: number;
  z?: number;
  ts: string;
  source_type?: DataSourceType;
  record_id?: string;
}

// ===== 游戏化玩法 + 具身智能（工厂即具身机器人）=====

/** 玩家角色（班组长/车间主任/厂长） */
export type PlayerRole =
  | 'shift_leader'
  | 'workshop_director'
  | 'factory_manager';

/** 玩家角色信息 */
export interface PlayerRoleInfo {
  role: PlayerRole;
  roleName: string;
  /** 可见层级 */
  visibleLevels: string[];
  /** 可执行操作 */
  permissions: string[];
  /** 玩家名称 */
  playerName: string;
}

/** 资源类型（人员/设备/工位三维资源） */
export type ResourceType = 'person' | 'device' | 'workstation';

/** 资源池条目 */
export interface ResourceItem {
  entityId: string;
  name: string;
  type: ResourceType;
  /** 当前工位 ID（若已分配） */
  assignedWorkstationId?: string | null;
  /** 负荷（0-1） */
  loadScore?: number | null;
  /** 电量百分比 */
  batteryPct?: number | null;
  /** 在线状态 */
  status: string;
  /** 技能标签 */
  skills?: string[];
}

/** 资源分配请求 */
export interface ResourceAllocationRequest {
  /** entity_id → 目标工位 ID 映射 */
  allocations: Array<{
    entityId: string;
    targetType: ResourceType;
    targetId: string;
  }>;
  operator?: string;
  reason?: string;
}

/** AI 评估结果 */
export interface AllocationEvaluation {
  /** 综合评分 red/yellow/green */
  overall: 'red' | 'yellow' | 'green';
  /** 负荷均衡度 0-1 */
  loadBalance: number;
  /** 技能匹配度 0-1 */
  skillMatch: number;
  /** 电量续航评估 0-1 */
  batteryEndurance: number;
  /** 冲突列表 */
  conflicts: string[];
  /** 建议 */
  suggestions: string[];
}

/** 资源分配结果 */
export interface ResourceAllocationResult {
  planId: string;
  evaluation: AllocationEvaluation;
  allocations: Array<{
    entityId: string;
    targetId: string;
    success: boolean;
    error?: string;
  }>;
}

/** 工序节点 */
export interface ProcessNode {
  nodeId: string;
  name: string;
  /** 工序顺序 */
  order: number;
  /** 分配的工位 ID */
  assignedWorkstationId?: string | null;
  /** 分配的人员 entity_id */
  assignedPersonId?: string | null;
  /** 预计节拍（秒） */
  estimatedTakt?: number | null;
  /** 节拍数据来源：telemetry=真实遥测推算，default=默认值 */
  taktSource?: 'telemetry' | 'default';
  /** 依赖的前置工序 ID */
  dependencies: string[];
}

/** 任务编排请求 */
export interface TaskOrchestrationRequest {
  /** MES 工单 ID 或自定义编排 ID */
  orderId: string;
  productCode?: string;
  quantity?: number;
  /** 工序节点列表 */
  nodes: ProcessNode[];
  operator?: string;
}

/** 节拍模拟结果 */
export interface TaktSimulation {
  /** 瓶颈工位 ID */
  bottleneckWorkstationId: string | null;
  /** 瓶颈工位名称 */
  bottleneckWorkstationName: string | null;
  /** 预计完成时间（秒） */
  estimatedCompletionSec: number;
  /** 每小时产量 */
  throughputPerHour: number;
  /** 各工位节拍 */
  stationTakts: Array<{
    workstationId: string;
    workstationName: string;
    taktSec: number;
    isBottleneck: boolean;
    /** 节拍数据来源：telemetry=真实遥测推算，default=默认值 */
    taktSource?: 'telemetry' | 'default';
  }>;
}

/** 任务编排结果 */
export interface TaskOrchestrationResult {
  planId: string;
  simulation: TaktSimulation;
  nodes: ProcessNode[];
}

/** 调度下发请求 */
export interface DispatchRequest {
  operator?: string;
  /** 执行确认回传 */
  executionNote?: string;
}

/** 调度下发结果 */
export interface DispatchResult {
  planId: string;
  status: 'dispatched' | 'executing' | 'completed' | 'conflict';
  /** 冲突列表 */
  conflicts: string[];
  /** 下发时间 */
  dispatchedAt: string;
  /** 审计 ID */
  auditId: string;
}

/** 外骨骼反馈指令类型（肢体下行通道） */
export type ExoFeedbackType = 'tactile' | 'voice' | 'ar' | 'status';

/** 外骨骼反馈请求 */
export interface ExoFeedbackRequest {
  /** 指令类型 */
  type: ExoFeedbackType;
  /** 触觉模式：vibrate_high / vibrate_low / stop / pulse */
  tactilePattern?: string;
  /** 语音/AR 文本 */
  message?: string;
  /** AR 投影内容（工位指引/工序提示） */
  arContent?: {
    type: 'workstation_guide' | 'process_hint' | 'safety_warning';
    text: string;
    durationSec?: number;
  };
  /** 优先级 */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** 触发原因 */
  reason?: string;
}

/** 外骨骼反馈结果 */
export interface ExoFeedbackResult {
  deviceId: string;
  accepted: boolean;
  delivered: boolean;
  error?: string;
}

/** 大脑推理建议（数据驱动） */
export interface BrainSuggestion {
  /** 建议类型 */
  type:
    | 'takt_improve'
    | 'load_balance'
    | 'battery_swap'
    | 'safety_intervene'
    | 'bottleneck_resolve';
  /** 建议标题 */
  title: string;
  /** 建议描述 */
  description: string;
  /** 影响实体 */
  affectedEntities: string[];
  /** 预期收益 */
  expectedBenefit: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 建议唯一标识（用于「采纳」时定位/转化） */
  suggestionId?: string;
  /** 关联方案 ID（已存在可审批方案时回填） */
  planId?: string;
  /** LLM 增强是否仍在进行（true 表示规则建议已返回、大模型增强后台执行中） */
  enhancing?: boolean;
}

/** 大脑建议 → 调度方案 转化请求 */
export interface ApplyBrainSuggestionRequest {
  type: BrainSuggestion['type'];
  title: string;
  description: string;
  affectedEntities: string[];
  expectedBenefit: string;
  confidence: number;
  operator?: string;
}

/** 大脑建议 → 调度方案 转化结果 */
export interface ApplyBrainSuggestionResult {
  planId: string;
  planName: string;
  strategy: string;
  status: string;
}

// ===== 审批 =====

/** 审批步骤状态 */
export type ApprovalStepStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'delegated'
  | 'skipped'
  | 'expired';

/** 审批实例状态 */
export type ApprovalInstanceStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'bypassed';

/** 审批步骤 */
export interface ApprovalStep {
  id: string;
  role: string;
  status: ApprovalStepStatus;
  reason?: string;
  delegateTo?: string;
}

/** 审批实例 */
export interface ApprovalInstance {
  id: string;
  entityType: string;
  entityId: string;
  status: ApprovalInstanceStatus;
  steps: ApprovalStep[];
  createdAt: string;
}

/** 创建审批实例请求 */
export interface CreateApprovalRequest {
  entityType: string;
  entityId: string;
  roles: string[];
}

/** 审批步骤操作 */
export type ApprovalStepAction =
  | 'approve'
  | 'reject'
  | 'delegate'
  | 'skip'
  | 'expire';

// ===== 统一对象时间线（Unified Object Timeline）=====

/**
 * 时间线事件来源类型。用于区分事件来自工作流编排、告警、设备遥测、
 * 系统审计、用户操作、边缘接入还是证据归档。
 */
export type TimelineSource =
  | 'workflow'
  | 'alert'
  | 'device'
  | 'system'
  | 'user'
  | 'edge'
  | 'evidence';

/** 权限可见性：visible=对当前身份完全可见；restricted=受限；hidden=不可见。 */
export type PermissionVisibility = 'visible' | 'restricted' | 'hidden';

/**
 * 时间线事件可信度摘要（与 client/src/lib/credibility.ts 的 CredibilityInfo
 * 结构保持一致，便于客户端直接复用 credibilitySummary 判定）。
 */
export interface TimelineCredibility {
  /** 数据来源类型（real / controlled_test / simulated / replayed / stale / offline 等）。 */
  sourceType?: string;
  /** 采集时间（ISO）。 */
  collectedAt?: string;
  /** 最近同步时间（ISO）。 */
  lastSyncedAt?: string;
  /** 数据完整性 0..1。 */
  completeness?: number;
  /** 置信度 0..1。 */
  confidence?: number;
  /** 是否来自离线缓存。 */
  isOfflineCache?: boolean;
  /** 是否模拟或回放数据。 */
  isSimulatedOrReplay?: boolean;
  /** 显式授权标记（false 则强制不可用于决策）。 */
  decisionAuthorized?: boolean;
}

/** 证据引用。 */
export interface TimelineEvidenceRef {
  /** 证据 ID（如 record_id / evidence_id）。 */
  id: string;
  /** 证据类型/媒介（image / video / telemetry / raw / document 等）。 */
  type?: string;
  /** 原始记录引用（record_id / raw_ref）。 */
  ref?: string;
  /** 人类可读标签。 */
  label?: string;
  /** 可访问资源地址。 */
  url?: string;
}

/**
 * 统一时间线事件模型。所有页面（Events / CommandMap 事件中心 / 回放）都应
 * 消费此结构，避免各页面各自拼装不兼容的时间线结构。
 */
export interface TimelineEvent {
  /** 稳定事件 ID（同时用作锚点 hash）。 */
  id: string;
  /** 事件发生时间（ISO 8601）。 */
  timestamp: string;
  /** 执行者（用户 id/姓名 或 system）。 */
  actor: string;
  /** 来源（workflow / alert / device / system / user / edge / evidence）。 */
  source: TimelineSource | string;
  /** 对象类型（alert / workflow / task / device / schedule / approval ...）。 */
  objectType: string;
  /** 对象 ID。 */
  objectId: string;
  /** 动作（created / updated / triggered / handled / approved ...）。 */
  action: string;
  /** 变更前状态（可为 null）。 */
  previousState: string | null;
  /** 变更后状态（可为 null）。 */
  currentState: string | null;
  /** 关联 ID（把 alert→decision→command→execution→receipt→review 串成链）。 */
  correlationId: string | null;
  /** 因果 ID（父事件，用于因果追溯）。 */
  causationId: string | null;
  /** 证据引用列表。 */
  evidence: TimelineEvidenceRef[];
  /** 可信度摘要（结构对齐 credibility.ts CredibilityInfo）。 */
  credibility: TimelineCredibility;
  /** 权限可见性。 */
  permissionVisibility: PermissionVisibility | string;
  /** 展示用严重度（可选）。 */
  severity?: string;
  /** 展示用标题（可选）。 */
  title?: string;
  /** 展示用状态（可选）。 */
  status?: string;
  /** 风险等级（low / medium / high，可选）。 */
  riskLevel?: 'low' | 'medium' | 'high' | string;
  /** 扩展元数据（可选）。 */
  meta?: Record<string, unknown>;
}

/** 时间线过滤条件。 */
export interface TimelineFilter {
  /** 对象类型过滤。 */
  objectType?: string;
  /** 事件类型/动作过滤（同 action）。 */
  eventType?: string;
  /** 动作过滤。 */
  action?: string;
  /** 风险等级过滤。 */
  riskLevel?: string;
  /** 执行者过滤。 */
  actor?: string;
  /** 起始时间（ISO，含）。 */
  from?: string;
  /** 结束时间（ISO，含）。 */
  to?: string;
}
