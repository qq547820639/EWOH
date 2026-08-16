-- standalone_056_route_org_isolation 回滚（列删除 = additive 列回撤；RLS policy 移除）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚后回到 R-94 前水平（路由拓扑无组织隔离，全局读面；列数据随列删除，
-- 无其余行数据损失）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP POLICY IF EXISTS route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node;
DROP POLICY IF EXISTS route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_route_node_org;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_route_edge_org;

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_node
  DROP COLUMN IF EXISTS org_id;

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_edge
  DROP COLUMN IF EXISTS org_id;
