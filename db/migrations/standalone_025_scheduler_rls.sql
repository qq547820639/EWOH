-- EWOH Command Map — Scheduler 域 RLS 覆盖 + GUC 名修复 (Task 1, standalone_025)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY / ADD COLUMN IF NOT EXISTS
--            / GRANT（幂等可重复执行）。
--
-- 背景（Task 1，Scheduler DB RLS audit/fix + 覆盖，已核验）：
--   1) 修复 standalone_023 的 GUC 名不一致：023 的 scheduler_constraint_org_isolation policy
--      读取 current_setting('app.primary_org_id')，但应用实际设置的 GUC 是
--      'app.current_org_id'（见 server/modules/shared/org-context.interceptor.ts 的
--      buildGucSettings）。真实 PG 下该 policy 将过滤掉全部 org 行（GUC 未设置 → NULL）。
--      025 重建该 policy：USING 读取 app.current_org_id，旧名 app.primary_org_id 仅在
--      未设置新名时回退（COALESCE + NULLIF 兼容）。
--   2) 对 org-scoped 调度域表启用 RLS（policy 名与 023 风格一致：
--      scheduler_<table>_org_isolation，FOR ALL TO service_role）：
--      ewoh_scheduling_run / ewoh_schedule_plan / ewoh_scheduling_plan_assignment /
--      ewoh_resource_reservation / ewoh_scheduling_policy / ewoh_scheduling_feedback /
--      ewoh_replan_trigger / ewoh_scheduling_constraint（重建）。
--   3) ewoh_schedule_plan 此前无 org_id 列（schema.ts 无该字段），025 补齐
--      （ADD COLUMN IF NOT EXISTS org_id varchar(255)）；NULL = 全局/存量方案放行，
--      与 ewoh_scheduling_constraint.org_id 语义一致（见 policy 的 org_id IS NULL 分支）。
--   4) 保持非 RLS 的表（应用层 org 过滤 + 既有审计测试覆盖，此处不启用）：
--      - ewoh_outbox：全局 sequence 事件日志（outbox_sequence_seq 全局原子键；SSE 按
--        sequence 增量重放/缺口检测），RLS 会破坏跨 org 的 sequence 键语义；
--      - ewoh_world_state_snapshot：snapshotVersion 全局唯一版本键（快照按版本存取）；
--      - ewoh_assignment_event：事件审计流（eventId 全局唯一，全量留痕）。
--
-- 约束行仅新增列/policy/RLS 开关/GRANT，不删除既有索引/列（向后兼容，与 023 同风格）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_schedule_plan：补齐 org_id 列（RLS 需要 org 归属列；此前 schema 无该字段）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS org_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.org_id IS '租户隔离（RLS + 应用层过滤；null=全局/存量方案）';

-- ============================================================================
-- 2) 组织隔离 GUC 表达式（修复 023 的 GUC 名不一致）：
--    应用设置 app.current_org_id（org-context.interceptor buildGucSettings）；
--    旧名 app.primary_org_id 仅在未设置新名时回退（兼容已按旧名配置的环境）。
--    未设置两者时表达式为 NULL → 仅放行 org_id IS NULL（全局）行（与 023 行为一致）。
-- ============================================================================

-- ============================================================================
-- 3) ewoh_scheduling_constraint：重建 023 的 policy（GUC 名修复 + WITH CHECK，幂等）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint;
CREATE POLICY scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

COMMENT ON POLICY scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint
  IS '约束组织隔离：org_id 匹配当前 org（app.current_org_id，回退 app.primary_org_id）或 NULL（全局）放行';

-- ============================================================================
-- 4) org-scoped 调度域表 RLS 覆盖（policy 名与 023 风格一致：scheduler_<table>_org_isolation）。
-- ============================================================================

-- ewoh_scheduling_run
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_run_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_run;
CREATE POLICY scheduler_run_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_run
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

-- ewoh_schedule_plan
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_plan_org_isolation
  ON __EWOH_SCHEMA__.ewoh_schedule_plan;
CREATE POLICY scheduler_plan_org_isolation
  ON __EWOH_SCHEMA__.ewoh_schedule_plan
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

-- ewoh_scheduling_plan_assignment
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_plan_assignment_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment;
CREATE POLICY scheduler_plan_assignment_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

-- ewoh_resource_reservation
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_resource_reservation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_resource_reservation;
CREATE POLICY scheduler_resource_reservation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_resource_reservation
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

-- ewoh_scheduling_policy
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_policy_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy;
CREATE POLICY scheduler_policy_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

-- ewoh_scheduling_feedback
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_feedback_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_feedback;
CREATE POLICY scheduler_feedback_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_feedback
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

-- ewoh_replan_trigger（org_id NOT NULL，policy 的 org_id IS NULL 分支对其自然不命中，无妨）
ALTER TABLE __EWOH_SCHEMA__.ewoh_replan_trigger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_replan_trigger_org_isolation
  ON __EWOH_SCHEMA__.ewoh_replan_trigger;
CREATE POLICY scheduler_replan_trigger_org_isolation
  ON __EWOH_SCHEMA__.ewoh_replan_trigger
  FOR ALL
  TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR org_id IS NULL
  );

-- ============================================================================
-- 5) 权限：8 张 org-scoped 表授予 service_role 完整 DML（幂等；已存在授权不重复报错）。
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_run TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_plan TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_resource_reservation TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_replan_trigger TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint TO service_role;
