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
     -- relname 是 name 类型：与 text[] 比较必须显式转换（PG 不做 name = text 的数组蕴含转换，
     -- 全新库跑 verify 实测报 `operator does not exist: name[] = text[]`）。
     AND c.relname::text = ANY (expected_tables)
     AND c.relrowsecurity = true;
  IF rls_enabled != 5 THEN
    RAISE EXCEPTION 'standalone_067 verify failed: expected 5 tables with RLS enabled, got %', rls_enabled;
  END IF;

  -- 2) policy：5/5 存在，且全部 TO service_role
  SELECT count(*) INTO policy_count FROM pg_policies
   WHERE schemaname = current_schema()
     AND tablename::text = ANY (expected_tables)
     AND policyname IN (
       'scheduling_execution_org_isolation',
       'scheduling_conflict_org_isolation',
       'scheduling_kpi_org_isolation',
       'route_cost_matrix_org_isolation',
       'policy_activation_org_isolation'
     )
     -- pg_policies.roles 是 name[]：与 text 字面量数组比较要显式转型，
     -- 否则报 `operator does not exist: name[] = text[]`（全新库实测）。
     AND roles = ARRAY['service_role']::name[];
  IF policy_count != 5 THEN
    RAISE EXCEPTION 'standalone_067 verify failed: expected 5 org isolation policies TO service_role, got %', policy_count;
  END IF;
END $$;

-- 验证出口标记：迁移 runner 以该列判定"verify 通过"。
-- 缺陷背景（NO-58d）：本文件此前**没有出口标记**，于是无论断言是否通过，
-- runner 都报 "did not return standalone_067_verified=1" → 被登记进基线；
-- 补上标记后它才真正开始验证 RLS/策略（全新库实测修复）。
SELECT 1 AS standalone_067_verified;
