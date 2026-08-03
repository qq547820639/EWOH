-- EWOH V0.5/V1.0 baseline schema (SQLite-compatible subset)
PRAGMA foreign_keys = ON;
CREATE TABLE person (
  person_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  team TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]',
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE device (
  device_id TEXT PRIMARY KEY,
  device_type TEXT NOT NULL,
  model TEXT NOT NULL,
  firmware_version TEXT,
  person_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  last_seen TEXT,
  FOREIGN KEY(person_id) REFERENCES person(person_id)
);
CREATE TABLE task (
  task_id TEXT PRIMARY KEY,
  task_name TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  required_skill TEXT,
  load_level REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_person_id TEXT
);
CREATE TABLE telemetry (
  record_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  seq INTEGER,
  payload_json TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  FOREIGN KEY(device_id) REFERENCES device(device_id)
);
CREATE INDEX idx_telemetry_device_ts ON telemetry(device_id, ts);
CREATE TABLE inference (
  inference_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts_start TEXT NOT NULL,
  ts_end TEXT NOT NULL,
  label TEXT NOT NULL,
  confidence REAL,
  model_id TEXT,
  model_version TEXT,
  evidence_json TEXT,
  source_type TEXT NOT NULL
);
CREATE TABLE risk_event (
  event_id TEXT PRIMARY KEY,
  event_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  person_id TEXT,
  device_id TEXT,
  task_id TEXT,
  zone_id TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  trigger_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  source_type TEXT NOT NULL,
  handling_json TEXT
);
CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ts TEXT NOT NULL
);

-- Embodied Factory OS extension (V0.7+): spatial / perception / world_model / scheduler / scenario / governance
-- 新增空间数字底座 / 感知融合 / 世界模型 / 决策调度 / 场景仿真 / 数据治理表，沿用 TEXT 主键、*_json TEXT、source_type TEXT NOT NULL、ISO 8601 时间戳约定。

-- ===== 空间数字底座 (SPATIAL) =====
-- 空间实体：集团→工厂→车间→产线→区域→工位→设备/人员/任务 的统一层级
CREATE TABLE spatial_entity (
  entity_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,            -- GROUP/FACTORY/WORKSHOP/LINE/ZONE/STATION/DEVICE/PERSON/TASK
  parent_id TEXT,                       -- 父级空间，自引用，可空
  name TEXT NOT NULL,
  pose_json TEXT,                       -- {x,y,z,yaw,confidence} 工厂坐标系位姿
  bbox_json TEXT,                       -- 边界框（最小外接矩形/盒）
  status TEXT,                          -- 实体当前状态
  source_type TEXT NOT NULL,            -- real/controlled_test/simulated
  confidence REAL,                      -- 实体置信度
  updated_at TEXT NOT NULL,             -- ISO 8601 更新时间
  version INTEGER NOT NULL DEFAULT 1,   -- 实体版本号，每次更新递增
  FOREIGN KEY(parent_id) REFERENCES spatial_entity(entity_id)
);
CREATE INDEX idx_spatial_entity_parent ON spatial_entity(parent_id);
CREATE INDEX idx_spatial_entity_type ON spatial_entity(entity_type);

-- 拓扑节点：工位/区域/通道在拓扑图中的节点
CREATE TABLE spatial_topology_node (
  node_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  label TEXT,
  FOREIGN KEY(entity_id) REFERENCES spatial_entity(entity_id)
);
CREATE INDEX idx_topology_node_entity ON spatial_topology_node(entity_id);

-- 拓扑边：节点之间的可达关系与路线
CREATE TABLE spatial_topology_edge (
  edge_id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  distance_m REAL,                      -- 行走距离（米）
  route_geojson TEXT,                   -- 路线 GeoJSON
  FOREIGN KEY(from_id) REFERENCES spatial_topology_node(node_id),
  FOREIGN KEY(to_id) REFERENCES spatial_topology_node(node_id)
);
CREATE INDEX idx_topology_edge_from ON spatial_topology_edge(from_id);
CREATE INDEX idx_topology_edge_to ON spatial_topology_edge(to_id);

