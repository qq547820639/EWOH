-- standalone_025_scheduler_rls 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（Task 1）：
--   8 张 org-scoped 调度表 relrowsecurity = true（RLS 启用）
--   8 条 policy 存在（scheduler_<table>_org_isolation，与 023 命名风格一致）
--   每条 policy 定义文本（USING/WITH CHECK）含 'app.current_org_id'（GUC 名修复生效）
--   ewoh_schedule_plan.org_id 列存在（025 补齐）
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言（runner 使用 >= 计数判定）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  rls_enabled integer := 0;
  policy_count integer := 0;
  policy_guc integer := 0;
  plan_org_col integer := 0;
BEGIN
  -- 1) 8 张 org-scoped 表全部 ENABLE ROW LEVEL SECURITY
  SELECT count(*) INTO rls_enabled FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname IN (
        'ewoh_scheduling_run','ewoh_schedule_plan','ewoh_scheduling_plan_assignment',
        'ewoh_resource_reservation','ewoh_scheduling_policy','ewoh_scheduling_feedback',
        'ewoh_replan_trigger','ewoh_scheduling_constraint'
      )
      AND c.relrowsecurity;
  IF rls_enabled <> 8 THEN
    missing := missing || format('rls_enabled=%s ', rls_enabled);
  END IF;

  -- 2) 8 条 policy 存在
  SELECT count(*) INTO policy_count FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename IN (
        'ewoh_scheduling_run','ewoh_schedule_plan','ewoh_scheduling_plan_assignment',
        'ewoh_resource_reservation','ewoh_scheduling_policy','ewoh_scheduling_feedback',
        'ewoh_replan_trigger','ewoh_scheduling_constraint'
      )
      AND policyname IN (
        'scheduler_run_org_isolation','scheduler_plan_org_isolation',
        'scheduler_plan_assignment_org_isolation','scheduler_resource_reservation_org_isolation',
        'scheduler_policy_org_isolation','scheduler_feedback_org_isolation',
        'scheduler_replan_trigger_org_isolation','scheduler_constraint_org_isolation'
      );
  IF policy_count <> 8 THEN
    missing := missing || format('policy_count=%s ', policy_count);
  END IF;

  -- 3) 每条 policy 定义文本含 app.current_org_id（GUC 修复生效）
  SELECT count(*) INTO policy_guc FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename IN (
        'ewoh_scheduling_run','ewoh_schedule_plan','ewoh_scheduling_plan_assignment',
        'ewoh_resource_reservation','ewoh_scheduling_policy','ewoh_scheduling_feedback',
        'ewoh_replan_trigger','ewoh_scheduling_constraint'
      )
      AND policyname IN (
        'scheduler_run_org_isolation','scheduler_plan_org_isolation',
        'scheduler_plan_assignment_org_isolation','scheduler_resource_reservation_org_isolation',
        'scheduler_policy_org_isolation','scheduler_feedback_org_isolation',
        'scheduler_replan_trigger_org_isolation','scheduler_constraint_org_isolation'
      )
      AND (
        qual::text LIKE '%app.current_org_id%'
        OR with_check::text LIKE '%app.current_org_id%'
      );
  IF policy_guc <> 8 THEN
    missing := missing || format('policy_guc=%s ', policy_guc);
  END IF;

  -- 4) ewoh_schedule_plan.org_id 列存在（025 补齐）
  SELECT count(*) INTO plan_org_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'org_id';
  IF plan_org_col <> 1 THEN
    missing := missing || format('plan_org_col=%s ', plan_org_col);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '025 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '025 verify OK: rls_enabled=8 policies=8 policy_guc=8 plan_org_col=1';
END $$;

SELECT
  (SELECT count(*) FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname IN (
         'ewoh_scheduling_run','ewoh_schedule_plan','ewoh_scheduling_plan_assignment',
         'ewoh_resource_reservation','ewoh_scheduling_policy','ewoh_scheduling_feedback',
         'ewoh_replan_trigger','ewoh_scheduling_constraint'
       )
       AND c.relrowsecurity
  ) AS rls_enabled,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename IN (
         'ewoh_scheduling_run','ewoh_schedule_plan','ewoh_scheduling_plan_assignment',
         'ewoh_resource_reservation','ewoh_scheduling_policy','ewoh_scheduling_feedback',
         'ewoh_replan_trigger','ewoh_scheduling_constraint'
       )
       AND policyname IN (
         'scheduler_run_org_isolation','scheduler_plan_org_isolation',
         'scheduler_plan_assignment_org_isolation','scheduler_resource_reservation_org_isolation',
         'scheduler_policy_org_isolation','scheduler_feedback_org_isolation',
         'scheduler_replan_trigger_org_isolation','scheduler_constraint_org_isolation'
       )
  ) AS policy_count,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename IN (
         'ewoh_scheduling_run','ewoh_schedule_plan','ewoh_scheduling_plan_assignment',
         'ewoh_resource_reservation','ewoh_scheduling_policy','ewoh_scheduling_feedback',
         'ewoh_replan_trigger','ewoh_scheduling_constraint'
       )
       AND policyname IN (
         'scheduler_run_org_isolation','scheduler_plan_org_isolation',
         'scheduler_plan_assignment_org_isolation','scheduler_resource_reservation_org_isolation',
         'scheduler_policy_org_isolation','scheduler_feedback_org_isolation',
         'scheduler_replan_trigger_org_isolation','scheduler_constraint_org_isolation'
       )
       AND (
         qual::text LIKE '%app.current_org_id%'
         OR with_check::text LIKE '%app.current_org_id%'
       )
  ) AS policy_guc,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan'
       AND column_name = 'org_id'
  ) AS plan_org_col;
