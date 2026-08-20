-- standalone_064 verify：ewoh_schedule_plan 双列存在 + 来源约束语义自证。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

SELECT
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'ewoh_schedule_plan'
     AND column_name = 'ai_narration') AS has_ai_narration,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'ewoh_schedule_plan'
     AND column_name = 'narration_source') AS has_narration_source,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'ewoh_schedule_plan'
     AND column_name = 'ai_narration'
     AND data_type = 'text') AS narration_text_type,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'ewoh_schedule_plan'
     AND column_name = 'narration_source'
     AND character_maximum_length = 32) AS source_len_32
\gset

SELECT CASE
  WHEN :has_ai_narration = 1 AND :has_narration_source = 1
    AND :narration_text_type = 1 AND :source_len_32 = 1
  THEN 'standalone_064_verified'
  ELSE 'standalone_064_verify_failed'
END AS result;
