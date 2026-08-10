-- standalone_027_resource_time_windows 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（spec §P1-A verify 期望值）：
--   maintenance_cols = 2（maintenance_start_ms / maintenance_end_ms 存在）
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  maintenance_cols integer := 0;
BEGIN
  SELECT count(*) INTO maintenance_cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_device'
      AND column_name IN ('maintenance_start_ms','maintenance_end_ms');
  IF maintenance_cols <> 2 THEN
    missing := missing || format('maintenance_cols=%s ', maintenance_cols);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '027 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '027 verify OK: device maintenance window columns present (cols=2)';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_device'
       AND column_name IN ('maintenance_start_ms','maintenance_end_ms')
  ) AS maintenance_cols;
