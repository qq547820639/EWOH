-- EWOH Command Map 智能调度驾驶舱 — RouteCostMatrix 落库缓存 rollback (Phase 2 / P2-T1)
-- DESTRUCTIVE-optional: 移除 ewoh_route_cost_matrix 表。
-- Guarded with DROP TABLE IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_route_cost_matrix;
