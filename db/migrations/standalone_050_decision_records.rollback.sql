-- standalone_050_decision_records 回滚（列删除 = additive 列回撤）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚后回到 R-68 前水平（方案持久化不再携带 DecisionRecord；无行数据损失，
-- decision_records_json 列数据随列删除）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  DROP COLUMN IF EXISTS decision_records_json;
