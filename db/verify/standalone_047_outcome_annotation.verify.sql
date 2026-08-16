-- standalone_047_outcome_annotation 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-034 / §10）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 outcome_annotation_org_isolation 存在且读 app.current_org_id
--   3) CHECK（target/kind/judger）与 UNIQUE (org_id, annotation_id) 存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 targetType 必须被 CHECK 拒绝
--      - 非法 outcomeKind 必须被 CHECK 拒绝
--      - 空 judged_by 必须被 CHECK 拒绝（判定事实完整，§33）
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_target_chk integer := 0;
  at_kind_chk integer := 0;
  at_judger_chk integer := 0;
  at_unique integer := 0;
  bad_target_rejected boolean := false;
  bad_kind_rejected boolean := false;
  bad_judger_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_outcome_annotation';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_outcome_annotation' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_outcome_annotation'
      AND policyname = 'outcome_annotation_org_isolation'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_target_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_outcome_annotation'
      AND con.conname = 'chk_ewoh_outcome_annotation_target';
  SELECT count(*) INTO at_kind_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_outcome_annotation'
      AND con.conname = 'chk_ewoh_outcome_annotation_kind';
  SELECT count(*) INTO at_judger_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_outcome_annotation'
      AND con.conname = 'chk_ewoh_outcome_annotation_judger';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_outcome_annotation'
      AND con.conname = 'uq_ewoh_outcome_annotation' AND con.contype = 'u';
  IF at_target_chk <> 1 OR at_kind_chk <> 1 OR at_judger_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints target=%s kind=%s judger=%s uq=%s ',
      at_target_chk, at_kind_chk, at_judger_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_047 verify failed: %', missing;
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_outcome_annotation
      (org_id, annotation_id, target_type, target_id, outcome_kind, judged_by, judged_at, record_json)
    VALUES
      ('verify-org-047', 'oa:verify-047', 'gizmo', 'X-1', 'success', 'person:op1', now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_target__';
  EXCEPTION
    WHEN check_violation THEN
      bad_target_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_target__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_target_rejected THEN
    RAISE EXCEPTION 'standalone_047 selfcheck failed: illegal targetType accepted';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_outcome_annotation
      (org_id, annotation_id, target_type, target_id, outcome_kind, judged_by, judged_at, record_json)
    VALUES
      ('verify-org-047', 'oa:verify-047', 'plan', 'PLAN-1', 'meh', 'person:op1', now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_kind__';
  EXCEPTION
    WHEN check_violation THEN
      bad_kind_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_kind__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_kind_rejected THEN
    RAISE EXCEPTION 'standalone_047 selfcheck failed: illegal outcomeKind accepted';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_outcome_annotation
      (org_id, annotation_id, target_type, target_id, outcome_kind, judged_by, judged_at, record_json)
    VALUES
      ('verify-org-047', 'oa:verify-047', 'plan', 'PLAN-1', 'success', '  ', now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_judger__';
  EXCEPTION
    WHEN check_violation THEN
      bad_judger_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_judger__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_judger_rejected THEN
    RAISE EXCEPTION 'standalone_047 selfcheck failed: blank judger accepted（判定事实完整失效）';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_outcome_annotation
      (org_id, annotation_id, target_type, target_id, outcome_kind, judged_by, judged_at, measured_json, record_json)
    VALUES
      ('verify-org-047', 'oa:verify-047', 'plan', 'PLAN-1', 'success', 'person:op1', now(),
       '{"delayMs":0}'::jsonb, '{}'::jsonb);
    DELETE FROM __EWOH_SCHEMA__.ewoh_outcome_annotation WHERE annotation_id = 'oa:verify-047';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_047 selfcheck failed: valid row rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_047_verified;
