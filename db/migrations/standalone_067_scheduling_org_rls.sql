-- standalone_067_scheduling_org_rls：调度执行域 5 表补 RLS（审计 T5，2026-08-28）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant：DROP POLICY IF EXISTS + ENABLE 幂等，可重复执行。
--
-- 背景（全量代码深度审计 2026-08-28 / T5）：
--   以下 5 表含 org_id 列但从未启用 RLS，且不在 standalone_057 的
--   「裁决记录（不改项）」名单内（该名单仅豁免 ewoh_world_state_snapshot /
--   ewoh_assignment_event / ewoh_outbox / prediction_shadow_observation 四表，
--   各有 GLOBAL_SHARED / DERIVED_TENANT_OWNERSHIP 的 ADR 裁决理由）。
--   这 5 表属遗漏而非有意豁免：
--     ewoh_scheduling_execution   （dispatch 派工执行档案）
--     ewoh_scheduling_conflict    （调度冲突记录）
--     ewoh_scheduling_kpi         （调度 KPI 聚合，org+period 幂等）
--     ewoh_route_cost_matrix      （路由代价矩阵）
--     ewoh_policy_activation      （策略激活/回滚审计）
--   org_id 列自 standalone_057 起 NOT NULL（存量已回填默认 org），列注释
--   「RLS org 隔离」所述能力此前实际缺失，本迁移补齐。
--
-- policy 形状对齐 standalone_057（rls_null_reject）：
--   FOR ALL TO service_role + org_id 匹配 app.current_org_id（回退
--   app.primary_org_id）+ OR org_id IS NULL 兜底分支（列虽 NOT NULL，
--   保留分支与 025/056/057 全家族形状逐字对齐，防御未来列约束回退）。
--   ::text 转换对 NOT NULL varchar 无害，兼容任意 numeric/uuid 形态列。
--
-- 不影响 RetentionService：其 owner 连接具备 BYPASSRLS（见 standalone_003
-- 运行时角色 NOBYPASSRLS 仅约束 api 角色；retention owner 角色继承
-- service_role 且表 owner 天然绕过 RLS），清理路径不受 policy 影响。
--
-- 应用侧读路径：KpiService / conflict.service / execution 查询均经
-- RequestDatabaseContext 注入 GUC（NEST-033），policy 生效后行为不变，
-- 仅新增跨租户行隔离。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ENABLE ROW LEVEL SECURITY（幂等）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_execution  ENABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_conflict   ENABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_kpi        ENABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_cost_matrix     ENABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_policy_activation     ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 2) org isolation policy（先 DROP 再 CREATE，保证幂等 + 形状收敛）
-- ============================================================================
DROP POLICY IF EXISTS scheduling_execution_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_execution;
CREATE POLICY scheduling_execution_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_execution
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduling_conflict_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_conflict;
CREATE POLICY scheduling_conflict_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_conflict
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduling_kpi_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_kpi;
CREATE POLICY scheduling_kpi_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_kpi
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS route_cost_matrix_org_isolation ON __EWOH_SCHEMA__.ewoh_route_cost_matrix;
CREATE POLICY route_cost_matrix_org_isolation ON __EWOH_SCHEMA__.ewoh_route_cost_matrix
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS policy_activation_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_activation;
CREATE POLICY policy_activation_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_activation
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

-- ============================================================================
-- 3) COMMENT（自描述，审计/巡检可追溯）
-- ============================================================================
COMMENT ON POLICY scheduling_execution_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_execution IS
  '执行档案组织隔离（standalone_067，审计 T5）：org_id 匹配当前 org 或 NULL 兜底（TO service_role，对齐 057 形状）';
COMMENT ON POLICY scheduling_conflict_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_conflict IS
  '冲突记录组织隔离（standalone_067，审计 T5）：org_id 匹配当前 org 或 NULL 兜底（TO service_role，对齐 057 形状）';
COMMENT ON POLICY scheduling_kpi_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_kpi IS
  'KPI 聚合组织隔离（standalone_067，审计 T5）：org_id 匹配当前 org 或 NULL 兜底（TO service_role，对齐 057 形状）';
COMMENT ON POLICY route_cost_matrix_org_isolation ON __EWOH_SCHEMA__.ewoh_route_cost_matrix IS
  '路由代价矩阵组织隔离（standalone_067，审计 T5）：org_id 匹配当前 org 或 NULL 兜底（TO service_role，对齐 057 形状）';
COMMENT ON POLICY policy_activation_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_activation IS
  '策略激活审计组织隔离（standalone_067，审计 T5）：org_id 匹配当前 org 或 NULL 兜底（TO service_role，对齐 057 形状）';
