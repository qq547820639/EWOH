-- standalone_057_rls_null_reject 回滚（re-entrant；需 EWOH_ALLOW_DESTRUCTIVE_ROLLBACK=1）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 回滚语义（可逆性说明）：
--   1) RLS policy 恢复 standalone_025/056 原定义（含 `OR org_id IS NULL` 放行
--      与无 TO 子句）。警告：原定义即审计 SQL-001/007 所指漏洞形态，仅应在
--      专项应急回退时使用；回退后尽快重新 apply 057。
--   2) org_id SET NOT NULL → DROP NOT NULL（可逆）。§1 的 backfill 值保留
--      （行数据不回滚，无数据损失；列恢复可空语义）。
--   3) 复合唯一 → 恢复单列唯一。警告：若 057 生效期间已有跨租户同业务 ID
--      写入，恢复单列唯一会因重复键失败——此时需人工清理后重试（数据损失
--      需求必须显式决策，脚本不静默删行）。
--   4) ewoh_org_visible(text) 重载：先重建 trace_span ::uuid 版 policy 再
--      DROP FUNCTION（避免依赖悬空）。
--   5) world_state_snapshot.org_id 血缘列保留（additive；drop 丢血缘数据，
--      若确需删除走独立显式迁移）。
--   6) 所有被 ENABLE ROW LEVEL SECURITY 且无对应 policy 保留的表，回滚中
--      一并 DISABLE ROW LEVEL SECURITY（PG 语义：RLS 启用 + 无 policy = 全拒，
--      见审计 SQL-002/008）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) 恢复 scheduler 8 表 + route_node/route_edge 原定义 policy（025/056 语义）
-- ============================================================================
DROP POLICY IF EXISTS scheduler_constraint_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_constraint;
CREATE POLICY scheduler_constraint_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_constraint
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduler_run_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_run;
CREATE POLICY scheduler_run_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_run
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduler_plan_org_isolation ON __EWOH_SCHEMA__.ewoh_schedule_plan;
CREATE POLICY scheduler_plan_org_isolation ON __EWOH_SCHEMA__.ewoh_schedule_plan
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduler_plan_assignment_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment;
CREATE POLICY scheduler_plan_assignment_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduler_resource_reservation_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_reservation;
CREATE POLICY scheduler_resource_reservation_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_reservation
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduler_policy_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_policy;
CREATE POLICY scheduler_policy_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_policy
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduler_feedback_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_feedback;
CREATE POLICY scheduler_feedback_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_feedback
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS scheduler_replan_trigger_org_isolation ON __EWOH_SCHEMA__.ewoh_replan_trigger;
CREATE POLICY scheduler_replan_trigger_org_isolation ON __EWOH_SCHEMA__.ewoh_replan_trigger
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

-- route_node / route_edge：恢复 056 原定义（无 TO 子句 = TO PUBLIC——057 修复
-- 前的形态；回滚警告见文件头）。
DROP POLICY IF EXISTS route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node;
CREATE POLICY route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node
  FOR ALL
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

DROP POLICY IF EXISTS route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge;
CREATE POLICY route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge
  FOR ALL
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );

-- ============================================================================
-- 2) saved_views / workbench_export_tasks：撤 RLS（DISABLE + DROP POLICY，
--    避免 RLS 启用无 policy 的全拒状态）+ 撤 org 复合唯一 + 恢复单列唯一。
-- ============================================================================
DROP POLICY IF EXISTS saved_views_org_isolation ON __EWOH_SCHEMA__.saved_views;
DROP POLICY IF EXISTS workbench_export_tasks_org_isolation ON __EWOH_SCHEMA__.workbench_export_tasks;
ALTER TABLE __EWOH_SCHEMA__.saved_views DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.workbench_export_tasks DISABLE ROW LEVEL SECURITY;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_saved_views_org_owner_name;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_workbench_export_tasks_org_task;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_workbench_export_tasks_org_idem;

-- 恢复单列唯一（若已有跨租户同 task_id/idempotency_key 行会失败：需人工清理，
-- 本脚本不静默删数据）。
DROP INDEX IF EXISTS __EWOH_SCHEMA__.workbench_export_tasks_task_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS workbench_export_tasks_task_id_key
  ON __EWOH_SCHEMA__.workbench_export_tasks (task_id);
DROP INDEX IF EXISTS __EWOH_SCHEMA__.workbench_export_tasks_idempotency_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS workbench_export_tasks_idempotency_key_key
  ON __EWOH_SCHEMA__.workbench_export_tasks (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================================
-- 3) 复合唯一 → 恢复单列唯一（12 表 + device；失败语义见文件头警告 3）。
--    PostgreSQL 的 ADD CONSTRAINT 无 IF NOT EXISTS 变体，用 DO $$ 守卫幂等。
-- ============================================================================
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_run_org_run_id;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_plan_assignment_org_assignment;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_constraint_org_constraint;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_node_org_node;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_edge_org_edge;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_feedback_org_feedback;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_conflict_org_conflict;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_cost_matrix_org_matrix;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_execution_org_execution;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_execution_org_assignment;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_kpi_org_kpi;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_policy_replay_org_replay;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_policy_activation_org_activation;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_device_org_device;

