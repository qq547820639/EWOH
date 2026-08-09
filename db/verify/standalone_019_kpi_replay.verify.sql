-- standalone_019_kpi_replay 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_kpi') THEN missing := missing || 'ewoh_scheduling_kpi '; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'ewoh_policy_replay') THEN missing := missing || 'ewoh_policy_replay '; END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION '019 verify FAILED: missing tables: %', missing;
  END IF;
  RAISE NOTICE '019 verify OK: kpi + policy_replay tables exist';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_policy_replay'
      AND column_name IN ('replay_id','candidate_policy_version','baseline_policy_version','snapshot_version','aggregate_kpis_json','per_run_results_json')) AS replay_key_cols;
