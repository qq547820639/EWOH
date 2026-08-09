-- standalone_020_policy_lifecycle 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_policy' AND column_name = 'status'
  ) THEN missing := missing || 'policy.status '; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_policy_activation'
  ) THEN missing := missing || 'ewoh_policy_activation '; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan' AND column_name = 'is_shadow'
  ) THEN missing := missing || 'plan.is_shadow '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '020 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '020 verify OK: policy.status + activation table + plan.is_shadow exist';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_policy_activation'
      AND column_name IN ('activation_id','policy_version','operator','gate_result_json','rollback_target')) AS activation_key_cols;
