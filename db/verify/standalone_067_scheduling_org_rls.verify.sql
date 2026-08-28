-- standalone_067_scheduling_org_rls 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标：
--   1) 5 张表 relrowsecurity 全部启用
--   2) 5 个 org isolation policy 存在且均 TO service_role
--   3) rollback 安全前提：policy 与 RLS 开关成对（禁止单边残留）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  rls_enabled integer := 0;
  policy_count integer := 0;
  expected_tables text[] := ARRAY[
    'ewoh_scheduling_execution',
    'ewoh_scheduling_conflict',
    'ewoh_scheduling_kpi',
    'ewoh_route_cost_matrix',
    'ewoh_policy_activation'
  ];
BEGIN
  -- 1) RLS 开关：5/5 启用
  SELECT count(*) INTO rls_enabled FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema()
     AND c.relname = ANY (expected_tables)
     AND c.relrowsecurity = true;
  IF rls_enabled != 5 THEN
    RAISE EXCEPTION 'standalone_067 verify failed: expected 5 tables with RLS enabled, got %', rls_enabled;
  END IF;

  -- 2) policy：5/5 存在，且全部 TO service_role
  SELECT count(*) INTO policy_count FROM pg_policies
   WHERE schemaname = current_schema()
     AND tablename = ANY (expected_tables)
     AND policyname IN (
       'scheduling_execution_org_isolation',
       'scheduling_conflict_org_isolation',
       'scheduling_kpi_org_isolation',
       'route_cost_matrix_org_isolation',
       'policy_activation_org_isolation'
     )
     AND roles = ARRAY['service_role'];
  IF policy_count != 5 THEN
    RAISE EXCEPTION 'standalone_067 verify failed: expected 5 org isolation policies TO service_role, got %', policy_count;
  END IF;
END $$;
