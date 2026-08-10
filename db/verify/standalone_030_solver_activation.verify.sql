-- standalone_030_solver_activation 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（Task A P0）：
--   1) ewoh_schedule_plan 存在 solver_status + fallback_reason 列（各 1）
--   2) ewoh_scheduling_run 存在 solver_status + fallback_reason 列（各 1）
-- 空库上恒为期望值（列存在由迁移保证，不依赖任何种子数据），保证本 verify 可直通。
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言（runner 使用精确 === 判定）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  plan_tbl integer := 0;
  run_tbl integer := 0;
BEGIN
  SELECT count(*) INTO plan_tbl FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan';
  IF plan_tbl <> 1 THEN missing := missing || 'ewoh_schedule_plan '; END IF;
  SELECT count(*) INTO run_tbl FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_run';
  IF run_tbl <> 1 THEN missing := missing || 'ewoh_scheduling_run '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '030 verify FAILED: missing tables: %', missing;
  END IF;
  RAISE NOTICE '030 verify OK: ewoh_schedule_plan + ewoh_scheduling_run exist';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan'
      AND column_name IN ('solver_status','fallback_reason')
  ) AS plan_solver_columns,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_run'
      AND column_name IN ('solver_status','fallback_reason')
  ) AS run_solver_columns;
