-- standalone_063_ai_suggestion_title_width 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（P1：ai_suggestion 列宽漂移收口）：
--   1) title 列宽 = 500（与 schema.ts 对齐）；
--   2) suggestion_type / status / ai_level 列宽 = 255（schema.ts 回填后一致）。
-- （单字段断言形态，同 SQL-103 先例；不落任何脏数据。）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  w_title integer := 0;
  w_type integer := 0;
  w_status integer := 0;
  w_level integer := 0;
BEGIN
  SELECT character_maximum_length INTO w_title FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_ai_suggestion' AND column_name = 'title';
  SELECT character_maximum_length INTO w_type FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_ai_suggestion' AND column_name = 'suggestion_type';
  SELECT character_maximum_length INTO w_status FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_ai_suggestion' AND column_name = 'status';
  SELECT character_maximum_length INTO w_level FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_ai_suggestion' AND column_name = 'ai_level';

  IF w_title IS DISTINCT FROM 500 THEN
    RAISE EXCEPTION 'verify incomplete: title 列宽不符 (want 500, got %)', w_title;
  END IF;
  IF w_type IS DISTINCT FROM 255 OR w_status IS DISTINCT FROM 255 OR w_level IS DISTINCT FROM 255 THEN
    RAISE EXCEPTION 'verify incomplete: 列宽不符 (type=%, status=%, level=%; want 255)', w_type, w_status, w_level;
  END IF;
END $$;

SELECT 1 AS standalone_063_verified;
