-- standalone_031_snapshot_version_counter 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标：
--   1) ewoh_snapshot_version_counter 表存在
--   2) 4 个期望列齐全（day/last_seq/created_at/_updated_at）
--   3) day 为 PRIMARY KEY（按天唯一，upsert 冲突目标）
-- 空库上恒为期望值（表存在由迁移保证，不依赖任何种子数据），保证本 verify 可直通。
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言（runner 使用精确 === 判定）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  tbl integer := 0;
BEGIN
  SELECT count(*) INTO tbl FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_snapshot_version_counter';
  IF tbl <> 1 THEN missing := missing || 'table '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '031 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '031 verify OK: ewoh_snapshot_version_counter exists';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_snapshot_version_counter'
      AND column_name IN ('day','last_seq','created_at','_updated_at')
  ) AS counter_columns,
  (SELECT count(*) FROM information_schema.table_constraints
    WHERE table_schema = current_schema() AND table_name = 'ewoh_snapshot_version_counter'
      AND constraint_type = 'PRIMARY KEY'
  ) AS counter_pk;
