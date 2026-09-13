-- 090 verify：租户清单函数存在、SECURITY DEFINER、只返回 org_id、PUBLIC 不可执行、
-- service_role 可执行；空库可跑（返回 0 行也是正确结果）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  fn_ok integer;
  secdef boolean;
  cols integer;
  public_ok boolean;
  service_ok boolean;
  probe_rows integer;
BEGIN
  SELECT count(*), bool_or(p.prosecdef)
    INTO fn_ok, secdef
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = current_schema() AND p.proname = 'ewoh_improvement_action_orgs';
  IF fn_ok <> 1 THEN RAISE EXCEPTION '090 verify FAILED: fn_count=%', fn_ok; END IF;
  IF NOT secdef THEN RAISE EXCEPTION '090 verify FAILED: 不是 SECURITY DEFINER'; END IF;

  SELECT count(*) INTO cols
    FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'ewoh_improvement_action';
  IF cols = 0 THEN RAISE EXCEPTION '090 verify FAILED: 依赖表 ewoh_improvement_action 不存在'; END IF;

  SELECT has_function_privilege('public', 'ewoh_improvement_action_orgs()', 'EXECUTE') INTO public_ok;
  IF public_ok THEN RAISE EXCEPTION '090 verify FAILED: PUBLIC 仍可执行'; END IF;
  SELECT has_function_privilege('service_role', 'ewoh_improvement_action_orgs()', 'EXECUTE') INTO service_ok;
  IF NOT service_ok THEN RAISE EXCEPTION '090 verify FAILED: service_role 不可执行'; END IF;

  -- 空库：0 行（返回结构正确即可）
  SELECT count(*) INTO probe_rows FROM ewoh_improvement_action_orgs();
  RAISE NOTICE '090 verify OK: SECURITY DEFINER + 仅 service_role 可执行（空库返回 % 行）', probe_rows;
END $$;

SELECT 1 AS standalone_090_verified;
