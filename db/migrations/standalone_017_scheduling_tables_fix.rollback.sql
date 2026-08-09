-- standalone_017_scheduling_tables_fix 回滚：删除补建的三张表（幂等）。
-- 注意：仅当表由本迁移补建（且不再被引用）时安全删除；DROP ... IF EXISTS 幂等。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_resource_reservation;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_outbox;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_scheduling_policy;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_replan_trigger;
