-- 096 verify：函数存在 + SECURITY DEFINER + search_path 固定 + 只返回 org_id
-- + PUBLIC 不可执行（authenticated/anon 无 EXECUTE）+ service_role 可执行。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  is_definer boolean := false;
  has_search_path boolean := false;
  returns_only_org boolean := false;
  public_cannot boolean := false;
  service_can boolean := false;
  probe_org uuid := '00000000-0000-4000-8000-000000000001';
  probe_cmd constant varchar := 'att-verify-096-pending-orgs';
  seen boolean := false;
BEGIN
  SELECT (p.prosecdef AND pg_get_function_result(p.oid) = 'TABLE(org_id uuid)')
    INTO is_definer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = current_schema() AND p.proname = 'ewoh_control_pending_orgs';
  IF is_definer IS NULL THEN RAISE EXCEPTION '096 verify FAILED: 函数不存在或签名不符'; END IF;

  SELECT (array_to_string(p.proconfig, ',') LIKE '%search_path=%') INTO has_search_path
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = current_schema() AND p.proname = 'ewoh_control_pending_orgs';

  SELECT (pg_get_function_result(p.oid) = 'TABLE(org_id uuid)') INTO returns_only_org
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = current_schema() AND p.proname = 'ewoh_control_pending_orgs';

  SELECT NOT has_function_privilege('public', p.oid, 'EXECUTE') INTO public_cannot
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = current_schema() AND p.proname = 'ewoh_control_pending_orgs';
  SELECT has_function_privilege('service_role', p.oid, 'EXECUTE') INTO service_can
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = current_schema() AND p.proname = 'ewoh_control_pending_orgs';

  -- 行为探针：造一条 sent 命令 → 函数必须返回该 org（且只返回 org_id）
  BEGIN
    INSERT INTO ewoh_control_command
      (org_id, command_id, request_id, root_command_id, attempt_no, command_key, status, sent_at)
    VALUES
      (probe_org, probe_cmd, 'CR-verify-096', probe_cmd, 1, 'pause', 'sent', now());
    SELECT EXISTS (SELECT 1 FROM ewoh_control_pending_orgs() f WHERE f.org_id = probe_org) INTO seen;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  EXCEPTION WHEN OTHERS THEN
    seen := false;
    DELETE FROM ewoh_control_command WHERE org_id = probe_org AND command_id = probe_cmd;
  END;

  IF NOT is_definer OR NOT has_search_path OR NOT returns_only_org
     OR NOT public_cannot OR NOT service_can OR NOT seen THEN
    RAISE EXCEPTION '096 verify incomplete: definer=% search_path=% only_org=% public_blocked=% service_ok=% probe=%',
      is_definer, has_search_path, returns_only_org, public_cannot, service_can, seen;
  END IF;
  RAISE NOTICE '096 verify OK: SECURITY DEFINER + 只返回 org_id + search_path 固定 + PUBLIC 不可执行 + 行为探针通过';
END $$;

SELECT 1 AS standalone_096_verified;
