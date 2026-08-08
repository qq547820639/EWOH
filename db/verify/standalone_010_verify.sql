-- EWOH Command Map 智能调度驾驶舱 — scheduling feedback table verification (Task 7)
-- Returns a single row with:
--   ewoh_scheduling_feedback_columns — count of the key feedback columns present
--   ewoh_scheduling_feedback_indexes — count of indexes on the feedback table
-- A result of (16, 4) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM (
       SELECT 'planned_start' AS column_name
       UNION ALL SELECT 'actual_start'
       UNION ALL SELECT 'planned_end'
       UNION ALL SELECT 'actual_end'
       UNION ALL SELECT 'planned_travel'
       UNION ALL SELECT 'actual_travel'
       UNION ALL SELECT 'planned_wait'
       UNION ALL SELECT 'actual_wait'
       UNION ALL SELECT 'original_resource_json'
       UNION ALL SELECT 'actual_resource_json'
       UNION ALL SELECT 'replan_count'
       UNION ALL SELECT 'conflict_count'
       UNION ALL SELECT 'override_count'
       UNION ALL SELECT 'solver_runtime'
       UNION ALL SELECT 'solver_fallback'
       UNION ALL SELECT 'accepted'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_scheduling_feedback'
      AND c.column_name = expected.column_name
  ) AS ewoh_scheduling_feedback_columns,
  (SELECT count(*)::bigint
     FROM pg_indexes i
    WHERE i.schemaname = '__EWOH_SCHEMA__'
      AND i.tablename = 'ewoh_scheduling_feedback'
      AND i.indexname LIKE 'idx_ewoh_scheduling_feedback_%'
  ) AS ewoh_scheduling_feedback_indexes;