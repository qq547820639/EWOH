-- EWOH Command Map — standalone_025 回滚（re-entrant）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 025 增量可回滚语义：025 是对 023 RLS 的覆盖/修复 + 8 张 org-scoped 调度表 RLS 覆盖。
-- 回滚只撤销 025 新增的 policy（DROP POLICY IF EXISTS，幂等可重复执行）；
-- **不** DISABLE ROW LEVEL SECURITY、**不** DROP org_id 列（ewoh_schedule_plan.org_id
-- 由 025 补齐，回滚保留——删列属破坏性变更且与 023 回滚删列语义不同，需显式迁移），
-- 也不撤销 GRANT（service_role 授权保留，既有授权重复授予无副作用）。
-- 回滚后：constraint 表回到 023 的 RLS 状态（表仍 ENABLE，但 policy 被删——
-- 无 policy 即无过滤，等价于未启用前的行为）；其余 7 张表回到无 policy 的 RLS 空转状态。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- 1) ewoh_scheduling_constraint：撤销 025 重建的 policy（023 的旧 policy 已在 025 中被替换）
DROP POLICY IF EXISTS scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint;

-- 2) 其余 org-scoped 调度表：撤销 025 新增 policy
DROP POLICY IF EXISTS scheduler_run_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_run;
DROP POLICY IF EXISTS scheduler_plan_org_isolation
  ON __EWOH_SCHEMA__.ewoh_schedule_plan;
DROP POLICY IF EXISTS scheduler_plan_assignment_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment;
DROP POLICY IF EXISTS scheduler_resource_reservation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_resource_reservation;
DROP POLICY IF EXISTS scheduler_policy_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy;
DROP POLICY IF EXISTS scheduler_feedback_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_feedback;
DROP POLICY IF EXISTS scheduler_replan_trigger_org_isolation
  ON __EWOH_SCHEMA__.ewoh_replan_trigger;
