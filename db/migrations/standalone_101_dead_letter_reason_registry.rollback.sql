-- 101 rollback：恢复 043 的原始 5-reason 约束。
-- 新 reason（clock_drift_future / event_write_failed）的行会违反恢复后的约束，
-- 回滚前必须先显式删除（这些行不允许静默变形——人审/导出后删除）。

DELETE FROM __EWOH_SCHEMA__.ewoh_dead_letter
  WHERE reason IN ('clock_drift_future', 'event_write_failed');

ALTER TABLE __EWOH_SCHEMA__.ewoh_dead_letter
  DROP CONSTRAINT IF EXISTS chk_ewoh_dead_letter_reason;

ALTER TABLE __EWOH_SCHEMA__.ewoh_dead_letter
  ADD CONSTRAINT chk_ewoh_dead_letter_reason
  CHECK (reason IN (
    'contract_violation', 'unknown_event_type', 'permanent_failure',
    'ttl_expired', 'max_attempts_exceeded'
  ));
