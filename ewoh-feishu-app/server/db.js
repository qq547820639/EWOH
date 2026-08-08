// server/db.js — 数据库初始化与 CRUD
// 使用 better-sqlite3 同步 API。
//
// v1.1.0 加固（设计决策 D2）：
//   - 默认使用文件数据库 `data/ewoh-feishu.db`（WAL 模式 + busy_timeout），进程退出后数据持久化，
//     与「30s 全量同步 + 飞书回写」设计一致；`:memory:` 仅保留给测试/显式配置（EWOH_DB_PATH=:memory:）。
//   - 自动创建数据目录；建表使用 IF NOT EXISTS，可重复执行（幂等）。
//   - 新增 webhook_dedup 表：webhook 业务幂等（见 D3），以 (event_id, action_type) 唯一约束防重复处置。

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 默认数据文件路径（相对应用根目录）
const DEFAULT_DB_REL_PATH = path.join('data', 'ewoh-feishu.db');

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

-- v1.1.0 D3：webhook 业务幂等表。
-- 以 (event_id, action_type) 为唯一键：同一事件同一处置动作只允许执行一次，
-- 重复投递（网络重试 / 飞书重推）直接命中唯一约束，返回"已处理"，不重复改状态。
CREATE TABLE IF NOT EXISTS webhook_dedup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  actor_id TEXT,
  result TEXT,                      -- JSON
  UNIQUE (event_id, action_type)
);
CREATE INDEX IF NOT EXISTS idx_dedup_event ON webhook_dedup(event_id);
`;

// 预置设备数据
const SEED_DEVICES = [
  { device_id: 'EXO-001', worker_name: '工人张三', device_model: 'EXO-Pro X1', firmware_version: '2.4.1', battery_pct: 85 },
  { device_id: 'EXO-002', worker_name: '工人李四', device_model: 'EXO-Pro X1', firmware_version: '2.4.1', battery_pct: 70 },
  { device_id: 'EXO-003', worker_name: '工人王五', device_model: 'EXO-Lite S2', firmware_version: '1.9.3', battery_pct: 14 },
];

// 预置规则数据（规则引擎唯一事实源；rules.js 从本表读取配置并兜底使用默认常量）
// v1.1.0 D5：阈值参数（value / threshold_sec / cooldown_sec / op）全部收敛到 config，
// rules.js 不再硬编码第二份，消除双源漂移。
const SEED_RULES = [
  {
    rule_id: 'R001', rule_version: 1, enabled: 1, severity: 'high',
    description: '深弯腰持续过久：pitch > 45° 持续 ≥10s',
    config: {
      event_code: 'POSTURE_BEND_LONG', event_type: 'L1',
      title: '深弯腰持续过久', description: 'pitch > 45° 持续 ≥10s，存在腰部损伤风险',
      param: 'pitch_deg', op: '>', value: 45, threshold_sec: 10, cooldown_sec: 30,
    },
  },
  {
    rule_id: 'R002', rule_version: 1, enabled: 1, severity: 'medium',
    description: '持续高负荷：torque > 20Nm 持续 ≥8s',
    config: {
      event_code: 'LOAD_CONTINUOUS', event_type: 'L2',
      title: '持续高负荷', description: 'torque > 20Nm 持续 ≥8s，助力系统负荷过高',
      param: 'torque_nm', op: '>', value: 20, threshold_sec: 8, cooldown_sec: 30,
    },
  },
  {
    rule_id: 'R003', rule_version: 1, enabled: 1, severity: 'high',
    description: '电量过低：battery < 15%',
    config: {
      event_code: 'LOW_BATTERY', event_type: 'L1',
      title: '电量过低', description: 'battery < 15%，设备即将断电',
      param: 'battery_pct', op: '<', value: 15, threshold_sec: 0, cooldown_sec: 60,
    },
  },
  {
    rule_id: 'R004', rule_version: 1, enabled: 1, severity: 'high',
    description: '传感器降级：quality_status != good 持续 ≥5s',
    config: {
      event_code: 'SENSOR_DEGRADED', event_type: 'L1',
      title: '传感器降级', description: 'quality_status != good 持续 ≥5s，数据可信度下降',
      param: 'quality_status', op: '!=', value: 'good', threshold_sec: 5, cooldown_sec: 30,
    },
  },
];

// 解析数据库路径：
//  - 显式传入 dbPath（如 ':memory:' 或绝对/相对路径）→ 直接使用；
//  - 未传入 → 读取 EWOH_DB_PATH 环境变量，缺省为 data/ewoh-feishu.db；
//  - 返回 { dbPath, isMemory }，文件库自动确保父目录存在。
function resolveDbPath(dbPath) {
  const p = dbPath || process.env.EWOH_DB_PATH || DEFAULT_DB_REL_PATH;
  const isMemory = p === ':memory:';
  if (!isMemory && !path.isAbsolute(p)) {
    // 相对路径基于应用根目录（server/ 的上级）解析，保证无论从仓库根还是 app 目录启动都一致
    const resolved = path.resolve(__dirname, '..', p);
    return { dbPath: resolved, isMemory, original: p };
  }
  return { dbPath: p, isMemory, original: p };
}

// 打开数据库连接
//  - 文件库：WAL 模式 + busy_timeout（防并发写锁），返回 db；
//  - 内存库（:memory:）：仅测试/显式配置，使用默认内存日志（WAL 不适用于内存库）。
function createDatabase(dbPath) {
  const { dbPath: resolvedPath, isMemory } = resolveDbPath(dbPath);

  if (!isMemory) {
    const dir = path.dirname(resolvedPath);
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  db.pragma('foreign_keys = ON');
  if (!isMemory) {
    // WAL：读写并发友好，崩溃恢复安全（better-sqlite3 同步 API 下防多进程写竞争）
    db.pragma('journal_mode = WAL');
    // busy_timeout：多进程/多连接写竞争时等待而非立即报 SQLITE_BUSY
    db.pragma('busy_timeout = 5000');
  }
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
function initDatabase(dbPath) {
  const db = createDatabase(dbPath);
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

// ============ webhook 业务幂等（v1.1.0 D3）============

// 尝试登记一次 webhook 处置（幂等）。
// 返回 { duplicated: boolean, row }：
//   - duplicated=false：首次登记成功，调用方应继续执行处置；
//   - duplicated=true：该 (event_id, action_type) 已处理过，调用方应直接返回"已处理"。
// 依赖 events 表的 event_id 唯一约束 + webhook_dedup 的 (event_id, action_type) 唯一约束，
// 同一事件同一动作不可能被执行两次。
function tryAcquireWebhookDedup(db, { event_id, action_type, actor_id, result }) {
  if (!event_id || !action_type) {
    return { duplicated: false, row: null, error: 'missing event_id or action_type' };
  }
  const now = new Date().toISOString();
  const processedAt = now;
  try {
    db.prepare(
      `INSERT INTO webhook_dedup (event_id, action_type, processed_at, actor_id, result)
       VALUES (?, ?, ?, ?, ?)`
    ).run(event_id, action_type, processedAt, actor_id || null, JSON.stringify(result || {}));
    return { duplicated: false, row: { event_id, action_type, processed_at: processedAt } };
  } catch (e) {
    // SQLITE_CONSTRAINT_UNIQUE：重复投递 → 返回已处理标记
    if (String(e.code || e.message).includes('UNIQUE')) {
      const row = db.prepare(
        'SELECT * FROM webhook_dedup WHERE event_id = ? AND action_type = ?'
      ).get(event_id, action_type);
      return { duplicated: true, row: row || null };
    }
    throw e;
  }
}

// 查询是否已处理过（只读，不登记）
function hasWebhookProcessed(db, eventId, actionType) {
  const row = db.prepare(
    'SELECT * FROM webhook_dedup WHERE event_id = ? AND action_type = ?'
  ).get(eventId, actionType);
  return !!row;
}

// 更新幂等记录结果（处置成功后标记 done；供审计与幂等命中溯源）
function updateWebhookDedupResult(db, eventId, actionType, result) {
  db.prepare(
    'UPDATE webhook_dedup SET result = ? WHERE event_id = ? AND action_type = ?'
  ).run(JSON.stringify(result || {}), eventId, actionType);
}

// 删除幂等记录（处置失败时调用，允许重试）
function deleteWebhookDedup(db, eventId, actionType) {
  db.prepare(
    'DELETE FROM webhook_dedup WHERE event_id = ? AND action_type = ?'
  ).run(eventId, actionType);
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
  DEFAULT_DB_REL_PATH,
  resolveDbPath,
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
  // webhook 幂等
  tryAcquireWebhookDedup,
  hasWebhookProcessed,
  updateWebhookDedupResult,
  deleteWebhookDedup,
  // 统计
  getSystemStats,
  // 工具
  safeParse,
};
