-- EWOH Role Workbench production persistence migration (2.A database artifacts)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ALTER TABLE ... ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
-- / CREATE TABLE IF NOT EXISTS. No physical foreign keys.
--
-- Three concerns:
--   1) Add an `org_id` tenant column to the 5 workbench source tables so the
--      server-side list/export queries can be scoped to a single organization
--      (replacing the old in-memory `.limit(5000)` aggregation). Existing rows
--      are backfilled from the transaction-local `app.current_org_id` setting
--      when present (NULL otherwise — a safe no-op default).
--   2) `saved_views` — PostgreSQL-persisted, org+owner scoped, soft-deletable
--      saved workbench views with transactional default-view uniqueness.
--   3) `workbench_export_tasks` — durable async export task registry with a
--      queued → running → succeeded | failed | cancelling → cancelled | expired
--      state machine, atomic claim, idempotency dedup and retry bookkeeping.
-- Grants mirrored from standalone_001_schema.sql (service_role member).
--
-- Idempotent by construction: safe to run repeatedly without error or data loss.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ---------------------------------------------------------------------------
-- 1) org_id tenant column on workbench source tables + composite indexes
-- ---------------------------------------------------------------------------
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task ADD COLUMN IF NOT EXISTS org_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task_step ADD COLUMN IF NOT EXISTS org_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ADD COLUMN IF NOT EXISTS org_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ADD COLUMN IF NOT EXISTS org_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ADD COLUMN IF NOT EXISTS org_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_binding ADD COLUMN IF NOT EXISTS org_id varchar(255);

-- Backfill existing rows from the transaction-local org setting (NULL when absent).
UPDATE __EWOH_SCHEMA__.ewoh_schedule_task
  SET org_id = nullif(current_setting('app.current_org_id', true), '')::varchar
  WHERE org_id IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_schedule_task_step
  SET org_id = nullif(current_setting('app.current_org_id', true), '')::varchar
  WHERE org_id IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_event
  SET org_id = nullif(current_setting('app.current_org_id', true), '')::varchar
  WHERE org_id IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_world_state
  SET org_id = nullif(current_setting('app.current_org_id', true), '')::varchar
  WHERE org_id IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_spatial_entity
  SET org_id = nullif(current_setting('app.current_org_id', true), '')::varchar
  WHERE org_id IS NULL;
UPDATE __EWOH_SCHEMA__.ewoh_resource_binding
  SET org_id = nullif(current_setting('app.current_org_id', true), '')::varchar
  WHERE org_id IS NULL;

