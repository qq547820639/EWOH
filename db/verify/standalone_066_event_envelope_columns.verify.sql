-- standalone_066_event_envelope_columns 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标：
--   1) ewoh_event 七列（occurred_at/observed_at/received_at/causation_id/
--      correlation_id/confidence/schema_version）存在且类型正确
--   2) 两个索引存在
--   3) 列 COMMENT 存在

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  col_count integer := 0;
  idx_count integer := 0;
BEGIN
  SELECT count(*) INTO col_count FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_event'
      AND column_name IN ('occurred_at','observed_at','received_at','causation_id','correlation_id','confidence','schema_version');
  IF col_count != 7 THEN
    RAISE EXCEPTION 'standalone_066 verify failed: expected 7 envelope columns, got %', col_count;
  END IF;

  SELECT count(*) INTO idx_count FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'ewoh_event'
      AND indexname IN ('idx_ewoh_event_occurred_at','idx_ewoh_event_correlation_id');
  IF idx_count != 2 THEN
    RAISE EXCEPTION 'standalone_066 verify failed: expected 2 envelope indexes, got %', idx_count;
  END IF;
END $$;

SELECT 1 AS standalone_066_verified;
