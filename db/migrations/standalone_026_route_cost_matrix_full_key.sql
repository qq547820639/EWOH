-- EWOH Command Map 智能调度 — Route matrix DB 全键唯一 (Phase 0 / P0-4, Task 4, standalone_026)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（spec §P0-4）：ewoh_route_cost_matrix 现有唯一索引 uq_ewoh_route_cost_matrix_task_snapshot
-- 仅覆盖 (task_id, snapshot_version)；逻辑层缓存 key 已含 5 维
--   snapshotVersion + policyVersion + routeGraphVersion + taskId + candidateSetHash
-- （travel-cost.service.ts getCachedMatrix），但 DB 层无对应约束，不同策略/候选集的矩阵
-- 可能互相覆盖。本迁移补充全键复合唯一索引：
--   (task_id, snapshot_version, policy_version, route_graph_version, candidate_set_hash)
-- 部分唯一索引（WHERE candidate_set_hash IS NOT NULL）兼容存量 NULL 行；
-- 旧索引 uq_ewoh_route_cost_matrix_task_snapshot 保留不删（向后兼容）。
-- 写入路径对齐：TravelCostService.persistMatrix 写 route_graph_version / candidate_set_hash 列。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) 全键列（与 travel-cost.service.ts persistMatrix 写入列对齐；存量行 NULL）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_cost_matrix
  ADD COLUMN IF NOT EXISTS route_graph_version varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_cost_matrix
  ADD COLUMN IF NOT EXISTS candidate_set_hash varchar(64);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_route_cost_matrix.route_graph_version IS '路由图版本（逻辑缓存 key 维度；worldVersion 代理或 default）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_route_cost_matrix.candidate_set_hash IS '候选集合确定性哈希（FNV-1a，8 hex；区分不同候选集的矩阵；NULL=存量行/未写入）';

-- ============================================================================
-- 2) 全键复合唯一索引（部分唯一：candidate_set_hash IS NOT NULL，兼容存量 NULL 行）
-- ============================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_route_cost_matrix_full_key
  ON __EWOH_SCHEMA__.ewoh_route_cost_matrix
  (task_id, snapshot_version, policy_version, route_graph_version, candidate_set_hash)
  WHERE candidate_set_hash IS NOT NULL;

COMMENT ON INDEX __EWOH_SCHEMA__.uq_ewoh_route_cost_matrix_full_key IS '逻辑全键唯一：task_id+snapshot_version+policy_version+route_graph_version+candidate_set_hash（防不同策略/候选集矩阵互相覆盖；旧 (task_id,snapshot_version) 索引保留）';
