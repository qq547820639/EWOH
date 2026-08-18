-- standalone_002_users verify（审计 SQL-103 补齐，2026-08-17；standalone 轨）。
-- Schema: public。
-- 断言 ewoh_user 的 fail-closed 设计（RLS 启用 + 无 policy + 全角色 REVOKE，
-- 读路径仅 SECURITY DEFINER 函数 ewoh_find_active_user；设计意图见迁移内注释）。
-- 形态：DO 块自证 + 单行 standalone_002_users_verified（--verify-standalone-users 断言 =1）。
SELECT set_config('search_path', 'public, pg_temp', false);

DO $$
DECLARE
  v_table_missing boolean;
  v_rls_enabled boolean;
  v_policy_count bigint;
  v_dml_grants bigint;
  v_fn_count bigint;
  v_fn_public_exec boolean;
BEGIN
  SELECT to_regclass('public.ewoh_user') IS NULL INTO v_table_missing;
  IF v_table_missing THEN
    RAISE EXCEPTION 'verify standalone_002_users: 表 public.ewoh_user 不存在';
  END IF;

  SELECT c.relrowsecurity INTO v_rls_enabled
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'ewoh_user';
  IF NOT v_rls_enabled THEN
    RAISE EXCEPTION 'verify standalone_002_users: ewoh_user RLS 未启用（fail-closed 设计要求启用）';
  END IF;

  SELECT count(*) INTO v_policy_count FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'ewoh_user';
  IF v_policy_count <> 0 THEN
    RAISE EXCEPTION 'verify standalone_002_users: ewoh_user 存在 % 条 policy（设计为无 policy 全拒）', v_policy_count;
  END IF;

  SELECT count(*) INTO v_dml_grants
    FROM information_schema.role_table_grants g
    JOIN pg_tables t ON t.schemaname = g.table_schema AND t.tablename = g.table_name
   WHERE g.table_schema = 'public' AND g.table_name = 'ewoh_user'
     AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
     AND g.grantee <> t.tableowner;
  IF v_dml_grants <> 0 THEN
    RAISE EXCEPTION 'verify standalone_002_users: ewoh_user 存在直接 DML 授权 % 条（设计为全拒，仅函数受控读取）', v_dml_grants;
  END IF;

  SELECT count(*) INTO v_fn_count
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ewoh_find_active_user';
  IF v_fn_count <> 1 THEN
    RAISE EXCEPTION 'verify standalone_002_users: ewoh_find_active_user 函数数量 %（期望 1）', v_fn_count;
  END IF;

  SELECT has_function_privilege('public', 'public.ewoh_find_active_user(text)', 'EXECUTE')
    INTO v_fn_public_exec;
  IF v_fn_public_exec THEN
    RAISE EXCEPTION 'verify standalone_002_users: ewoh_find_active_user 对 PUBLIC 可执行（期望已 REVOKE）';
  END IF;
END $$;

SELECT 1 AS standalone_002_users_verified;
