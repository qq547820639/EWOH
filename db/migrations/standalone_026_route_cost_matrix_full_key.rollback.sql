-- EWOH Command Map 智能调度 — standalone_026 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 仅移除全键唯一索引（幂等可重复执行）。
-- 保留 route_graph_version / candidate_set_hash 列（审计 SQL-041 文档化裁决，
-- 2026-08-17）：travel-cost.service.ts persistMatrix 已写入这两列，rollback 后
-- 应用层仍会继续写——drop 列会破坏运行时兼容并造成既写数据丢失（不可接受）。
-- 数据损失说明：无。列数据完整保留；回滚仅弱化唯一性约束（相同全键的重复
-- 缓存行可再次写入），确定性 replay 幂等覆盖语义退化为最新写入优先。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_cost_matrix_full_key;
