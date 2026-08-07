-- EWOH Intelligent Scheduling Workbench persistence migration (Task 0.5)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ALTER TABLE ... ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- No physical foreign keys.
--
-- Adds the full SchedulingPlanV2 / SchedulingAssignment persistence columns so that
-- a persisted plan can be read back (round-trip) semantically equivalent to the
-- in-memory object:
--   1) ewoh_schedule_plan            — policy_version / solver_version / horizon_minutes / score_breakdown_json
--   2) ewoh_scheduling_plan_assignment — eta_seconds / distance_meters / risk_level / score_breakdown_json
--
-- Idempotent by construction: safe to run repeatedly without error or data loss.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ---------------------------------------------------------------------------
-- 1) ewoh_schedule_plan — full SchedulingPlanV2 metadata
-- ---------------------------------------------------------------------------
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS policy_version integer;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS solver_version varchar(100);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS horizon_minutes integer;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS score_breakdown_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.policy_version IS 'SchedulingPolicy.version used to solve this plan';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.solver_version IS 'Solver version used to solve this plan';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.horizon_minutes IS 'Scheduling horizon in minutes';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.score_breakdown_json IS 'Plan-level objective score breakdown';

-- ---------------------------------------------------------------------------
-- 2) ewoh_scheduling_plan_assignment — full SchedulingAssignment detail
-- ---------------------------------------------------------------------------
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment ADD COLUMN IF NOT EXISTS eta_seconds real;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment ADD COLUMN IF NOT EXISTS distance_meters real;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment ADD COLUMN IF NOT EXISTS risk_level varchar(50);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment ADD COLUMN IF NOT EXISTS score_breakdown_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment.eta_seconds IS 'Route ETA in seconds from the map-aligned route graph';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment.distance_meters IS 'Route distance in meters';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment.risk_level IS 'Route risk summary';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment.score_breakdown_json IS 'Assignment-level objective score breakdown';

-- ---------------------------------------------------------------------------
-- 3) Grants — mirror the service_role grant set used by standalone_006.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_plan TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment TO service_role;