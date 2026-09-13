-- 081 rollback：移除通知的处置结果列与待处置部分索引。
--
-- 回滚即回到"通知只有 pending/read/sent/failed"的旧语义：已经写入的处置结果
-- （谁在何时因哪次处置关闭了哪条提醒）会丢失，因此**已上线环境不建议回滚**；
-- 通知本身（含 title/body/status/read_at）与业务事实不受影响。

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_notification_pending_external_ref;

ALTER TABLE __EWOH_SCHEMA__.ewoh_notification DROP COLUMN IF EXISTS resolution_ref;
ALTER TABLE __EWOH_SCHEMA__.ewoh_notification DROP COLUMN IF EXISTS resolved_by;
ALTER TABLE __EWOH_SCHEMA__.ewoh_notification DROP COLUMN IF EXISTS resolved_at;
ALTER TABLE __EWOH_SCHEMA__.ewoh_notification DROP COLUMN IF EXISTS resolution;
