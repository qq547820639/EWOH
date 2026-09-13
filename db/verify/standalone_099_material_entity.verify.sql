-- standalone_099_material_entity 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（P4-material-master / 议题 R-2）：
--   1) 三表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) 各表 policy 存在、只授 service_role、含租户谓词且非恒真放行
--   3) 关键 CHECK 约束存在（quantity_status ⟺ quantity 绑定）+ 业务键唯一约束
--   4) ★ 行为探针（SAVEPOINT 包裹，验证不落脏数据）——这是本脚本的核心，
--      锁定不变量「读不到 ≠ 0」：
--        · stock：quantity_status='unknown' 且 quantity=0 → 必须被 CHECK 拒绝
--          （如果这条能通过，应用层就能把"读不到"写成 0 混进表里，红线失守）
--        · stock：quantity_status='known' 且 quantity IS NULL → 必须被拒绝
--        · requirement：同款两条（unknown+0 拒绝 / known+NULL 拒绝）
--        · 合法行（known + 数值）必须被接受（否则约束过宽会误伤真实数据）
--   5) 可见性自证（SET LOCAL GUC + SET LOCAL ROLE ewoh_api）：
--        org-a / org-b / 无 GUC（fail-closed 全拒）/ global_admin 四态
--
-- 为什么必须切 ewoh_api：本 verify 以 owner/超级用户连接，属主与 BYPASSRLS 角色
-- 绕过 RLS，在 owner 身份下任何可见性探针都会「两行都可见」而恒真（standalone_056
-- 已在 2026-09-12 踩过这个坑；098 同款处置）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  v_tables constant text[] := ARRAY[
    'ewoh_material',
    'ewoh_material_stock',
    'ewoh_material_requirement'
  ];
  v_policies constant text[] := ARRAY[
    'material_org_isolation',
    'material_stock_org_isolation',
    'material_requirement_org_isolation'
  ];
  v_rls boolean;
  v_pol integer;
  v_scope_ok boolean;
  v_semantics_ok boolean;
  v_chk integer;
  v_uq integer;
  unknown_zero_rejected boolean := false;
  known_null_rejected boolean := false;
  req_unknown_zero_rejected boolean := false;
  req_known_null_rejected boolean := false;
  known_ok boolean := false;
  vis_a_ok boolean := true;
  vis_b_ok boolean := true;
  vis_none_ok boolean := true;
  vis_admin_ok boolean := true;
  probe_a varchar := '00000000-0000-4000-8000-0000000000c1';
  probe_b varchar := '00000000-0000-4000-8000-0000000000d2';
