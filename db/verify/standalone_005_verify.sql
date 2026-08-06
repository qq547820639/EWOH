-- EWOH Role Workbench production persistence verification (2.A database artifacts)
-- Returns a single row with:
--   ewoh_workbench_persist_table_count — count of the 2 new domain tables present
--   workbench_org_columns — count of the 6 workbench source tables that now carry org_id
--   saved_views_default_uq — 1 if the partial unique default-view index exists
-- A result of (2, 6, 1) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM information_schema.tables t
    WHERE t.table_schema = '__EWOH_SCHEMA__'
      AND t.table_name IN ('saved_views', 'workbench_export_tasks')
  ) AS ewoh_workbench_persist_table_count,
  (SELECT count(*)::bigint
     FROM (
       SELECT 'ewoh_schedule_task' AS name
       UNION ALL SELECT 'ewoh_schedule_task_step'
       UNION ALL SELECT 'ewoh_event'
       UNION ALL SELECT 'ewoh_world_state'
       UNION ALL SELECT 'ewoh_spatial_entity'
       UNION ALL SELECT 'ewoh_resource_binding'
     ) AS expected(name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__' AND c.table_name = expected.name AND c.column_name = 'org_id'
  ) AS workbench_org_columns,
  (SELECT count(*)::bigint
     FROM pg_indexes i
    WHERE i.schemaname = '__EWOH_SCHEMA__'
      AND i.tablename = 'saved_views'
      AND i.indexname = 'uq_saved_views_default'
  ) AS saved_views_default_uq;