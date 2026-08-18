-- standalone_062_route_edge_status_check 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（P1：route_edge.status 无 CHECK + 强制 cast 透传）：
--   1) CHECK 约束 route_edge_status_valid 存在且有效（convalidated）；
--   2) 存量无非法 status（归一步骤生效的自证）。
-- （单字段断言形态，同 SQL-103 先例；不落任何脏数据。）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_cst integer := 0;
  bad_rows integer := 0;
BEGIN
  SELECT count(*) INTO at_cst
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE con.conname = 'route_edge_status_valid'
      AND nsp.nspname = current_schema()
      AND rel.relname = 'ewoh_route_edge'
      AND con.contype = 'c'
      AND con.convalidated;
  IF at_cst <> 1 THEN
    RAISE EXCEPTION 'verify incomplete: route_edge status CHECK 缺失/未验证 (at=%)', at_cst;
  END IF;

  SELECT count(*) INTO bad_rows FROM ewoh_route_edge
    WHERE status NOT IN ('open', 'normal', 'congested', 'blocked');
  IF bad_rows <> 0 THEN
    RAISE EXCEPTION 'verify incomplete: 存量非法 status 残留 (rows=%)', bad_rows;
  END IF;
END $$;

SELECT 1 AS standalone_062_verified;
