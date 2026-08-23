-- standalone_066_event_envelope_columns 回滚
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚后回到 standalone_065 前水平（ewoh_event 无 envelope 列）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_event_occurred_at;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_event_correlation_id;

ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS occurred_at;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS observed_at;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS received_at;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS causation_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS correlation_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS confidence;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS schema_version;

SELECT 1 AS standalone_066_rollback_verified;