-- 空间资产：统一输出 GeoJSON/GLB/3D Tiles/点云/Gaussian Splat/拓扑 JSON
CREATE TABLE spatial_asset (
  asset_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL,             -- GEOJSON/GLB/TILES_3D/POINTCLOUD/GAUSSIAN_SPLAT/TOPOLOGY_JSON
  lod TEXT NOT NULL,                    -- L0/L1/L2/L3 建模分级
  spatial_entity_id TEXT,               -- 关联空间实体
  uri TEXT NOT NULL,                    -- 资产访问路径
  version INTEGER NOT NULL DEFAULT 1,
  source_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  checksum TEXT,                        -- 完整性校验
  provenance TEXT,                      -- 来源溯源（CAD/扫描/摄影测量等）
  FOREIGN KEY(spatial_entity_id) REFERENCES spatial_entity(entity_id)
);
CREATE INDEX idx_spatial_asset_entity ON spatial_asset(spatial_entity_id);
CREATE INDEX idx_spatial_asset_lod ON spatial_asset(lod);

-- ===== 感知融合层 (PERCEPTION) =====
-- 融合状态：UWB + 外骨骼 IMU + 视觉骨架 + 设备状态 + 工位占用 + MES 任务 + 环境
CREATE TABLE fused_state (
  fused_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  device_id TEXT,                       -- 当前绑定外骨骼设备
  unified_pose_json TEXT,               -- 统一位置（融合后坐标/朝向/质量标记）
  posture_json TEXT,                    -- 人体姿态（骨架/关节角/身体倾角）
  current_action TEXT,                  -- 当前动作（unknown 强制可输出）
  workstation_id TEXT,                  -- 当前所在工位
  task_id TEXT,                         -- 当前任务
  binding_json TEXT,                    -- 人员—设备—任务绑定关系
  confidence REAL,                      -- 融合置信度
  source_type TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(person_id) REFERENCES person(person_id),
  FOREIGN KEY(device_id) REFERENCES device(device_id),
  FOREIGN KEY(task_id) REFERENCES task(task_id)
);
CREATE INDEX idx_fused_state_person_ts ON fused_state(person_id, updated_at);

-- ===== 世界模型层 (WORLD_MODEL) =====
-- 世界状态：实体在某时间窗口的状态快照
CREATE TABLE world_state (
  state_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,              -- 关联空间实体（逻辑外键，不强约束）
  state_type TEXT NOT NULL,             -- 状态类型（load/posture/device/task/zone/...）
  state_json TEXT NOT NULL,             -- 状态载荷
  valid_from TEXT NOT NULL,             -- 状态生效时间
  valid_to TEXT,                        -- 状态失效时间，空表示当前有效
  source_type TEXT NOT NULL,
  confidence REAL
);
CREATE INDEX idx_world_state_entity ON world_state(entity_id, valid_from, valid_to);

-- 事件图节点：感知冲突/预测/建议/确认/重分配/反馈等事件节点
CREATE TABLE event_graph_node (
  node_id TEXT PRIMARY KEY,
  event_id TEXT,                        -- 关联 risk_event，可空（非风险类事件）
  node_type TEXT NOT NULL,              -- sensor_conflict/prediction/suggestion/confirmation/reallocation/feedback/...
  payload_json TEXT NOT NULL,
  ts TEXT NOT NULL,
  causality_parent_id TEXT,             -- 因果链父节点，自引用，可空
  FOREIGN KEY(event_id) REFERENCES risk_event(event_id),
  FOREIGN KEY(causality_parent_id) REFERENCES event_graph_node(node_id)
);
CREATE INDEX idx_event_graph_node_parent ON event_graph_node(causality_parent_id);
CREATE INDEX idx_event_graph_node_ts ON event_graph_node(ts);

-- 事件图边：节点间关系（caused/followed/triggered/confirmed）
CREATE TABLE event_graph_edge (
  edge_id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  relation TEXT NOT NULL,               -- caused/followed/triggered/confirmed
  FOREIGN KEY(from_node) REFERENCES event_graph_node(node_id),
  FOREIGN KEY(to_node) REFERENCES event_graph_node(node_id)
);
CREATE INDEX idx_event_graph_edge_from ON event_graph_edge(from_node);
CREATE INDEX idx_event_graph_edge_to ON event_graph_edge(to_node);

-- ===== 决策与调度层 (SCHEDULER) =====
-- 调度请求：触发来源与状态流转
CREATE TABLE schedule_request (
  request_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  trigger_json TEXT NOT NULL,           -- 触发上下文（负荷/电量/积压/设备异常等）
  status TEXT NOT NULL,                 -- shadow/proposed/confirmed/rejected/executed
  requester_id TEXT                     -- 发起者（人/系统/班组长）
);
CREATE INDEX idx_schedule_request_status ON schedule_request(status, ts);

