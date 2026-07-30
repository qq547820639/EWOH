-- EWOH 受控试点系统 初始建表脚本（SQLite 子集，postgres 兼容）
-- 说明：
--   1) 开发/单机默认通过 Storage.init_db 自动执行幂等 CREATE TABLE IF NOT EXISTS，
--      本脚本与 edge/storage.py 中 _SCHEMA 完全对齐，仅供 postgres 迁移或人工新建库使用。
--   2) SQLite 路径下若已由 Storage.init_db 创建，本脚本所有 CREATE TABLE IF NOT EXISTS
--      均为幂等空操作。
--   3) PostgreSQL 中执行：psql -d ewoh -f migrations/001_initial.sql

-- 人员
CREATE TABLE IF NOT EXISTS person (
  person_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  team TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]',
  consent_status TEXT NOT NULL DEFAULT 'unknown',
  active INTEGER NOT NULL DEFAULT 1
);

-- 设备
CREATE TABLE IF NOT EXISTS device (
  device_id TEXT PRIMARY KEY,
  device_type TEXT NOT NULL,
  model TEXT NOT NULL,
  firmware_version TEXT,
  person_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  last_seen TEXT
);

-- 遥测（高频）
CREATE TABLE IF NOT EXISTS telemetry (
  record_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  seq INTEGER,
  payload_json TEXT NOT NULL,
  quality_status TEXT NOT NULL,
  source_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telemetry_device_ts ON telemetry(device_id, ts);

-- 推理结果
CREATE TABLE IF NOT EXISTS inference (
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

-- 风险事件
CREATE TABLE IF NOT EXISTS risk_event (
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

-- 原始帧字节留存（线协议追溯）
CREATE TABLE IF NOT EXISTS raw_frame (
  record_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  seq INTEGER,
  frame_type INTEGER,
  raw_bytes BLOB,
  source_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_frame_device_ts ON raw_frame(device_id, ts);

-- 操作审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  before_json TEXT,
  after_json TEXT,
  ts TEXT NOT NULL,
  request_id TEXT,
  source_ip TEXT,
  result TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- 授权记录
CREATE TABLE IF NOT EXISTS consent_record (
  consent_id TEXT PRIMARY KEY,
  person_id TEXT,
  granted_at TEXT,
  withdrawn_at TEXT,
  scope TEXT,
  source TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_record_person ON consent_record(person_id);

-- 设备协议版本注册表（按 device_model 维度）
CREATE TABLE IF NOT EXISTS device_protocol_version (
  device_model TEXT PRIMARY KEY,
  protocol_version TEXT NOT NULL,
  firmware_min TEXT,
  firmware_max TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);

-- 事件处置流水（评论/状态变更留痕，与 risk_event 多对一）
CREATE TABLE IF NOT EXISTS event_handling (
  handling_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  action TEXT NOT NULL,
  operator TEXT,
  handled_at TEXT NOT NULL,
  comment_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_handling_event ON event_handling(event_id);

-- 人工确认派工流水（持久化版）
CREATE TABLE IF NOT EXISTS assignment (
  task_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  confirmer TEXT,
  status TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (task_id, person_id)
);

-- 模型注册表（model_id + version 双主键，激活态互斥）
CREATE TABLE IF NOT EXISTS model_registry (
  model_id TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT,
  activated_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT,
  card_path TEXT,
  PRIMARY KEY (model_id, version)
);

-- 规则注册表
CREATE TABLE IF NOT EXISTS rule_registry (
  rule_id TEXT NOT NULL,
  version TEXT NOT NULL,
  config_json TEXT,
  activated_by TEXT,
  activated_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id, version)
);

-- 迁移版本表
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
