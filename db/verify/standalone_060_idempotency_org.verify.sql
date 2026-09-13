-- standalone_060_idempotency_org 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（R2-SDB-006）：
--   1) org_id 列存在、NOT NULL、带 DEFAULT
--   2) 复合唯一 uq_ewoh_idempotency_keys_org_scope_key (org_id, scope, idempotency_key) 存在且有效；旧单列唯一已清除
--   3) RLS 启用 + idempotency_org_isolation 策略存在
-- （单字段断言形态，同 SQL-103 先例；不落任何脏数据。）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_col integer := 0;
  at_notnull integer := 0;
  at_default integer := 0;
  at_idx integer := 0;
  at_old integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  cols text := '';
BEGIN
  SELECT count(*) INTO at_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_idempotency_keys'
      AND column_name = 'org_id';
  IF at_col <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: org_id 列缺失 (at=%)', at_col;
  END IF;

  SELECT count(*) INTO at_notnull FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_idempotency_keys'
      AND column_name = 'org_id' AND is_nullable = 'NO';
  IF at_notnull <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: org_id 未 NOT NULL (at=%)', at_notnull;
  END IF;

  SELECT count(*) INTO at_default FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_idempotency_keys'
      AND column_name = 'org_id' AND column_default IS NOT NULL;
  IF at_default <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: org_id 无 DEFAULT (at=%)', at_default;
  END IF;

  SELECT count(*) INTO at_idx FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE n.nspname = current_schema() AND c.relname = 'uq_ewoh_idempotency_keys_org_scope_key'
      AND t.relname = 'ewoh_idempotency_keys' AND i.indisunique AND i.indisvalid;
  IF at_idx <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: 复合唯一索引缺失/无效 (at=%)', at_idx;
  END IF;

  SELECT count(*) INTO at_old FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'uq_ewoh_idempotency_keys_scope_key';
  IF at_old <> 0 THEN
    RAISE EXCEPTION 'verify incomplete: 旧单列唯一残留 (at=%)', at_old;
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_idempotency_keys' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: RLS 未启用 (at=%)', at_rls;
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_idempotency_keys'
      AND policyname = 'idempotency_org_isolation';
  IF at_policy <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: RLS 策略缺失 (at=%)', at_policy;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema() AND c.relname = 'uq_ewoh_idempotency_keys_org_scope_key';
  IF cols IS DISTINCT FROM 'org_id,scope,idempotency_key' THEN
    RAISE EXCEPTION 'verify incomplete: 复合唯一列序不符 (cols=%)', cols;
  END IF;
END $$;

-- 自证标记（迁移 runner 断言该行存在；此前文件只做 DO 断言、从不输出标记 →
-- 全链 verify 永远判失败，2026-09-12 NO-58 烧账修复）。
SELECT 1 AS standalone_060_verified;
