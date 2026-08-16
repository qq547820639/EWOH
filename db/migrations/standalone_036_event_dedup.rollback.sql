-- standalone_036_event_dedup 回滚（全新表 additive：DROP TABLE 即回滚，
-- 索引/约束/RLS 策略随表级联删除）。
-- 注意：回滚后 Edge 事件上行写入将失败（fail-closed，不静默降级为不去重直写）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_ingest_event_dedup;
