// server/db.js — 数据库初始化与 CRUD
// 使用 better-sqlite3 同步 API，内存数据库（:memory:），进程退出即释放

const Database = require('better-sqlite3');
const crypto = require('crypto');

// 建表 SQL（IF NOT EXISTS 保证可重复执行）
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL UNIQUE,
  worker_name TEXT NOT NULL,
  device_model TEXT,
  firmware_version TEXT,
  battery_pct REAL DEFAULT 100,
  online INTEGER DEFAULT 1,
  last_telemetry_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  pitch_deg REAL,
  roll_deg REAL,
  torque_nm REAL,
  assist_pct REAL,
  battery_pct REAL,
  gyro_dps TEXT,            -- JSON 数组 [x, y, z]
  quality_status TEXT,      -- good / degraded / invalid
  confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_telem_device_ts ON telemetry(device_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  event_code TEXT NOT NULL,
  event_type TEXT NOT NULL,         -- L1 / L2
  severity TEXT,
  title TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open / handled / closed
  trigger_data TEXT,                -- JSON
  evidence TEXT,                    -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  handler_id TEXT,
  handler_action TEXT,
  handler_comment TEXT,
  handled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
CREATE INDEX IF NOT EXISTS idx_events_code ON events(event_code);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,
  rule_version INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  config TEXT,                      -- JSON
  severity TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_id TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_type TEXT,
  target_id TEXT,
  detail TEXT,                      -- JSON
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`;

// 预置设备数据
const SEED_DEVICES = [
  { device_id: 'EXO-001', worker_name: '工人张三', device_model: 'EXO-Pro X1', firmware_version: '2.4.1', battery_pct: 85 },
  { device_id: 'EXO-002', worker_name: '工人李四', device_model: 'EXO-Pro X1', firmware_version: '2.4.1', battery_pct: 70 },
  { device_id: 'EXO-003', worker_name: '工人王五', device_model: 'EXO-Lite S2', firmware_version: '1.9.3', battery_pct: 14 },
];

// 预置规则数据（与 rules.js 引擎配置保持一致）
const SEED_RULES = [
  {
    rule_id: 'R001', rule_version: 1, enabled: 1, severity: 'high',
    description: '深弯腰持续过久：pitch > 45° 持续 ≥10s',
    config: { event_code: 'POSTURE_BEND_LONG', event_type: 'L1', param: 'pitch_deg', op: '>', value: 45, threshold_sec: 10, cooldown_sec: 30 },
  },
  {
    rule_id: 'R002', rule_version: 1, enabled: 1, severity: 'medium',
    description: '持续高负荷：torque > 20Nm 持续 ≥8s',
    config: { event_code: 'LOAD_CONTINUOUS', event_type: 'L2', param: 'torque_nm', op: '>', value: 20, threshold_sec: 8, cooldown_sec: 30 },
  },
  {
    rule_id: 'R003', rule_version: 1, enabled: 1, severity: 'high',
    description: '电量过低：battery < 15%',
    config: { event_code: 'LOW_BATTERY', event_type: 'L1', param: 'battery_pct', op: '<', value: 15, threshold_sec: 0, cooldown_sec: 60 },
  },
  {
    rule_id: 'R004', rule_version: 1, enabled: 1, severity: 'high',
    description: '传感器降级：quality_status != good 持续 ≥5s',
    config: { event_code: 'SENSOR_DEGRADED', event_type: 'L1', param: 'quality_status', op: '!=', value: 'good', threshold_sec: 5, cooldown_sec: 30 },
  },
];

// 打开数据库连接（内存数据库，内存库不支持 WAL，使用默认内存日志）
function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

// 建表
function initSchema(db) {
  db.exec(SCHEMA_SQL);
}

// 预置设备 + 规则（仅在表为空时插入，避免重复）
function seedData(db) {
  const now = new Date().toISOString();

  const devCount = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  if (devCount === 0) {
    const insDev = db.prepare(
      'INSERT INTO devices (device_id, worker_name, device_model, firmware_version, battery_pct, online, last_telemetry_at, created_at) VALUES (@device_id, @worker_name, @device_model, @firmware_version, @battery_pct, 1, @now, @now)'
    );
    const tx = db.transaction((rows) => {
      for (const r of rows) insDev.run({ ...r, now });
    });
    tx(SEED_DEVICES);
  }

  const ruleCount = db.prepare('SELECT COUNT(*) AS c FROM rules').get().c;
  if (ruleCount === 0) {
    const insRule = db.prepare(
      'INSERT INTO rules (rule_id, rule_version, enabled, config, severity, description) VALUES (@rule_id, @rule_version, @enabled, @config, @severity, @description)'
    );
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        insRule.run({ ...r, config: JSON.stringify(r.config) });
      }
    });
    tx(SEED_RULES);
  }
}

// 一站式初始化：建表 + 预置数据，返回 db
function initDatabase() {
  const db = createDatabase();
  initSchema(db);
  seedData(db);
  return db;
}

// ============ 设备 CRUD ============

function listDevices(db) {
  return db.prepare('SELECT * FROM devices ORDER BY device_id').all();
}

function getDevice(db, deviceId) {
  return db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
}

// 模拟器每帧更新设备电量、在线状态、最后通信时间
function updateDeviceTelemetry(db, deviceId, { battery_pct, online, last_telemetry_at }) {
  db.prepare(
    'UPDATE devices SET battery_pct = ?, online = ?, last_telemetry_at = ? WHERE device_id = ?'
  ).run(battery_pct, online ? 1 : 0, last_telemetry_at, deviceId);
}

// ============ 遥测 CRUD ============

function insertTelemetry(db, row) {
  db.prepare(
    `INSERT INTO telemetry (device_id, ts, pitch_deg, roll_deg, torque_nm, assist_pct, battery_pct, gyro_dps, quality_status, confidence)
     VALUES (@device_id, @ts, @pitch_deg, @roll_deg, @torque_nm, @assist_pct, @battery_pct, @gyro_dps, @quality_status, @confidence)`
  ).run({
    ...row,
    gyro_dps: JSON.stringify(row.gyro_dps),
  });
}

function listTelemetry(db, { device_id, limit = 100, offset = 0 } = {}) {
  if (device_id) {
    return db.prepare(
      'SELECT * FROM telemetry WHERE device_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?'
    ).all(device_id, limit, offset);
  }
  return db.prepare('SELECT * FROM telemetry ORDER BY ts DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// 各设备最新一帧
function getLatestTelemetryByDevice(db, deviceId) {
  return db.prepare(
    'SELECT * FROM telemetry WHERE device_id = ? ORDER BY ts DESC LIMIT 1'
  ).get(deviceId);
}

function getLatestTelemetryAll(db) {
  const devices = listDevices(db);
  return devices.map((d) => getLatestTelemetryByDevice(db, d.device_id)).filter(Boolean);
}

// ============ 规则 CRUD ============

function listRules(db) {
  const rows = db.prepare('SELECT * FROM rules ORDER BY rule_id').all();
  return rows.map((r) => ({ ...r, config: safeParse(r.config), enabled: !!r.enabled }));
}

function getRule(db, ruleId) {
  const r = db.prepare('SELECT * FROM rules WHERE rule_id = ?').get(ruleId);
  if (r) {
    r.config = safeParse(r.config);
    r.enabled = !!r.enabled;
  }
  return r;
}

// 按 event_code 反查规则
function getRuleByCode(db, eventCode) {
  const rows = db.prepare('SELECT * FROM rules').all();
  for (const r of rows) {
    const cfg = safeParse(r.config);
    if (cfg && cfg.event_code === eventCode) {
      return { ...r, config: cfg, enabled: !!r.enabled };
    }
  }
  return undefined;
}

// ============ 审计日志 ============

function insertAudit(db, { action, actor_id, target_type, target_id, detail }) {
  const audit_id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO audit_log (audit_id, action, actor_id, target_type, target_id, detail, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(audit_id, action, actor_id || null, target_type || null, target_id || null, JSON.stringify(detail || {}), new Date().toISOString());
  return audit_id;
}

function listAudit(db, { action, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM audit_log';
  const params = [];
  if (action) {
    sql += ' WHERE action = ?';
    params.push(action);
  }
  sql += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return db.prepare(sql).all(...params).map(parseAuditRow);
}

function countAudit(db, { action } = {}) {
  if (action) {
    return db.prepare('SELECT COUNT(*) AS c FROM audit_log WHERE action = ?').get(action).c;
  }
  return db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
}

// ============ 系统统计 ============

function getSystemStats(db) {
  const deviceTotal = db.prepare('SELECT COUNT(*) AS c FROM devices').get().c;
  const deviceOnline = db.prepare('SELECT COUNT(*) AS c FROM devices WHERE online = 1').get().c;
  const openEvents = db.prepare("SELECT COUNT(*) AS c FROM events WHERE status = 'open'").get().c;
  const handledEvents = db.prepare("SELECT COUNT(*) AS c FROM events WHERE status = 'handled'").get().c;
  const closedEvents = db.prepare("SELECT COUNT(*) AS c FROM events WHERE status = 'closed'").get().c;
  const totalEvents = db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
  const telemetryTotal = db.prepare('SELECT COUNT(*) AS c FROM telemetry').get().c;
  const rulesEnabled = db.prepare('SELECT COUNT(*) AS c FROM rules WHERE enabled = 1').get().c;
  const rulesTotal = db.prepare('SELECT COUNT(*) AS c FROM rules').get().c;
  return {
    devices: { total: deviceTotal, online: deviceOnline, offline: deviceTotal - deviceOnline },
    events: { total: totalEvents, open: openEvents, handled: handledEvents, closed: closedEvents },
    telemetry: { total: telemetryTotal },
    rules: { total: rulesTotal, enabled: rulesEnabled },
  };
}

// ============ 工具函数 ============

function safeParse(str) {
  if (str == null) return null;
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
}

function parseAuditRow(row) {
  if (!row) return row;
  return { ...row, detail: safeParse(row.detail) };
}

module.exports = {
  SCHEMA_SQL,
  SEED_DEVICES,
  SEED_RULES,
  createDatabase,
  initSchema,
  seedData,
  initDatabase,
  // 设备
  listDevices,
  getDevice,
  updateDeviceTelemetry,
  // 遥测
  insertTelemetry,
  listTelemetry,
  getLatestTelemetryByDevice,
  getLatestTelemetryAll,
  // 规则
  listRules,
  getRule,
  getRuleByCode,
  // 审计
  insertAudit,
  listAudit,
  countAudit,
  // 统计
  getSystemStats,
  // 工具
  safeParse,
};
