-- standalone_068_dashboard_org_composite_indexes 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标：3 个复合索引存在且列序正确
--   idx_ewoh_event_org_status_severity  → (org_id, status, severity)
--   idx_ewoh_telemetry_org_ts_load      → (org_id, ts) [+ INCLUDE load_score]
--   idx_ewoh_device_org_online          → (org_id, online)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  idx_count integer := 0;
  col_check integer := 0;
BEGIN
  SELECT count(*) INTO idx_count FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname IN (
        'idx_ewoh_event_org_status_severity',
        'idx_ewoh_telemetry_org_ts_load',
        'idx_ewoh_device_org_online'
      );
  IF idx_count != 3 THEN
    RAISE EXCEPTION 'standalone_068 verify failed: expected 3 composite indexes, got %', idx_count;
  END IF;

  -- 列序断言：核心两索引的首列必须为 org_id（保证 org 等值前缀命中）
  SELECT count(*) INTO col_check FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
   WHERE n.nspname = current_schema()
     AND c.relname IN ('idx_ewoh_event_org_status_severity', 'idx_ewoh_telemetry_org_ts_load', 'idx_ewoh_device_org_online')
     AND a.attname = 'org_id';
  IF col_check != 3 THEN
    RAISE EXCEPTION 'standalone_068 verify failed: expected all 3 indexes leading with org_id, got %', col_check;
  END IF;
END $$;
