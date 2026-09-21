-- standalone_103_workbench_query_indexes 验证。
DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;
DO $$
DECLARE index_count integer;
BEGIN
  SELECT count(*) INTO index_count
  FROM pg_indexes
  WHERE schemaname = current_schema()
    AND indexname IN (
      'idx_ewoh_schedule_task_org_status_plan_end',
      'idx_ewoh_schedule_task_step_org_status_name_trgm'
    );
  IF index_count != 2 THEN
    RAISE EXCEPTION 'standalone_103 verify failed: expected 2 workbench indexes, got %', index_count;
  END IF;
END $$;
SELECT 1 AS standalone_103_verified;
