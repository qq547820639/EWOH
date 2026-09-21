-- standalone_104 回滚：只移除置信度范围约束。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_event
  DROP CONSTRAINT IF EXISTS chk_ewoh_event_confidence_range;

SELECT 1 AS standalone_104_rollback_verified;
