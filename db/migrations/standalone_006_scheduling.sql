-- EWOH Intelligent Scheduling Workbench persistence migration (Task 1)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- / CREATE INDEX IF NOT EXISTS. No physical foreign keys.
--
-- Adds the scheduling V2 domain model:
--   1) ewoh_scheduling_run            — durable runs of the scheduling solver
--   2) New version/time-window columns on ewoh_schedule_plan
--   3) ewoh_scheduling_plan_assignment— per-task/person/device/time-window assignments
--   4) ewoh_scheduling_constraint     — locked/forced constraints feeding the solver
--   5) ewoh_world_state_snapshot      — immutable world-state snapshots for plans
--   6) ewoh_route_node / ewoh_route_edge — movement route graph for A* routing
--   7) ewoh_assignment_event          — assignment lifecycle event stream
--
-- Idempotent by construction: safe to run repeatedly without error or data loss.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ---------------------------------------------------------------------------
-- 1) ewoh_scheduling_run — durable scheduling solver runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id varchar(255) NOT NULL UNIQUE,
  trigger_type varchar(100),
  trigger_entity_id varchar(255),
  status varchar(50) NOT NULL DEFAULT 'queued',
  snapshot_version varchar(255),
  plan_ids jsonb,
  error text,
  org_id varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_run_status ON __EWOH_SCHEMA__.ewoh_scheduling_run (status);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_run_trigger ON __EWOH_SCHEMA__.ewoh_scheduling_run (trigger_type, trigger_entity_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_run_org_status ON __EWOH_SCHEMA__.ewoh_scheduling_run (org_id, status);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_run IS 'Durable runs of the deterministic scheduling solver';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_run.status IS 'queued|running|succeeded|failed';

-- ---------------------------------------------------------------------------
-- 2) ewoh_schedule_plan — version / trigger / snapshot columns
-- ---------------------------------------------------------------------------
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS snapshot_version varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS trigger_type varchar(100);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS trigger_entity_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS baseline_delta_json jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS violations_json jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS superseded_by varchar(255);

CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_plan_snapshot ON __EWOH_SCHEMA__.ewoh_schedule_plan (snapshot_version);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_plan_trigger ON __EWOH_SCHEMA__.ewoh_schedule_plan (trigger_type, trigger_entity_id);

-- ---------------------------------------------------------------------------
-- 3) ewoh_scheduling_plan_assignment — per-entity time-window assignments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id varchar(255) NOT NULL UNIQUE,
  plan_id varchar(255) NOT NULL,
  task_id varchar(255),
  person_id varchar(255),
  device_id varchar(255),
  station_id varchar(255),
  zone_id varchar(255),
  planned_start timestamptz(3),
  planned_end timestamptz(3),
  route_id varchar(255),
  status varchar(50) NOT NULL DEFAULT 'proposed',
  explanation_json jsonb,
  version integer NOT NULL DEFAULT 1,
  reason text,
  org_id varchar(255),
  created_by varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_plan_assignment_plan ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment (plan_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_plan_assignment_task ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment (task_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_plan_assignment_person ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment (person_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_plan_assignment_device ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment (device_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_plan_assignment_status ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment (status);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment IS 'Task-person-device-time-window assignment inside a scheduling plan';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment.status IS 'proposed|approved|dispatched|acknowledged|executing|completed|blocked|failed|cancelled';

-- ---------------------------------------------------------------------------
-- 4) ewoh_scheduling_constraint — locked/forced constraints for the solver
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_constraint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  constraint_id varchar(255) NOT NULL UNIQUE,
  plan_id varchar(255),
  task_id varchar(255),
  type varchar(50) NOT NULL,
  value_json jsonb,
  active boolean NOT NULL DEFAULT true,
  created_by varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_constraint_plan ON __EWOH_SCHEMA__.ewoh_scheduling_constraint (plan_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_constraint_task ON __EWOH_SCHEMA__.ewoh_scheduling_constraint (task_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_constraint_type ON __EWOH_SCHEMA__.ewoh_scheduling_constraint (type);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint IS 'Hard constraints for the scheduling solver';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_constraint.type IS 'LOCKED_PERSON|LOCKED_DEVICE|LOCKED_TIME|FORBIDDEN_ZONE|MIN_BATTERY';

-- ---------------------------------------------------------------------------
-- 5) ewoh_world_state_snapshot — immutable world-state snapshots for plans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_world_state_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_version varchar(255) NOT NULL UNIQUE,
  snapshot_json jsonb NOT NULL,
  created_at timestamptz(3),
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_world_state_snapshot IS 'Immutable world-state snapshot that a scheduling plan is based on';

-- ---------------------------------------------------------------------------
-- 6) ewoh_route_node / ewoh_route_edge — movement route graph
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_route_node (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id varchar(255) NOT NULL UNIQUE,
  node_type varchar(50),
  x real,
  y real,
  floor varchar(50),
  station_id varchar(255),
  zone_id varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_route_node_station ON __EWOH_SCHEMA__.ewoh_route_node (station_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_route_node_zone ON __EWOH_SCHEMA__.ewoh_route_node (zone_id);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_route_edge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_id varchar(255) NOT NULL UNIQUE,
  from_node_id varchar(255),
  to_node_id varchar(255),
  distance_meters real,
  expected_time_seconds real,
  direction varchar(20),
  capacity integer,
  risk_level varchar(50),
  status varchar(50) NOT NULL DEFAULT 'open',
  accessible_for jsonb,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_route_edge_from ON __EWOH_SCHEMA__.ewoh_route_edge (from_node_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_route_edge_to ON __EWOH_SCHEMA__.ewoh_route_edge (to_node_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_route_edge_status ON __EWOH_SCHEMA__.ewoh_route_edge (status);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_route_node IS 'Navigable node in the factory route graph';
COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_route_edge IS 'Directed-weighted edge in the factory route graph';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_route_edge.status IS 'open|congested|blocked';

-- ---------------------------------------------------------------------------
-- 7) ewoh_assignment_event — assignment lifecycle event stream
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_assignment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(255) NOT NULL UNIQUE,
  assignment_id varchar(255),
  task_id varchar(255),
  person_id varchar(255),
  device_id varchar(255),
  from_status varchar(50),
  to_status varchar(50),
  actor varchar(255),
  reason text,
  payload_json jsonb,
  created_at timestamptz(3),
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_assignment_event_assignment ON __EWOH_SCHEMA__.ewoh_assignment_event (assignment_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_assignment_event_task ON __EWOH_SCHEMA__.ewoh_assignment_event (task_id);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_assignment_event IS 'Assignment lifecycle event stream for replay/audit';

-- ---------------------------------------------------------------------------
-- 8) Grants — mirror the service_role grant set used by standalone_005.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_run TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_world_state_snapshot TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_route_node TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_route_edge TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_assignment_event TO service_role;