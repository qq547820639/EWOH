-- EWOH 2026-09-01 — 审批独立性数据地基（standalone_069，B5 / 决策单 D-3）
-- 给 ewoh_schedule_plan 增加 created_by（方案生成操作者）。
-- 背景：审批独立性核实（DR-2026-09-01）确认「自批」是结构性必然——
-- 表中只有 confirmed_by（审批人），无生成人字段，回避校验无从执行。
-- 本迁移补齐数据地基；生成路径写入与 approvePlanV2 回避校验由应用层配合落地。
-- 幂等：DO 块按列存在性守卫，重复执行无副作用。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'created_by'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
      ADD COLUMN created_by varchar(255);
  END IF;
END $$;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.created_by IS
  '方案生成操作者（2026-09-01 B5 审批独立性治理；NULL=存量/legacy 行，回避校验对 NULL 放行）';
