-- 082 verify：安灯租户清单函数就位，且**只返回 org_id**（不泄露业务细节）、
-- 运行角色经 GRANT 可执行、PUBLIC 无 EXECUTE。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  (SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.proname = 'ewoh_open_andon_orgs'
      AND p.prosecdef = true           -- SECURITY DEFINER
      AND p.proretset = true
      AND pg_get_function_result(p.oid) = 'TABLE(org_id character varying)') = 1
  -- 只返回 org_id 一列（不返回标题/设备/时间等业务细节）
  AND (SELECT array_length(p.proargtypes, 1) FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = current_schema() AND p.proname = 'ewoh_open_andon_orgs') = 1
  -- 运行角色可执行（service_role 成员按 NO-37a 同一模式）
  AND has_function_privilege(
        'service_role',
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = current_schema() AND p.proname = 'ewoh_open_andon_orgs'),
        'EXECUTE')
  -- PUBLIC 不得执行
  AND NOT has_function_privilege(
        'public',
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = current_schema() AND p.proname = 'ewoh_open_andon_orgs'),
        'EXECUTE')
  THEN 1 ELSE 0 END AS standalone_082_verified;