-- 调度候选：硬约束过滤后的人员候选与评分明细
CREATE TABLE schedule_candidate (
  candidate_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  score_json TEXT,                      -- 多目标分项评分（产量/准时率/安全/负荷/距离/换岗）
  hard_constraint_json TEXT,            -- 硬约束检查明细（含拦截原因）
  passed INTEGER NOT NULL DEFAULT 0,    -- 是否通过硬约束（0/1）
  rank INTEGER,                         -- 综合排名
  FOREIGN KEY(request_id) REFERENCES schedule_request(request_id),
  FOREIGN KEY(person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_schedule_candidate_request ON schedule_candidate(request_id, rank);
CREATE INDEX idx_schedule_candidate_person ON schedule_candidate(person_id);

-- 调度方案：至少三个方案（保持现状/最小调整/产能优先/安全负荷均衡/设备异常应急）
CREATE TABLE schedule_plan (
  plan_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  plan_type TEXT NOT NULL,              -- keep_current/minimal_adjust/capacity_first/safety_balanced/equipment_emergency
  metrics_json TEXT,                    -- 预计产量/延误风险/负荷变化/行走距离/电量消耗/拥堵变化等分项指标
  affected_persons_json TEXT,           -- 受影响人员清单
  assumptions_json TEXT,                -- 关键假设
  confidence REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id) REFERENCES schedule_request(request_id)
);
CREATE INDEX idx_schedule_plan_request ON schedule_plan(request_id);

-- 调度决策：人工确认记录，附理由与审计引用
CREATE TABLE schedule_decision (
  decision_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,          -- confirm/reject/modify
  actor_id TEXT NOT NULL,               -- 确认人（班组长或授权人员）
  reason TEXT,                          -- 选择理由（高风险建议必填）
  ts TEXT NOT NULL,
  audit_ref TEXT,                       -- 关联 audit_log
  FOREIGN KEY(plan_id) REFERENCES schedule_plan(plan_id)
);
CREATE INDEX idx_schedule_decision_plan ON schedule_decision(plan_id);

-- ===== 场景仿真层 (SCENARIO) =====
-- 仿真运行：调度前对方案的模拟执行结果
CREATE TABLE scenario_run (
  run_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  metrics_json TEXT,                    -- 仿真分项指标与对比基线
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id) REFERENCES schedule_request(request_id),
  FOREIGN KEY(plan_id) REFERENCES schedule_plan(plan_id)
);
CREATE INDEX idx_scenario_run_request ON scenario_run(request_id);
CREATE INDEX idx_scenario_run_plan ON scenario_run(plan_id);

-- ===== 数据治理与隐私扩展 (GOVERNANCE) =====
-- 授权记录扩展：员工数据采集授权与撤回
CREATE TABLE consent_record_ext (
  record_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  purpose TEXT NOT NULL,                -- 用途（调度/负荷分析/培训/安全复盘等）
  fields_json TEXT NOT NULL,            -- 授权采集字段范围
  granted_at TEXT NOT NULL,
  revoked_at TEXT,                      -- 撤回时间，空表示授权有效
  retention_rule TEXT,                  -- 适用保留策略
  audit_ref TEXT,                       -- 关联 audit_log
  FOREIGN KEY(person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_consent_record_person ON consent_record_ext(person_id, revoked_at);

-- 保留策略：分层保留周期
CREATE TABLE retention_policy (
  policy_id TEXT PRIMARY KEY,
  data_class TEXT NOT NULL,             -- high_freq_telemetry/minute_agg/event_evidence/schedule_task/audit_log/spatial_basemap/training_data
  retention_days INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  effective_from TEXT NOT NULL,
  note TEXT
);
CREATE INDEX idx_retention_policy_class ON retention_policy(data_class, effective_from);

-- 模型注册表扩展：动作识别/负荷评分/调度模型版本与生命周期
CREATE TABLE model_registry_ext (
  model_id TEXT PRIMARY KEY,
  model_type TEXT NOT NULL,             -- action_recognition/load_score/scheduler/...
  version TEXT NOT NULL,
  status TEXT NOT NULL,                 -- candidate/shadow/active/retired
  data_version TEXT,                    -- 训练数据版本
  feature_version TEXT,                 -- 特征版本
  threshold_version TEXT,               -- 阈值版本
  model_card_uri TEXT,                  -- 模型卡地址
  activated_at TEXT,
  retired_at TEXT,
  audit_ref TEXT                        -- 关联 audit_log
);
CREATE INDEX idx_model_registry_type_status ON model_registry_ext(model_type, status);
