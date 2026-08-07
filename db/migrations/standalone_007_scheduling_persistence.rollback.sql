-- EWOH Intelligent Scheduling Workbench persistence rollback (Task 0.5)
-- DESTRUCTIVE: removes the columns added by standalone_007_scheduling_persistence.sql.
-- Every ALTER guarded with IF EXISTS / DROP COLUMN IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- Remove the columns added to ewoh_schedule_plan.
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS policy_version;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS solver_version;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS horizon_minutes;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN IF EXISTS score_breakdown_json;

-- Remove the columns added to ewoh_scheduling_plan_assignment.
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment DROP COLUMN IF EXISTS eta_seconds;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment DROP COLUMN IF EXISTS distance_meters;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment DROP COLUMN IF EXISTS risk_level;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment DROP COLUMN IF EXISTS score_breakdown_json;