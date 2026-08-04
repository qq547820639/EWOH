-- EWOH F61-02 domain persistence tables rollback (2.A database artifacts)
-- DESTRUCTIVE: drops the 6 tables created by standalone_004_ewoh_domain.sql.
-- Reverse dependency order; every DROP guarded with IF EXISTS for re-entrancy.
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_idempotency_keys CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_factory_replication_sessions CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_evidence_metadata CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_git_sync_state CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_handoffs CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_resource_locks CASCADE;