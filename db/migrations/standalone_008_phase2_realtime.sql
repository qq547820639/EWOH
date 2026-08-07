-- EWOH Scheduling V2 Phase 2 — real-time closed-loop (Task 2.1)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Safe to run repeatedly.
--
-- Adds entity_type / entity_version to ewoh_outbox so scheduling events carry the
-- entity type and its world-state version, enabling SSE gap detection and the
-- ImpactAnalyzer to classify events (RESOURCE_OFFLINE / RESERVATION_CONFLICT /
-- PLAN_STALE / ROUTE_BLOCKED) by the target entity.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox ADD COLUMN IF NOT EXISTS entity_type varchar(100);
ALTER TABLE __EWOH_SCHEMA__.ewoh_outbox ADD COLUMN IF NOT EXISTS entity_version integer;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_outbox.entity_type IS 'Entity type (device/person/task/route/zone...) referenced by entity_id';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_outbox.entity_version IS 'World-state version of entity_id at trigger time';

CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_sequence ON __EWOH_SCHEMA__.ewoh_outbox (sequence);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_outbox TO service_role;