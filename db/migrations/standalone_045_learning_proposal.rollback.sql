-- standalone_045_learning_proposal 回滚（表为全新，additive）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- 回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
-- 回滚后提案写入将失败（服务层 fail-closed 拒绝，不影响评估主契约）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_learning_proposal CASCADE;
