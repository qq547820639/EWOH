-- standalone_052_agent_approval_decision 回滚（列删除 = additive 列回撤）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚后回到 R-79 前水平（审批解析不再携带 DecisionRecord 留痕；
-- decision_json 列数据随列删除，无其余行数据损失）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_agent_approval
  DROP COLUMN IF EXISTS decision_json;
