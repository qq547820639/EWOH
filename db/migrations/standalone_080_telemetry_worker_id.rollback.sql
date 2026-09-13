-- 080 rollback：移除遥测佩戴人列与配套索引。
--
-- 回滚即放弃"遥测作为佩戴第二证据源"的能力（会话与提醒不受影响，
-- 只是交叉校验退化为"无遥测佐证"）。既有遥测数据本身保留。

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_telemetry_org_device_ts;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry DROP COLUMN IF EXISTS worker_id;
