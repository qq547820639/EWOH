-- standalone_059_spatial_entity_org_unique 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（R2-SOP-003 / R2-SAM-003 / R2-DBM-002）：
--   1) 复合唯一索引 uq_ewoh_spatial_entity_org_entity (org_id, entity_id) 存在、唯一且有效
--   2) 旧单列唯一（约束/索引两种形态）已清除
--   3) 历史重复行已清理（同 (org_id, entity_id) 无重复）
-- （单字段断言形态，同 SQL-103 先例；不落任何脏数据。）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_idx integer := 0;
  at_old integer := 0;
  cols text := '';
  dup_rows integer := 0;
BEGIN
  SELECT count(*) INTO at_idx FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE n.nspname = current_schema() AND c.relname = 'uq_ewoh_spatial_entity_org_entity'
      AND t.relname = 'ewoh_spatial_entity' AND i.indisunique AND i.indisvalid;
  IF at_idx <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: uq_ewoh_spatial_entity_org_entity 缺失/非唯一 (at=%)', at_idx;
  END IF;

  SELECT count(*) INTO at_old FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'ewoh_spatial_entity_entity_id_key';
  SELECT count(*) + at_old INTO at_old FROM pg_constraint
    WHERE conname = 'ewoh_spatial_entity_entity_id_key'
      AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema());
  IF at_old <> 0 THEN
    RAISE EXCEPTION 'verify incomplete: 旧单列唯一残留 (at=%)', at_old;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO cols
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema() AND c.relname = 'uq_ewoh_spatial_entity_org_entity';
  IF cols IS DISTINCT FROM 'org_id,entity_id' THEN
    RAISE EXCEPTION 'verify incomplete: 索引列不符 (cols=%)', cols;
  END IF;

  SELECT count(*) INTO dup_rows FROM (
    SELECT org_id, entity_id
      FROM ewoh_spatial_entity
     WHERE org_id IS NOT NULL
     GROUP BY org_id, entity_id
    HAVING count(*) > 1
  ) d;
  IF dup_rows <> 0 THEN
    RAISE EXCEPTION 'verify incomplete: 存在历史重复 (org_id, entity_id) 行 (dups=%)', dup_rows;
  END IF;
END $$;
