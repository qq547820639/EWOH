-- 084 verify：责任人班次列与"同职责同班次唯一"索引就位。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_device_responsibility'
      AND column_name = 'shift_id'
      AND data_type = 'character varying'
      AND is_nullable = 'NO') = 1
  AND EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_ewoh_device_responsibility_active'
      AND indexdef LIKE '%(org_id, device_id, responsibility, shift_id)%'
      AND indexdef LIKE '%WHERE%active%'
  )
  AND EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'idx_ewoh_device_responsibility_shift'
      AND indexdef LIKE '%(org_id, device_id, shift_id)%'
  )
  AND (SELECT relrowsecurity FROM pg_class
        WHERE oid = '__EWOH_SCHEMA__.ewoh_device_responsibility'::regclass) = true
  THEN 1 ELSE 0 END AS standalone_084_verified;
