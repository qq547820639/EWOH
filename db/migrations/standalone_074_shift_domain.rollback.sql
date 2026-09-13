-- EWOH 班次域回滚 (standalone_074)
-- 两张表均为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_shift_handover;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_shift;
