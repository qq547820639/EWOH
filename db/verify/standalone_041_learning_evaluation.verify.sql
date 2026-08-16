-- standalone_041_learning_evaluation 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-021 / NO-09a）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 learning_evaluation_org_isolation 存在且读 app.current_org_id
--   3) CHECK（evaluation_type/period）与 UNIQUE (org_id, eval_id) 存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 evaluation_type 必须被 CHECK 拒绝
--      - period_end < period_start 必须被 CHECK 拒绝
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_type_chk integer := 0;
  at_period_chk integer := 0;
  at_unique integer := 0;
  bad_type_rejected boolean := false;
  bad_period_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_evaluation';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_evaluation' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_learning_evaluation'
      AND policyname = 'learning_evaluation_org_isolation'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_type_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_evaluation'
      AND con.conname = 'chk_ewoh_learning_evaluation_type';
  SELECT count(*) INTO at_period_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_evaluation'
      AND con.conname = 'chk_ewoh_learning_evaluation_period';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_evaluation'
      AND con.conname = 'uq_ewoh_learning_evaluation' AND con.contype = 'u';
  IF at_type_chk <> 1 OR at_period_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints type=%s period=%s uq=%s ', at_type_chk, at_period_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_041 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 evaluation_type 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_evaluation
      (org_id, eval_id, evaluation_type, period_start, period_end, engine_version, metrics_json, basis_json, result_json)
    VALUES
      ('verify-org-041', 'le:verify-041', 'teleport', now(), now(), '1.0.0',
       '{}'::jsonb, '["x"]'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_type__';
  EXCEPTION
    WHEN check_violation THEN
      bad_type_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_type__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_type_rejected THEN
    RAISE EXCEPTION 'standalone_041 selfcheck failed: illegal evaluation_type accepted';
  END IF;

  BEGIN
    -- period_end < period_start 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_evaluation
      (org_id, eval_id, evaluation_type, period_start, period_end, engine_version, metrics_json, basis_json, result_json)
    VALUES
      ('verify-org-041', 'le:verify-041', 'periodic',
       '2026-08-16T08:00:00Z'::timestamptz, '2026-08-16T00:00:00Z'::timestamptz, '1.0.0',
       '{}'::jsonb, '["x"]'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_period__';
  EXCEPTION
    WHEN check_violation THEN
      bad_period_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_period__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_period_rejected THEN
    RAISE EXCEPTION 'standalone_041 selfcheck failed: reversed period accepted';
  END IF;

  BEGIN
    -- 合法行可写入（随后删除，不留脏数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_evaluation
      (org_id, eval_id, evaluation_type, period_start, period_end, engine_version, metrics_json, basis_json, result_json)
    VALUES
      ('verify-org-041', 'le:verify-041', 'periodic',
       '2026-08-16T00:00:00Z'::timestamptz, '2026-08-16T08:00:00Z'::timestamptz, '1.0.0',
       '{"modelAccuracy": null}'::jsonb, '["x"]'::jsonb, '{}'::jsonb);
    DELETE FROM __EWOH_SCHEMA__.ewoh_learning_evaluation WHERE eval_id = 'le:verify-041';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_041 selfcheck failed: valid row rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_041_verified;
