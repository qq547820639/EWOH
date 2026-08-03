-- ============================================================
-- EWOH Schema 扩展：真机数据直连（皮肤+内脏+肢体）
-- 对应 spec：realtime-ingest-and-gamification §3
-- 幂等设计：所有 ALTER 使用 ADD COLUMN IF NOT EXISTS + DEFAULT
-- ============================================================

-- ============================================================
-- 1. ewoh_telemetry 扩展（14 列）
--    承接 UnifiedExoFrame.to_storage_dict() 真机外骨骼数据
-- ============================================================
ALTER TABLE ewoh_telemetry
  ADD COLUMN IF NOT EXISTS source_type varchar(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS record_id varchar(64),
  ADD COLUMN IF NOT EXISTS ingested_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS raw_ref varchar(128),
  ADD COLUMN IF NOT EXISTS joint_angles jsonb,
  ADD COLUMN IF NOT EXISTS angular_velocity_dps real,
  ADD COLUMN IF NOT EXISTS assist_level varchar(50),
  ADD COLUMN IF NOT EXISTS torque_nm real,
  ADD COLUMN IF NOT EXISTS cumulative_load_score real,
  ADD COLUMN IF NOT EXISTS temperature_c real,
  ADD COLUMN IF NOT EXISTS fault_code varchar(100),
  ADD COLUMN IF NOT EXISTS packet_loss_pct real DEFAULT 0,
  ADD COLUMN IF NOT EXISTS data_confidence real DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS data_quality varchar(20) DEFAULT 'good';

-- 回填存量模拟数据 source_type
UPDATE ewoh_telemetry
SET source_type = 'simulated'
WHERE source_type IS NULL;

-- ============================================================
-- 2. ewoh_device 扩展（7 列）
--    承接设备元信息（固件/硬件/协议版本 + 运维状态）
-- ============================================================
ALTER TABLE ewoh_device
  ADD COLUMN IF NOT EXISTS source_type varchar(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS firmware_version varchar(100),
  ADD COLUMN IF NOT EXISTS hardware_version varchar(100),
  ADD COLUMN IF NOT EXISTS protocol_version varchar(50),
  ADD COLUMN IF NOT EXISTS temperature_c real,
  ADD COLUMN IF NOT EXISTS fault_code varchar(100),
  ADD COLUMN IF NOT EXISTS last_raw_ref varchar(128);

UPDATE ewoh_device
SET source_type = 'simulated'
WHERE source_type IS NULL;

-- ============================================================
-- 3. ewoh_event 扩展（3 列）
--    承接规则引擎证据链
-- ============================================================
ALTER TABLE ewoh_event
  ADD COLUMN IF NOT EXISTS source_type varchar(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS trigger_record_id varchar(64),
  ADD COLUMN IF NOT EXISTS evidence_json jsonb;

UPDATE ewoh_event
SET source_type = 'simulated'
WHERE source_type IS NULL;

-- ============================================================
-- 4. ewoh_environment 扩展（3 列）
--    承接环境传感器真机数据
-- ============================================================
ALTER TABLE ewoh_environment
  ADD COLUMN IF NOT EXISTS source_type varchar(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS record_id varchar(64),
  ADD COLUMN IF NOT EXISTS data_confidence real DEFAULT 1.0;

UPDATE ewoh_environment
SET source_type = 'simulated'
WHERE source_type IS NULL;

-- ============================================================
-- 5. 索引（3 个，幂等创建）
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_telemetry_source
  ON ewoh_telemetry (source_type);

CREATE INDEX IF NOT EXISTS idx_telemetry_record
  ON ewoh_telemetry (record_id);

CREATE INDEX IF NOT EXISTS idx_event_source
  ON ewoh_event (source_type);

-- ============================================================
-- 6. 注释（便于运维查阅）
-- ============================================================
COMMENT ON COLUMN ewoh_telemetry.source_type IS '数据来源：simulated/real/controlled_test';
COMMENT ON COLUMN ewoh_telemetry.record_id IS '原始记录ID（UUID，幂等去重用）';
COMMENT ON COLUMN ewoh_telemetry.raw_ref IS '原始报文哈希（SHA256，幂等去重用）';
COMMENT ON COLUMN ewoh_telemetry.data_quality IS '数据质量：good/degraded/invalid';
COMMENT ON COLUMN ewoh_event.source_type IS '事件来源：simulated/real/controlled_test';
COMMENT ON COLUMN ewoh_event.trigger_record_id IS '触发该事件的遥测记录ID';
COMMENT ON COLUMN ewoh_event.evidence_json IS '证据快照（触发时关键指标）';
