-- standalone_064 回滚：移除 ewoh_schedule_plan.ai_narration / narration_source。
-- 数据损失：存量 ai_narration 文本将删除（仅用于迁移链验证，生产禁用）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'ai_narration'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN ai_narration;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'narration_source'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DROP COLUMN narration_source;
  END IF;
END $$;
