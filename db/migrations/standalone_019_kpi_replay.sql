-- EWOH Command Map 智能调度 — KPI 聚合 + Policy Replay 持久化 (Phase 4 / P4-KPI+P4-REPLAY, standalone_019)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS（幂等）。
--
-- ewoh_scheduling_kpi：生产 KPI 聚合缓存（Delivery/Resources/Stability/Solver/DataQuality），
--   由 KpiService 周期性聚合写缓存；同 org + period 幂等覆盖。
-- ewoh_policy_replay：Policy Replay 记录（deterministic replay 结果持久化），
--   相同 snapshot + policy + solver version + seed/config = 确定性结果。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_kpi (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kpi_id varchar(255) NOT NULL UNIQUE,
  org_id varchar(255),
  period_start timestamptz(3) NOT NULL,
  period_end timestamptz(3) NOT NULL,
  kpi_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source varchar(50) NOT NULL DEFAULT 'aggregate',
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_kpi_org_period
  ON __EWOH_SCHEMA__.ewoh_scheduling_kpi (org_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_kpi_org
  ON __EWOH_SCHEMA__.ewoh_scheduling_kpi (org_id);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_policy_replay (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  replay_id varchar(255) NOT NULL UNIQUE,
  org_id varchar(255),
  candidate_policy_version integer NOT NULL,
  baseline_policy_version integer NOT NULL,
  solver_version varchar(100),
  snapshot_version varchar(255),
  snapshot_set jsonb DEFAULT '[]'::jsonb,
  seed integer,
  status varchar(50) NOT NULL DEFAULT 'COMPLETED',
  aggregate_kpis_json jsonb DEFAULT '{}'::jsonb,
  per_run_results_json jsonb DEFAULT '[]'::jsonb,
  failures_json jsonb DEFAULT '[]'::jsonb,
  started_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz(3),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ewoh_policy_replay_candidate
  ON __EWOH_SCHEMA__.ewoh_policy_replay (candidate_policy_version);
CREATE INDEX IF NOT EXISTS idx_ewoh_policy_replay_org
  ON __EWOH_SCHEMA__.ewoh_policy_replay (org_id);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_kpi IS '生产 KPI 聚合缓存（Delivery/Resources/Stability/Solver/DataQuality）';
COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_policy_replay IS 'Policy Replay 记录（deterministic：snapshot+policy+solver+seed）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_kpi TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_policy_replay TO service_role;
