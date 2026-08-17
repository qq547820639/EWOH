-- EWOH 2026-08-17 审计整改 — RLS NULL 放行收敛 + org_id 收紧 + 复合唯一键
-- (standalone_057, 审计 SQL-001/007/009/013~027/033/034/035/046/050/054, NEST-503/521, NEST-205 配套)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: DROP POLICY IF EXISTS / DROP CONSTRAINT IF EXISTS / DROP INDEX IF EXISTS
-- / CREATE ... IF NOT EXISTS / DO $$ 守卫（幂等可重复执行）。
--
-- 背景（docs/audit/2026-08-17-line-by-line-audit.md §6.23）：
--   1) SQL-001/NEST-503：standalone_025 的 8 张 scheduler 表 RLS policy 含
--      `OR org_id IS NULL` 放行分支（USING 与 WITH CHECK 均放行 NULL 行）——
--      org_id 为 NULL 的行对所有租户可见可写，新 INSERT 不设 org_id 即跨租户泄漏。
--      057 重建 policy：仅 org 匹配（或显式 global_admin）放行，NULL 一律拒绝
--      （fail-closed）。global_admin 例外路径显式声明（与 001 ewoh_world_snapshot
--      全局行 idiom 一致：app.is_global_admin='true'）。
--   2) SQL-007/054：standalone_056 的 route_node/route_edge policy 无 TO 子句
--      （默认 TO PUBLIC，含 anon）。057 重建为 TO service_role。
--   3) SQL-009：standalone_005 的 saved_views / workbench_export_tasks 无 RLS。
--      057 补 org 隔离 policy（列名 organization_id）+ 补 (org, ...) 唯一键。
--   4) SQL-013~015/017/020~025/035：调度域表 org_id 可空 + 单列业务键唯一
--      → 057 先 backfill（默认 org，见下）再 SET NOT NULL，业务键唯一改
--      复合 (org_id, x)，跨租户同业务 ID 不再冲突。
--   5) SQL-026/027：uq_ewoh_scheduling_policy_org_active / uq_ewoh_scheduling_kpi_org_period
--      依赖 org_id NOT NULL（PG 中 NULL != NULL 使部分唯一对 NULL 行去重失效）。
--   6) NEST-205 配套（ewohDevice）：旧库已有 deviceId 单列唯一索引
--      （ewoh_device_device_id_key），057 drop 旧建新 (org_id, device_id)。
--   7) SQL-033：standalone_039 删除了 knowledge_entry 的 authenticated 读
--      policy 无替代 → 057 恢复 ewoh_org_select（含共享层哨兵 org 可读）。
--   8) SQL-034：trace_span policy 调 ewoh_org_visible(org_id::uuid) 但列为
--      varchar(255)，非 UUID 值运行时抛 invalid input syntax → 057 新增
--      ewoh_org_visible(text) 重载并重建该 policy（NEST-502/512 最小破坏
--      方案：保留既有 uuid 列与 uuid 版函数，varchar 列 policy 走 text 版）。
--   9) SQL-046：notify_scheduler_outbox（SECURITY DEFINER 触发器函数）显式
--      REVOKE FROM PUBLIC + GRANT TO service_role，暴露面文档化。
--
-- 裁决记录（不改项，理由）：
--   - SQL-016/018/019：ewoh_world_state_snapshot / ewoh_assignment_event /
--     ewoh_outbox 保持「org_id 血缘列可空 + 业务键全局唯一」。ADR-004/028
--     已裁决 GLOBAL_SHARED / DERIVED_TENANT_OWNERSHIP 语义（RLS 关闭、
--     eventId/snapshot_version 为全局版本键，SSE 跨 org 重放与审计留痕依赖
--     全局唯一，见 standalone_025/028 头注释与 schema-manifest notes）。
--     057 仅补 world_state_snapshot.org_id 血缘列（business_key 对齐）。
--   - SQL-010：prediction_shadow_observation 维持 GLOBAL_SHARED（029 迁移头
--     显式声明 advisory-only 观测 + null=全局/ALL 采样语义），不启用 RLS；
--     manifest 已补登记（SQL-030）。
--   - SQL-043：ewoh_knowledge_entry.base_id DROP NOT NULL 是 standalone_039
--     的显式契约决策（「新契约条目无知识库归属约束，NULL 为诚实值」，ADR-018
--     Amendment 1），无物理外键，引用合法性由应用层（validateKnowledgeEntry）
--     把关，不恢复 NOT NULL。
--
-- backfill 策略（spec 边界 2：org 数据回填）：
--   默认 org 取值优先级：ewoh_organization 中最小 org_id（seed 首个集团 org）
--   → 表无 org 行时使用 seed 默认 org '00000000-0000-4000-8000-000000000001'
--   并创建哨兵默认 org 行（幂等）+ RAISE NOTICE 记录。
--
-- 兼容性：不重命名/删除既有迁移；已应用库重跑本迁移无变更（全部幂等）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) 默认 org 解析（幂等）：ewoh_organization 最小 org_id → 哨兵默认 org。
-- ============================================================================
DO $$
DECLARE
  v_default_org text;
