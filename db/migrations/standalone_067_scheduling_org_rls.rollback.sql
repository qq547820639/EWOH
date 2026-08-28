-- standalone_067_scheduling_org_rls 回滚（re-entrant；需 EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 关键（审计 SQL-002/008 同款教训）：RLS 启用 + 无 policy = 全拒（对
-- service_role 完全不可读写），因此 DROP POLICY 后必须一并 DISABLE ROW
-- LEVEL SECURITY，恢复到 067 之前"无 RLS"的原始水平。
-- 回滚后回到 2026-08-28 审计前状态：5 表无行级隔离（跨租户可读）——
-- 该状态即审计 T5 所指风险本身，仅在专项应急时使用并尽快重新 apply。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP POLICY IF EXISTS scheduling_execution_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_execution;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_execution  DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduling_conflict_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_conflict;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_conflict   DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduling_kpi_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_kpi;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_kpi        DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS route_cost_matrix_org_isolation ON __EWOH_SCHEMA__.ewoh_route_cost_matrix;
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_cost_matrix     DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_activation_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_activation;
ALTER TABLE __EWOH_SCHEMA__.ewoh_policy_activation     DISABLE ROW LEVEL SECURITY;
