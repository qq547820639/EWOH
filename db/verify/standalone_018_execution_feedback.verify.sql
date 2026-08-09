-- standalone_018_execution_feedback 验证（postgres.js 兼容：无 psql 元命令）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_execution'
  ) THEN missing := missing || 'ewoh_scheduling_execution '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '018 verify FAILED: missing tables: %', missing;
  END IF;
  RAISE NOTICE '018 verify OK: ewoh_scheduling_execution exists';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_execution'
      AND column_name IN ('execution_id','assignment_id','plan_id','status','deviation_type','actual_start_at','actual_end_at')) AS exec_key_cols,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'ewoh_scheduling_execution') AS exec_indexes;
