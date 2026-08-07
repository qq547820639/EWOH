-- EWOH Intelligent Scheduling Workbench persistence verification (Task 1)
-- Returns a single row with:
--   ewoh_scheduling_table_count — count of the 7 new V2 tables present
--   ewoh_schedule_plan_v2_columns — count of the 7 V2 columns added to ewoh_schedule_plan
--   ewoh_schedule_plan_version_col — 1 if the `version` column exists on ewoh_schedule_plan
-- A result of (7, 7, 1) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM information_schema.tables t
    WHERE t.table_schema = '__EWOH_SCHEMA__'
      AND t.table_name IN (
        'ewoh_scheduling_run',
        'ewoh_scheduling_plan_assignment',
        'ewoh_scheduling_constraint',
        'ewoh_world_state_snapshot',
        'ewoh_route_node',
        'ewoh_route_edge',
        'ewoh_assignment_event'
      )
  ) AS ewoh_scheduling_table_count,
  (SELECT count(*)::bigint
     FROM (
       SELECT 'version' AS column_name
       UNION ALL SELECT 'snapshot_version'
       UNION ALL SELECT 'trigger_type'
       UNION ALL SELECT 'trigger_entity_id'
       UNION ALL SELECT 'baseline_delta_json'
       UNION ALL SELECT 'violations_json'
       UNION ALL SELECT 'superseded_by'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_schedule_plan'
      AND c.column_name = expected.column_name
  ) AS ewoh_schedule_plan_v2_columns,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_schedule_plan'
      AND c.column_name = 'version'
  ) AS ewoh_schedule_plan_version_col;