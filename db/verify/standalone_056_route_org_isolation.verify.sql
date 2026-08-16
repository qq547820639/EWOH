-- standalone_056_route_org_isolation 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-074 / NO-13y）：
--   1) ewoh_route_node / ewoh_route_edge 列 org_id 存在且类型 varchar(255)
--   2) 两表 RLS 已启用 + policy 存在且定义文本含 app.current_org_id 与
--      org_id IS NULL 分支（与 standalone_025 语义对齐）
--   3) 可见性自证（SET LOCAL GUC，验证后删除不留脏数据）：
--      - org-a GUC：可见 org-a 行与 NULL 存量行，不可见 org-b 行
--      - org-b GUC：可见 org-b 行与 NULL 存量行，不可见 org-a 行

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  node_col integer := 0;
  edge_col integer := 0;
  node_pol integer := 0;
  edge_pol integer := 0;
  node_rls boolean := false;
  edge_rls boolean := false;
  pol_text_ok boolean := false;
  vis_a_ok boolean := false;
  vis_b_ok boolean := false;
  vis_null_ok boolean := false;
  probe_a varchar := 'verify-056-a';
  probe_b varchar := 'verify-056-b';
BEGIN
  SELECT count(*) INTO node_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_route_node'
      AND column_name = 'org_id' AND data_type = 'character varying';
  SELECT count(*) INTO edge_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_route_edge'
      AND column_name = 'org_id' AND data_type = 'character varying';

  SELECT count(*) INTO node_pol FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_route_node'
      AND policyname = 'route_node_org_isolation';
  SELECT count(*) INTO edge_pol FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_route_edge'
      AND policyname = 'route_edge_org_isolation';

  SELECT relrowsecurity INTO node_rls FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_route_node';
  SELECT relrowsecurity INTO edge_rls FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_route_edge';

  SELECT bool_and(
    (qual::text LIKE '%app.current_org_id%' OR with_check::text LIKE '%app.current_org_id%')
    AND (qual::text LIKE '%org_id IS NULL%' OR with_check::text LIKE '%org_id IS NULL%')
  ) INTO pol_text_ok FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename IN ('ewoh_route_node', 'ewoh_route_edge')
      AND policyname IN ('route_node_org_isolation', 'route_edge_org_isolation');

  -- 3) 可见性自证（写入探针行 → SET LOCAL GUC 判定 → 清理）
  BEGIN
    INSERT INTO ewoh_route_node (node_id, node_type, x, y, org_id)
      VALUES ('verify-056-node-a', 'waypoint', 0, 0, probe_a),
             ('verify-056-node-b', 'waypoint', 1, 1, probe_b),
             ('verify-056-node-null', 'waypoint', 2, 2, NULL);

    PERFORM set_config('app.current_org_id', probe_a, true);
    PERFORM set_config('app.primary_org_id', '', true);
    vis_a_ok := EXISTS (SELECT 1 FROM ewoh_route_node WHERE node_id = 'verify-056-node-a')
                AND NOT EXISTS (SELECT 1 FROM ewoh_route_node WHERE node_id = 'verify-056-node-b')
                AND EXISTS (SELECT 1 FROM ewoh_route_node WHERE node_id = 'verify-056-node-null');

    PERFORM set_config('app.current_org_id', probe_b, true);
    vis_b_ok := EXISTS (SELECT 1 FROM ewoh_route_node WHERE node_id = 'verify-056-node-b')
                AND NOT EXISTS (SELECT 1 FROM ewoh_route_node WHERE node_id = 'verify-056-node-a')
                AND EXISTS (SELECT 1 FROM ewoh_route_node WHERE node_id = 'verify-056-node-null');

    PERFORM set_config('app.current_org_id', '', true);
    vis_null_ok := EXISTS (SELECT 1 FROM ewoh_route_node WHERE node_id = 'verify-056-node-null');

    DELETE FROM ewoh_route_node WHERE node_id LIKE 'verify-056-node-%';
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM ewoh_route_node WHERE node_id LIKE 'verify-056-node-%';
    RAISE;
  END;

  IF node_col <> 1 OR edge_col <> 1 OR node_pol <> 1 OR edge_pol <> 1
     OR NOT node_rls OR NOT edge_rls OR NOT pol_text_ok
     OR NOT vis_a_ok OR NOT vis_b_ok OR NOT vis_null_ok THEN
    RAISE EXCEPTION 'standalone_056 verify incomplete: node_col=% edge_col=% node_pol=% edge_pol=% node_rls=% edge_rls=% pol_text=% vis_a=% vis_b=% vis_null=%',
      node_col, edge_col, node_pol, edge_pol, node_rls, edge_rls, pol_text_ok, vis_a_ok, vis_b_ok, vis_null_ok;
  END IF;
END $$;

SELECT 1 AS standalone_056_verified;
