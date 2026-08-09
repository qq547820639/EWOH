-- standalone_016_task_requirement 回滚：删除新增列（幂等）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS required_device_capabilities;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS candidate_stations;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS required_skills;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS required_certifications;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS predecessor_ids;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel DROP COLUMN IF EXISTS certifications;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_production_task_required_device_caps;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel DROP COLUMN IF EXISTS version;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task DROP COLUMN IF EXISTS version;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment DROP COLUMN IF EXISTS decision_trace_json;
