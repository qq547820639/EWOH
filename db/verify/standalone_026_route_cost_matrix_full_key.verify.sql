-- standalone_026_route_cost_matrix_full_key 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（spec §P0-4 verify 期望值）：
--   full_key_columns = 2（route_graph_version / candidate_set_hash）
--   full_key_index   = 1（uq_ewoh_route_cost_matrix_full_key 存在）
--   full_key_unique  = 1（pg_index.indisunique=true，确为唯一索引）
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  full_key_columns integer := 0;
  full_key_index integer := 0;
  full_key_unique integer := 0;
BEGIN
  SELECT count(*) INTO full_key_columns FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_route_cost_matrix'
      AND column_name IN ('route_graph_version','candidate_set_hash');
  IF full_key_columns <> 2 THEN
    missing := missing || format('full_key_columns=%s ', full_key_columns);
  END IF;

  SELECT count(*) INTO full_key_index FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'ewoh_route_cost_matrix'
      AND indexname = 'uq_ewoh_route_cost_matrix_full_key';
  IF full_key_index <> 1 THEN
    missing := missing || format('full_key_index=%s ', full_key_index);
  END IF;

  SELECT count(*) INTO full_key_unique FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_class ic ON ic.oid = i.indexrelid
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_route_cost_matrix'
      AND ic.relname = 'uq_ewoh_route_cost_matrix_full_key'
      AND i.indisunique;
  IF full_key_unique <> 1 THEN
    missing := missing || format('full_key_unique=%s ', full_key_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '026 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '026 verify OK: full-key unique index present (cols=2 idx=1 unique=1)';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_route_cost_matrix'
       AND column_name IN ('route_graph_version','candidate_set_hash')
  ) AS full_key_columns,
  (SELECT count(*) FROM pg_indexes
     WHERE schemaname = current_schema() AND tablename = 'ewoh_route_cost_matrix'
       AND indexname = 'uq_ewoh_route_cost_matrix_full_key'
  ) AS full_key_index,
  (SELECT count(*) FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE n.nspname = current_schema() AND c.relname = 'ewoh_route_cost_matrix'
       AND ic.relname = 'uq_ewoh_route_cost_matrix_full_key'
       AND i.indisunique
  ) AS full_key_unique;
