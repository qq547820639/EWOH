-- standalone_077 verify：方案取消三列存在且类型正确。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

SELECT CASE WHEN
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'cancelled_reason'
      AND data_type = 'text'
      AND is_nullable = 'YES') = 1
  AND (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'cancelled_by'
      AND data_type = 'character varying'
      AND character_maximum_length = 255
      AND is_nullable = 'YES') = 1
  AND (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'cancelled_at'
      AND data_type = 'timestamp with time zone'
      AND is_nullable = 'YES') = 1
  THEN 1 ELSE 0 END AS standalone_077_verified;
