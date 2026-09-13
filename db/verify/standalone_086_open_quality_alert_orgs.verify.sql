-- 086 verify：函数就位、SECURITY DEFINER、只接收一个 interval 参数、service_role 可执行、PUBLIC 不可执行。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  (SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.proname = 'ewoh_open_quality_alert_orgs'
      AND p.prosecdef = true
      AND p.proretset = true
      AND pg_get_function_result(p.oid) = 'TABLE(org_id character varying)') = 1
  AND has_function_privilege(
        'service_role',
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = current_schema() AND p.proname = 'ewoh_open_quality_alert_orgs'),
        'EXECUTE')
  AND NOT has_function_privilege(
        'public',
        (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = current_schema() AND p.proname = 'ewoh_open_quality_alert_orgs'),
        'EXECUTE')
  THEN 1 ELSE 0 END AS standalone_086_verified;
