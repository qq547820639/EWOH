-- EWOH Intelligent Scheduling Workbench persistence rollback (Task 1)
-- DESTRUCTIVE: drops the tables created by standalone_006_scheduling.sql and
-- removes the V2 columns added to ewoh_schedule_plan.
-- Reverse dependency order; every DROP/ALTER guarded with IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_assignment_event CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_route_edge CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_route_node CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_world_state_snapshot CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_scheduling_constraint CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_scheduling_run CASCADE;

-- Remove the V2 columns added to ewoh_schedule_plan (indexes drop with the column).
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS version;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS snapshot_version;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS trigger_type;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS trigger_entity_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS baseline_delta_json;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS violations_json;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS superseded_by;