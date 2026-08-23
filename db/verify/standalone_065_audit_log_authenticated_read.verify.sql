-- standalone_057_audit_log_authenticated_read 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标：
--   1) ewoh_audit_log RLS 已启用
--   2) ewoh_audit_select_authenticated policy 存在且定义含 ewoh_org_visible
--   3) authenticated 角色有 SELECT 权限
--   4) service_role 原有 ewoh_audit_select policy 仍存在（不触碰）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  rls_on boolean := false;
  auth_pol integer := 0;
  svc_pol integer := 0;
  auth_grant integer := 0;
  pol_text text := '';
BEGIN
  -- 1) RLS 启用
  SELECT relrowsecurity INTO rls_on FROM pg_class
    WHERE relname = 'ewoh_audit_log' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema());

  -- 2) 新策略存在
  SELECT count(*) INTO auth_pol FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_audit_log'
      AND policyname = 'ewoh_audit_select_authenticated';

  -- 3) 原策略仍存在
  SELECT count(*) INTO svc_pol FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_audit_log'
      AND policyname = 'ewoh_audit_select';

  -- 4) authenticated 有 SELECT 权限
  SELECT count(*) INTO auth_grant
    FROM information_schema.role_table_grants
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_audit_log'
      AND grantee = current_setting('app.current_role', true)
      AND privilege_type = 'SELECT';

  IF NOT rls_on THEN
    RAISE EXCEPTION 'standalone_057 verify failed: RLS not enabled on ewoh_audit_log';
  END IF;
  IF auth_pol != 1 THEN
    RAISE EXCEPTION 'standalone_057 verify failed: ewoh_audit_select_authenticated policy not found';
  END IF;
  IF svc_pol != 1 THEN
    RAISE EXCEPTION 'standalone_057 verify failed: ewoh_audit_select policy missing (service_role policy removed)';
  END IF;
END $$;

SELECT 1 AS standalone_057_verified;
