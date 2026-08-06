-- EWOH F61-02 domain persistence tables migration (2.A database artifacts)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / COMMENT.
-- No physical foreign keys. These tables back agent/domain state (locks, handoffs,
-- git sync, evidence metadata, factory replication sessions, idempotency keys).
-- Idempotent by construction: safe to run repeatedly without error or data loss.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ---------------------------------------------------------------------------
-- 1) ewoh_resource_locks — distributed resource locking with optimistic versioning
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_resource_locks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  resource_key varchar(255) NOT NULL,
  resource_id varchar(255) NOT NULL,
  holder varchar(255) NOT NULL,
  purpose text,
  acquired_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz(3),
  renewed_at timestamptz(3),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_resource_locks_org_key ON __EWOH_SCHEMA__.ewoh_resource_locks (org_id, resource_key);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_locks_holder ON __EWOH_SCHEMA__.ewoh_resource_locks (holder);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_locks_active ON __EWOH_SCHEMA__.ewoh_resource_locks (active);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_resource_locks IS 'Distributed resource locks with optimistic versioning';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_resource_locks.id IS 'Primary key (gen_random_uuid)';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_resource_locks.org_id IS 'Organization/tenant scope';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_resource_locks.resource_key IS 'Logical lock key (unique per org)';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_resource_locks.resource_id IS 'Physical resource being locked';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_resource_locks.holder IS 'Lock holder identity';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_resource_locks.active IS 'Whether the lock is currently active';

-- ---------------------------------------------------------------------------
-- 2) ewoh_handoffs — agent/actor context handoffs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id varchar(255) NOT NULL UNIQUE,
  from_actor varchar(255) NOT NULL,
  to_actor varchar(255) NOT NULL,
  scope varchar(500) NOT NULL,
  context_pack text,
  acceptance text,
  open_questions jsonb,
  state varchar(50) NOT NULL DEFAULT 'open',
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at timestamptz(3),
  closed_at timestamptz(3),
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_handoffs_state ON __EWOH_SCHEMA__.ewoh_handoffs (state);
CREATE INDEX IF NOT EXISTS idx_ewoh_handoffs_to_actor ON __EWOH_SCHEMA__.ewoh_handoffs (to_actor);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_handoffs IS 'Context handoffs between actors/agents';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_handoffs.open_questions IS 'Array of open questions (jsonb)';

-- ---------------------------------------------------------------------------
-- 3) ewoh_git_sync_state — last git sync cursor/status
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_git_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_id varchar(255) NOT NULL UNIQUE,
  last_sync_at timestamptz(3),
  last_sync_sha varchar(64),
  last_sync_status varchar(50),
  conflicts jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_git_sync_state IS 'Git sync cursors and conflict state';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_git_sync_state.conflicts IS 'Conflict list (jsonb)';

-- ---------------------------------------------------------------------------
-- 4) ewoh_evidence_metadata — evidence provenance/verification metadata
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_evidence_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id varchar(255) NOT NULL UNIQUE,
  work_item_id varchar(255),
  commit_sha varchar(64),
  env_fingerprint varchar(255),
  verifier varchar(255),
  produced_at timestamptz(3),
  expires_at timestamptz(3),
  result varchar(50),
  checksum varchar(128),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_evidence_metadata_work_item ON __EWOH_SCHEMA__.ewoh_evidence_metadata (work_item_id);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_evidence_metadata IS 'Provenance and verification metadata for work evidence';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_evidence_metadata.checksum IS 'Content checksum of evidence';

-- ---------------------------------------------------------------------------
-- 5) ewoh_factory_replication_sessions — factory replication session tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_factory_replication_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id varchar(255) NOT NULL UNIQUE,
  org_id varchar(255),
  factory_id varchar(255) NOT NULL,
  step varchar(100),
  status varchar(50) NOT NULL DEFAULT 'running',
  progress integer NOT NULL DEFAULT 0,
  started_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at timestamptz(3),
  output_evidence_id varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_factory_replication_sessions_factory ON __EWOH_SCHEMA__.ewoh_factory_replication_sessions (factory_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_factory_replication_sessions_status ON __EWOH_SCHEMA__.ewoh_factory_replication_sessions (status);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_factory_replication_sessions IS 'Factory replication session lifecycle';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_factory_replication_sessions.progress IS 'Progress percentage 0..100';

-- ---------------------------------------------------------------------------
-- 6) ewoh_idempotency_keys — idempotent request/action deduplication
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key varchar(500) NOT NULL,
  scope varchar(100) NOT NULL DEFAULT 'default',
  response jsonb,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_idempotency_keys_scope_key ON __EWOH_SCHEMA__.ewoh_idempotency_keys (scope, idempotency_key);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys IS 'Idempotency keys for deduplicated operations';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_idempotency_keys.response IS 'Cached response for replay (jsonb)';

-- ---------------------------------------------------------------------------
-- 7) Grants — the standalone API connects as `ewoh_api` (which is a member of
-- `service_role`); without explicit table grants the domain persistence writes
-- surface as 500 / permission denied. Mirror the grant set in
-- standalone_001_schema.sql. (No sequences: all PKs use gen_random_uuid().)
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_resource_locks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_handoffs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_git_sync_state TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_evidence_metadata TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_factory_replication_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_idempotency_keys TO service_role;