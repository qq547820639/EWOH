-- EWOH 复盘/运行记忆回滚 (standalone_075)
-- 全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_retrospective;
