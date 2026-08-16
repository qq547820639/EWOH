-- standalone_045_learning_proposal 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-026 / NO-12b）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 learning_proposal_org_isolation 存在且读 app.current_org_id
--   3) CHECK（kind/status/rule/parameter/values/shadow_gate/approval/
--      rejection/rollback）与 UNIQUE (org_id, proposal_id) 存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 kind 必须被 CHECK 拒绝
--      - approved 无影子证据必须被 CHECK 拒绝（§33 无影子证据不激活）
--      - approved 无 approver 必须被 CHECK 拒绝（§2 人审阶梯 DB 兜底）
--      - rolled_back 无理由必须被 CHECK 拒绝
--      - baseline=candidate 必须被 CHECK 拒绝
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_kind_chk integer := 0;
  at_status_chk integer := 0;
  at_values_chk integer := 0;
  at_shadow_chk integer := 0;
  at_approval_chk integer := 0;
  at_rollback_chk integer := 0;
  at_unique integer := 0;
  bad_kind_rejected boolean := false;
  bad_shadow_rejected boolean := false;
  bad_approval_rejected boolean := false;
  bad_rollback_rejected boolean := false;
  bad_values_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_learning_proposal'
      AND policyname = 'learning_proposal_org_isolation'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_kind_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal'
      AND con.conname = 'chk_ewoh_learning_proposal_kind';
  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal'
      AND con.conname = 'chk_ewoh_learning_proposal_status';
  SELECT count(*) INTO at_values_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal'
      AND con.conname = 'chk_ewoh_learning_proposal_values';
  SELECT count(*) INTO at_shadow_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal'
      AND con.conname = 'chk_ewoh_learning_proposal_shadow_gate';
  SELECT count(*) INTO at_approval_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal'
      AND con.conname = 'chk_ewoh_learning_proposal_approval';
  SELECT count(*) INTO at_rollback_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal'
      AND con.conname = 'chk_ewoh_learning_proposal_rollback';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_proposal'
      AND con.conname = 'uq_ewoh_learning_proposal' AND con.contype = 'u';
  IF at_kind_chk <> 1 OR at_status_chk <> 1 OR at_values_chk <> 1 OR at_shadow_chk <> 1 OR at_approval_chk <> 1 OR at_rollback_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints kind=%s status=%s values=%s shadow=%s approval=%s rollback=%s uq=%s ',
      at_kind_chk, at_status_chk, at_values_chk, at_shadow_chk, at_approval_chk, at_rollback_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_045 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 kind 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value, candidate_value, record_json)
    VALUES
      ('verify-org-045', 'lp:verify-045', 'policy_weight', 'proposed', 'rule:worker-overload',
       'workloadThreshold', 0.8, 0.75, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_kind__';
  EXCEPTION
    WHEN check_violation THEN
      bad_kind_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_kind__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_kind_rejected THEN
    RAISE EXCEPTION 'standalone_045 selfcheck failed: illegal kind accepted';
  END IF;

  BEGIN
    -- approved 无影子证据必须被 CHECK 拒绝（§33 无影子证据不激活）
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value, candidate_value,
       approved_by, approved_at, record_json)
    VALUES
      ('verify-org-045', 'lp:verify-045', 'rule_threshold', 'approved', 'rule:worker-overload',
       'workloadThreshold', 0.8, 0.75, 'person:approver-1', now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_shadow__';
  EXCEPTION
    WHEN check_violation THEN
      bad_shadow_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_shadow__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_shadow_rejected THEN
    RAISE EXCEPTION 'standalone_045 selfcheck failed: approved without shadow evidence accepted';
  END IF;

  BEGIN
    -- approved 无 approver 必须被 CHECK 拒绝（§2 人审阶梯 DB 兜底）
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value, candidate_value,
       shadow_eval_json, approved_at, record_json)
    VALUES
      ('verify-org-045', 'lp:verify-045', 'rule_threshold', 'approved', 'rule:worker-overload',
       'workloadThreshold', 0.8, 0.75, '{"riskLevel":"low"}'::jsonb, now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_approval__';
  EXCEPTION
    WHEN check_violation THEN
      bad_approval_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_approval__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_approval_rejected THEN
    RAISE EXCEPTION 'standalone_045 selfcheck failed: approved without approver accepted';
  END IF;

  BEGIN
    -- rolled_back 无理由必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value, candidate_value,
       shadow_eval_json, approved_by, approved_at, rolled_back_by, record_json)
    VALUES
      ('verify-org-045', 'lp:verify-045', 'rule_threshold', 'rolled_back', 'rule:worker-overload',
       'workloadThreshold', 0.8, 0.75, '{"riskLevel":"low"}'::jsonb, 'person:approver-1', now(),
       'person:approver-1', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_rollback__';
  EXCEPTION
    WHEN check_violation THEN
      bad_rollback_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_rollback__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_rollback_rejected THEN
    RAISE EXCEPTION 'standalone_045 selfcheck failed: rollback without reason accepted';
  END IF;

  BEGIN
    -- baseline = candidate 必须被 CHECK 拒绝（no-op 变更拒绝，§33）
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value, candidate_value, record_json)
    VALUES
      ('verify-org-045', 'lp:verify-045', 'rule_threshold', 'proposed', 'rule:worker-overload',
       'workloadThreshold', 0.8, 0.8, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_values__';
  EXCEPTION
    WHEN check_violation THEN
      bad_values_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_values__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_values_rejected THEN
    RAISE EXCEPTION 'standalone_045 selfcheck failed: no-op change accepted';
  END IF;

  BEGIN
    -- 合法行可写入（随后删除，不留脏数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value, candidate_value,
       shadow_eval_json, approved_by, approved_at, record_json)
    VALUES
      ('verify-org-045', 'lp:verify-045', 'rule_threshold', 'approved', 'rule:worker-overload',
       'workloadThreshold', 0.8, 0.75, '{"baselineThreshold":0.8,"candidateThreshold":0.75,"factsCount":1,"baselineFires":0,"candidateFires":1,"addedSubjects":[],"removedSubjects":[],"riskLevel":"low"}'::jsonb,
       'person:approver-1', now(), '{}'::jsonb);
    DELETE FROM __EWOH_SCHEMA__.ewoh_learning_proposal WHERE proposal_id = 'lp:verify-045';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_045 selfcheck failed: valid row rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_045_verified;
