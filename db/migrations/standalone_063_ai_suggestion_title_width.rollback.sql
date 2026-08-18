-- standalone_063 回滚：ai_suggestion.title 收窄回 255（可能截断 >255 存量行，
-- 仅用于迁移链验证，生产禁用）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_ai_suggestion'
      AND column_name = 'title'
      AND character_maximum_length = 500
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion
      ALTER COLUMN title TYPE varchar(255);
  END IF;
END $$;
