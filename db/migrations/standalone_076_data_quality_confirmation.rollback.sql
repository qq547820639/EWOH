-- EWOH 数据质量人工确认回滚 (standalone_076)
-- 全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_data_quality_confirmation;