-- Composite indexes: org_id + frequent predicates (status / priority / ts analog)
-- + a stable unique key so cursor pagination stays correct with duplicate timestamps.
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_org_status ON __EWOH_SCHEMA__.ewoh_schedule_task (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_org_priority ON __EWOH_SCHEMA__.ewoh_schedule_task (org_id, priority);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_org_updated ON __EWOH_SCHEMA__.ewoh_schedule_task (org_id, _updated_at);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_org_key ON __EWOH_SCHEMA__.ewoh_schedule_task (org_id, schedule_task_id);

CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_step_org_status ON __EWOH_SCHEMA__.ewoh_schedule_task_step (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_task_step_org_assignee ON __EWOH_SCHEMA__.ewoh_schedule_task_step (org_id, assigned_person_id);

CREATE INDEX IF NOT EXISTS idx_ewoh_event_org_status ON __EWOH_SCHEMA__.ewoh_event (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_org_type ON __EWOH_SCHEMA__.ewoh_event (org_id, event_type);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_org_created ON __EWOH_SCHEMA__.ewoh_event (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ewoh_event_org_key ON __EWOH_SCHEMA__.ewoh_event (org_id, event_id);

CREATE INDEX IF NOT EXISTS idx_ewoh_world_state_org_ts ON __EWOH_SCHEMA__.ewoh_world_state (org_id, ts);

CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_entity_org_type ON __EWOH_SCHEMA__.ewoh_spatial_entity (org_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_entity_org_status ON __EWOH_SCHEMA__.ewoh_spatial_entity (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_spatial_entity_org_key ON __EWOH_SCHEMA__.ewoh_spatial_entity (org_id, entity_id);

CREATE INDEX IF NOT EXISTS idx_ewoh_resource_binding_org_status ON __EWOH_SCHEMA__.ewoh_resource_binding (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_binding_org_start ON __EWOH_SCHEMA__.ewoh_resource_binding (org_id, start_time);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_binding_org_key ON __EWOH_SCHEMA__.ewoh_resource_binding (org_id, binding_id);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_task.org_id IS 'Organization/tenant scope';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_task_step.org_id IS 'Organization/tenant scope';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_event.org_id IS 'Organization/tenant scope';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_world_state.org_id IS 'Organization/tenant scope';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_spatial_entity.org_id IS 'Organization/tenant scope';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_resource_binding.org_id IS 'Organization/tenant scope';

-- ---------------------------------------------------------------------------
-- 2) saved_views — org+owner scoped, soft-deletable saved workbench views
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.saved_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id varchar(255) NOT NULL,
  owner_user_id varchar(255) NOT NULL,
  name varchar(255) NOT NULL,
  workbench varchar(50) NOT NULL,
  list_key varchar(100),
  schema_version integer NOT NULL DEFAULT 1,
  filter_json jsonb,
  sort_json jsonb,
  visible_columns jsonb,
  column_order jsonb,
  density varchar(20),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz(3)
);

CREATE INDEX IF NOT EXISTS idx_saved_views_org_owner ON __EWOH_SCHEMA__.saved_views (organization_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_saved_views_org_name ON __EWOH_SCHEMA__.saved_views (organization_id, name);
-- One default view per (org, owner, workbench, list_key); soft-deleted rows excluded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_views_default
  ON __EWOH_SCHEMA__.saved_views (organization_id, owner_user_id, workbench, list_key)
  WHERE is_default AND deleted_at IS NULL;

COMMENT ON TABLE __EWOH_SCHEMA__.saved_views IS 'PostgreSQL-persisted saved workbench views';
COMMENT ON COLUMN __EWOH_SCHEMA__.saved_views.organization_id IS 'Organization/tenant scope';
COMMENT ON COLUMN __EWOH_SCHEMA__.saved_views.owner_user_id IS 'View owner';
COMMENT ON COLUMN __EWOH_SCHEMA__.saved_views.is_default IS 'Whether this is the default view for its (org, owner, workbench, list) bucket';

-- ---------------------------------------------------------------------------
-- 3) workbench_export_tasks — durable async export task registry
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.workbench_export_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id varchar(255) NOT NULL UNIQUE,
  organization_id varchar(255) NOT NULL,
  owner_user_id varchar(255) NOT NULL,
  role varchar(50) NOT NULL,
  list_key varchar(100) NOT NULL,
  filter_json jsonb,
  sort_json jsonb,
  columns_json jsonb,
  status varchar(20) NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  error text,
  idempotency_key varchar(255) UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz(3),
  claimed_by varchar(255),
  claimed_at timestamptz(3),
  started_at timestamptz(3),
  finished_at timestamptz(3),
  expires_at timestamptz(3),
  download_url text,
  file_size bigint,
  row_count bigint,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workbench_export_tasks_status_retry ON __EWOH_SCHEMA__.workbench_export_tasks (status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_workbench_export_tasks_org_owner ON __EWOH_SCHEMA__.workbench_export_tasks (organization_id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_workbench_export_tasks_idem ON __EWOH_SCHEMA__.workbench_export_tasks (idempotency_key);

COMMENT ON TABLE __EWOH_SCHEMA__.workbench_export_tasks IS 'Durable async export task registry with atomic claim and retry bookkeeping';
COMMENT ON COLUMN __EWOH_SCHEMA__.workbench_export_tasks.status IS 'queued|running|succeeded|failed|cancelling|cancelled|expired';
COMMENT ON COLUMN __EWOH_SCHEMA__.workbench_export_tasks.idempotency_key IS 'Client-supplied key for deduplicated creation';

-- ---------------------------------------------------------------------------
-- 4) Grants — the standalone API connects as `ewoh_api` (member of
-- `service_role`); without explicit grants these writes surface as permission
-- denied. Mirror the grant set in standalone_001_schema.sql.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.saved_views TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.workbench_export_tasks TO service_role;