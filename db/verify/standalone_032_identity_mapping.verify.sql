-- standalone_032_identity_mapping 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-006 / NO-02b）：
--   1) ewoh_identity_mapping 表存在且 relrowsecurity = true（TENANT_SCOPED，RLS 启用）
--   2) identity_mapping_org_isolation 策略存在且 USING/WITH CHECK 含 'app.current_org_id'
--   3) 业务键唯一约束 (org_id, source_system, source_id) 存在
--   4) ewoh_telemetry.entity_id 列存在（additive 落点）
--   5) 契约形状不变量（自证 SQL）：插入一条映射记录后按 (org_id, source_system,
--      source_id) 可精确检索、按 status 过滤生效——验证表结构与 CHECK 约束实际可用。
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言（runner 使用 >= 计数判定）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  tbl_ok integer := 0;
  rls_ok integer := 0;
  policy_ok integer := 0;
  unique_ok integer := 0;
  telemetry_col_ok integer := 0;
  selfcheck_ok integer := 0;
BEGIN
  -- 1) 表存在 + RLS 启用
  SELECT count(*) INTO tbl_ok FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_identity_mapping';
  IF tbl_ok <> 1 THEN missing := missing || format('table_missing=%s ', tbl_ok); END IF;

  SELECT count(*) INTO rls_ok FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_identity_mapping' AND c.relrowsecurity;
  IF rls_ok <> 1 THEN missing := missing || format('rls_disabled=%s ', rls_ok); END IF;

  -- 2) 策略存在且读 app.current_org_id（与 standalone_025 同 GUC 修复口径）
  SELECT count(*) INTO policy_ok FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'ewoh_identity_mapping'
      AND policyname = 'identity_mapping_org_isolation'
      AND (pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%'
           AND pg_get_expr(polwithcheck, polrelid) LIKE '%app.current_org_id%');
  IF policy_ok <> 1 THEN missing := missing || format('policy_missing=%s ', policy_ok); END IF;

  -- 3) 业务键唯一约束存在
  SELECT count(*) INTO unique_ok FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_identity_mapping'
      AND con.conname = 'uq_ewoh_identity_mapping_source' AND con.contype = 'u';
  IF unique_ok <> 1 THEN missing := missing || format('unique_missing=%s ', unique_ok); END IF;

  -- 4) telemetry.entity_id 列存在
  SELECT count(*) INTO telemetry_col_ok FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_telemetry' AND column_name = 'entity_id';
  IF telemetry_col_ok <> 1 THEN missing := missing || format('telemetry_col_missing=%s ', telemetry_col_ok); END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_032 verify failed: %', missing;
  END IF;

  -- 5) 契约形状自证（用临时 org，仅验证结构可用性；verify 后不清理会留下测试数据，
  --    故用 SAVEPOINT + ROLLBACK 包裹，验证不落脏数据）
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_identity_mapping
      (org_id, mapping_id, version, source_system, source_id, source_id_kind,
       target_entity_id, target_kind, authority, status)
    VALUES
      ('verify-org-032', 'map:verify-032', 1, 'mes', 'WO-VERIFY-032', NULL,
       'order:00000000-0000-4000-8000-000000000032', 'order', 'registration', 'active');
    SELECT count(*) INTO selfcheck_ok FROM __EWOH_SCHEMA__.ewoh_identity_mapping
      WHERE org_id = 'verify-org-032' AND source_system = 'mes' AND source_id = 'WO-VERIFY-032'
        AND status = 'active' AND target_kind = 'order';
    RAISE EXCEPTION '__rollback_marker__';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = '__rollback_marker__' THEN
        -- 正常路径：自证完成，回滚测试行
      ELSE
        RAISE;
      END IF;
  END;
  IF selfcheck_ok <> 1 THEN
    RAISE EXCEPTION 'standalone_032 selfcheck failed: selfcheck_ok=%', selfcheck_ok;
  END IF;
END $$;

SELECT 1 AS standalone_032_verified;