DO $$
DECLARE
  r record;
  v_restore text[] := ARRAY[
    'ewoh_scheduling_run|ewoh_scheduling_run_run_id_key|run_id',
    'ewoh_scheduling_plan_assignment|ewoh_scheduling_plan_assignment_assignment_id_key|assignment_id',
    'ewoh_scheduling_constraint|ewoh_scheduling_constraint_constraint_id_key|constraint_id',
    'ewoh_route_node|ewoh_route_node_node_id_key|node_id',
    'ewoh_route_edge|ewoh_route_edge_edge_id_key|edge_id',
    'ewoh_scheduling_feedback|ewoh_scheduling_feedback_feedback_id_key|feedback_id',
    'ewoh_scheduling_conflict|ewoh_scheduling_conflict_conflict_id_key|conflict_id',
    'ewoh_route_cost_matrix|ewoh_route_cost_matrix_matrix_id_key|matrix_id',
    'ewoh_scheduling_execution|ewoh_scheduling_execution_execution_id_key|execution_id',
    'ewoh_scheduling_kpi|ewoh_scheduling_kpi_kpi_id_key|kpi_id',
    'ewoh_policy_replay|ewoh_policy_replay_replay_id_key|replay_id',
    'ewoh_policy_activation|ewoh_policy_activation_activation_id_key|activation_id',
    'ewoh_device|ewoh_device_device_id_key|device_id'
  ];
  v_parts text[];
BEGIN
  FOREACH r IN ARRAY v_restore LOOP
    v_parts := string_to_array(r, '|');
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = '__EWOH_SCHEMA__'
         AND c.relname = v_parts[1]
         AND con.conname = v_parts[2]
    ) THEN
      EXECUTE format('ALTER TABLE __EWOH_SCHEMA__.%I ADD CONSTRAINT %I UNIQUE (%I)',
                     v_parts[1], v_parts[2], v_parts[3]);
    END IF;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_execution_assignment
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (assignment_id);

-- ============================================================================
-- 4) org_id NOT NULL → 可空（15 表；backfill 值保留，见文件头说明 2）。
-- ============================================================================
DO $$
DECLARE
  t text;
  v_tables text[] := ARRAY[
    'ewoh_scheduling_run',
    'ewoh_scheduling_plan_assignment',
    'ewoh_scheduling_constraint',
    'ewoh_schedule_plan',
    'ewoh_resource_reservation',
    'ewoh_scheduling_policy',
    'ewoh_scheduling_feedback',
    'ewoh_scheduling_conflict',
    'ewoh_route_cost_matrix',
    'ewoh_policy_activation',
    'ewoh_scheduling_kpi',
    'ewoh_scheduling_execution',
    'ewoh_policy_replay',
    'ewoh_route_node',
    'ewoh_route_edge'
  ];
BEGIN
  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format(
      'ALTER TABLE __EWOH_SCHEMA__.%I ALTER COLUMN org_id DROP NOT NULL', t);
  END LOOP;
END $$;

-- ============================================================================
-- 5) trace_span policy 恢复 ::uuid 形态 + 删除 ewoh_org_visible(text) 重载
--    （先重建 policy 再 DROP FUNCTION，避免依赖悬空）。
-- ============================================================================
DROP POLICY IF EXISTS trace_span_org_or_global ON __EWOH_SCHEMA__.ewoh_trace_span;
CREATE POLICY trace_span_org_or_global
  ON __EWOH_SCHEMA__.ewoh_trace_span
  FOR ALL TO service_role
  USING (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id::uuid)
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id::uuid)
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

DROP FUNCTION IF EXISTS public.ewoh_org_visible(text);

-- ============================================================================
-- 6) knowledge_entry：撤销 057 恢复的 authenticated 只读 policy（回到 039 形态）。
-- ============================================================================
DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_knowledge_entry;

-- ============================================================================
-- 7) notify_scheduler_outbox 权限恢复 057 前形态（PUBLIC 默认 EXECUTE）。
-- ============================================================================
REVOKE EXECUTE ON FUNCTION __EWOH_SCHEMA__.notify_scheduler_outbox() FROM service_role;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.notify_scheduler_outbox() TO PUBLIC;

-- ============================================================================
-- 8) world_state_snapshot.org_id 血缘列保留（additive；见文件头说明 5）。
--    idx_ewoh_resource_reservation_org 保留（性能索引，无语义影响）。
-- ============================================================================
