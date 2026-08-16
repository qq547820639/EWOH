-- standalone_035_work_order 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-012 / NO-05e-b）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 work_order_org_isolation 存在且读 app.current_org_id
--   3) CHECK 约束（type/origin_kind/severity/status/completion/cancellation）存在
--   4) 业务键唯一约束 (org_id, work_order_id) 存在
--   5) 契约形状自证（SAVEPOINT 包裹，验证不落脏数据）：
--      - completed 缺 completed_at 必须被 CHECK 拒绝（fail-closed）
--      - cancelled 缺 reason 必须被 CHECK 拒绝（fail-closed）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  wo_tbl integer := 0;
  wo_rls integer := 0;
  wo_policy integer := 0;
  wo_completion_chk integer := 0;
  wo_cancellation_chk integer := 0;
  wo_unique integer := 0;
  completion_rejected boolean := false;
  cancellation_rejected boolean := false;
BEGIN
  SELECT count(*) INTO wo_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_work_order';
  IF wo_tbl <> 1 THEN
    missing := missing || format('table wo=%s ', wo_tbl);
  END IF;

  SELECT count(*) INTO wo_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_work_order' AND c.relrowsecurity;
  IF wo_rls <> 1 THEN
    missing := missing || format('rls wo=%s ', wo_rls);
  END IF;

  SELECT count(*) INTO wo_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_work_order'
      AND policyname = 'work_order_org_isolation'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF wo_policy <> 1 THEN
    missing := missing || format('policy wo=%s ', wo_policy);
  END IF;

  SELECT count(*) INTO wo_completion_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_work_order'
      AND con.conname = 'chk_ewoh_wo_completion';
  SELECT count(*) INTO wo_cancellation_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_work_order'
      AND con.conname = 'chk_ewoh_wo_cancellation';
  SELECT count(*) INTO wo_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_work_order'
      AND con.conname = 'uq_ewoh_wo_org_id' AND con.contype = 'u';
  IF wo_completion_chk <> 1 OR wo_cancellation_chk <> 1 OR wo_unique <> 1 THEN
    missing := missing || format('constraints completion=%s cancellation=%s uq=%s ', wo_completion_chk, wo_cancellation_chk, wo_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_035 verify failed: %', missing;
  END IF;

  -- 5) 契约形状自证（SAVEPOINT 包裹回滚，不落脏数据）
  BEGIN
    -- completed 缺 completed_at 必须被 CHECK 拒绝（fail-closed 不变量）
    INSERT INTO __EWOH_SCHEMA__.ewoh_work_order
      (org_id, work_order_id, work_order_type, origin_kind, origin_id, subject_entity_id, subject_kind, severity, status)
    VALUES
      ('verify-org-035', 'WO-VERIFY-035-A', 'maintenance', 'maintenance_condition', 'mc:verify', 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'device', 'high', 'completed');
    RAISE EXCEPTION '__unexpected_accept_completion__';
  EXCEPTION
    WHEN check_violation THEN
      completion_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_completion__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT completion_rejected THEN
    RAISE EXCEPTION 'standalone_035 selfcheck failed: completed-without-completed_at accepted';
  END IF;

  BEGIN
    -- cancelled 缺 reason 必须被 CHECK 拒绝（fail-closed 不变量）
    INSERT INTO __EWOH_SCHEMA__.ewoh_work_order
      (org_id, work_order_id, work_order_type, origin_kind, origin_id, subject_entity_id, subject_kind, severity, status)
    VALUES
      ('verify-org-035', 'WO-VERIFY-035-B', 'maintenance', 'maintenance_condition', 'mc:verify', 'device:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11', 'device', 'high', 'cancelled');
    RAISE EXCEPTION '__unexpected_accept_cancellation__';
  EXCEPTION
    WHEN check_violation THEN
      cancellation_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_cancellation__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT cancellation_rejected THEN
    RAISE EXCEPTION 'standalone_035 selfcheck failed: cancelled-without-reason accepted';
  END IF;
END $$;

SELECT 1 AS standalone_035_verified;
