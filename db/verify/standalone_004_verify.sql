-- EWOH F61-02 domain persistence tables verification (2.A database artifacts)
-- Returns a single row with a count of the 6 managed domain tables that exist
-- in the target schema. A value of 6 in ewoh_domain_table_count means all present.
SELECT
  count(*)::bigint AS ewoh_domain_table_count
FROM (
  VALUES
    ('ewoh_resource_locks'),
    ('ewoh_handoffs'),
    ('ewoh_git_sync_state'),
    ('ewoh_evidence_metadata'),
    ('ewoh_factory_replication_sessions'),
    ('ewoh_idempotency_keys')
) AS expected(name)
JOIN information_schema.tables t
  ON t.table_schema = '__EWOH_SCHEMA__' AND t.table_name = expected.name;