-- standalone_020_policy_lifecycle 回滚（幂等；保留 status 列但还原 active 语义）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_policy_activation;

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS shadow_policy_version;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS is_shadow;

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy DROP COLUMN IF EXISTS status;
