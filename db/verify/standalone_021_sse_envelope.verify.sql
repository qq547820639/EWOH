-- standalone_021_sse_envelope 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_outbox' AND column_name = 'correlation_id'
  ) THEN missing := missing || 'outbox.correlation_id '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '021 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '021 verify OK: outbox.correlation_id exists';
END $$;

SELECT
  (SELECT count(*) FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'ewoh_outbox') AS outbox_indexes;
