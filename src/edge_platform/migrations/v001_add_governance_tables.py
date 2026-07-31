"""Task 14.2 / 14.3 迁移脚本 v001：新增 7 张治理与审计表。

从旧 schema（仅 person/device/telemetry/inference/risk_event 五张表）升级到新 schema，
追加：device_protocol_version / event_handling / assignment / model_registry /
rule_registry / consent_record / audit_log。

幂等性：全部使用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，
对已存在表与旧数据无副作用，可重复执行。
纯 Python 标准库（sqlite3）。
"""

import sqlite3

VERSION = "001"

# 新增表的 DDL（与 edge_platform.stubs.SCHEMA 中治理表部分保持一致）
MIGRATION = """
-- 设备协议版本登记（固件升级追溯）
CREATE TABLE IF NOT EXISTS device_protocol_version (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  firmware_version TEXT,
  hardware_version TEXT,
  upgraded_at TEXT NOT NULL,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_device_protocol_version_device ON device_protocol_version(device_id);

-- 事件处置记录
CREATE TABLE IF NOT EXISTS event_handling (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  handler_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  handled_at TEXT NOT NULL,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_handling_event ON event_handling(event_id);

-- 派工记录
CREATE TABLE IF NOT EXISTS assignment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id TEXT UNIQUE NOT NULL,
  task_id TEXT,
  person_id TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  recommended_by TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_assignment_person ON assignment(person_id);
CREATE INDEX IF NOT EXISTS idx_assignment_status ON assignment(status);

-- 模型注册表
CREATE TABLE IF NOT EXISTS model_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT UNIQUE NOT NULL,
  model_type TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  model_card_uri TEXT,
  registered_at TEXT NOT NULL,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_registry_type_status ON model_registry(model_type, status);

-- 规则注册表
CREATE TABLE IF NOT EXISTS rule_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT,
  severity TEXT,
  approver_id TEXT,
  effective_from TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(rule_id, rule_version)
);
CREATE INDEX IF NOT EXISTS idx_rule_registry_enabled ON rule_registry(enabled);

-- 授权记录
CREATE TABLE IF NOT EXISTS consent_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT UNIQUE NOT NULL,
  person_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revoke_reason TEXT,
  audit_ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_consent_record_person ON consent_record(person_id);
CREATE INDEX IF NOT EXISTS idx_consent_record_status ON consent_record(status);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT UNIQUE NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  result TEXT,
  request_id TEXT,
  source_ip TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_ts ON audit_log(action, ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_ts ON audit_log(actor_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_type, target_id);
"""


def upgrade(db):
    """在给定 sqlite3.Connection 上执行 v001 迁移（幂等）。

    接受 Connection 或 db_path 字符串。返回执行的语句条数（仅作记录，不计受影响行数）。
    """
    should_close = False
    if isinstance(db, str):
        db = sqlite3.connect(db)
        should_close = True
    try:
        db.executescript(MIGRATION)
        db.commit()
        return MIGRATION.count("CREATE TABLE IF NOT EXISTS")
    finally:
        if should_close:
            db.close()
