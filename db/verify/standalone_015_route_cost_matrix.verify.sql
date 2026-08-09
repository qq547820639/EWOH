-- EWOH Command Map 智能调度驾驶舱 — RouteCostMatrix 落库缓存 verification (Phase 2 / P2-T1)
-- Returns a single row with:
--   route_cost_matrix_columns — count of the key columns present
--   route_cost_matrix_indexes — count of indexes on the table
--   route_cost_matrix_uq       — 1 if the (task_id, snapshot_version) unique index exists
-- A result of (11, 3, 1) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM (
       SELECT 'matrix_id' AS column_name
       UNION ALL SELECT 'task_id'
       UNION ALL SELECT 'snapshot_version'
       UNION ALL SELECT 'policy_version'
       UNION ALL SELECT 'solver_version'
       UNION ALL SELECT 'candidates_json'
       UNION ALL SELECT 'generated_at'
       UNION ALL SELECT 'org_id'
       UNION ALL SELECT '_created_at'
       UNION ALL SELECT '_updated_at'
       UNION ALL SELECT 'id'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_route_cost_matrix'
      AND c.column_name = expected.column_name
  ) AS route_cost_matrix_columns,
  (SELECT count(*)::bigint
     FROM pg_indexes i
    WHERE i.schemaname = '__EWOH_SCHEMA__'
      AND i.tablename = 'ewoh_route_cost_matrix'
      AND (
        i.indexname LIKE 'idx_ewoh_route_cost_matrix_%'
        OR i.indexname LIKE 'uq_ewoh_route_cost_matrix_%'
      )
  ) AS route_cost_matrix_indexes,
  (SELECT count(*)::bigint
     FROM pg_indexes i
    WHERE i.schemaname = '__EWOH_SCHEMA__'
      AND i.tablename = 'ewoh_route_cost_matrix'
      AND i.indexname = 'uq_ewoh_route_cost_matrix_task_snapshot'
  ) AS route_cost_matrix_uq;
