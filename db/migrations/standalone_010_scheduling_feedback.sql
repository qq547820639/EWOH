-- EWOH Command Map 智能调度驾驶舱 — scheduling feedback table (Task 7)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- No physical foreign keys.
--
-- Adds ewoh_scheduling_feedback — an OBSERVATIONAL-ONLY store of
-- planned-vs-actual execution data and scheduler KPIs for OFFLINE evaluation,
-- parameter comparison, and regression. It must NOT feed back into (or alter)
-- production scheduling rules.
--
-- One row is written per plan assignment at dispatch time (planned baseline),
-- then enriched when the plan is approved/rejected (acceptance) and when a task
-- actually starts/completes (actuals). Plan-level counters (replan / conflict /
-- override / solver runtime / fallback) are repeated on each assignment row so a
-- single row fully describes one executed assignment for offline analysis.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id varchar(255) NOT NULL UNIQUE,
  run_id varchar(255),
  plan_id varchar(255) NOT NULL,
  task_id varchar(255),
  assignment_id varchar(255),
  -- planned / actual time windows
  planned_start timestamptz(3),
  actual_start timestamptz(3),
  planned_end timestamptz(3),
  actual_end timestamptz(3),
  -- planned / actual travel & wait (seconds)
  planned_travel real,
  actual_travel real,
  planned_wait real,
  actual_wait real,
  -- original (planned) vs actual resource snapshot { personId, deviceId, stationId }
  original_resource_json jsonb,
  actual_resource_json jsonb,
  -- scheduler counters observed for this assignment's plan
  replan_count integer NOT NULL DEFAULT 0,
  conflict_count integer NOT NULL DEFAULT 0,
  override_count integer NOT NULL DEFAULT 0,
  solver_runtime real,
  solver_fallback boolean NOT NULL DEFAULT false,
  -- acceptance: true = approved, false = rejected, null = not-yet-decided
  accepted boolean,
  ts timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  org_id varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_feedback_plan ON __EWOH_SCHEMA__.ewoh_scheduling_feedback (plan_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_feedback_assignment ON __EWOH_SCHEMA__.ewoh_scheduling_feedback (assignment_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_feedback_task ON __EWOH_SCHEMA__.ewoh_scheduling_feedback (task_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_feedback_ts ON __EWOH_SCHEMA__.ewoh_scheduling_feedback (ts);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback IS 'Planned-vs-actual scheduling execution feedback (observational only, offline evaluation)';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_feedback.accepted IS 'true=approved, false=rejected, null=undecided';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_feedback.solver_fallback IS 'true when the CP-SAT solver fell back to the heuristic solver for this plan';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback TO service_role;