BEGIN
  SELECT min(org_id::text) INTO v_default_org
    FROM __EWOH_SCHEMA__.ewoh_organization
   WHERE org_id IS NOT NULL;

  IF v_default_org IS NULL THEN
    v_default_org := '00000000-0000-4000-8000-000000000001';
    IF NOT EXISTS (
      SELECT 1 FROM __EWOH_SCHEMA__.ewoh_organization
       WHERE org_id = v_default_org::uuid
    ) THEN
      INSERT INTO __EWOH_SCHEMA__.ewoh_organization
        (id, org_id, name, org_type, parent_id, status, description)
      VALUES
        (gen_random_uuid(), v_default_org::uuid, 'Default Organization', 'group',
         NULL, 'active',
         'standalone_057 sentinel default org: backfill target for NULL org_id rows');
      RAISE NOTICE 'standalone_057: ewoh_organization 为空，已创建哨兵默认 org %（backfill 目标，已记录）', v_default_org;
    END IF;
  END IF;
END $$;

-- ============================================================================
-- 2) org_id backfill + SET NOT NULL（SQL-020/021/022/025~027/035）。
--    15 张调度域表：NULL org_id 行回填默认 org，然后收紧 NOT NULL。
--    （ewoh_outbox / ewoh_assignment_event / ewoh_world_state_snapshot /
--     prediction_shadow_observation 不在本清单——GLOBAL_SHARED/DERIVED 血缘
--     语义，见头部裁决记录。）
-- ============================================================================
DO $$
DECLARE
  v_default_org text;
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
  SELECT min(org_id::text) INTO v_default_org
    FROM __EWOH_SCHEMA__.ewoh_organization
   WHERE org_id IS NOT NULL;
  v_default_org := coalesce(v_default_org, '00000000-0000-4000-8000-000000000001');

  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format(
      'UPDATE __EWOH_SCHEMA__.%I SET org_id = %L WHERE org_id IS NULL',
      t, v_default_org);
  END LOOP;

  FOREACH t IN ARRAY v_tables LOOP
    EXECUTE format(
      'ALTER TABLE __EWOH_SCHEMA__.%I ALTER COLUMN org_id SET NOT NULL', t);
  END LOOP;
END $$;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.org_id IS '租户隔离（RLS + 应用层过滤；standalone_057 起 NOT NULL，存量 NULL 行已回填默认 org）';

-- ============================================================================
-- 3) RLS policy 重建（SQL-001/007/054/NEST-503）：去除 `OR org_id IS NULL`
--    放行分支，显式 TO service_role；global_admin 例外路径显式声明。
--    GUC 未设置且非 global_admin 时表达式为 NULL → fail-closed 全拒。
--    幂等：DROP POLICY IF EXISTS 后重建，policy 名与 025/056 保持一致
--    （verify 断言不漂移）。
-- ============================================================================

-- 3.1 scheduler 8 表（重建 standalone_025 的 policy）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_constraint_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_constraint;
CREATE POLICY scheduler_constraint_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_constraint
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_run_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_run;
CREATE POLICY scheduler_run_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_run
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_plan_org_isolation ON __EWOH_SCHEMA__.ewoh_schedule_plan;
CREATE POLICY scheduler_plan_org_isolation ON __EWOH_SCHEMA__.ewoh_schedule_plan
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_plan_assignment_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment;
CREATE POLICY scheduler_plan_assignment_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_resource_reservation_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_reservation;
CREATE POLICY scheduler_resource_reservation_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_reservation
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_policy_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_policy;
CREATE POLICY scheduler_policy_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_policy
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_feedback_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_feedback;
CREATE POLICY scheduler_feedback_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_feedback
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_replan_trigger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduler_replan_trigger_org_isolation ON __EWOH_SCHEMA__.ewoh_replan_trigger;
CREATE POLICY scheduler_replan_trigger_org_isolation ON __EWOH_SCHEMA__.ewoh_replan_trigger
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

-- 3.2 route_node / route_edge（SQL-007/054：补 TO service_role + 去 NULL 放行）
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_node ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node;
CREATE POLICY route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_edge ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge;
CREATE POLICY route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge
  FOR ALL TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

