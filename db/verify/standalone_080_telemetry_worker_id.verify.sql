-- 080 verify：遥测佩戴人列与"每设备最近一帧"索引就位，且遥测 RLS 不变量未被破坏。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_telemetry'
      AND column_name = 'worker_id'
      AND data_type = 'character varying'
      AND is_nullable = 'YES') = 1
  AND EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_ewoh_telemetry_org_device_ts'
      AND indexdef LIKE '%(org_id, device_id, ts DESC)%'
  )
  -- 遥测 RLS 策略仍在（租户隔离不被本次改动破坏）
  AND (SELECT relrowsecurity FROM pg_class
        WHERE oid = '__EWOH_SCHEMA__.ewoh_telemetry'::regclass) = true
  AND (SELECT count(*) FROM pg_policies
        WHERE schemaname = current_schema() AND tablename = 'ewoh_telemetry') >= 2
  THEN 1 ELSE 0 END AS standalone_080_verified;
