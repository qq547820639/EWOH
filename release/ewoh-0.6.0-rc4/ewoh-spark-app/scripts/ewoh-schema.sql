-- EWOH 平台数据库表结构
-- 在 Miaoda PostgreSQL 中创建设备、事件、遥测三张业务表

-- 设备表
CREATE TABLE IF NOT EXISTS ewoh_device (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL UNIQUE,
  worker_name VARCHAR(255),
  device_model VARCHAR(255),
  battery_pct INTEGER DEFAULT 100,
  online BOOLEAN DEFAULT FALSE,
  last_telemetry_at TIMESTAMPTZ,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 事件表
CREATE TABLE IF NOT EXISTS ewoh_event (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL UNIQUE,
  device_id VARCHAR(255),
  event_code VARCHAR(255),
  event_type VARCHAR(255),
  severity VARCHAR(255),
  title VARCHAR(500),
  status VARCHAR(255) DEFAULT 'open',
  created_at TIMESTAMPTZ,
  handler_action TEXT,
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 遥测表
CREATE TABLE IF NOT EXISTS ewoh_telemetry (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  pitch_deg REAL,
  load_score REAL,
  fatigue_trend REAL,
  battery_pct INTEGER,
  quality_status VARCHAR(255),
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_ewoh_event_status ON ewoh_event(status);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_created_at ON ewoh_event(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ewoh_telemetry_device_ts ON ewoh_telemetry(device_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_ewoh_device_online ON ewoh_device(online);
