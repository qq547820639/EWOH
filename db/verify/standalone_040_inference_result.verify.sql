-- standalone_040_inference_result 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-019 / NO-08a）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 inference_result_org_isolation 存在且读 app.current_org_id
--   3) CHECK（level/confidence/data_quality/ood）与 UNIQUE (org_id, inference_id) 存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 level 必须被 CHECK 拒绝
--      - confidence 越界必须被 CHECK 拒绝
--      - ood_flag=false 带 reasons 必须被 CHECK 拒绝（契约 OOD 一致性）
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_level_chk integer := 0;
  at_confidence_chk integer := 0;
  at_dq_chk integer := 0;
  at_ood_chk integer := 0;
  at_unique integer := 0;
  bad_level_rejected boolean := false;
  bad_confidence_rejected boolean := false;
  bad_ood_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_inference_result';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_inference_result' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_inference_result'
      AND policyname = 'inference_result_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_level_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_inference_result'
      AND con.conname = 'chk_ewoh_inference_result_level';
  SELECT count(*) INTO at_confidence_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_inference_result'
      AND con.conname = 'chk_ewoh_inference_result_confidence';
  SELECT count(*) INTO at_dq_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_inference_result'
      AND con.conname = 'chk_ewoh_inference_result_data_quality';
  SELECT count(*) INTO at_ood_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_inference_result'
      AND con.conname = 'chk_ewoh_inference_result_ood';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_inference_result'
      AND con.conname = 'uq_ewoh_inference_result' AND con.contype = 'u';
  IF at_level_chk <> 1 OR at_confidence_chk <> 1 OR at_dq_chk <> 1 OR at_ood_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints level=%s confidence=%s dq=%s ood=%s uq=%s ',
      at_level_chk, at_confidence_chk, at_dq_chk, at_ood_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_040 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 level 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_inference_result
      (org_id, inference_id, subject_id, level, model_id, model_version, input_version,
       label, confidence, ood_flag, ood_reasons, data_quality,
       evidence_ts_start, evidence_ts_end, evidence_is_rule, result_json)
    VALUES
      ('verify-org-040', 'inf:verify-040-level', 'decision:sug-verify', 'L9_teleport',
       'm', 'v1', 'i1', 'verify', 1.0, false, '[]'::jsonb, 'good', now(), now(), true, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_level__';
  EXCEPTION
    WHEN check_violation THEN
      bad_level_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_level__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_level_rejected THEN
    RAISE EXCEPTION 'standalone_040 selfcheck failed: illegal level accepted';
  END IF;

  BEGIN
    -- confidence 越界必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_inference_result
      (org_id, inference_id, subject_id, level, model_id, model_version, input_version,
       label, confidence, ood_flag, ood_reasons, data_quality,
       evidence_ts_start, evidence_ts_end, evidence_is_rule, result_json)
    VALUES
      ('verify-org-040', 'inf:verify-040-confidence', 'decision:sug-verify', 'L1_deterministic_rules',
       'm', 'v1', 'i1', 'verify', 1.5, false, '[]'::jsonb, 'good', now(), now(), true, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_confidence__';
  EXCEPTION
    WHEN check_violation THEN
      bad_confidence_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_confidence__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_confidence_rejected THEN
    RAISE EXCEPTION 'standalone_040 selfcheck failed: out-of-range confidence accepted';
  END IF;

  BEGIN
    -- ood_flag=false 带 reasons 必须被 CHECK 拒绝（契约 OOD 一致性）
    INSERT INTO __EWOH_SCHEMA__.ewoh_inference_result
      (org_id, inference_id, subject_id, level, model_id, model_version, input_version,
       label, confidence, ood_flag, ood_reasons, data_quality,
       evidence_ts_start, evidence_ts_end, evidence_is_rule, result_json)
    VALUES
      ('verify-org-040', 'inf:verify-040-ood', 'decision:sug-verify', 'L1_deterministic_rules',
       'm', 'v1', 'i1', 'verify', 1.0, false, '["low_confidence"]'::jsonb, 'good', now(), now(), true, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_ood__';
  EXCEPTION
    WHEN check_violation THEN
      bad_ood_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_ood__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_ood_rejected THEN
    RAISE EXCEPTION 'standalone_040 selfcheck failed: ood flag/reasons mismatch accepted';
  END IF;

  BEGIN
    -- 合法行可写入（随后删除，不留脏数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_inference_result
      (org_id, inference_id, subject_id, level, model_id, model_version, input_version,
       label, confidence, ood_flag, ood_reasons, data_quality,
       evidence_ts_start, evidence_ts_end, evidence_is_rule, result_json)
    VALUES
      ('verify-org-040', 'inf:verify-040-ok', 'decision:sug-verify', 'L1_deterministic_rules',
       'rule-a2-suggestion', 'v1', 'snapshot-v3', 'verify ok', 1.0, false, '[]'::jsonb, 'good',
       now(), now(), true, '{"label":"verify ok"}'::jsonb);
    DELETE FROM __EWOH_SCHEMA__.ewoh_inference_result WHERE inference_id = 'inf:verify-040-ok';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_040 selfcheck failed: valid row rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_040_verified;
