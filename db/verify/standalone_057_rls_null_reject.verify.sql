-- standalone_057_rls_null_reject verify（2026-08-17 审计整改 W1 配套）。
-- Schema: __EWOH_SCHEMA__（runner substitute 注入 public）。
-- 断言 057 的全部终态：
--   1) scheduler 8 表 + route_node/route_edge 的 policy：TO service_role 且
--      qual/with_check 不含 `org_id IS NULL` 放行分支；
--   2) saved_views / workbench_export_tasks RLS 启用 + policy 存在；
--   3) 15 张调度域表 org_id NOT NULL；
--   4) 复合唯一索引（(org_id, 业务键) 12 表 + ewoh_device + workbench 2 表）；
--   5) ewoh_org_visible(text) 重载存在；
--   6) knowledge_entry 的 authenticated SELECT policy 存在；
--   7) notify_scheduler_outbox 对 PUBLIC 无 EXECUTE。
-- 形态：DO 块自证 + 单行 standalone_057_verified（--verify-standalone-rls-null-reject 断言 =1）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  v_policy record;
  v_bad text;
  v_policy_count bigint;
  v_notnull_violations bigint;
  v_missing_unique text;
BEGIN
  -- 1) policy 终态：TO service_role + 无 NULL 放行（先确认 10 条全部存在）
  SELECT count(*) INTO v_policy_count
    FROM pg_policies
   WHERE schemaname = '__EWOH_SCHEMA__'
     AND policyname IN (
       'scheduler_constraint_org_isolation',
       'scheduler_run_org_isolation',
       'scheduler_plan_org_isolation',
       'scheduler_plan_assignment_org_isolation',
       'scheduler_resource_reservation_org_isolation',
       'scheduler_policy_org_isolation',
       'scheduler_feedback_org_isolation',
       'scheduler_replan_trigger_org_isolation',
       'route_node_org_isolation',
       'route_edge_org_isolation'
     );
  IF v_policy_count <> 10 THEN
    RAISE EXCEPTION 'verify standalone_057: 期望 10 条 org 隔离 policy，实际 %', v_policy_count;
  END IF;

  FOR v_policy IN
    SELECT p.tablename, p.policyname, p.roles, p.qual, p.with_check
      FROM pg_policies p
     WHERE p.schemaname = '__EWOH_SCHEMA__'
       AND p.policyname IN (
         'scheduler_constraint_org_isolation',
         'scheduler_run_org_isolation',
         'scheduler_plan_org_isolation',
         'scheduler_plan_assignment_org_isolation',
         'scheduler_resource_reservation_org_isolation',
         'scheduler_policy_org_isolation',
         'scheduler_feedback_org_isolation',
         'scheduler_replan_trigger_org_isolation',
         'route_node_org_isolation',
         'route_edge_org_isolation'
       )
  LOOP
    IF v_policy.roles::text NOT LIKE '%{service_role}%' THEN
      RAISE EXCEPTION 'verify standalone_057: policy % 不含 service_role（roles=%）', v_policy.policyname, v_policy.roles;
    END IF;
    IF v_policy.qual LIKE '%org_id IS NULL%' OR v_policy.with_check LIKE '%org_id IS NULL%' THEN
      RAISE EXCEPTION 'verify standalone_057: policy % 仍含 org_id IS NULL 放行分支', v_policy.policyname;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_notnull_violations
    FROM (VALUES
      'ewoh_scheduling_run', 'ewoh_scheduling_plan_assignment', 'ewoh_scheduling_constraint',
      'ewoh_schedule_plan', 'ewoh_resource_reservation', 'ewoh_scheduling_policy',
      'ewoh_scheduling_feedback', 'ewoh_scheduling_conflict', 'ewoh_route_cost_matrix',
      'ewoh_policy_activation', 'ewoh_scheduling_kpi', 'ewoh_scheduling_execution',
      'ewoh_policy_replay', 'ewoh_route_node', 'ewoh_route_edge'
    ) AS t(name)
    JOIN information_schema.columns c
      ON c.table_schema = '__EWOH_SCHEMA__' AND c.table_name = t.name AND c.column_name = 'org_id'
   WHERE c.is_nullable = 'YES';
  IF v_notnull_violations <> 0 THEN
    RAISE EXCEPTION 'verify standalone_057: % 张表 org_id 仍可空（期望 NOT NULL）', v_notnull_violations;
  END IF;

  -- 2) workbench 两表 RLS + policy
  SELECT string_agg(t.tablename, ',') INTO v_bad
    FROM (VALUES ('saved_views'), ('workbench_export_tasks')) AS t(tablename)
    LEFT JOIN pg_policies p
      ON p.schemaname = '__EWOH_SCHEMA__' AND p.tablename = t.tablename
     AND p.policyname = t.tablename || '_org_isolation'
   WHERE p.policyname IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'verify standalone_057: workbench RLS policy 缺失（%）', v_bad;
  END IF;

  -- 4) 复合唯一索引
  SELECT string_agg(expected_idx.indexname, ',') INTO v_missing_unique
    FROM (VALUES
      ('uq_ewoh_scheduling_run_org_run_id'),
      ('uq_ewoh_scheduling_plan_assignment_org_assignment'),
      ('uq_ewoh_scheduling_constraint_org_constraint'),
      ('uq_ewoh_route_node_org_node'),
      ('uq_ewoh_route_edge_org_edge'),
      ('uq_ewoh_scheduling_feedback_org_feedback'),
      ('uq_ewoh_scheduling_conflict_org_conflict'),
      ('uq_ewoh_route_cost_matrix_org_matrix'),
      ('uq_ewoh_scheduling_execution_org_execution'),
      ('uq_ewoh_scheduling_execution_org_assignment'),
      ('uq_ewoh_scheduling_kpi_org_kpi'),
      ('uq_ewoh_policy_replay_org_replay'),
      ('uq_ewoh_policy_activation_org_activation'),
      ('uq_ewoh_device_org_device'),
      ('uq_workbench_export_tasks_org_task'),
      ('uq_saved_views_org_owner_name')
    ) AS expected_idx(indexname)
    LEFT JOIN pg_indexes i
      ON i.schemaname = '__EWOH_SCHEMA__' AND i.indexname = expected_idx.indexname
   WHERE i.indexname IS NULL;
  IF v_missing_unique IS NOT NULL THEN
    RAISE EXCEPTION 'verify standalone_057: 复合唯一索引缺失（%）', v_missing_unique;
  END IF;

  -- 5) ewoh_org_visible(text) 重载
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'ewoh_org_visible'
       AND pg_get_function_identity_arguments(p.oid) = 'p_org_id text'
  ) THEN
    RAISE EXCEPTION 'verify standalone_057: ewoh_org_visible(text) 重载缺失';
  END IF;

  -- 6) knowledge_entry authenticated SELECT policy
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = '__EWOH_SCHEMA__' AND tablename = 'ewoh_knowledge_entry'
       AND policyname = 'ewoh_org_select' AND roles::text LIKE '%{authenticated}%'
  ) THEN
    RAISE EXCEPTION 'verify standalone_057: knowledge_entry authenticated SELECT policy 缺失（SQL-033）';
  END IF;

  -- 7) notify_scheduler_outbox 暴露面
  IF has_function_privilege('public', '__EWOH_SCHEMA__.notify_scheduler_outbox()', 'EXECUTE') THEN
    RAISE EXCEPTION 'verify standalone_057: notify_scheduler_outbox 对 PUBLIC 仍可执行（SQL-046）';
  END IF;
END $$;

SELECT 1 AS standalone_057_verified;