COMMENT ON POLICY scheduler_constraint_org_isolation ON __EWOH_SCHEMA__.ewoh_scheduling_constraint IS
  '约束组织隔离（standalone_057）：org_id 匹配当前 org（app.current_org_id，回退 app.primary_org_id）或显式 global_admin 放行；org_id IS NULL 一律拒绝（fail-closed，回填后列已 NOT NULL）';
COMMENT ON POLICY route_node_org_isolation ON __EWOH_SCHEMA__.ewoh_route_node IS
  '路由节点组织隔离（standalone_057）：TO service_role（修复 056 缺 TO 即 TO PUBLIC）；org 匹配或显式 global_admin；NULL 拒绝';
COMMENT ON POLICY route_edge_org_isolation ON __EWOH_SCHEMA__.ewoh_route_edge IS
  '路由边组织隔离（standalone_057）：TO service_role（修复 056 缺 TO 即 TO PUBLIC）；org 匹配或显式 global_admin；NULL 拒绝';

-- 3.3 saved_views / workbench_export_tasks（SQL-009：补 RLS + org 复合唯一）
ALTER TABLE __EWOH_SCHEMA__.saved_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS saved_views_org_isolation ON __EWOH_SCHEMA__.saved_views;
CREATE POLICY saved_views_org_isolation ON __EWOH_SCHEMA__.saved_views
  FOR ALL TO service_role
  USING (
    organization_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    organization_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

ALTER TABLE __EWOH_SCHEMA__.workbench_export_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workbench_export_tasks_org_isolation ON __EWOH_SCHEMA__.workbench_export_tasks;
CREATE POLICY workbench_export_tasks_org_isolation ON __EWOH_SCHEMA__.workbench_export_tasks
  FOR ALL TO service_role
  USING (
    organization_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    organization_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

COMMENT ON POLICY saved_views_org_isolation ON __EWOH_SCHEMA__.saved_views IS
  '保存视图组织隔离（standalone_057，SQL-009 修复）：organization_id 匹配当前 org 或显式 global_admin；service_role only';
COMMENT ON POLICY workbench_export_tasks_org_isolation ON __EWOH_SCHEMA__.workbench_export_tasks IS
  '导出任务组织隔离（standalone_057，SQL-009 修复）：organization_id 匹配当前 org 或显式 global_admin；service_role only';

-- workbench 业务键唯一补 org 维度（SQL-009）：
--   task_id / idempotency_key 单列唯一 → (organization_id, task_id) /
--   (organization_id, idempotency_key)；saved_views 补 (org, owner, workbench, name)
--   软删排除的唯一键。
ALTER TABLE __EWOH_SCHEMA__.workbench_export_tasks
  DROP CONSTRAINT IF EXISTS workbench_export_tasks_task_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_workbench_export_tasks_org_task;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_export_tasks_org_task
  ON __EWOH_SCHEMA__.workbench_export_tasks (organization_id, task_id);

ALTER TABLE __EWOH_SCHEMA__.workbench_export_tasks
  DROP CONSTRAINT IF EXISTS workbench_export_tasks_idempotency_key_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_workbench_export_tasks_org_idem;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workbench_export_tasks_org_idem
  ON __EWOH_SCHEMA__.workbench_export_tasks (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_saved_views_org_owner_name;
CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_views_org_owner_name
  ON __EWOH_SCHEMA__.saved_views (organization_id, owner_user_id, workbench, name)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- 4) 业务键唯一约束复合化（SQL-013~015/017/020/021/022/023/024/025）：
--    drop 单列唯一（PG 默认命名 <table>_<column>_key）→ 建复合唯一索引。
--    注意：ewoh_outbox/ewoh_assignment_event/ewoh_world_state_snapshot 的
--    全局唯一键保留（头部裁决记录）。
-- ============================================================================
-- ewoh_scheduling_run：run_id → (org_id, run_id)（SQL-013）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run
  DROP CONSTRAINT IF EXISTS ewoh_scheduling_run_run_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_run_org_run_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_run_org_run_id
  ON __EWOH_SCHEMA__.ewoh_scheduling_run (org_id, run_id);

-- ewoh_scheduling_plan_assignment：assignment_id → (org_id, assignment_id)（SQL-014）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment
  DROP CONSTRAINT IF EXISTS ewoh_scheduling_plan_assignment_assignment_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_plan_assignment_org_assignment;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_plan_assignment_org_assignment
  ON __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment (org_id, assignment_id);

-- ewoh_scheduling_constraint：constraint_id → (org_id, constraint_id)（SQL-015）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  DROP CONSTRAINT IF EXISTS ewoh_scheduling_constraint_constraint_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_constraint_org_constraint;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_constraint_org_constraint
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint (org_id, constraint_id);

-- ewoh_route_node / ewoh_route_edge（SQL-017/050）
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_node
  DROP CONSTRAINT IF EXISTS ewoh_route_node_node_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_node_org_node;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_route_node_org_node
  ON __EWOH_SCHEMA__.ewoh_route_node (org_id, node_id);

ALTER TABLE __EWOH_SCHEMA__.ewoh_route_edge
  DROP CONSTRAINT IF EXISTS ewoh_route_edge_edge_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_edge_org_edge;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_route_edge_org_edge
  ON __EWOH_SCHEMA__.ewoh_route_edge (org_id, edge_id);

-- ewoh_scheduling_feedback：feedback_id → (org_id, feedback_id)（SQL-020）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback
  DROP CONSTRAINT IF EXISTS ewoh_scheduling_feedback_feedback_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_feedback_org_feedback;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_feedback_org_feedback
  ON __EWOH_SCHEMA__.ewoh_scheduling_feedback (org_id, feedback_id);

-- ewoh_scheduling_conflict：conflict_id → (org_id, conflict_id)（SQL-021）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_conflict
  DROP CONSTRAINT IF EXISTS ewoh_scheduling_conflict_conflict_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_conflict_org_conflict;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_conflict_org_conflict
  ON __EWOH_SCHEMA__.ewoh_scheduling_conflict (org_id, conflict_id);

-- ewoh_route_cost_matrix：matrix_id → (org_id, matrix_id)（SQL-022）
ALTER TABLE __EWOH_SCHEMA__.ewoh_route_cost_matrix
  DROP CONSTRAINT IF EXISTS ewoh_route_cost_matrix_matrix_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_route_cost_matrix_org_matrix;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_route_cost_matrix_org_matrix
  ON __EWOH_SCHEMA__.ewoh_route_cost_matrix (org_id, matrix_id);

-- ewoh_scheduling_execution：execution_id / assignment_id → 复合（SQL-023）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_execution
  DROP CONSTRAINT IF EXISTS ewoh_scheduling_execution_execution_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_execution_org_execution;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_execution_org_execution
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (org_id, execution_id);
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_execution_assignment;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_execution_org_assignment;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_execution_org_assignment
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (org_id, assignment_id);

-- ewoh_scheduling_kpi / ewoh_policy_replay（SQL-024/027：
--   kpi_id / replay_id 复合；org_period 部分唯一依赖 org_id NOT NULL，已在 §2 收紧）
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_kpi
  DROP CONSTRAINT IF EXISTS ewoh_scheduling_kpi_kpi_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_scheduling_kpi_org_kpi;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_kpi_org_kpi
  ON __EWOH_SCHEMA__.ewoh_scheduling_kpi (org_id, kpi_id);

ALTER TABLE __EWOH_SCHEMA__.ewoh_policy_replay
  DROP CONSTRAINT IF EXISTS ewoh_policy_replay_replay_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_policy_replay_org_replay;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_policy_replay_org_replay
  ON __EWOH_SCHEMA__.ewoh_policy_replay (org_id, replay_id);

-- ewoh_policy_activation：activation_id → (org_id, activation_id)（SQL-025）
ALTER TABLE __EWOH_SCHEMA__.ewoh_policy_activation
  DROP CONSTRAINT IF EXISTS ewoh_policy_activation_activation_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_policy_activation_org_activation;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_policy_activation_org_activation
  ON __EWOH_SCHEMA__.ewoh_policy_activation (org_id, activation_id);

-- ewoh_device：deviceId 单列唯一 → (org_id, device_id)（NEST-205 配套；
--   旧库已有 ewoh_device_device_id_key 单列唯一，drop 旧建新）
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  DROP CONSTRAINT IF EXISTS ewoh_device_device_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.ewoh_device_device_id_key;
DROP INDEX IF EXISTS __EWOH_SCHEMA__.uq_ewoh_device_org_device;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_device_org_device
  ON __EWOH_SCHEMA__.ewoh_device (org_id, device_id);

COMMENT ON INDEX __EWOH_SCHEMA__.uq_ewoh_device_org_device IS
  '设备业务键租户复合唯一（standalone_057，NEST-205）：同 org 内 device_id 唯一；跨租户可复用同一 device_id';

-- ============================================================================
-- 5) ewoh_org_visible(text) 重载（SQL-034 / NEST-502/512 最小破坏方案）：
--    与 uuid 版语义一致（text 直等比较，不做 ::uuid cast——varchar(255) 的
--    org_id 列在非 UUID 值时不再抛 invalid input syntax）。既有 uuid 列的
--    policy 继续走 uuid 版函数；本重载供 varchar 列 policy（trace_span 等）使用。
-- ============================================================================
CREATE OR REPLACE FUNCTION public.ewoh_org_visible(p_org_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    coalesce(current_setting('app.is_global_admin', true), '') = 'true'
    OR (
      nullif(coalesce(current_setting('app.current_org_ids', true), ''), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM unnest(string_to_array(current_setting('app.current_org_ids', true), ',')) AS o(org)
        WHERE btrim(o.org) <> '' AND btrim(o.org) = p_org_id
      )
    );
$$;

COMMENT ON FUNCTION public.ewoh_org_visible(text) IS
  'org 可见性判定（text 版，standalone_057）：varchar org_id 列的 RLS policy 使用本重载，避免 ::uuid cast 在非 UUID 值时抛错（SQL-034）；语义与 uuid 版一致';

-- trace_span policy 重建：走 text 重载，去除 org_id::uuid 强制 cast（SQL-034）
DROP POLICY IF EXISTS trace_span_org_or_global ON __EWOH_SCHEMA__.ewoh_trace_span;
CREATE POLICY trace_span_org_or_global
  ON __EWOH_SCHEMA__.ewoh_trace_span
  FOR ALL TO service_role
  USING (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id)
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id)
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

COMMENT ON POLICY trace_span_org_or_global ON __EWOH_SCHEMA__.ewoh_trace_span IS
  'trace span 可见性（standalone_057 重建）：ewoh_org_visible(org_id) 走 text 重载，非 UUID org_id 值不再抛 invalid input syntax（SQL-034）';

-- ============================================================================
-- 6) knowledge_entry：恢复 authenticated SELECT policy（SQL-033）。
--    standalone_039 删除遗留 ewoh_org_select 后 authenticated 全拒；本迁移
--    恢复只读策略（租户行 ewoh_org_visible + 共享层哨兵 org 行全租户可读，
--    与 039 的 service_role policy 语义对齐）。
-- ============================================================================
DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_knowledge_entry;
CREATE POLICY ewoh_org_select ON __EWOH_SCHEMA__.ewoh_knowledge_entry
  FOR SELECT TO authenticated
  USING (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id)
    OR (scope IN ('global', 'industry')
        AND org_id::text = '00000000-0000-4000-8000-000000000000')
  );

