-- standalone_021_sse_envelope 回滚（幂等）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox DROP COLUMN IF EXISTS correlation_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback DROP COLUMN IF EXISTS correlation_id;
