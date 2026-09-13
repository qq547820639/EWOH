-- standalone_058_control_attempt_unique 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（R2-DBM-002 / NEST-425 / W3）：
--   1) 唯一索引 uq_ewoh_control_command_attempt 存在、唯一且有效
--   2) 索引列 = (request_id, command_key, attempt_no)
--   3) 历史重复行已清理（同 (request_id, command_key, attempt_no) 无重复）
-- （单字段断言形态，同 SQL-103 先例；不落任何脏数据。）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_idx integer := 0;
  at_unique integer := 0;
  at_valid integer := 0;
  cols text := '';
  dup_rows integer := 0;
BEGIN
  SELECT count(*) INTO at_idx FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'uq_ewoh_control_command_attempt';
  IF at_idx <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: uq_ewoh_control_command_attempt 缺失 (at=%)', at_idx;
  END IF;

  SELECT count(*) INTO at_unique FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE n.nspname = current_schema() AND c.relname = 'uq_ewoh_control_command_attempt'
      AND t.relname = 'ewoh_control_command' AND i.indisunique AND i.indisvalid;
  IF at_unique <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: 索引非唯一/无效或表不符 (at=%)', at_unique;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema() AND c.relname = 'uq_ewoh_control_command_attempt';
  IF cols IS DISTINCT FROM 'request_id,command_key,attempt_no' THEN
    RAISE EXCEPTION 'verify incomplete: 索引列不符 (cols=%)', cols;
  END IF;

  SELECT count(*) INTO dup_rows FROM (
    SELECT request_id, command_key, attempt_no
      FROM ewoh_control_command
     GROUP BY request_id, command_key, attempt_no
    HAVING count(*) > 1
  ) d;
  IF dup_rows <> 0 THEN
    RAISE EXCEPTION 'verify incomplete: 存在历史重复 attempt 行 (dups=%)', dup_rows;
  END IF;
END $$;

-- 自证标记（迁移 runner 断言该行存在；此前文件只做 DO 断言、从不输出标记 →
-- 全链 verify 永远判失败，2026-09-12 NO-58 烧账修复）。
SELECT 1 AS standalone_058_verified;
