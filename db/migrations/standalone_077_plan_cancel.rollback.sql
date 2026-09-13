-- EWOH 方案取消/回滚列回滚 (standalone_077)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP COLUMN IF EXISTS cancelled_reason,
  DROP COLUMN IF EXISTS cancelled_by,
  DROP COLUMN IF EXISTS cancelled_at;
