-- EWOH 深化：完整世界模型数据库扩展
-- 在妙搭 PostgreSQL 中新增 8 张表 + 空间实体种子数据

-- 1. 空间实体表
CREATE TABLE IF NOT EXISTS ewoh_spatial_entity (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_id VARCHAR(255) NOT NULL UNIQUE,
  entity_type VARCHAR(100) NOT NULL,
  parent_id VARCHAR(255),
  name VARCHAR(255) NOT NULL,
  x REAL DEFAULT 0,
  y REAL DEFAULT 0,
  yaw REAL DEFAULT 0,
  bbox_w REAL DEFAULT 0,
  bbox_h REAL DEFAULT 0,
  status VARCHAR(100) DEFAULT 'active',
  source_type VARCHAR(50) DEFAULT 'seed',
  confidence REAL DEFAULT 1.0,
  version INTEGER DEFAULT 1,
  extra JSONB,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_entity_type ON ewoh_spatial_entity(entity_type);
CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_entity_parent ON ewoh_spatial_entity(parent_id);

-- 2. 空间拓扑表
CREATE TABLE IF NOT EXISTS ewoh_topology (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_entity VARCHAR(255) NOT NULL,
  to_entity VARCHAR(255) NOT NULL,
  relation VARCHAR(100) NOT NULL DEFAULT 'adjacent',
  distance REAL DEFAULT 0,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_topology_from ON ewoh_topology(from_entity);

-- 3. 世界状态快照表
CREATE TABLE IF NOT EXISTS ewoh_world_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_id VARCHAR(255) NOT NULL,
  state_json JSONB NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_world_state_entity_ts ON ewoh_world_state(entity_id, ts DESC);

-- 4. 事件因果链表
CREATE TABLE IF NOT EXISTS ewoh_event_chain (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL,
  parent_event_id VARCHAR(255),
  causal_type VARCHAR(100) DEFAULT 'triggered',
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_chain_event ON ewoh_event_chain(event_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_chain_parent ON ewoh_event_chain(parent_event_id);

-- 5. 调度方案表
CREATE TABLE IF NOT EXISTS ewoh_schedule_plan (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  plan_id VARCHAR(255) NOT NULL UNIQUE,
  plan_name VARCHAR(255) NOT NULL,
  strategy VARCHAR(100) NOT NULL,
  status VARCHAR(50) DEFAULT 'shadow',
  takt_improvement REAL DEFAULT 0,
  high_load_persons INTEGER DEFAULT 0,
  low_battery_risk INTEGER DEFAULT 0,
  affected_persons INTEGER DEFAULT 0,
  metrics_json JSONB,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  confirmed_by VARCHAR(255),
  confirmed_at TIMESTAMPTZ,
  confirm_reason TEXT,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_plan_status ON ewoh_schedule_plan(status);

-- 6. 调度审计表
CREATE TABLE IF NOT EXISTS ewoh_schedule_audit (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  audit_id VARCHAR(255) NOT NULL UNIQUE,
  plan_id VARCHAR(255) NOT NULL,
  action VARCHAR(100) NOT NULL,
  operator VARCHAR(255),
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_audit_plan ON ewoh_schedule_audit(plan_id);

-- 7. 模型注册表
CREATE TABLE IF NOT EXISTS ewoh_model_registry (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  model_id VARCHAR(255) NOT NULL UNIQUE,
  model_name VARCHAR(255) NOT NULL,
  version VARCHAR(50) NOT NULL,
  type VARCHAR(100) NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  card_json JSONB,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 8. 环境传感器表
CREATE TABLE IF NOT EXISTS ewoh_environment (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  sensor_id VARCHAR(255) NOT NULL,
  entity_id VARCHAR(255),
  temperature REAL,
  vibration REAL,
  noise REAL,
  air_quality REAL,
  ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_environment_sensor_ts ON ewoh_environment(sensor_id, ts DESC);

-- ===== 空间实体种子数据 =====
-- 1 工厂
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version) VALUES
('F-01', 'factory', NULL, 'EWOH 智能工厂', 500, 350, 0, 1000, 700, 'active', 'seed', 1.0, 1);

-- 1 车间
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version) VALUES
('WS-MAIN', 'workshop', 'F-01', '总装车间', 500, 350, 0, 900, 600, 'active', 'seed', 1.0, 1);

-- 1 产线
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version) VALUES
('PL-01', 'production_line', 'WS-MAIN', '装配线A', 500, 350, 0, 800, 500, 'active', 'seed', 1.0, 1);

-- 2 区域
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version) VALUES
('AREA-ASSY', 'zone', 'PL-01', '装配区', 265, 250, 0, 450, 300, 'active', 'seed', 1.0, 1),
('AREA-LOG', 'zone', 'PL-01', '物流区', 730, 250, 0, 380, 300, 'active', 'seed', 1.0, 1);

-- 4 工位
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version) VALUES
('WS-01', 'workstation', 'AREA-ASSY', '装配工位1', 145, 200, 0, 80, 60, 'active', 'seed', 1.0, 1),
('WS-02', 'workstation', 'AREA-ASSY', '装配工位2', 290, 200, 0, 80, 60, 'active', 'seed', 1.0, 1),
('WS-03', 'workstation', 'AREA-ASSY', '检测工位', 435, 200, 0, 80, 60, 'active', 'seed', 1.0, 1),
('WS-04', 'workstation', 'AREA-LOG', '物流工位', 680, 200, 0, 100, 80, 'active', 'seed', 1.0, 1);

-- 8 设备（外骨骼）
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version, extra) VALUES
('EXO-001', 'device', 'WS-01', '外骨骼-001', 145, 200, 0, 12, 12, 'online', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-A","worker_id":"W-001"}'::jsonb),
('EXO-002', 'device', 'WS-02', '外骨骼-002', 290, 200, 0, 12, 12, 'online', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-A","worker_id":"W-002"}'::jsonb),
('EXO-003', 'device', 'WS-03', '外骨骼-003', 435, 200, 0, 12, 12, 'online', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-B","worker_id":"W-003"}'::jsonb),
('EXO-004', 'device', 'WS-04', '外骨骼-004', 680, 200, 0, 12, 12, 'online', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-B","worker_id":"W-004"}'::jsonb),
('EXO-005', 'device', 'WS-01', '外骨骼-005', 170, 230, 0, 12, 12, 'online', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-A","worker_id":"W-005"}'::jsonb),
('EXO-006', 'device', 'WS-02', '外骨骼-006', 315, 230, 0, 12, 12, 'offline', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-A","worker_id":"W-006"}'::jsonb),
('EXO-007', 'device', 'WS-03', '外骨骼-007', 460, 230, 0, 12, 12, 'online', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-B","worker_id":"W-007"}'::jsonb),
('EXO-008', 'device', 'WS-04', '外骨骼-008', 705, 230, 0, 12, 12, 'online', 'seed', 1.0, 1, '{"device_model":"EXO-Pro-B","worker_id":"W-008"}'::jsonb);

-- 8 人员
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version, extra) VALUES
('W-001', 'person', 'WS-01', '人员-001', 145, 195, 180, 8, 8, 'active', 'seed', 0.95, 1, '{"device_id":"EXO-001","task":"装配作业","load_score":0.35}'::jsonb),
('W-002', 'person', 'WS-02', '人员-002', 290, 195, 180, 8, 8, 'active', 'seed', 0.92, 1, '{"device_id":"EXO-002","task":"装配作业","load_score":0.45}'::jsonb),
('W-003', 'person', 'WS-03', '人员-003', 435, 195, 180, 8, 8, 'active', 'seed', 0.88, 1, '{"device_id":"EXO-003","task":"质量检测","load_score":0.25}'::jsonb),
('W-004', 'person', 'WS-04', '人员-004', 680, 195, 180, 8, 8, 'active', 'seed', 0.90, 1, '{"device_id":"EXO-004","task":"物料搬运","load_score":0.65}'::jsonb),
('W-005', 'person', 'WS-01', '人员-005', 170, 225, 90, 8, 8, 'active', 'seed', 0.85, 1, '{"device_id":"EXO-005","task":"辅助装配","load_score":0.30}'::jsonb),
('W-006', 'person', 'WS-02', '人员-006', 315, 225, 270, 8, 8, 'idle', 'seed', 0.80, 1, '{"device_id":"EXO-006","task":"休息","load_score":0.10}'::jsonb),
('W-007', 'person', 'WS-03', '人员-007', 460, 225, 90, 8, 8, 'active', 'seed', 0.87, 1, '{"device_id":"EXO-007","task":"质量检测","load_score":0.28}'::jsonb),
('W-008', 'person', 'WS-04', '人员-008', 705, 225, 270, 8, 8, 'active', 'seed', 0.91, 1, '{"device_id":"EXO-008","task":"物料搬运","load_score":0.72}'::jsonb);

-- 4 摄像头
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version, extra) VALUES
('CAM-01', 'camera', 'AREA-ASSY', '摄像头-装配区1', 145, 120, 180, 12, 12, 'online', 'seed', 1.0, 1, '{"fov_deg":75,"range_m":12,"height_m":3.5,"floor":1}'::jsonb),
('CAM-02', 'camera', 'AREA-ASSY', '摄像头-装配区2', 385, 120, 180, 12, 12, 'online', 'seed', 1.0, 1, '{"fov_deg":75,"range_m":12,"height_m":3.5,"floor":1}'::jsonb),
('CAM-03', 'camera', 'AREA-LOG', '摄像头-物流区1', 630, 120, 180, 12, 12, 'online', 'seed', 1.0, 1, '{"fov_deg":80,"range_m":15,"height_m":4.0,"floor":1}'::jsonb),
('CAM-04', 'camera', 'AREA-LOG', '摄像头-物流区2', 810, 120, 180, 12, 12, 'offline', 'seed', 1.0, 1, '{"fov_deg":80,"range_m":15,"height_m":4.0,"floor":1}'::jsonb);

-- 3 UWB 基站
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version, extra) VALUES
('UWB-BS-01', 'uwb_station', 'AREA-ASSY', 'UWB基站-装配区', 265, 280, 0, 10, 10, 'online', 'seed', 1.0, 1, '{"coverage_r":180,"height_m":4.0,"floor":1,"accuracy_m":0.3}'::jsonb),
('UWB-BS-02', 'uwb_station', 'AREA-LOG', 'UWB基站-物流区', 730, 280, 0, 10, 10, 'online', 'seed', 1.0, 1, '{"coverage_r":180,"height_m":4.0,"floor":1,"accuracy_m":0.3}'::jsonb),
('UWB-BS-03', 'uwb_station', 'PL-01', 'UWB基站-中央通道', 500, 350, 0, 10, 10, 'online', 'seed', 1.0, 1, '{"coverage_r":250,"height_m":4.0,"floor":1,"accuracy_m":0.5}'::jsonb);

-- 路线/通道
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version) VALUES
('ROUTE-01', 'route', 'PL-01', '主通道', 500, 400, 0, 800, 40, 'active', 'seed', 1.0, 1);

-- 禁区
INSERT INTO ewoh_spatial_entity (entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version) VALUES
('ZONE-RESTRICT-01', 'restricted_zone', 'PL-01', '设备禁区', 900, 500, 0, 80, 80, 'active', 'seed', 1.0, 1);

-- 拓扑关系
INSERT INTO ewoh_topology (from_entity, to_entity, relation, distance) VALUES
('WS-01', 'WS-02', 'adjacent', 145),
('WS-02', 'WS-03', 'adjacent', 145),
('WS-03', 'WS-04', 'adjacent', 245),
('WS-01', 'AREA-ASSY', 'belongs_to', 0),
('WS-02', 'AREA-ASSY', 'belongs_to', 0),
('WS-03', 'AREA-ASSY', 'belongs_to', 0),
('WS-04', 'AREA-LOG', 'belongs_to', 0),
('AREA-ASSY', 'AREA-LOG', 'connected', 265),
('AREA-ASSY', 'ROUTE-01', 'connected', 50),
('AREA-LOG', 'ROUTE-01', 'connected', 50);

-- 模型注册表种子数据
INSERT INTO ewoh_model_registry (model_id, model_name, version, type, status, card_json) VALUES
('MODEL-RULE-001', '姿态阈值规则', 'v1.0', 'rule', 'active', '{"description":"姿态角超阈值检测","threshold_deg":45}'::jsonb),
('MODEL-RULE-002', '高负荷时长规则', 'v1.0', 'rule', 'active', '{"description":"高负荷持续时间检测","threshold_sec":300}'::jsonb),
('MODEL-RULE-003', '电量预测规则', 'v1.0', 'rule', 'active', '{"description":"电量低阈值检测","threshold_pct":20}'::jsonb),
('MODEL-ACTION-001', '动作识别模型', 'v0.1', 'ml', 'shadow', '{"description":"12类动作识别","classes":["stand","walk","bend","lift","lower","carry","reach","push","pull","kneel","idle","unknown"]}'::jsonb);
