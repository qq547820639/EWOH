-- standalone_066_event_envelope_columns: ewoh_event 补全 Event Envelope 字段
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（ADR-009 / §5 / AD-EVENT-ENVELOPE-GAP）：ewoh_event 当前仅保留
-- created_at（事件记录时间）+ event_time（设备时间语义未显式），缺少
-- ADR-009 Event Envelope 六字段：occurred_at / observed_at / received_at /
-- causation_id / correlation_id / confidence / schema_version。
-- 全部 ADD COLUMN IF NOT EXISTS（存量数据保留，新列 nullable 向后兼容）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) 事件时间语义三列（ADR-009 occurred ≤ observed ≤ received，5min drift 容忍）。
ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  ADD COLUMN IF NOT EXISTS occurred_at timestamptz(6);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.occurred_at IS
  '事件发生时间（ADR-009 occurredAt；边缘设备时钟；NULL=边缘未上行）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  ADD COLUMN IF NOT EXISTS observed_at timestamptz(6);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.observed_at IS
  '事件观察时间（ADR-009 observedAt；边缘接收时间）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  ADD COLUMN IF NOT EXISTS received_at timestamptz(6);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.received_at IS
  '云端接收时间（ADR-009 receivedAt；ingest 写入时 now()）';

-- 2) 因果/关联/置信/版本四列。
ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  ADD COLUMN IF NOT EXISTS causation_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.causation_id IS
  '引起本事件的事件 ID（ADR-009 causationId；因果链追踪）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  ADD COLUMN IF NOT EXISTS correlation_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.correlation_id IS
  '关联事件组 ID（ADR-009 correlationId；同一流程所有事件共享）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  ADD COLUMN IF NOT EXISTS confidence numeric(5,4);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.confidence IS
  '事件置信度（ADR-009 confidence；0-1 范围；NULL=未声明）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  ADD COLUMN IF NOT EXISTS schema_version varchar(50);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.schema_version IS
  '事件模式版本（ADR-009 schemaVersion；1.0.0）';

-- 3) 按时间语义加索引（查询优化）。
CREATE INDEX IF NOT EXISTS idx_ewoh_event_occurred_at
  ON __EWOH_SCHEMA__.ewoh_event (occurred_at);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_correlation_id
  ON __EWOH_SCHEMA__.ewoh_event (correlation_id);

SELECT 1 AS standalone_066_verified;
