-- standalone_097_idempotency_payload_fingerprint 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（缺陷 D：幂等 payload 指纹必须落库）：
--   1) 表 ewoh_idempotency_payload_fingerprint 就位、列齐、org_id NOT NULL 且有 DEFAULT；
--   2) 复合唯一 uq_ewoh_idempotency_payload_fingerprint (org_id, scope, idempotency_key)
--      存在且有效、列序正确（这是 DbPayloadStore.set 的 ON CONFLICT 冲突目标）；
--   3) RLS 启用 + idempotency_payload_fingerprint_org_isolation 策略带
--      app.current_org_id（读写两面都带）；
--   4) **行为探针**：ON CONFLICT 覆盖写真的落在同一行（同键不同 payload 读回新指纹，
--      而不是插入第二行或静默不动）+ 重复键裸插入被唯一约束拒绝 + 空指纹被 CHECK 拒绝。
-- 空库可跑、跑完不留脏数据。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_col integer := 0;
  at_notnull integer := 0;
  at_default integer := 0;
  at_unique integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  cols text := '';
  control_ok boolean := false;
  conflict_overwrote boolean := false;
  duplicate_rejected boolean := false;
  blank_rejected boolean := false;
  probe_org constant varchar := '00000000-0000-4000-8000-0000000000d9';
  probe_key constant varchar := 'verify-097-fingerprint-key';
  probe_fp_a constant text := '{"orderId":"WO-VERIFY-097","stepId":"S1"}';
  probe_fp_b constant text := '{"orderId":"WO-VERIFY-097","stepId":"S1","tampered":true}';
  row_count integer := 0;
  stored text := '';
BEGIN
  -- 1) 列齐 + org_id NOT NULL / DEFAULT（org_id 由 GUC 或回退默认 org 填充，
  --    DbPayloadStore.set 不显式写 org_id，缺 DEFAULT 就会 NOT NULL 违例）。
  SELECT count(*) INTO at_col FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_idempotency_payload_fingerprint'
      AND column_name IN (
        'org_id', 'scope', 'idempotency_key', 'fingerprint', '_created_at', '_updated_at'
      );
  IF at_col <> 6 THEN
    RAISE EXCEPTION 'verify incomplete: 列缺失 (at=%)', at_col;
  END IF;

  SELECT count(*) INTO at_notnull FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_idempotency_payload_fingerprint'
      AND column_name = 'org_id' AND is_nullable = 'NO';
  IF at_notnull <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: org_id 未 NOT NULL (at=%)', at_notnull;
  END IF;

  SELECT count(*) INTO at_default FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_idempotency_payload_fingerprint'
      AND column_name = 'org_id' AND column_default IS NOT NULL;
  IF at_default <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: org_id 无 DEFAULT (at=%)', at_default;
  END IF;

  -- 2) 复合唯一（ON CONFLICT 的目标）+ 列序。
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'ewoh_idempotency_payload_fingerprint'
      AND con.conname = 'uq_ewoh_idempotency_payload_fingerprint' AND con.contype = 'u';
  IF at_unique <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: 复合唯一约束缺失 (at=%)', at_unique;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO cols
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema()
      AND c.relname = 'ewoh_idempotency_payload_fingerprint'
      AND con.conname = 'uq_ewoh_idempotency_payload_fingerprint';
  IF cols IS DISTINCT FROM 'org_id,scope,idempotency_key' THEN
    RAISE EXCEPTION 'verify incomplete: 复合唯一列序不符 (cols=%)', cols;
  END IF;

  -- 3) RLS + 策略（读写两面都必须带 GUC 谓词，否则跨租户可读或可写）。
  SELECT count(*) INTO at_rls FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'ewoh_idempotency_payload_fingerprint' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: RLS 未启用 (at=%)', at_rls;
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'ewoh_idempotency_payload_fingerprint'
      AND policyname = 'idempotency_payload_fingerprint_org_isolation'
      AND qual LIKE '%app.current_org_id%' AND with_check LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: RLS 策略缺失/未带租户谓词 (at=%)', at_policy;
  END IF;

  -- 4) 行为探针：控制组一次写入 → 读回。
  BEGIN
    INSERT INTO ewoh_idempotency_payload_fingerprint (org_id, scope, idempotency_key, fingerprint)
    VALUES (probe_org, 'default', probe_key, probe_fp_a);
    SELECT count(*) INTO row_count FROM ewoh_idempotency_payload_fingerprint
      WHERE org_id = probe_org AND scope = 'default' AND idempotency_key = probe_key;
    SELECT fingerprint INTO stored FROM ewoh_idempotency_payload_fingerprint
      WHERE org_id = probe_org AND scope = 'default' AND idempotency_key = probe_key;
    control_ok := (row_count = 1 AND stored = probe_fp_a);

    -- ON CONFLICT 覆盖写：同键换指纹后仍然只有一行，且读回的是新指纹
    -- （DbPayloadStore.set 的语义——不是插入第二行，也不是静默不动）。
    INSERT INTO ewoh_idempotency_payload_fingerprint (org_id, scope, idempotency_key, fingerprint)
    VALUES (probe_org, 'default', probe_key, probe_fp_b)
    ON CONFLICT (org_id, scope, idempotency_key)
    DO UPDATE SET fingerprint = EXCLUDED.fingerprint, _updated_at = CURRENT_TIMESTAMP;
    SELECT count(*) INTO row_count FROM ewoh_idempotency_payload_fingerprint
      WHERE org_id = probe_org AND scope = 'default' AND idempotency_key = probe_key;
    SELECT fingerprint INTO stored FROM ewoh_idempotency_payload_fingerprint
      WHERE org_id = probe_org AND scope = 'default' AND idempotency_key = probe_key;
    conflict_overwrote := (row_count = 1 AND stored = probe_fp_b);

    -- 同键裸插入必须被唯一约束拒绝（否则指纹行可以分裂成多份，读回哪一份成了随机）。
    BEGIN
      INSERT INTO ewoh_idempotency_payload_fingerprint (org_id, scope, idempotency_key, fingerprint)
      VALUES (probe_org, 'default', probe_key, probe_fp_a);
      duplicate_rejected := false;
    EXCEPTION WHEN unique_violation THEN
      duplicate_rejected := true;
    END;

    -- 空指纹必须被 CHECK 拒绝（空串会让 409 判断误报/漏报）。
    BEGIN
      INSERT INTO ewoh_idempotency_payload_fingerprint (org_id, scope, idempotency_key, fingerprint)
      VALUES (probe_org, 'default', probe_key || '-blank', '   ');
      blank_rejected := false;
    EXCEPTION WHEN check_violation THEN
      blank_rejected := true;
    END;

    DELETE FROM ewoh_idempotency_payload_fingerprint WHERE org_id = probe_org;
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
    DELETE FROM ewoh_idempotency_payload_fingerprint WHERE org_id = probe_org;
  END;

  IF NOT control_ok OR NOT conflict_overwrote OR NOT duplicate_rejected OR NOT blank_rejected THEN
    RAISE EXCEPTION
      'standalone_097 verify incomplete: control=% overwrote=% duplicate=% blank=%',
      control_ok, conflict_overwrote, duplicate_rejected, blank_rejected;
  END IF;

  RAISE NOTICE '097 verify OK: 6 cols + org_id default/not null + composite unique + RLS + ON CONFLICT 覆盖写 + 重复键拒绝 + 空指纹拒绝';
END $$;

-- 自证标记（迁移 runner 断言该行存在；verify 文件必须输出标记行，否则全链 verify 判失败）。
SELECT 1 AS standalone_097_verified;
