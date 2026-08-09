-- standalone_016_task_requirement 验证（真实 DB 执行，输出列存在性断言）。
-- 用法：psql -f db/verify/standalone_016_task_requirement.verify.sql
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;


DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_production_task'
      AND column_name = 'required_device_capabilities'
  ) THEN missing := missing || 'required_device_capabilities '; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_production_task'
      AND column_name = 'candidate_stations'
  ) THEN missing := missing || 'candidate_stations '; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_production_task'
      AND column_name = 'required_skills'
  ) THEN missing := missing || 'required_skills '; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_production_task'
      AND column_name = 'required_certifications'
  ) THEN missing := missing || 'required_certifications '; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_production_task'
      AND column_name = 'predecessor_ids'
  ) THEN missing := missing || 'predecessor_ids '; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_personnel'
      AND column_name = 'certifications'
  ) THEN missing := missing || 'certifications '; END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '016 verify FAILED: missing columns: %', missing;
  END IF;
  RAISE NOTICE '016 verify OK: 全部 TaskRequirement 列存在';
END $$;

-- backfill 数据完整性：新列不允许 NULL（除空库外）
SELECT count(*) AS null_required_device_capability_rows
FROM __EWOH_SCHEMA__.ewoh_production_task
WHERE required_device_capabilities IS NULL;
