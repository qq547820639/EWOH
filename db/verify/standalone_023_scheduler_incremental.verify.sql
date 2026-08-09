-- standalone_023_scheduler_incremental 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（05 §4.1 verify 期望值）：
--   constraint 新列 = 6（valid_from_ms/expires_at_ms/org_id/source/deactivated_at/deactivated_by）
--   constraint 索引 = 2（idx_constraint_org_active / idx_constraint_expiry）
--   plan 新列 = 2（constraints_json / effective_constraints_hash）
--   spatial 新列 = 2（coordinate_type / floor_id）
--   device 新列 = 1（location_coordinate_type）
--   RLS policy = 1（scheduler_constraint_org_isolation）
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言（runner 使用 >= 关键列 + RLS policy 计数判定）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  constraint_new_cols integer := 0;
  constraint_idx integer := 0;
  plan_new_cols integer := 0;
  spatial_new_cols integer := 0;
  device_new_cols integer := 0;
  rls_policies integer := 0;
BEGIN
  SELECT count(*) INTO constraint_new_cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_constraint'
      AND column_name IN ('valid_from_ms','expires_at_ms','org_id','source','deactivated_at','deactivated_by');
  IF constraint_new_cols <> 6 THEN
    missing := missing || format('constraint_new_cols=%s ', constraint_new_cols);
  END IF;

  SELECT count(*) INTO constraint_idx FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'ewoh_scheduling_constraint'
      AND indexname IN ('idx_constraint_org_active','idx_constraint_expiry');
  IF constraint_idx <> 2 THEN
    missing := missing || format('constraint_idx=%s ', constraint_idx);
  END IF;

  SELECT count(*) INTO plan_new_cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan'
      AND column_name IN ('constraints_json','effective_constraints_hash');
  IF plan_new_cols <> 2 THEN
    missing := missing || format('plan_new_cols=%s ', plan_new_cols);
  END IF;

  SELECT count(*) INTO spatial_new_cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_spatial_entity'
      AND column_name IN ('coordinate_type','floor_id');
  IF spatial_new_cols <> 2 THEN
    missing := missing || format('spatial_new_cols=%s ', spatial_new_cols);
  END IF;

  SELECT count(*) INTO device_new_cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_device'
      AND column_name = 'location_coordinate_type';
  IF device_new_cols <> 1 THEN
    missing := missing || format('device_new_cols=%s ', device_new_cols);
  END IF;

  SELECT count(*) INTO rls_policies FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_scheduling_constraint'
      AND policyname = 'scheduler_constraint_org_isolation';
  IF rls_policies <> 1 THEN
    missing := missing || format('rls_policies=%s ', rls_policies);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '023 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '023 verify OK: constraint new cols=6 idx=2 plan=2 spatial=2 device=1 rls=1';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_constraint'
       AND column_name IN ('valid_from_ms','expires_at_ms','org_id','source','deactivated_at','deactivated_by')
  ) AS constraint_new_cols,
  (SELECT count(*) FROM pg_indexes
     WHERE schemaname = current_schema() AND tablename = 'ewoh_scheduling_constraint'
       AND indexname IN ('idx_constraint_org_active','idx_constraint_expiry')
  ) AS constraint_indexes,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan'
       AND column_name IN ('constraints_json','effective_constraints_hash')
  ) AS plan_new_cols,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_spatial_entity'
       AND column_name IN ('coordinate_type','floor_id')
  ) AS spatial_new_cols,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_device'
       AND column_name = 'location_coordinate_type'
  ) AS device_new_cols,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = current_schema() AND tablename = 'ewoh_scheduling_constraint'
       AND policyname = 'scheduler_constraint_org_isolation'
  ) AS rls_policies;
