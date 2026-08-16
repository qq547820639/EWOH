-- standalone_035_work_order 回滚（全新表 additive：DROP TABLE 即回滚，
-- 索引/约束/RLS 策略随表级联删除）。
-- 注意：此表由 NO-05e-b 引入，无存量数据依赖；回滚后 WorkOrder 模块
-- 写入将失败（fail-closed，不静默降级）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_work_order;
