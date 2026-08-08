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

// ===== Scheduling V2（智能调度工作台）=====

/** 调度方案状态（V2） */
export type PlanStatus =
  | 'draft'
  | 'shadow'
  | 'approved'
  | 'dispatched'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'superseded';

/** 调度分配状态（V2） */
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

/** 调度触发类型（V2） */
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

/** 世界状态快照（V2） */
/** 硬约束类型（求解器必须真实执行，否则返回 UNSUPPORTED_CONSTRAINT）。 */
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

/** 软约束类型（贡献到目标评分，不决定可行性）。 */
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

/** 统一调度约束：接口接受的所有约束都必须被求解器执行或显式拒绝。 */
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

/** 人工覆盖动作类型（BrainPanel / 资源池 / 命令图人工干预）。 */
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

/** 单个手工覆盖动作：由服务转换为 SchedulingConstraint 并触发 V2 重排。 */
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

/** 应用人工覆盖请求（POST /plans/:planId/overrides）。 */
export interface PlanOverrideRequest {
  actions: PlanOverrideAction[];
  operator?: string;
  reason?: string;
}

/** 覆盖前后方案差异摘要。 */
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

/** 应用人工覆盖响应：before/after 完整方案 + 差异汇总 + 落库约束。 */
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

/**
 * 求解器状态：明确标识实际使用的求解器与结果质量。
 * - OPTIMAL/FEASIBLE：CP-SAT 或启发式产出的可行解；
 * - FALLBACK：CP-SAT 不可用/超时/异常，回退到启发式；
 * - INFEASIBLE：无可行解；
 * - TIMEOUT：求解超时；
 * - UNAVAILABLE：后端未配置求解器（如 OR-Tools 缺失）。
 */
export type SolverStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'FALLBACK'
  | 'INFEASIBLE'
  | 'TIMEOUT'
  | 'UNAVAILABLE';

/** 内部求解请求（控制面 → 优化 Worker 的稳定契约）。 */
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

/** 内部求解响应（优化 Worker → 控制面）。 */
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

/** 多目标评分分解（可解释，非单一 total）。 */
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

/** 统一资源状态投影（person/device/station/tool/material/vehicle）。 */
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

/** 调度运行记录（V2） */
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

/** 调度分配（V2） */
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

/** 可解释决策轨迹（任务 → 资源 的选中依据）。 */
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

/** 调度方案指标（V2） */
export interface SchedulingPlanMetrics {
  lateMinutes: number;
  walkingMeters: number;
  stationWaitMinutes: number;
  maxWorkload: number;
  changeCost: number;
}

/** 调度方案（V2） */
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

/** 调度反馈（SchedulingFeedback，Task 7）：观测型 planned-vs-actual 执行数据，仅用于离线评估/参数对比/回归，不参与生产调度。 */
export interface SchedulingFeedbackResource {
  personId?: string | null;
  deviceId?: string | null;
  stationId?: string | null;
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

/** 由 ewoh_scheduling_feedback 派生的调度 KPI（离线评估）。 */
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

/** 调度策略权重（V2） */
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

/** 版本化调度策略配置（集中所有调度参数，消除 magic numbers）。 */
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
}

/** 调度策略版本列表项（Task 6：命令图调度闭环，候选策略注册/对比/激活）。 */
export interface SchedulingPolicyVersionSummary {
  configVersion: number;
  active: boolean;
  updatedBy: string | null;
  createdAt: string;
}

/**
 * 候选策略版本 vs 当前生效版本的 shadow 对比结果（Task 6，只读）。
 * 仅用于离线评估（反馈 KPI + 目标权重对比），绝不激活任何版本。
 */
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

/** 下发结果（V2 DispatchCoordinator）。 */
export interface DispatchCoordinatorResult {
  planId: string;
  dispatchedAt: string;
  dispatchedAssignments: number;
  reservedAssignments: number;
  taskIds: string[];
  outboxEventIds: string[];
}

/** Outbox 领域事件（V2）。 */
export interface OutboxEvent {
  id: string;
  eventType: string;
  entityId: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'published' | 'failed';
  sequence: number;
  createdAt: string;
  /** 实体类型（device / person / task / route / zone ...），用于影响分析与事件分类。 */
  entityType?: string;
  /** 该实体在触发时的版本（来自 world-state entityVersions），用于新鲜度/缺口判定。 */
  entityVersion?: number;
}

/** 调度实时事件（V2 SSE/流）。 */
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

/** 路由图节点（V2） */
export interface RouteGraphNode {
  nodeId: string;
  nodeType: string | null;
  x: number;
  y: number;
  floor: string | null;
  stationId: string | null;
  zoneId: string | null;
}

/** 路由图边（V2） */
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

/** 路由图（V2） */
export interface RouteGraph {
  nodes: RouteGraphNode[];
  edges: RouteGraphEdge[];
}

/** 规划路径（V2） */
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

/** 人员资格判定结果（V2） */
export interface EligibilityResult {
  personId: string;
  eligible: boolean;
  reasons: string[];
}

/** 单个任务候选资源（人员×设备），由候选资源端点返回。 */
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

/** 候选资源端点响应。 */
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

/** 生成调度运行请求（V2） */
export interface CreateRunRequest {
  trigger?: SchedulingTrigger;
  entityId?: string;
  horizonMinutes?: number;
  operator?: string;
  reason?: string;
}

/** 查询调度运行历史请求（V2） */
export interface ListRunsRequest {
  /** 按运行状态过滤（queued/running/succeeded/failed）。 */
  status?: string;
  /** 页码（从 1 开始）。 */
  page?: number;
  /** 每页条数。 */
  pageSize?: number;
  /** 起始时间过滤（ISO 字符串，按 createdAt）。 */
  from?: string;
  /** 结束时间过滤（ISO 字符串，按 createdAt）。 */
  to?: string;
}

/** 查询调度运行历史响应（V2）：运行记录分页 + 当前活跃方案列表。 */
export interface ListRunsResponse {
  runs: SchedulingRun[];
  plans: SchedulingPlanV2[];
  total: number;
  page: number;
  pageSize: number;
}

/** 审批方案请求（V2） */
export interface ApprovePlanRequest {
  version: number;
  snapshotVersion: string;
  operator?: string;
  reason?: string;
}

/** 拒绝方案请求（V2） */
export interface RejectPlanRequest {
  operator?: string;
  reason?: string;
}

/** 重排方案请求（V2） */
export interface ReplanRequest {
  lockedConstraints: SchedulingConstraint[];
  operator?: string;
  reason?: string;
}

/** 路由计算请求（V2） */
export interface CalculateRouteRequest {
  personId: string;
  taskId: string;
}

/** 调度冲突严重度。 */
export type ConflictSeverity = 'critical' | 'high' | 'medium' | 'low';

/** 调度冲突作用域。 */
export type SchedulingConflictScope = 'task' | 'resource' | 'plan' | 'route' | 'global';

/** 统一调度冲突类型（命令图冲突面板 / 冲突中心）。 */
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
  | 'reservation_conflict';

/** 统一调度冲突（V2）：由真实世界状态/预占/方案聚合推导，不虚构。 */
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

/** 查询调度冲突请求（V2）。 */
export interface ConflictsListRequest {
  type?: SchedulingConflictType;
  severity?: ConflictSeverity;
  scope?: SchedulingConflictScope;
  resourceId?: string;
}

/** 查询调度冲突响应（V2）。 */
export interface ConflictsListResponse {
  conflicts: SchedulingConflict[];
  total: number;
}
