-- standalone_069 verify：ewoh_schedule_plan.created_by 列存在 + 类型/长度自证。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

SELECT
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'ewoh_schedule_plan'
     AND column_name = 'created_by') AS has_created_by,
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = current_schema()
     AND table_name = 'ewoh_schedule_plan'
     AND column_name = 'created_by'
     AND character_maximum_length = 255) AS created_by_len_255
\gset

SELECT CASE
  WHEN :has_created_by = 1 AND :created_by_len_255 = 1
  THEN 'standalone_069_verified'
  ELSE 'standalone_069_verify_failed'
END AS result;
