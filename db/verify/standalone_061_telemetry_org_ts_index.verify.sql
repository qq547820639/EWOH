-- standalone_061_telemetry_org_ts_index 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（P1：telemetry 缺 (org_id, ts) 索引）：
--   1) idx_ewoh_telemetry_org_ts 存在且有效；
--   2) 索引列序 = (org_id, ts)。
-- （单字段断言形态，同 SQL-103 先例；不落任何脏数据。）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_idx integer := 0;
  cols text := '';
BEGIN
  SELECT count(*) INTO at_idx FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE n.nspname = current_schema() AND c.relname = 'idx_ewoh_telemetry_org_ts'
      AND t.relname = 'ewoh_telemetry' AND i.indisvalid;
  IF at_idx <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: (org_id, ts) 复合索引缺失/无效 (at=%)', at_idx;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema() AND c.relname = 'idx_ewoh_telemetry_org_ts';
  IF cols IS DISTINCT FROM 'org_id,ts' THEN
    RAISE EXCEPTION 'verify incomplete: 复合索引列序不符 (cols=%)', cols;
  END IF;
END $$;

SELECT 1 AS standalone_061_verified;
