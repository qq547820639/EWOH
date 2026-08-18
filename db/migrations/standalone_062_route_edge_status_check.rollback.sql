-- standalone_062 回滚：移除 route_edge.status CHECK 约束（恢复无守护状态，
-- 仅用于迁移链验证，生产禁用；存量归一不回滚——'open' 为合法值）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_edge
  DROP CONSTRAINT IF EXISTS route_edge_status_valid;
