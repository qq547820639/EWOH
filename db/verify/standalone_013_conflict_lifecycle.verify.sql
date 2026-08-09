-- EWOH Command Map 智能调度驾驶舱 — Conflict Lifecycle 持久化 verification (Phase 3 / P3-T1)
-- Returns a single row with:
--   conflict_columns    — count of the key lifecycle columns present
--   conflict_indexes    — count of indexes on the table
--   conflict_status_default — 1 if status DEFAULT 'OPEN'
-- A result of (19, 4, 1) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM (
       SELECT 'conflict_id' AS column_name
       UNION ALL SELECT 'type'
       UNION ALL SELECT 'severity'
       UNION ALL SELECT 'scope'
       UNION ALL SELECT 'status'
       UNION ALL SELECT 'task_ids'
       UNION ALL SELECT 'resource_ids'
       UNION ALL SELECT 'resource_id'
       UNION ALL SELECT 'resource_type'
       UNION ALL SELECT 'plan_id'
       UNION ALL SELECT 'snapshot_version'
       UNION ALL SELECT 'message'
       UNION ALL SELECT 'resolution'
       UNION ALL SELECT 'data'
       UNION ALL SELECT 'detected_at'
       UNION ALL SELECT 'acknowledged_by'
       UNION ALL SELECT 'acknowledged_at'
       UNION ALL SELECT 'resolved_by'
       UNION ALL SELECT 'resolved_at'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_scheduling_conflict'
      AND c.column_name = expected.column_name
  ) AS conflict_columns,
  (SELECT count(*)::bigint
     FROM pg_indexes i
    WHERE i.schemaname = '__EWOH_SCHEMA__'
      AND i.tablename = 'ewoh_scheduling_conflict'
      AND i.indexname LIKE 'idx_ewoh_scheduling_conflict_%'
  ) AS conflict_indexes,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_scheduling_conflict'
      AND c.column_name = 'status'
      AND c.column_default IS NOT NULL
      AND c.column_default ILIKE '%OPEN%'
  ) AS conflict_status_default;
