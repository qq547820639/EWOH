-- standalone_069 回滚：移除 ewoh_schedule_plan.created_by。
-- 数据损失：存量生成人记录将删除（仅用于迁移链验证，生产禁用）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'created_by'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN created_by;
  END IF;
END $$;
