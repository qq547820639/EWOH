-- 101 回滚：恢复 043 的原始 5-reason 约束。
-- 新 reason（clock_drift_future / event_write_failed）不允许静默删除。
-- 必须先在同一会话显式设置：
--   SET app.allow_evidence_deletion = '1';
-- 回滚会将受影响行原样隔离到 ewoh_dead_letter_rollback_quarantine，
-- 供人工导出/审计；随后才删除源表中的这些行并恢复约束。
DO $$
BEGIN
  IF COALESCE(current_setting('app.allow_evidence_deletion', true), '') <> '1' THEN
    RAISE EXCEPTION 'dead-letter evidence rollback requires explicit session GUC app.allow_evidence_deletion=1';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_dead_letter_rollback_quarantine
  (LIKE __EWOH_SCHEMA__.ewoh_dead_letter INCLUDING ALL);

INSERT INTO __EWOH_SCHEMA__.ewoh_dead_letter_rollback_quarantine
SELECT *
FROM __EWOH_SCHEMA__.ewoh_dead_letter
WHERE reason IN ('clock_drift_future', 'event_write_failed');

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
