-- standalone_029_prediction_shadow_observation 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（Task 7）：
--   1) prediction_shadow_observation 表存在
--   2) 18 个期望列齐全（id/org_id/prediction_type/entity_id/task_id/correlation_id/
--      execution_id/prediction/baseline/actual/confidence/model_version/policy_version/
--      snapshot_version/created_at/actual_at/absolute_error/relative_error）
--   3) 3 个期望索引存在（idx_..._org_created / idx_..._correlation / idx_..._task）
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
    WHERE table_schema = current_schema() AND table_name = 'prediction_shadow_observation';
  IF tbl <> 1 THEN missing := missing || 'table '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '029 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '029 verify OK: prediction_shadow_observation exists';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'prediction_shadow_observation'
      AND column_name IN ('id','org_id','prediction_type','entity_id','task_id','correlation_id',
                          'execution_id','prediction','baseline','actual','confidence','model_version',
                          'policy_version','snapshot_version','created_at','actual_at',
                          'absolute_error','relative_error')
  ) AS shadow_obs_columns,
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'prediction_shadow_observation'
      AND indexname IN ('idx_prediction_shadow_observation_org_created',
                        'idx_prediction_shadow_observation_correlation',
                        'idx_prediction_shadow_observation_task')
  ) AS shadow_obs_indexes;
