-- EWOH Command Map 智能调度 — SSE 统一 Envelope + 观测列 (Phase 4 / P4-SSE+P4-OBS, standalone_021)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等）。
--
-- 1) ewoh_outbox.correlation_id：全链路关联（触发 → run → plan → dispatch → execution → KPI）。
-- 2) ewoh_scheduling_feedback.correlation_id 对齐（执行反馈与事件链路同源）。
-- 3) sequence 索引：SSE 按 sequence 顺序回放与 Last-Event-ID 续传加速。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox
  ADD COLUMN IF NOT EXISTS correlation_id varchar(255);

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback
  ADD COLUMN IF NOT EXISTS correlation_id varchar(255);

CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_sequence_asc
  ON __EWOH_SCHEMA__.ewoh_outbox (sequence);
CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_correlation
  ON __EWOH_SCHEMA__.ewoh_outbox (correlation_id);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_outbox.correlation_id IS 'SSE 统一 Envelope 关联 ID（run/plan/execution 全链路）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_feedback.correlation_id IS '执行反馈关联 ID（与 outbox 事件同源）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback TO service_role;
