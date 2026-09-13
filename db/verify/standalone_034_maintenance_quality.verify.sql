-- standalone_034_maintenance_quality 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-010 / NO-05b）：
--   1) 两表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) 两条 RLS 策略存在且读 app.current_org_id
--   3) CHECK 约束（condition_type/severity/status + finding_type/disposition 必带决策）存在
--   4) 业务键唯一约束 (org_id, <id>) 存在
--   5) 契约形状自证（SAVEPOINT 包裹，验证不落脏数据）：
--      - 插入维护条件（work_order_created + due 逾期判定语义由应用/契约层承担，此处
--        验证列与 CHECK 可用）
--      - 插入 dispositioned 缺 decision 的质量发现必须被 CHECK 拒绝（fail-closed）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  mc_tbl integer := 0;
  qf_tbl integer := 0;
  mc_rls integer := 0;
  qf_rls integer := 0;
  mc_policy integer := 0;
  qf_policy integer := 0;
  qf_disposition_required integer := 0;
  mc_unique integer := 0;
  qf_unique integer := 0;
  rejection_ok boolean := false;
BEGIN
  SELECT count(*) INTO mc_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_maintenance_condition';
  SELECT count(*) INTO qf_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_quality_finding';
  IF mc_tbl <> 1 OR qf_tbl <> 1 THEN
    missing := missing || format('tables mc=%s qf=%s ', mc_tbl, qf_tbl);
  END IF;

  SELECT count(*) INTO mc_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_maintenance_condition' AND c.relrowsecurity;
  SELECT count(*) INTO qf_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_quality_finding' AND c.relrowsecurity;
  IF mc_rls <> 1 OR qf_rls <> 1 THEN
    missing := missing || format('rls mc=%s qf=%s ', mc_rls, qf_rls);
  END IF;

  SELECT count(*) INTO mc_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_maintenance_condition'
      AND policyname = 'maintenance_condition_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  SELECT count(*) INTO qf_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_quality_finding'
      AND policyname = 'quality_finding_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  IF mc_policy <> 1 OR qf_policy <> 1 THEN
    missing := missing || format('policies mc=%s qf=%s ', mc_policy, qf_policy);
  END IF;

  SELECT count(*) INTO qf_disposition_required FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_quality_finding'
      AND con.conname = 'chk_ewoh_qf_disposition_required';
  SELECT count(*) INTO mc_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_maintenance_condition'
      AND con.conname = 'uq_ewoh_mc_org_id' AND con.contype = 'u';
  SELECT count(*) INTO qf_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_quality_finding'
      AND con.conname = 'uq_ewoh_qf_org_id' AND con.contype = 'u';
  IF qf_disposition_required <> 1 OR mc_unique <> 1 OR qf_unique <> 1 THEN
    missing := missing || format('constraints disp_req=%s mc_uq=%s qf_uq=%s ', qf_disposition_required, mc_unique, qf_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_034 verify failed: %', missing;
  END IF;

  -- 5) 契约形状自证（SAVEPOINT 包裹回滚，不落脏数据）
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_maintenance_condition
      (org_id, condition_id, subject_entity_id, subject_kind, condition_type, severity, status, detected_at)
    VALUES
      ('verify-org-034', 'MC-VERIFY-034', 'machine:cnc-verify', 'machine', 'wear', 'high', 'work_order_created', now());
    RAISE EXCEPTION '__rollback_marker__';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = '__rollback_marker__' THEN NULL; ELSE RAISE; END IF;
  END;

  BEGIN
    -- dispositioned 缺决策必须被 CHECK 拒绝（fail-closed 不变量）
    INSERT INTO __EWOH_SCHEMA__.ewoh_quality_finding
      (org_id, finding_id, finding_type, severity, status, disposition, links, detected_at)
    VALUES
      ('verify-org-034', 'QF-VERIFY-034', 'nonconformance', 'high', 'dispositioned', NULL, '[]'::jsonb, now());
    RAISE EXCEPTION '__unexpected_accept__';
  EXCEPTION
    WHEN check_violation THEN
      rejection_ok := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT rejection_ok THEN
    RAISE EXCEPTION 'standalone_034 selfcheck failed: dispositioned-without-decision accepted';
  END IF;
END $$;

SELECT 1 AS standalone_034_verified;
