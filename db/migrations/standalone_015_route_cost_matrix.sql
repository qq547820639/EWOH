-- EWOH Command Map 智能调度驾驶舱 — RouteCostMatrix 落库缓存 (Phase 2 / P2-T1, 决策 D-D)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- No physical foreign keys.
--
-- 背景（02 §10 / 决策 D-D）：RouteCostMatrix（Task×候选 的路径成本矩阵）落库缓存，
-- 支撑确定性 replay（相同 snapshot+policyVersion+solverVersion 可完全复现）。
-- 写入路径：TravelCostService.persistMatrix；读取路径：getCachedMatrix。
-- 唯一键：task_id + snapshot_version（同一任务同快照的矩阵幂等覆盖）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_route_cost_matrix (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_id varchar(255) NOT NULL UNIQUE,
  task_id varchar(255) NOT NULL,
  snapshot_version varchar(255) NOT NULL,
  policy_version integer,
  solver_version varchar(100),
  candidates_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  generated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  org_id varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_route_cost_matrix_task_snapshot
  ON __EWOH_SCHEMA__.ewoh_route_cost_matrix (task_id, snapshot_version);
CREATE INDEX IF NOT EXISTS idx_ewoh_route_cost_matrix_task
  ON __EWOH_SCHEMA__.ewoh_route_cost_matrix (task_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_route_cost_matrix_snapshot
  ON __EWOH_SCHEMA__.ewoh_route_cost_matrix (snapshot_version);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_route_cost_matrix IS 'RouteCostMatrix 缓存：Task×候选路径成本（决策 D-D，确定性 replay）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_route_cost_matrix.candidates_json IS 'CandidateRouteCost[] jsonb 数组';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_route_cost_matrix TO service_role;
