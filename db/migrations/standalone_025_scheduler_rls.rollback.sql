-- EWOH Command Map — standalone_025 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 025 增量可回滚语义：025 是对 023 RLS 的覆盖/修复 + 8 张 org-scoped 调度表 RLS 覆盖。
-- 回滚撤销 025 新增的 policy（DROP POLICY IF EXISTS，幂等可重复执行）并
-- DISABLE ROW LEVEL SECURITY（审计 SQL-002 修复，2026-08-17：PG 语义下
-- RLS 启用 + 无 policy = 全拒，并非「无过滤」——仅 DROP POLICY 会使 8 张表
-- 对 service_role 完全不可读写，回滚必须一并关闭 RLS 开关回到 023 之前的
-- 无 RLS 状态）。
-- **不** DROP org_id 列（ewoh_schedule_plan.org_id 由 025 补齐，回滚保留——
-- 删列属破坏性变更，需显式迁移），也不撤销 GRANT（重复授予无副作用）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) ewoh_scheduling_constraint：撤销 025 重建的 policy（023 的旧 policy 已在 025 中被替换）
DROP POLICY IF EXISTS scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint DISABLE ROW LEVEL SECURITY;

-- 2) 其余 org-scoped 调度表：撤销 025 新增 policy + 关闭 RLS（回到 025 前无 RLS 状态）
DROP POLICY IF EXISTS scheduler_run_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_run;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_plan_org_isolation
  ON __EWOH_SCHEMA__.ewoh_schedule_plan;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_plan_assignment_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_resource_reservation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_resource_reservation;
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_policy_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_feedback_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_feedback;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_replan_trigger_org_isolation
  ON __EWOH_SCHEMA__.ewoh_replan_trigger;
ALTER TABLE __EWOH_SCHEMA__.ewoh_replan_trigger DISABLE ROW LEVEL SECURITY;
