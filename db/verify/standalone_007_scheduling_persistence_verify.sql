-- standalone_007_scheduling_persistence verify（审计 SQL-103 补齐，2026-08-17）。
-- Schema: __EWOH_SCHEMA__（runner substitute 注入 public）。
-- 断言 SchedulingPlanV2 / SchedulingAssignment 持久化元数据列已就位：
--   ewoh_schedule_plan：policy_version / solver_version / horizon_minutes / score_breakdown_json
--   ewoh_scheduling_plan_assignment：eta_seconds / distance_meters / risk_level / score_breakdown_json
-- 形态：DO 块自证 + 单行 standalone_007_verified（--verify-standalone-scheduling-persistence 断言 =1）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  v_plan_cols bigint;
  v_assignment_cols bigint;
BEGIN
  SELECT count(*) INTO v_plan_cols
    FROM information_schema.columns
   WHERE table_schema = '__EWOH_SCHEMA__' AND table_name = 'ewoh_schedule_plan'
     AND column_name IN ('policy_version', 'solver_version', 'horizon_minutes', 'score_breakdown_json');
  IF v_plan_cols <> 4 THEN
    RAISE EXCEPTION 'verify standalone_007: ewoh_schedule_plan 缺 V2 元数据列（期望 4 列，实际 %）', v_plan_cols;
  END IF;

  SELECT count(*) INTO v_assignment_cols
    FROM information_schema.columns
   WHERE table_schema = '__EWOH_SCHEMA__' AND table_name = 'ewoh_scheduling_plan_assignment'
     AND column_name IN ('eta_seconds', 'distance_meters', 'risk_level', 'score_breakdown_json');
  IF v_assignment_cols <> 4 THEN
    RAISE EXCEPTION 'verify standalone_007: ewoh_scheduling_plan_assignment 缺 V2 详情列（期望 4 列，实际 %）', v_assignment_cols;
  END IF;
END $$;

SELECT 1 AS standalone_007_verified;
