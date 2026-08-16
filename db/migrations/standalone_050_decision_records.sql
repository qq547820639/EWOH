-- ewoh_schedule_plan decision_records_json 列（standalone_050, ADR-048 / NO-12y / §3/§12/§18）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（§12 Decision History / §18 可解释性 / ADR-047 Canonical Decision Model）：
--   DecisionRecord（ADR-047 契约形态：Decision Catalog 8 类封闭注册表 + 判定事实
--   完整）随方案持久化——persistPlan 唯一投影点（ADR-048 决策 1）产出
--   decisionRecordsJson 列，决策历史自此有单一事实源（可检索/可链接/可解释）。
--   既有受管表原地加固：managed_count/physical_create_count 不变（73/76）。
--   旧行 NULL = 未投影（读回兼容，additive）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS decision_records_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.decision_records_json IS
  'Canonical DecisionRecord[]（ADR-047 契约形态；ADR-048 persistPlan 唯一投影点写入；决策历史单一事实源，§12/§18；NULL=存量未投影行）';
