-- EWOH Scheduling V2 Phase 2 — rollback (Task 2.1)
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox DROP COLUMN IF EXISTS entity_type;
ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox DROP COLUMN IF EXISTS entity_version;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_outbox_sequence;