COMMENT ON POLICY ewoh_org_select ON __EWOH_SCHEMA__.ewoh_knowledge_entry IS
  '知识条目 authenticated 只读（standalone_057 恢复，SQL-033）：本租户行（ewoh_org_visible）+ 共享层哨兵 org 行；DML 仍仅 service_role（knowledge_entry_service_all）';

-- ============================================================================
-- 7) notify_scheduler_outbox 函数暴露面收敛（SQL-046）：
--    SECURITY DEFINER 触发器函数显式 REVOKE FROM PUBLIC + GRANT service_role。
-- ============================================================================
REVOKE ALL PRIVILEGES ON FUNCTION __EWOH_SCHEMA__.notify_scheduler_outbox() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION __EWOH_SCHEMA__.notify_scheduler_outbox() TO service_role;

COMMENT ON FUNCTION __EWOH_SCHEMA__.notify_scheduler_outbox() IS
  'outbox AFTER INSERT 通知触发器（standalone_024，SECURITY DEFINER）：仅由触发器调用；standalone_057 起 REVOKE FROM PUBLIC、EXECUTE 仅 service_role（SQL-046）';

-- ============================================================================
-- 8) world_state_snapshot：补 org_id 血缘列（SQL-016 部分修复；唯一键裁决
--    保留全局版本键，见头部裁决记录）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state_snapshot
  ADD COLUMN IF NOT EXISTS org_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_world_state_snapshot.org_id IS
  '租户血缘（GLOBAL_SHARED，ADR-004）：仅记录不隔离；snapshot_version 保持全局唯一版本键（standalone_057 裁决，RLS 关闭）';

-- ============================================================================
-- 9) 补充索引（NEST-521 DB 侧）：ewoh_resource_reservation org 维度索引，
--    与其他调度表 idx_xxx_org_* 口径一致。
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_reservation_org
  ON __EWOH_SCHEMA__.ewoh_resource_reservation (org_id);

-- ============================================================================
-- 10) 权限复核（幂等；057 未改变表授权集，仅确认 workbench 两表 + 15 表
--     service_role DML 可用——与 005/025/056 授权一致，重复 GRANT 无副作用）。
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.saved_views TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.workbench_export_tasks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_route_node TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_route_edge TO service_role;