BEGIN
  -- 1) RLS 已启用 + policy 存在且唯一 + 只授 service_role
  FOR i IN 1 .. array_length(v_tables, 1) LOOP
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = v_tables[i];
    IF v_rls IS NULL OR NOT v_rls THEN
      RAISE EXCEPTION '099 verify FAILED: % 未启用 RLS（standalone_099 未应用或回滚残留）', v_tables[i];
    END IF;

    SELECT count(*) INTO v_pol FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = v_tables[i]
       AND policyname = v_policies[i];
    IF v_pol <> 1 THEN
      RAISE EXCEPTION '099 verify FAILED: % 的 policy % 计数=%（期望 1）',
        v_tables[i], v_policies[i], v_pol;
    END IF;

    SELECT ('service_role' = ANY (roles)) AND NOT ('public' = ANY (roles))
      INTO v_scope_ok
      FROM pg_policies
     WHERE schemaname = current_schema() AND tablename = v_tables[i]
       AND policyname = v_policies[i];
    IF v_scope_ok IS NULL OR NOT v_scope_ok THEN
      RAISE EXCEPTION '099 verify FAILED: % 的 policy 作用角色不是且仅 service_role', v_tables[i];
    END IF;

    -- policy 语义：必须含 org 谓词与管理员例外，且不得是恒真放行
    --（恒真判定用 btrim 精确比对，不能模糊匹配 true —— 策略体本就有 is_global_admin='true' 字面量）。
    SELECT (qual IS NOT NULL AND with_check IS NOT NULL
            AND qual::text LIKE '%app.current_org_id%'
            AND with_check::text LIKE '%app.current_org_id%'
            AND qual::text LIKE '%is_global_admin%'
            AND with_check::text LIKE '%is_global_admin%'
            AND btrim(qual::text) NOT IN ('true', '(true)')
            AND btrim(with_check::text) NOT IN ('true', '(true)'))
      INTO v_semantics_ok
      FROM pg_policies
     WHERE schemaname = current_schema() AND tablename = v_tables[i]
       AND policyname = v_policies[i];
    IF v_semantics_ok IS NULL OR NOT v_semantics_ok THEN
      RAISE EXCEPTION '099 verify FAILED: % 的 policy 无租户谓词或形同恒真放行', v_tables[i];
    END IF;
  END LOOP;

  -- 2) CHECK 约束存在（三表各自的 quantity 绑定 + 唯一键）
  SELECT count(*) INTO v_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relname = 'ewoh_material_stock'
     AND con.conname = 'chk_ewoh_material_stock_quantity';
  IF v_chk <> 1 THEN
    RAISE EXCEPTION '099 verify FAILED: ewoh_material_stock.chk_ewoh_material_stock_quantity 缺失';
  END IF;
  SELECT count(*) INTO v_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema() AND c.relname = 'ewoh_material_requirement'
     AND con.conname = 'chk_ewoh_material_req_quantity';
  IF v_chk <> 1 THEN
    RAISE EXCEPTION '099 verify FAILED: ewoh_material_requirement.chk_ewoh_material_req_quantity 缺失';
  END IF;

  SELECT count(*) INTO v_uq FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema()
     AND ((c.relname = 'ewoh_material' AND con.conname = 'uq_ewoh_material_org_id')
       OR (c.relname = 'ewoh_material_stock' AND con.conname = 'uq_ewoh_material_stock_org_id')
       OR (c.relname = 'ewoh_material_requirement' AND con.conname = 'uq_ewoh_material_req_org_id'))
     AND con.contype = 'u';
  IF v_uq <> 3 THEN
    RAISE EXCEPTION '099 verify FAILED: 三表业务键唯一约束计数=%（期望 3）', v_uq;
  END IF;

  -- 3) ★ 行为探针：核心不变量「读不到 ≠ 0」
  BEGIN
    -- unknown + quantity=0：把"读不到"写成 0 —— 必须被拒
    INSERT INTO __EWOH_SCHEMA__.ewoh_material_stock
      (org_id, stock_id, material_id, location_id, location_kind, quantity,
       quantity_status, source_kind, observed_at)
    VALUES
      ('verify-org-099', 'STK-VERIFY-099-U0', 'MAT-VERIFY', 'WH-VERIFY', 'warehouse', 0,
       'unknown', 'manual_count', now());
    RAISE EXCEPTION '__unexpected_accept_unknown_zero__';
  EXCEPTION
    WHEN check_violation THEN
      unknown_zero_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_unknown_zero__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT unknown_zero_rejected THEN
    RAISE EXCEPTION '099 selfcheck FAILED: unknown=0 被接受（"读不到写成 0"红线失守）';
  END IF;

  BEGIN
    -- known + quantity IS NULL：声称可信却没有数字 —— 必须被拒
    INSERT INTO __EWOH_SCHEMA__.ewoh_material_stock
      (org_id, stock_id, material_id, location_id, location_kind, quantity,
       quantity_status, source_kind, observed_at)
    VALUES
      ('verify-org-099', 'STK-VERIFY-099-KN', 'MAT-VERIFY', 'WH-VERIFY', 'warehouse', NULL,
       'known', 'manual_count', now());
    RAISE EXCEPTION '__unexpected_accept_known_null__';
  EXCEPTION
    WHEN check_violation THEN
      known_null_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_known_null__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT known_null_rejected THEN
    RAISE EXCEPTION '099 selfcheck FAILED: known+NULL 被接受';
  END IF;

  BEGIN
    -- 合法行必须被接受（约束不得过宽误伤真实数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_material_stock
      (org_id, stock_id, material_id, location_id, location_kind, quantity,
       quantity_status, source_kind, observed_at)
    VALUES
      ('verify-org-099', 'STK-VERIFY-099-OK', 'MAT-VERIFY', 'WH-VERIFY', 'warehouse', 12.5,
       'known', 'manual_count', now());
    known_ok := true;
  EXCEPTION WHEN OTHERS THEN
    known_ok := false;
  END;

  BEGIN
    -- requirement：unknown + 0 必须被拒
    INSERT INTO __EWOH_SCHEMA__.ewoh_material_requirement
      (org_id, requirement_id, material_id, requirement_type, quantity,
       quantity_status, source_kind, effective_at)
    VALUES
      ('verify-org-099', 'REQ-VERIFY-099-U0', 'MAT-VERIFY', 'threshold', 0,
       'unknown', 'erp_master', now());
    RAISE EXCEPTION '__unexpected_accept_req_unknown_zero__';
  EXCEPTION
    WHEN check_violation THEN
      req_unknown_zero_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_req_unknown_zero__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT req_unknown_zero_rejected THEN
    RAISE EXCEPTION '099 selfcheck FAILED: requirement unknown=0 被接受';
  END IF;

  BEGIN
    -- requirement：known + NULL 必须被拒
    INSERT INTO __EWOH_SCHEMA__.ewoh_material_requirement
      (org_id, requirement_id, material_id, requirement_type, quantity,
       quantity_status, source_kind, effective_at)
    VALUES
      ('verify-org-099', 'REQ-VERIFY-099-KN', 'MAT-VERIFY', 'threshold', NULL,
       'known', 'erp_master', now());
    RAISE EXCEPTION '__unexpected_accept_req_known_null__';
  EXCEPTION
    WHEN check_violation THEN
      req_known_null_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_req_known_null__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT req_known_null_rejected THEN
    RAISE EXCEPTION '099 selfcheck FAILED: requirement known+NULL 被接受';
  END IF;

  IF NOT known_ok THEN
    RAISE EXCEPTION '099 selfcheck FAILED: 合法库存行被拒绝（约束过宽）';
  END IF;

  -- 探针行的清理（合法插入的那条）
  DELETE FROM __EWOH_SCHEMA__.ewoh_material_stock WHERE stock_id LIKE 'STK-VERIFY-099-%';
  DELETE FROM __EWOH_SCHEMA__.ewoh_material_requirement WHERE requirement_id LIKE 'REQ-VERIFY-099-%';

  -- 4) 可见性自证（四态）
  BEGIN
    DELETE FROM __EWOH_SCHEMA__.ewoh_material WHERE material_id LIKE 'verify-099-%';
    DELETE FROM __EWOH_SCHEMA__.ewoh_material_stock WHERE stock_id LIKE 'verify-099-%';
    DELETE FROM __EWOH_SCHEMA__.ewoh_material_requirement WHERE requirement_id LIKE 'verify-099-%';

    INSERT INTO __EWOH_SCHEMA__.ewoh_material
      (org_id, material_id, material_code, name) VALUES
      (probe_a, 'verify-099-mat-a', 'CODE-A', 'verify mat a'),
      (probe_b, 'verify-099-mat-b', 'CODE-B', 'verify mat b');
    INSERT INTO __EWOH_SCHEMA__.ewoh_material_stock
      (org_id, stock_id, material_id, location_id, location_kind, quantity,
       quantity_status, source_kind, observed_at) VALUES
      (probe_a, 'verify-099-stk-a', 'verify-099-mat-a', 'WH-A', 'warehouse', 5, 'known', 'manual_count', now()),
      (probe_b, 'verify-099-stk-b', 'verify-099-mat-b', 'WH-B', 'warehouse', 7, 'known', 'manual_count', now());
    INSERT INTO __EWOH_SCHEMA__.ewoh_material_requirement
      (org_id, requirement_id, material_id, requirement_type, quantity,
       quantity_status, source_kind, effective_at) VALUES
      (probe_a, 'verify-099-req-a', 'verify-099-mat-a', 'threshold', 10, 'known', 'erp_master', now()),
      (probe_b, 'verify-099-req-b', 'verify-099-mat-b', 'threshold', 20, 'known', 'erp_master', now());

    SET LOCAL ROLE ewoh_api;

    -- org-a：只见 a 行
    PERFORM set_config('app.current_org_id', probe_a, true);
    PERFORM set_config('app.primary_org_id', '', true);
    PERFORM set_config('app.is_global_admin', 'false', true);
    vis_a_ok :=
      EXISTS (SELECT 1 FROM ewoh_material WHERE material_id = 'verify-099-mat-a')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material WHERE material_id = 'verify-099-mat-b')
      AND EXISTS (SELECT 1 FROM ewoh_material_stock WHERE stock_id = 'verify-099-stk-a')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material_stock WHERE stock_id = 'verify-099-stk-b')
      AND EXISTS (SELECT 1 FROM ewoh_material_requirement WHERE requirement_id = 'verify-099-req-a')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material_requirement WHERE requirement_id = 'verify-099-req-b');

    -- org-b：只见 b 行
    PERFORM set_config('app.current_org_id', probe_b, true);
    vis_b_ok :=
      EXISTS (SELECT 1 FROM ewoh_material WHERE material_id = 'verify-099-mat-b')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material WHERE material_id = 'verify-099-mat-a')
      AND EXISTS (SELECT 1 FROM ewoh_material_stock WHERE stock_id = 'verify-099-stk-b')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material_stock WHERE stock_id = 'verify-099-stk-a')
      AND EXISTS (SELECT 1 FROM ewoh_material_requirement WHERE requirement_id = 'verify-099-req-b')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material_requirement WHERE requirement_id = 'verify-099-req-a');

    -- 无 GUC 且非管理员：一行都不可见（fail-closed）
    PERFORM set_config('app.current_org_id', '', true);
    PERFORM set_config('app.primary_org_id', '', true);
    PERFORM set_config('app.is_global_admin', 'false', true);
    vis_none_ok :=
      NOT EXISTS (SELECT 1 FROM ewoh_material WHERE material_id LIKE 'verify-099-%')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material_stock WHERE stock_id LIKE 'verify-099-%')
      AND NOT EXISTS (SELECT 1 FROM ewoh_material_requirement WHERE requirement_id LIKE 'verify-099-%');

    -- 全局管理员例外路径：两行都可见
    PERFORM set_config('app.is_global_admin', 'true', true);
    vis_admin_ok :=
      EXISTS (SELECT 1 FROM ewoh_material WHERE material_id = 'verify-099-mat-a')
      AND EXISTS (SELECT 1 FROM ewoh_material WHERE material_id = 'verify-099-mat-b')
      AND EXISTS (SELECT 1 FROM ewoh_material_stock WHERE stock_id = 'verify-099-stk-a')
      AND EXISTS (SELECT 1 FROM ewoh_material_stock WHERE stock_id = 'verify-099-stk-b')
      AND EXISTS (SELECT 1 FROM ewoh_material_requirement WHERE requirement_id = 'verify-099-req-a')
      AND EXISTS (SELECT 1 FROM ewoh_material_requirement WHERE requirement_id = 'verify-099-req-b');

    RESET ROLE;

    DELETE FROM __EWOH_SCHEMA__.ewoh_material WHERE material_id LIKE 'verify-099-%';
    DELETE FROM __EWOH_SCHEMA__.ewoh_material_stock WHERE stock_id LIKE 'verify-099-%';
    DELETE FROM __EWOH_SCHEMA__.ewoh_material_requirement WHERE requirement_id LIKE 'verify-099-%';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    DELETE FROM __EWOH_SCHEMA__.ewoh_material WHERE material_id LIKE 'verify-099-%';
    DELETE FROM __EWOH_SCHEMA__.ewoh_material_stock WHERE stock_id LIKE 'verify-099-%';
    DELETE FROM __EWOH_SCHEMA__.ewoh_material_requirement WHERE requirement_id LIKE 'verify-099-%';
    RAISE;
  END;

  IF NOT vis_a_ok OR NOT vis_b_ok OR NOT vis_none_ok OR NOT vis_admin_ok THEN
    RAISE EXCEPTION '099 verify FAILED: 可见性自证 vis_a=% vis_b=% vis_none=% vis_admin=%',
      vis_a_ok, vis_b_ok, vis_none_ok, vis_admin_ok;
  END IF;

  RAISE NOTICE '099 verify OK: 三表 RLS(material_org_isolation/material_stock_org_isolation/material_requirement_org_isolation) + quantity 绑定 CHECK 行为探针（unknown+0 与 known+NULL 均被拒，合法行被接受） + org-a/org-b/无GUC/管理员 四态可见性自证通过';
END $$;

SELECT 1 AS standalone_099_verified;
