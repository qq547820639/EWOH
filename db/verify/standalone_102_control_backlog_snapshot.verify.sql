-- 102 verify：表结构 + 索引 + RLS + 行为探针（插入→计数→删除）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  has_table boolean := false;
  has_index boolean := false;
  has_rls boolean := false;
  has_policy boolean := false;
  probe_ok boolean := false;
  probe_org varchar := '00000000-0000-4000-8000-000000000001';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'ewoh_control_backlog_snapshot'
  ) INTO has_table;
  IF NOT has_table THEN RAISE EXCEPTION '102 verify FAILED: 表不存在'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema() AND indexname = 'idx_ewoh_control_backlog_snapshot_org_time'
  ) INTO has_index;

  -- 租户隔离：RLS 必须开启 + org 隔离策略必须存在（audit-unrls-tenant-tables 同判据）
  SELECT c.relrowsecurity INTO has_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relname = 'ewoh_control_backlog_snapshot';
  SELECT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = current_schema() AND tablename = 'ewoh_control_backlog_snapshot'
       AND policyname = 'control_backlog_snapshot_org_isolation'
  ) INTO has_policy;

  BEGIN
    INSERT INTO ewoh_control_backlog_snapshot (org_id, sla_ms, escalation_multiplier, totals, devices)
    VALUES (probe_org, 300000, 3, '{"commands":1}'::jsonb, '[{"deviceId":"X"}]'::jsonb);
    probe_ok := EXISTS (
      SELECT 1 FROM ewoh_control_backlog_snapshot
       WHERE org_id = probe_org AND totals->>'commands' = '1'
    );
    DELETE FROM ewoh_control_backlog_snapshot WHERE org_id = probe_org;
  EXCEPTION WHEN OTHERS THEN
    probe_ok := false;
    DELETE FROM ewoh_control_backlog_snapshot WHERE org_id = probe_org;
  END;

  IF NOT has_table OR NOT has_index OR NOT has_rls OR NOT has_policy OR NOT probe_ok THEN
    RAISE EXCEPTION '102 verify incomplete: table=% index=% rls=% policy=% probe=%',
      has_table, has_index, has_rls, has_policy, probe_ok;
  END IF;
  RAISE NOTICE '102 verify OK: 表 + org/时间索引 + RLS/org 隔离策略 + 插入探针';
END $$;

SELECT 1 AS standalone_102_verified;
