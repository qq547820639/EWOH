-- standalone_049_agent_approval 回滚（表为全新，additive）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_agent_approval CASCADE;
