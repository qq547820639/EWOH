-- 078 verify：人员→账号反查函数就位，且身份面仍对业务角色 fail-closed。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  -- 函数存在、是 SECURITY DEFINER、只返回 username/person_id（不含口令哈希/角色）
  (SELECT count(*) FROM pg_proc
    WHERE proname = 'ewoh_find_active_users_by_person'
      AND pronamespace = current_schema()::regnamespace
      AND prosecdef = true
      AND pg_get_function_result(oid) LIKE '%username%'
      AND pg_get_function_result(oid) LIKE '%person_id%'
      AND pg_get_function_result(oid) NOT LIKE '%password_hash%'
      AND pg_get_function_result(oid) NOT LIKE '%roles%') = 1
  -- PUBLIC 无执行权（受控读取；运行角色经 service_role 授权调用）
  AND (SELECT count(*) FROM pg_proc p
        WHERE p.proname = 'ewoh_find_active_users_by_person'
          AND p.pronamespace = current_schema()::regnamespace
          AND has_function_privilege('public', p.oid, 'EXECUTE')) = 0
  -- 第二个函数：跨租户"有活跃会话的租户"清单存在、SECURITY DEFINER、且只返回 org_id
  AND (SELECT count(*) FROM pg_proc
        WHERE proname = 'ewoh_active_exo_session_orgs'
          AND pronamespace = current_schema()::regnamespace
          AND prosecdef = true
          AND pg_get_function_result(oid) NOT LIKE '%person_id%'
          AND pg_get_function_result(oid) NOT LIKE '%session_id%'
          AND pg_get_function_result(oid) LIKE '%org_id%') = 1
  AND (SELECT count(*) FROM pg_proc p
        WHERE p.proname = 'ewoh_active_exo_session_orgs'
          AND p.pronamespace = current_schema()::regnamespace
          AND has_function_privilege('public', p.oid, 'EXECUTE')) = 0
  -- 身份表 fail-closed 不变量未被本次改动破坏：RLS 仍启用、仍无 policy
  AND (SELECT relrowsecurity FROM pg_class
        WHERE oid = '__EWOH_SCHEMA__.ewoh_user'::regclass) = true
  AND (SELECT count(*) FROM pg_policies
        WHERE schemaname = current_schema() AND tablename = 'ewoh_user') = 0
  THEN 1 ELSE 0 END AS standalone_078_verified;
