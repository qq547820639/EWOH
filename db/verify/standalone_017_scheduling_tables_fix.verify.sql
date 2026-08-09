-- standalone_017_scheduling_tables_fix 验证（真实 DB 执行）。
-- 用法：psql -f db/verify/standalone_017_scheduling_tables_fix.verify.sql
-- Schema: __EWOH_SCHEMA__ (standalone → public)

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;


DO $$
DECLARE
  missing text := '';
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'ewoh_resource_reservation',
    'ewoh_outbox',
    'ewoh_scheduling_policy',
    'ewoh_replan_trigger'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = tbl
    ) THEN
      missing := missing || tbl || ' ';
    END IF;
  END LOOP;
  IF missing <> '' THEN
    RAISE EXCEPTION '017 verify FAILED: missing tables: %', missing;
  END IF;
  RAISE NOTICE '017 verify OK: 4 张调度领域表存在';
END $$;

-- 关键列对齐检查
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_outbox'
      AND column_name IN ('event_id','event_type','entity_id','sequence','status')) AS outbox_key_cols,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_resource_reservation'
      AND column_name IN ('reservation_id','resource_type','resource_id','start_ms','end_ms')) AS reservation_key_cols,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_policy'
      AND column_name IN ('config_version','config_json','weights_json','active')) AS policy_key_cols,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_replan_trigger'
      AND column_name IN ('trigger_key','org_id','trigger_type','entity_id')) AS replan_trigger_key_cols;
