-- EWOH Command Map 智能调度 — standalone_026 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 仅移除全键唯一索引（幂等可重复执行）。
-- 保留 route_graph_version / candidate_set_hash 列：travel-cost.service.ts
-- persistMatrix 已写入这两列，rollback 后应用层仍会写（drop 列会破坏运行时兼容）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_cost_matrix_full_key;
