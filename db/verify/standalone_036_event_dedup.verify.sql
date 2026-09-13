-- standalone_036_event_dedup 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-009 / NO-04b）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 ingest_event_dedup_org_isolation 存在且读 app.current_org_id
--   3) 业务键唯一约束 (org_id, source, event_id) 存在
--   4) 时间语义列（occurred_at/received_at/is_late/clock_drift）存在
--   5) 契约形状自证（SAVEPOINT 包裹，验证不落脏数据）：
--      - 同 (org_id, source, event_id) 重复插入必须被唯一约束拒绝（幂等去重执行面）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  dedup_tbl integer := 0;
  dedup_rls integer := 0;
  dedup_policy integer := 0;
  dedup_unique integer := 0;
  dedup_cols integer := 0;
  duplicate_rejected boolean := false;
BEGIN
  SELECT count(*) INTO dedup_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_ingest_event_dedup';
  IF dedup_tbl <> 1 THEN
    missing := missing || format('table dedup=%s ', dedup_tbl);
  END IF;

  SELECT count(*) INTO dedup_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_ingest_event_dedup' AND c.relrowsecurity;
  IF dedup_rls <> 1 THEN
    missing := missing || format('rls dedup=%s ', dedup_rls);
  END IF;

  SELECT count(*) INTO dedup_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_ingest_event_dedup'
      AND policyname = 'ingest_event_dedup_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  IF dedup_policy <> 1 THEN
    missing := missing || format('policy dedup=%s ', dedup_policy);
  END IF;

  SELECT count(*) INTO dedup_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_ingest_event_dedup'
      AND con.conname = 'uq_ewoh_ingest_event_dedup' AND con.contype = 'u';
  IF dedup_unique <> 1 THEN
    missing := missing || format('uq dedup=%s ', dedup_unique);
  END IF;

  SELECT count(*) INTO dedup_cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_ingest_event_dedup'
      AND column_name IN ('occurred_at', 'received_at', 'is_late', 'clock_drift');
  IF dedup_cols <> 4 THEN
    missing := missing || format('time-semantics-cols=%s ', dedup_cols);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_036 verify failed: %', missing;
  END IF;

  -- 5) 契约形状自证（SAVEPOINT 包裹回滚，不落脏数据）：
  --    同 (org_id, source, event_id) 重复插入必须被唯一约束拒绝
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_ingest_event_dedup
      (org_id, source, event_id, event_type)
    VALUES
      ('verify-org-036', 'edge:world-projection', 'EVT-VERIFY-036', 'EntityDeclared');
    INSERT INTO __EWOH_SCHEMA__.ewoh_ingest_event_dedup
      (org_id, source, event_id, event_type)
    VALUES
      ('verify-org-036', 'edge:world-projection', 'EVT-VERIFY-036', 'EntityDeclared');
    RAISE EXCEPTION '__unexpected_accept_duplicate__';
  EXCEPTION
    WHEN unique_violation THEN
      duplicate_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_duplicate__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT duplicate_rejected THEN
    RAISE EXCEPTION 'standalone_036 selfcheck failed: duplicate (org,source,event) accepted';
  END IF;
END $$;

SELECT 1 AS standalone_036_verified;
