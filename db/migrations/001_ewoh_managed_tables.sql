-- EWOH managed tables migration (AG-10)
-- Schema placeholder: __EWOH_SCHEMA__
-- Re-entrant: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS.
-- No physical foreign keys. RLS is org-scoped; direct DML is revoked from user roles.

CREATE SCHEMA IF NOT EXISTS __EWOH_SCHEMA__;
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $ewoh_type$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'user_profile' AND n.nspname = '__EWOH_SCHEMA__'
  ) THEN
    EXECUTE format('CREATE TYPE %I.user_profile AS (user_id varchar)', '__EWOH_SCHEMA__');
  END IF;
END
$ewoh_type$;

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_org_visible(p_org_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    coalesce(current_setting('app.is_global_admin', true), '') = 'true'
    OR (
      nullif(coalesce(current_setting('app.current_org_ids', true), ''), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM unnest(string_to_array(current_setting('app.current_org_ids', true), ',')) AS o(org)
        WHERE btrim(o.org) <> '' AND btrim(o.org)::uuid = p_org_id
      )
    );
$$;

-- Existing physical table baselines (portable fresh-DB bootstrap).
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_ai_suggestion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id varchar(255) NOT NULL,
  title varchar(255),
  suggestion_type varchar(255),
  status varchar(255) DEFAULT 'not_generated',
  related_event_id varchar(255),
  related_task_id varchar(255),
  input_summary text,
  content text,
  risk_assessment text,
  ai_level varchar(255) DEFAULT 'A2',
  triggered_by varchar(255),
  plan_content jsonb,
  adopted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id varchar(255) NOT NULL UNIQUE,
  worker_name varchar(255),
  device_model varchar(255),
  battery_pct integer DEFAULT 100,
  online boolean DEFAULT false,
  last_telemetry_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_type varchar(50) DEFAULT 'simulated',
  firmware_version varchar(100),
  hardware_version varchar(100),
  protocol_version varchar(50),
  temperature_c real,
  fault_code varchar(100),
  last_raw_ref varchar(128)
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_device_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id varchar(255) NOT NULL,
  binding_type varchar(255) NOT NULL,
  target_id varchar(255) NOT NULL,
  target_type varchar(255) NOT NULL,
  start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expected_end_time timestamptz,
  actual_end_time timestamptz,
  reason text,
  status varchar(255) DEFAULT 'active',
  operator_id varchar(255),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_device_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id varchar(255) NOT NULL,
  device_type varchar(255),
  manufacturer varchar(255),
  serial_number varchar(255),
  install_date timestamptz,
  owner_id varchar(255),
  access_config jsonb,
  run_config jsonb,
  description text,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_environment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id varchar(255) NOT NULL,
  entity_id varchar(255),
  temperature real,
  vibration real,
  noise real,
  air_quality real,
  ts timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_type varchar(50) DEFAULT 'simulated',
  record_id varchar(64),
  data_confidence real DEFAULT 1.0
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(255) NOT NULL UNIQUE,
  device_id varchar(255),
  event_code varchar(255),
  event_type varchar(255),
  severity varchar(255),
  title varchar(500),
  status varchar(255) DEFAULT 'open',
  created_at timestamptz,
  handler_action text,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_type varchar(50) DEFAULT 'simulated',
  trigger_record_id varchar(64),
  evidence_json jsonb
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_event_chain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(255) NOT NULL,
  parent_event_id varchar(255),
  causal_type varchar(255) DEFAULT 'triggered',
  description text,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_model_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id varchar(255) NOT NULL UNIQUE,
  model_name varchar(255) NOT NULL,
  version varchar(50) NOT NULL,
  type varchar(100) NOT NULL,
  status varchar(50) DEFAULT 'active',
  card_json jsonb,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  org_type varchar(100) NOT NULL,
  parent_id varchar(255),
  description text,
  status varchar(50) DEFAULT 'active',
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_personnel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(255) NOT NULL,
  employee_no varchar(255) NOT NULL,
  org_id varchar(255),
  team_name varchar(255),
  position varchar(255),
  skills jsonb,
  status varchar(50) DEFAULT 'available',
  health_status varchar(50) DEFAULT 'normal',
  current_load jsonb,
  spatial_entity_id varchar(255),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_production_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(255) NOT NULL,
  description text,
  task_type varchar(100) NOT NULL,
  priority varchar(50) DEFAULT 'medium',
  status varchar(50) DEFAULT 'draft',
  assignee_id varchar(255),
  device_id varchar(255),
  spatial_entity_id varchar(255),
  plan_start timestamptz,
  plan_end timestamptz,
  progress integer DEFAULT 0,
  source varchar(50) DEFAULT 'manual',
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_schedule_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_id varchar(255) NOT NULL UNIQUE,
  plan_id varchar(255) NOT NULL,
  action varchar(100) NOT NULL,
  operator varchar(255),
  reason text,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_schedule_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id varchar(255) NOT NULL UNIQUE,
  plan_name varchar(255) NOT NULL,
  strategy varchar(100) NOT NULL,
  status varchar(50) DEFAULT 'shadow',
  takt_improvement real DEFAULT 0,
  high_load_persons integer DEFAULT 0,
  low_battery_risk integer DEFAULT 0,
  affected_persons integer DEFAULT 0,
  metrics_json jsonb,
  reason text,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  confirmed_by varchar(255),
  confirmed_at timestamptz,
  confirm_reason text,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduler_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key varchar(255) NOT NULL,
  config_value jsonb NOT NULL,
  updated_by varchar(255),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_spatial_entity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id varchar(255) NOT NULL UNIQUE,
  entity_type varchar(100) NOT NULL,
  parent_id varchar(255),
  name varchar(255) NOT NULL,
  x real DEFAULT 0,
  y real DEFAULT 0,
  yaw real DEFAULT 0,
  bbox_w real DEFAULT 0,
  bbox_h real DEFAULT 0,
  status varchar(100) DEFAULT 'active',
  source_type varchar(50) DEFAULT 'seed',
  confidence real DEFAULT 1.0,
  version integer DEFAULT 1,
  extra jsonb,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_telemetry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id varchar(255) NOT NULL,
  ts timestamptz NOT NULL,
  pitch_deg real,
  load_score real,
  fatigue_trend real,
  battery_pct integer,
  quality_status varchar(255),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_type varchar(50) DEFAULT 'simulated',
  record_id varchar(64),
  ingested_at timestamptz DEFAULT CURRENT_TIMESTAMP,
  raw_ref varchar(128),
  joint_angles jsonb,
  angular_velocity_dps real,
  assist_level real,
  torque_nm real,
  cumulative_load_score real,
  temperature_c real,
  fault_code varchar(100),
  packet_loss_pct real DEFAULT 0,
  data_confidence real DEFAULT 1.0,
  data_quality varchar(20) DEFAULT 'good'
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_topology (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity varchar(255) NOT NULL,
  to_entity varchar(255) NOT NULL,
  relation varchar(100) DEFAULT 'adjacent',
  distance real DEFAULT 0,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_world_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id varchar(255) NOT NULL,
  state_json jsonb NOT NULL,
  ts timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- New managed tables (35 physical CREATEs; ewoh_device_person_binding maps to existing ewoh_device_binding).
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_person_skill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  person_id varchar(255) NOT NULL,
  skill_id varchar(255) NOT NULL,
  level varchar(50) NOT NULL DEFAULT 'basic',
  certified boolean NOT NULL DEFAULT false,
  certified_at timestamptz,
  expires_at timestamptz,
  status varchar(50) NOT NULL DEFAULT 'active',
  UNIQUE (org_id, person_id, skill_id),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_person_skill_org ON __EWOH_SCHEMA__.ewoh_person_skill (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_skill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  skill_id varchar(255) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  category varchar(100),
  description text,
  certification_required boolean NOT NULL DEFAULT false,
  status varchar(50) NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_skill_org ON __EWOH_SCHEMA__.ewoh_skill (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  role_id varchar(255) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  code varchar(100) NOT NULL,
  description text,
  scope varchar(50) NOT NULL DEFAULT 'org',
  status varchar(50) NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  UNIQUE (org_id, code),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_role_org ON __EWOH_SCHEMA__.ewoh_role (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_person_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  person_id varchar(255) NOT NULL,
  role_id varchar(255) NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_to timestamptz,
  status varchar(50) NOT NULL DEFAULT 'active',
  UNIQUE (org_id, person_id, role_id),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_person_role_org ON __EWOH_SCHEMA__.ewoh_person_role (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_device_capability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  capability_id varchar(255) NOT NULL UNIQUE,
  device_id varchar(255) NOT NULL,
  capability_type varchar(100) NOT NULL,
  capability_key varchar(255) NOT NULL,
  capability_value jsonb,
  compatible boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  status varchar(50) NOT NULL DEFAULT 'active',
  effective_from timestamptz,
  effective_to timestamptz,
  UNIQUE (org_id, device_id, capability_key),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_device_capability_org ON __EWOH_SCHEMA__.ewoh_device_capability (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_spatial_relation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  relation_id varchar(255) NOT NULL UNIQUE,
  from_entity_id varchar(255) NOT NULL,
  to_entity_id varchar(255) NOT NULL,
  relation_type varchar(100) NOT NULL,
  distance_m numeric(18,4),
  route_json jsonb,
  status varchar(50) NOT NULL DEFAULT 'active',
  valid_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to timestamptz,
  UNIQUE (org_id, from_entity_id, to_entity_id, relation_type),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_relation_org ON __EWOH_SCHEMA__.ewoh_spatial_relation (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_spatial_hierarchy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  parent_entity_id varchar(255) NOT NULL,
  child_entity_id varchar(255) NOT NULL,
  hierarchy_level integer NOT NULL DEFAULT 0,
  path varchar(2048),
  sort_order integer NOT NULL DEFAULT 0,
  status varchar(50) NOT NULL DEFAULT 'active',
  UNIQUE (org_id, parent_entity_id, child_entity_id),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_hierarchy_org ON __EWOH_SCHEMA__.ewoh_spatial_hierarchy (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_model_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  asset_id varchar(255) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  asset_type varchar(50) NOT NULL,
  lod varchar(10) NOT NULL DEFAULT 'L0',
  uri varchar(2048) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  checksum varchar(128),
  provenance text,
  spatial_entity_id varchar(255),
  model_node_id varchar(255),
  model_version_id varchar(255),
  status varchar(50) NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_model_asset_org ON __EWOH_SCHEMA__.ewoh_model_asset (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_model_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  binding_id varchar(255) NOT NULL UNIQUE,
  model_asset_id varchar(255) NOT NULL,
  entity_id varchar(255) NOT NULL,
  entity_type varchar(50) NOT NULL,
  binding_type varchar(100) NOT NULL,
  priority integer NOT NULL DEFAULT 0,
  status varchar(50) NOT NULL DEFAULT 'active',
  effective_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_to timestamptz,
  UNIQUE (org_id, model_asset_id, entity_id, binding_type),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_model_binding_org ON __EWOH_SCHEMA__.ewoh_model_binding (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_workstation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  workstation_id varchar(255) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  workstation_type varchar(100) NOT NULL,
  spatial_entity_id varchar(255),
  description text,
  capacity integer NOT NULL DEFAULT 1,
  status varchar(50) NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_workstation_org ON __EWOH_SCHEMA__.ewoh_workstation (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_workstation_device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  workstation_id varchar(255) NOT NULL,
  device_id varchar(255) NOT NULL,
  binding_type varchar(100) NOT NULL DEFAULT 'installed',
  start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_time timestamptz,
  status varchar(50) NOT NULL DEFAULT 'active',
  operator_id varchar(255),
  UNIQUE (org_id, workstation_id, device_id, binding_type),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_workstation_device_org ON __EWOH_SCHEMA__.ewoh_workstation_device (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_workstation_person (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  workstation_id varchar(255) NOT NULL,
  person_id varchar(255) NOT NULL,
  assignment_role varchar(100) NOT NULL DEFAULT 'worker',
  start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_time timestamptz,
  status varchar(50) NOT NULL DEFAULT 'active',
  UNIQUE (org_id, workstation_id, person_id, assignment_role),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_workstation_person_org ON __EWOH_SCHEMA__.ewoh_workstation_person (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_workstation_skill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  workstation_id varchar(255) NOT NULL,
  skill_id varchar(255) NOT NULL,
  required_level varchar(50) NOT NULL DEFAULT 'basic',
  min_count integer NOT NULL DEFAULT 1,
  status varchar(50) NOT NULL DEFAULT 'active',
  UNIQUE (org_id, workstation_id, skill_id),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_workstation_skill_org ON __EWOH_SCHEMA__.ewoh_workstation_skill (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_workstation_relation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  relation_id varchar(255) NOT NULL UNIQUE,
  from_workstation_id varchar(255) NOT NULL,
  to_workstation_id varchar(255) NOT NULL,
  relation_type varchar(100) NOT NULL,
  distance_m numeric(18,4),
  status varchar(50) NOT NULL DEFAULT 'active',
  UNIQUE (org_id, from_workstation_id, to_workstation_id, relation_type),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_workstation_relation_org ON __EWOH_SCHEMA__.ewoh_workstation_relation (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_task_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  template_id varchar(255) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  task_type varchar(100) NOT NULL,
  description text,
  priority varchar(50) NOT NULL DEFAULT 'medium',
  estimated_duration_sec integer,
  risk_level varchar(50) NOT NULL DEFAULT 'low',
  status varchar(50) NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_task_template_org ON __EWOH_SCHEMA__.ewoh_task_template (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_task_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  step_id varchar(255) NOT NULL UNIQUE,
  template_id varchar(255) NOT NULL,
  step_no integer NOT NULL,
  name varchar(255) NOT NULL,
  instruction text,
  duration_sec integer,
  status varchar(50) NOT NULL DEFAULT 'active',
  UNIQUE (org_id, template_id, step_no),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_task_step_org ON __EWOH_SCHEMA__.ewoh_task_step (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_task_skill_req (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  task_step_id varchar(255) NOT NULL,
  skill_id varchar(255) NOT NULL,
  required_level varchar(50) NOT NULL DEFAULT 'basic',
  min_people integer NOT NULL DEFAULT 1,
  max_people integer,
  priority integer NOT NULL DEFAULT 0,
  UNIQUE (org_id, task_step_id, skill_id),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_task_skill_req_org ON __EWOH_SCHEMA__.ewoh_task_skill_req (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_schedule_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  schedule_task_id varchar(255) NOT NULL UNIQUE,
  template_id varchar(255),
  title varchar(255) NOT NULL,
  description text,
  status varchar(50) NOT NULL DEFAULT 'draft',
  priority varchar(50) NOT NULL DEFAULT 'medium',
  source varchar(50) NOT NULL DEFAULT 'manual',
  plan_start timestamptz,
  plan_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  parent_task_id varchar(255),
  approval_id varchar(255),
  suggestion_id varchar(255),
  session_id varchar(255),
  is_simulation boolean NOT NULL DEFAULT false,
  progress integer NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_org ON __EWOH_SCHEMA__.ewoh_schedule_task (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_schedule_task_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  step_id varchar(255) NOT NULL UNIQUE,
  schedule_task_id varchar(255) NOT NULL,
  step_no integer NOT NULL,
  name varchar(255) NOT NULL,
  instruction text,
  status varchar(50) NOT NULL DEFAULT 'pending',
  planned_start timestamptz,
  planned_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  assigned_person_id varchar(255),
  assigned_device_id varchar(255),
  spatial_entity_id varchar(255),
  progress integer NOT NULL DEFAULT 0,
  result_json jsonb,
  parent_step_id varchar(255),
  UNIQUE (org_id, schedule_task_id, step_no),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_step_org ON __EWOH_SCHEMA__.ewoh_schedule_task_step (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_schedule_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  assignment_id varchar(255) NOT NULL UNIQUE,
  schedule_task_id varchar(255) NOT NULL,
  task_step_id varchar(255),
  assignee_type varchar(50) NOT NULL,
  assignee_id varchar(255) NOT NULL,
  assignment_role varchar(100) NOT NULL DEFAULT 'executor',
  planned_start timestamptz,
  planned_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,
  status varchar(50) NOT NULL DEFAULT 'assigned',
  is_primary boolean NOT NULL DEFAULT false,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_assignment_org ON __EWOH_SCHEMA__.ewoh_schedule_assignment (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_resource_preorder (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  preorder_id varchar(255) NOT NULL UNIQUE,
  resource_type varchar(100) NOT NULL,
  resource_id varchar(255) NOT NULL,
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  reserved_qty numeric(18,4) NOT NULL DEFAULT 0,
  issued_qty numeric(18,4) NOT NULL DEFAULT 0,
  consumed_qty numeric(18,4) NOT NULL DEFAULT 0,
  returned_qty numeric(18,4) NOT NULL DEFAULT 0,
  unit varchar(50),
  batch_no varchar(255),
  task_id varchar(255),
  task_step_id varchar(255),
  status varchar(50) NOT NULL DEFAULT 'pending',
  priority integer NOT NULL DEFAULT 0,
  start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_time timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_resource_preorder_org ON __EWOH_SCHEMA__.ewoh_resource_preorder (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_resource_binding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  binding_id varchar(255) NOT NULL UNIQUE,
  binding_type varchar(100) NOT NULL,
  resource_type varchar(100) NOT NULL,
  resource_id varchar(255) NOT NULL,
  target_type varchar(100) NOT NULL,
  target_id varchar(255) NOT NULL,
  start_time timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  end_time timestamptz,
  reason text,
  status varchar(50) NOT NULL DEFAULT 'active',
  operator_id varchar(255),
  quantity numeric(18,4) NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  UNIQUE (org_id, resource_id, target_id, binding_type),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_resource_binding_org ON __EWOH_SCHEMA__.ewoh_resource_binding (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_control_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  request_id varchar(255) NOT NULL UNIQUE,
  device_id varchar(255) NOT NULL,
  control_type varchar(100) NOT NULL,
  command_keys jsonb NOT NULL DEFAULT '[]',
  status varchar(50) NOT NULL DEFAULT 'draft',
  idempotency_key varchar(255),
  requested_by varchar(255),
  approved_by varchar(255),
  approved_at timestamptz,
  reason text,
  risk_level varchar(50) NOT NULL DEFAULT 'normal',
  requires_secondary_confirm boolean NOT NULL DEFAULT true,
  deadline timestamptz,
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_control_request_org ON __EWOH_SCHEMA__.ewoh_control_request (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_control_request_org_idem ON __EWOH_SCHEMA__.ewoh_control_request (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_control_command (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  command_id varchar(255) NOT NULL UNIQUE,
  request_id varchar(255) NOT NULL,
  root_command_id varchar(255) NOT NULL,
  attempt_no integer NOT NULL DEFAULT 1,
  command_key varchar(255) NOT NULL,
  payload jsonb,
  status varchar(50) NOT NULL DEFAULT 'pending',
  sent_at timestamptz,
  response_at timestamptz,
  response_json jsonb,
  error_code varchar(100),
  error_message text,
  idempotency_key varchar(255),
  UNIQUE (org_id, root_command_id, attempt_no, command_key),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_control_command_org ON __EWOH_SCHEMA__.ewoh_control_command (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_control_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  result_id varchar(255) NOT NULL UNIQUE,
  request_id varchar(255) NOT NULL,
  command_id varchar(255) NOT NULL,
  result_type varchar(100) NOT NULL,
  result_code varchar(100),
  result_json jsonb,
  success boolean NOT NULL DEFAULT false,
  completed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operator_id varchar(255),
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_control_result_org ON __EWOH_SCHEMA__.ewoh_control_result (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_event_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  rule_id varchar(255) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  rule_type varchar(100) NOT NULL,
  trigger_json jsonb NOT NULL DEFAULT '{}',
  conditions_json jsonb,
  actions_json jsonb NOT NULL DEFAULT '[]',
  priority integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz,
  effective_to timestamptz,
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_event_rule_org ON __EWOH_SCHEMA__.ewoh_event_rule (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_event_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  action_id varchar(255) NOT NULL UNIQUE,
  rule_id varchar(255) NOT NULL,
  action_type varchar(100) NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}',
  status varchar(50) NOT NULL DEFAULT 'active',
  executed_count integer NOT NULL DEFAULT 0,
  last_executed_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_event_action_org ON __EWOH_SCHEMA__.ewoh_event_action (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_event_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  subscription_id varchar(255) NOT NULL UNIQUE,
  subscriber_type varchar(50) NOT NULL,
  subscriber_id varchar(255) NOT NULL,
  event_type varchar(255) NOT NULL,
  severity_filter jsonb,
  channel varchar(100) NOT NULL,
  config jsonb,
  enabled boolean NOT NULL DEFAULT true,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_event_subscription_org ON __EWOH_SCHEMA__.ewoh_event_subscription (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_world_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  snapshot_version bigint NOT NULL,
  snapshot_type varchar(50) NOT NULL DEFAULT 'full',
  payload jsonb NOT NULL,
  entity_count integer NOT NULL DEFAULT 0,
  checksum varchar(128),
  source_type varchar(50) NOT NULL DEFAULT 'simulated',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_world_snapshot_org ON __EWOH_SCHEMA__.ewoh_world_snapshot (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_world_snapshot_org_version ON __EWOH_SCHEMA__.ewoh_world_snapshot (coalesce(org_id, '00000000-0000-4000-8000-000000000000'::uuid), snapshot_version);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_world_delta_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  snapshot_version bigint NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id varchar(255) NOT NULL,
  delta_type varchar(50) NOT NULL,
  payload jsonb,
  before_json jsonb,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source_type varchar(50) NOT NULL DEFAULT 'simulated',
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_world_delta_org_seq ON __EWOH_SCHEMA__.ewoh_world_delta_log (org_id, seq);
CREATE INDEX IF NOT EXISTS idx_ewoh_world_delta_version_seq ON __EWOH_SCHEMA__.ewoh_world_delta_log (snapshot_version, seq);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_system_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  config_id varchar(255) NOT NULL UNIQUE,
  config_key varchar(255) NOT NULL,
  config_value jsonb NOT NULL,
  is_public boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  effective_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_to timestamptz,
  status varchar(50) NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_system_config_org ON __EWOH_SCHEMA__.ewoh_system_config (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_system_config_org_key ON __EWOH_SCHEMA__.ewoh_system_config (coalesce(org_id, '00000000-0000-4000-8000-000000000000'::uuid), config_key);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  base_id varchar(255) NOT NULL UNIQUE,
  name varchar(255) NOT NULL,
  description text,
  knowledge_type varchar(100) NOT NULL DEFAULT 'general',
  status varchar(50) NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_knowledge_base_org ON __EWOH_SCHEMA__.ewoh_knowledge_base (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_knowledge_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  entry_id varchar(255) NOT NULL UNIQUE,
  base_id varchar(255) NOT NULL,
  title varchar(255) NOT NULL,
  content text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]',
  source_type varchar(50) NOT NULL DEFAULT 'manual',
  checksum varchar(128),
  status varchar(50) NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_knowledge_entry_org ON __EWOH_SCHEMA__.ewoh_knowledge_entry (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  notification_id varchar(255) NOT NULL UNIQUE,
  recipient_type varchar(50) NOT NULL,
  recipient_id varchar(255) NOT NULL,
  channel varchar(100) NOT NULL,
  title varchar(255) NOT NULL,
  body text,
  severity varchar(50) NOT NULL DEFAULT 'info',
  status varchar(50) NOT NULL DEFAULT 'pending',
  scheduled_at timestamptz,
  sent_at timestamptz,
  read_at timestamptz,
  external_ref varchar(255),
  error_message text,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_notification_org ON __EWOH_SCHEMA__.ewoh_notification (org_id);


CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid),
  audit_seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
  actor_id varchar(255) NOT NULL,
  action varchar(100) NOT NULL,
  entity_type varchar(255) NOT NULL,
  entity_id varchar(255) NOT NULL,
  before_json jsonb,
  after_json jsonb,
  reason text,
  client_ip varchar(64),
  request_id varchar(128),
  risk_level varchar(50) NOT NULL DEFAULT 'normal',
  is_high_risk boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  chain_seq bigint NOT NULL,
  prev_hash varchar(64) NOT NULL DEFAULT repeat('0', 64),
  hash varchar(64) NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END),
  _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END)
);

CREATE INDEX IF NOT EXISTS idx_ewoh_audit_log_org_seq ON __EWOH_SCHEMA__.ewoh_audit_log (org_id, audit_seq);
CREATE INDEX IF NOT EXISTS idx_ewoh_audit_log_entity ON __EWOH_SCHEMA__.ewoh_audit_log (entity_type, entity_id);


-- 12 frozen ALTERs plus mapped-existing hardening.
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_event ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);

ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ADD COLUMN IF NOT EXISTS org_id uuid;

ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ADD COLUMN IF NOT EXISTS _created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ADD COLUMN IF NOT EXISTS _updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ADD COLUMN IF NOT EXISTS _created_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ADD COLUMN IF NOT EXISTS _updated_by __EWOH_SCHEMA__.user_profile DEFAULT (CASE WHEN current_setting('app.user_id', true) = '' THEN NULL ELSE concat('(', current_setting('app.user_id', true), ')')::__EWOH_SCHEMA__.user_profile END);
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ADD COLUMN IF NOT EXISTS org_id uuid;

DO $ewoh_personnel$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__EWOH_SCHEMA__' AND table_name = 'ewoh_personnel' AND column_name = 'org_id' AND data_type <> 'uuid'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ADD COLUMN IF NOT EXISTS org_id_legacy varchar(255);
    UPDATE __EWOH_SCHEMA__.ewoh_personnel SET org_id_legacy = org_id WHERE org_id_legacy IS NULL AND org_id IS NOT NULL;
    ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ALTER COLUMN org_id TYPE uuid USING (CASE WHEN org_id ~ '^[0-9a-fA-F-]{36}$' THEN org_id::uuid ELSE NULL END);
  END IF;
END
$ewoh_personnel$;

-- Table 79 detailed ALTERs.
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS z real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS roll real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS pitch real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS bbox_d real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS model_node_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS model_version_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS coordinate_system varchar(100) DEFAULT 'world';
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS coordinate_origin jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS floor_elevation real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS unit varchar(50) DEFAULT 'm';
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS lifecycle_status varchar(50) DEFAULT 'active';
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS runtime_status varchar(50) DEFAULT 'unknown';
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS health_status varchar(50) DEFAULT 'unknown';
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS device_category varchar(100);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ADD COLUMN IF NOT EXISTS extra jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS suggestion_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS session_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS version integer DEFAULT 1;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS parent_plan_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS is_simulation boolean DEFAULT false;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ADD COLUMN IF NOT EXISTS approval_id varchar(255);

DO $ewoh_backfill$
DECLARE
  v_default_org uuid;
BEGIN
  SELECT id INTO v_default_org
  FROM __EWOH_SCHEMA__.ewoh_organization
  ORDER BY CASE WHEN org_type = 'factory' THEN 0 WHEN org_type = 'base' THEN 1 ELSE 2 END, id
  LIMIT 1;
  IF NOT FOUND THEN
    v_default_org := '00000000-0000-4000-8000-000000000001'::uuid;
    INSERT INTO __EWOH_SCHEMA__.ewoh_organization (id, org_id, name, org_type, status, _created_at, _updated_at)
    VALUES (v_default_org, v_default_org, '默认组织', 'default', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  UPDATE __EWOH_SCHEMA__.ewoh_organization SET org_id = id WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_ai_suggestion SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_device SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_device_binding SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_device_config SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_environment SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_event SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_event_chain SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_model_registry SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_personnel SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_production_task SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_schedule_audit SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_schedule_plan SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_scheduler_config SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_spatial_entity SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_telemetry SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_topology SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
  UPDATE __EWOH_SCHEMA__.ewoh_world_state SET org_id = COALESCE(org_id, v_default_org) WHERE org_id IS NULL;
END
$ewoh_backfill$;

ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_ai_suggestion_org ON __EWOH_SCHEMA__.ewoh_ai_suggestion (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_device_org ON __EWOH_SCHEMA__.ewoh_device (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_device_binding_org ON __EWOH_SCHEMA__.ewoh_device_binding (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_device_config_org ON __EWOH_SCHEMA__.ewoh_device_config (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_environment_org ON __EWOH_SCHEMA__.ewoh_environment (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_org ON __EWOH_SCHEMA__.ewoh_event (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_chain_org ON __EWOH_SCHEMA__.ewoh_event_chain (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_model_registry_org ON __EWOH_SCHEMA__.ewoh_model_registry (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_organization_org ON __EWOH_SCHEMA__.ewoh_organization (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_personnel_org ON __EWOH_SCHEMA__.ewoh_personnel (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_production_task_org ON __EWOH_SCHEMA__.ewoh_production_task (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_audit_org ON __EWOH_SCHEMA__.ewoh_schedule_audit (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_plan_org ON __EWOH_SCHEMA__.ewoh_schedule_plan (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduler_config_org ON __EWOH_SCHEMA__.ewoh_scheduler_config (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_entity_org ON __EWOH_SCHEMA__.ewoh_spatial_entity (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_telemetry_org ON __EWOH_SCHEMA__.ewoh_telemetry (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_topology_org ON __EWOH_SCHEMA__.ewoh_topology (org_id);
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE INDEX IF NOT EXISTS idx_ewoh_world_state_org ON __EWOH_SCHEMA__.ewoh_world_state (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduler_config_org_key ON __EWOH_SCHEMA__.ewoh_scheduler_config (org_id, config_key);
ALTER TABLE __EWOH_SCHEMA__.ewoh_person_skill ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_skill ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_role ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_person_role ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_capability ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_relation ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_hierarchy ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_asset ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_binding ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_workstation ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_workstation_device ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_workstation_person ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_workstation_skill ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_workstation_relation ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_task_template ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_task_step ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_task_skill_req ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task_step ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_assignment ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_preorder ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_binding ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_control_request ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_control_result ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_rule ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_action ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_subscription ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_snapshot ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_delta_log ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_system_config ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_base ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_notification ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);
ALTER TABLE __EWOH_SCHEMA__.ewoh_audit_log ALTER COLUMN org_id SET DEFAULT (nullif(current_setting('app.current_org_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION __EWOH_SCHEMA__.ewoh_append_audit_log(
  p_org_id uuid,
  p_actor_id text,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb DEFAULT NULL,
  p_after jsonb DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_client_ip text DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_is_high_risk boolean DEFAULT false,
  p_risk_level text DEFAULT 'normal'
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = __EWOH_SCHEMA__, pg_temp
AS $$
DECLARE
  v_prev_hash text;
  v_hash text;
  v_audit_id uuid := gen_random_uuid();
  v_chain_seq bigint;
BEGIN
  IF p_org_id IS NULL THEN
    IF coalesce(current_setting('app.is_global_admin', true), '') <> 'true' THEN
      RAISE EXCEPTION 'global audit records require global administrator context' USING ERRCODE = '42501';
    END IF;
  ELSIF NOT __EWOH_SCHEMA__.ewoh_org_visible(p_org_id) THEN
    RAISE EXCEPTION 'audit organization is outside the request context' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(p_org_id::text, 'global'), 0));
  SELECT hash, chain_seq INTO v_prev_hash, v_chain_seq
  FROM __EWOH_SCHEMA__.ewoh_audit_log
  WHERE org_id IS NOT DISTINCT FROM p_org_id
  ORDER BY audit_seq DESC
  LIMIT 1;
  v_prev_hash := coalesce(v_prev_hash, repeat('0', 64));
  v_chain_seq := coalesce(v_chain_seq, 0) + 1;
  v_hash := encode(sha256(convert_to(concat_ws('|',
    v_prev_hash,
    coalesce(p_org_id::text, ''),
    coalesce(p_actor_id, ''),
    p_action,
    p_entity_type,
    coalesce(p_entity_id, ''),
    coalesce(p_before::text, ''),
    coalesce(p_after::text, ''),
    coalesce(p_reason, ''),
    coalesce(p_client_ip, ''),
    coalesce(p_request_id, ''),
    coalesce(p_is_high_risk::text, 'false'),
    to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  ), 'UTF8')), 'hex');
  INSERT INTO __EWOH_SCHEMA__.ewoh_audit_log (
    id, org_id, actor_id, action, entity_type, entity_id, before_json, after_json,
    reason, client_ip, request_id, is_high_risk, risk_level, occurred_at, chain_seq, prev_hash, hash
  ) VALUES (
    v_audit_id, p_org_id, p_actor_id, p_action, p_entity_type, p_entity_id, p_before, p_after,
    p_reason, p_client_ip, p_request_id, p_is_high_risk, p_risk_level, now(), v_chain_seq, v_prev_hash, v_hash
  );
  RETURN v_audit_id;
END;
$$;

-- Replace loose legacy policies with org-scoped policies.
DO $ewoh_drop_legacy_policies$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = '__EWOH_SCHEMA__' AND tablename = ANY (ARRAY['ewoh_ai_suggestion', 'ewoh_device', 'ewoh_device_binding', 'ewoh_device_config', 'ewoh_environment', 'ewoh_event', 'ewoh_event_chain', 'ewoh_model_registry', 'ewoh_organization', 'ewoh_personnel', 'ewoh_production_task', 'ewoh_schedule_audit', 'ewoh_schedule_plan', 'ewoh_scheduler_config', 'ewoh_spatial_entity', 'ewoh_telemetry', 'ewoh_topology', 'ewoh_world_state', 'ewoh_person_skill', 'ewoh_skill', 'ewoh_role', 'ewoh_person_role', 'ewoh_device_capability', 'ewoh_spatial_relation', 'ewoh_spatial_hierarchy', 'ewoh_model_asset', 'ewoh_model_binding', 'ewoh_workstation', 'ewoh_workstation_device', 'ewoh_workstation_person', 'ewoh_workstation_skill', 'ewoh_workstation_relation', 'ewoh_task_template', 'ewoh_task_step', 'ewoh_task_skill_req', 'ewoh_schedule_task', 'ewoh_schedule_task_step', 'ewoh_schedule_assignment', 'ewoh_resource_preorder', 'ewoh_resource_binding', 'ewoh_control_request', 'ewoh_control_command', 'ewoh_control_result', 'ewoh_event_rule', 'ewoh_event_action', 'ewoh_event_subscription', 'ewoh_world_snapshot', 'ewoh_world_delta_log', 'ewoh_system_config', 'ewoh_knowledge_base', 'ewoh_knowledge_entry', 'ewoh_notification', 'ewoh_audit_log'])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, '__EWOH_SCHEMA__', p.tablename);
  END LOOP;
END
$ewoh_drop_legacy_policies$;

DO $ewoh_rls_normal$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ewoh_ai_suggestion', 'ewoh_device', 'ewoh_device_binding', 'ewoh_device_config', 'ewoh_environment', 'ewoh_event', 'ewoh_event_chain', 'ewoh_model_registry', 'ewoh_organization', 'ewoh_personnel', 'ewoh_production_task', 'ewoh_schedule_audit', 'ewoh_schedule_plan', 'ewoh_scheduler_config', 'ewoh_spatial_entity', 'ewoh_telemetry', 'ewoh_topology', 'ewoh_world_state', 'ewoh_person_skill', 'ewoh_skill', 'ewoh_role', 'ewoh_person_role', 'ewoh_device_capability', 'ewoh_spatial_relation', 'ewoh_spatial_hierarchy', 'ewoh_model_asset', 'ewoh_model_binding', 'ewoh_workstation', 'ewoh_workstation_device', 'ewoh_workstation_person', 'ewoh_workstation_skill', 'ewoh_workstation_relation', 'ewoh_task_template', 'ewoh_task_step', 'ewoh_task_skill_req', 'ewoh_schedule_task', 'ewoh_schedule_task_step', 'ewoh_schedule_assignment', 'ewoh_resource_preorder', 'ewoh_resource_binding', 'ewoh_control_request', 'ewoh_control_command', 'ewoh_control_result', 'ewoh_event_rule', 'ewoh_event_action', 'ewoh_event_subscription', 'ewoh_knowledge_base', 'ewoh_knowledge_entry', 'ewoh_notification'] LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', '__EWOH_SCHEMA__', t);
    EXECUTE format('DROP POLICY IF EXISTS ewoh_org_select ON %I.%I', '__EWOH_SCHEMA__', t);
    EXECUTE format('CREATE POLICY ewoh_org_select ON %I.%I FOR SELECT TO %I USING (%I.ewoh_org_visible(org_id))', '__EWOH_SCHEMA__', t, 'authenticated_workspace_aadknm4yzbyds', '__EWOH_SCHEMA__');
    EXECUTE format('DROP POLICY IF EXISTS ewoh_service_all ON %I.%I', '__EWOH_SCHEMA__', t);
    EXECUTE format('CREATE POLICY ewoh_service_all ON %I.%I FOR ALL TO %I USING (%I.ewoh_org_visible(org_id)) WITH CHECK (%I.ewoh_org_visible(org_id))', '__EWOH_SCHEMA__', t, 'service_role_workspace_aadknm4yzbyds', '__EWOH_SCHEMA__', '__EWOH_SCHEMA__');
  END LOOP;
END
$ewoh_rls_normal$;

-- Special policies: global rows only for admin; system_config public rows readable.
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_world_snapshot;
CREATE POLICY ewoh_org_select ON __EWOH_SCHEMA__.ewoh_world_snapshot FOR SELECT TO authenticated_workspace_aadknm4yzbyds USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_world_snapshot;
CREATE POLICY ewoh_service_all ON __EWOH_SCHEMA__.ewoh_world_snapshot FOR ALL TO service_role_workspace_aadknm4yzbyds USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true')) WITH CHECK (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_delta_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_world_delta_log;
CREATE POLICY ewoh_org_select ON __EWOH_SCHEMA__.ewoh_world_delta_log FOR SELECT TO authenticated_workspace_aadknm4yzbyds USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_world_delta_log;
CREATE POLICY ewoh_service_all ON __EWOH_SCHEMA__.ewoh_world_delta_log FOR ALL TO service_role_workspace_aadknm4yzbyds USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true')) WITH CHECK (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));
ALTER TABLE __EWOH_SCHEMA__.ewoh_system_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_system_config;
CREATE POLICY ewoh_org_select ON __EWOH_SCHEMA__.ewoh_system_config FOR SELECT TO authenticated_workspace_aadknm4yzbyds USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND (is_public OR coalesce(current_setting('app.is_global_admin', true), '') = 'true')));
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_system_config;
CREATE POLICY ewoh_service_all ON __EWOH_SCHEMA__.ewoh_system_config FOR ALL TO service_role_workspace_aadknm4yzbyds USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND (is_public OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'))) WITH CHECK (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));
ALTER TABLE __EWOH_SCHEMA__.ewoh_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ewoh_audit_select ON __EWOH_SCHEMA__.ewoh_audit_log;
CREATE POLICY ewoh_audit_select ON __EWOH_SCHEMA__.ewoh_audit_log FOR SELECT TO service_role_workspace_aadknm4yzbyds USING (__EWOH_SCHEMA__.ewoh_org_visible(org_id) OR (org_id IS NULL AND coalesce(current_setting('app.is_global_admin', true), '') = 'true'));

-- Grants: only the trusted backend role gets DML; audit_log is write-only via function.
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_device FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_device TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_device_binding FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_device_binding TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_device_config FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_device_config TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_environment FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_environment TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_event FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_event TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_event_chain FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_event_chain TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_model_registry FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_model_registry TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_organization FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_organization TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_personnel FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_personnel TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_production_task FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_production_task TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_schedule_audit FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_audit TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_schedule_plan FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_plan TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_scheduler_config FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduler_config TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_spatial_entity FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_spatial_entity TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_telemetry FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_telemetry TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_topology FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_topology TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_world_state FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_world_state TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_person_skill FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_person_skill TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_skill FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_skill TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_role FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_role TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_person_role FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_person_role TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_device_capability FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_device_capability TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_spatial_relation FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_spatial_relation TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_spatial_hierarchy FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_spatial_hierarchy TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_model_asset FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_model_asset TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_model_binding FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_model_binding TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_workstation FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_workstation TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_workstation_device FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_workstation_device TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_workstation_person FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_workstation_person TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_workstation_skill FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_workstation_skill TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_workstation_relation FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_workstation_relation TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_task_template FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_task_template TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_task_step FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_task_step TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_task_skill_req FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_task_skill_req TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_schedule_task FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_task TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_schedule_task_step FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_task_step TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_schedule_assignment FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_assignment TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_resource_preorder FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_resource_preorder TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_resource_binding FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_resource_binding TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_control_request FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_control_request TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_control_command FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_control_command TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_control_result FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_control_result TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_event_rule FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_event_rule TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_event_action FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_event_action TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_event_subscription FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_event_subscription TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_world_snapshot FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_world_snapshot TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_world_delta_log FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_world_delta_log TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_system_config FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_system_config TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_knowledge_base FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_knowledge_base TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_knowledge_entry TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_notification FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_notification TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_audit_log FROM anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, user_authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT SELECT ON TABLE __EWOH_SCHEMA__.ewoh_audit_log TO service_role_workspace_aadknm4yzbyds;
REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.ewoh_append_audit_log FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.ewoh_append_audit_log TO service_role_workspace_aadknm4yzbyds;
GRANT USAGE ON SCHEMA __EWOH_SCHEMA__ TO service_role_workspace_aadknm4yzbyds;
