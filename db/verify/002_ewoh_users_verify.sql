-- 002_ewoh_users verify（审计 SQL-103 补齐，2026-08-17；legacy Miaoda 轨）。
-- Schema: __EWOH_SCHEMA__（runner substitute 注入）。
-- 断言 ewoh_user 的 fail-closed 设计（RLS 启用 + 无 policy + 全角色 REVOKE，
-- 读路径仅 SECURITY DEFINER 函数 ewoh_find_active_user）。
-- 形态：DO 块自证 + 单行 users_verified（runner --verify-users 断言 =1）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  v_table_missing boolean;
  v_rls_enabled boolean;
  v_policy_count bigint;
  v_dml_grants bigint;
  v_fn_count bigint;
  v_fn_public_exec boolean;
BEGIN
  SELECT to_regclass('__EWOH_SCHEMA__.ewoh_user') IS NULL INTO v_table_missing;
  IF v_table_missing THEN
    RAISE EXCEPTION 'verify 002_ewoh_users: 表 __EWOH_SCHEMA__.ewoh_user 不存在';
  END IF;

  SELECT c.relrowsecurity INTO v_rls_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = '__EWOH_SCHEMA__' AND c.relname = 'ewoh_user';
  IF NOT v_rls_enabled THEN
    RAISE EXCEPTION 'verify 002_ewoh_users: ewoh_user RLS 未启用（fail-closed 设计要求启用）';
  END IF;

  SELECT count(*) INTO v_policy_count FROM pg_policies
   WHERE schemaname = '__EWOH_SCHEMA__' AND tablename = 'ewoh_user';
  IF v_policy_count <> 0 THEN
    RAISE EXCEPTION 'verify 002_ewoh_users: ewoh_user 存在 % 条 policy（设计为无 policy 全拒）', v_policy_count;
  END IF;

  -- 全角色无直接 DML 授权（含 PUBLIC）。
  SELECT count(*) INTO v_dml_grants
    FROM information_schema.role_table_grants
   WHERE table_schema = '__EWOH_SCHEMA__' AND table_name = 'ewoh_user'
     AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  IF v_dml_grants <> 0 THEN
    RAISE EXCEPTION 'verify 002_ewoh_users: ewoh_user 存在直接 DML 授权 % 条（设计为全拒，仅函数受控读取）', v_dml_grants;
  END IF;

  SELECT count(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = '__EWOH_SCHEMA__' AND p.proname = 'ewoh_find_active_user';
  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION 'verify 002_ewoh_users: ewoh_find_active_user 函数数量 %（期望 1）', v_fn_count;
  END IF;

  SELECT has_function_privilege('public', '__EWOH_SCHEMA__.ewoh_find_active_user(text)', 'EXECUTE')
    INTO v_fn_public_exec;
  IF v_fn_public_exec THEN
    RAISE EXCEPTION 'verify 002_ewoh_users: ewoh_find_active_user 对 PUBLIC 可执行（期望已 REVOKE）';
  END IF;
END $$;

SELECT 1 AS users_verified;
