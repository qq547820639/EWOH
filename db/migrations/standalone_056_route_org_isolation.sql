-- ewoh_route_node / ewoh_route_edge org_id 列 + RLS（standalone_056, ADR-074 / NO-13y / §4/§15/§23）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / DROP POLICY IF EXISTS（幂等可重复执行）。
--
-- 背景（ADR-074）：路由拓扑是 World Model 中枢读面（§4）唯一无组织边界
-- 组件——两表无 org_id、无 RLS，GET /api/scheduler/routes 与 collectState
-- （GET /snapshot 与所有求解/重排快照路径）共享全局路由图，跨租户工厂
-- 布局事实泄漏。原地加固：org_id varchar(255)（NULL=存量/种子全局过渡行，
-- 与 standalone_025 语义对齐）+ RLS policy（org 匹配或 NULL 放行；不用
-- ewoh_org_visible——其 NULL 分支会隐藏存量全局行，破坏种子/内部无 GUC
-- 读取的过渡兼容）。应用无写路径（种子注入），未来写路径由 RLS WITH CHECK
-- 强制 ctx 归属。managed_count/physical_create_count 不变（74/77）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_node
  ADD COLUMN IF NOT EXISTS org_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_route_node.org_id IS
  '路由节点组织归属（ADR-074/standalone_056；RLS 组织隔离；null=存量/种子全局过渡行）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_edge
  ADD COLUMN IF NOT EXISTS org_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_route_edge.org_id IS
  '路由边组织归属（ADR-074/standalone_056；RLS 组织隔离；null=存量/种子全局过渡行）';

CREATE INDEX IF NOT EXISTS idx_ewoh_route_node_org ON __EWOH_SCHEMA__.ewoh_route_node (org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_route_edge_org ON __EWOH_SCHEMA__.ewoh_route_edge (org_id);

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_node ENABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_edge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node;
DROP POLICY IF EXISTS route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge;

-- 与 standalone_025 scheduler RLS 逐字对齐：org 匹配（app.current_org_id，
-- 回退 app.primary_org_id）或 org_id IS NULL（存量/全局过渡）。
CREATE POLICY route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node
  FOR ALL
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

CREATE POLICY route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge
  FOR ALL
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

COMMENT ON POLICY route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node IS
  '路由节点组织隔离：org_id 匹配当前 org（app.current_org_id，回退 app.primary_org_id）或 NULL（存量/全局过渡）放行（ADR-074/standalone_056）';

COMMENT ON POLICY route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge IS
  '路由边组织隔离：org_id 匹配当前 org（app.current_org_id，回退 app.primary_org_id）或 NULL（存量/全局过渡）放行（ADR-074/standalone_056）';
