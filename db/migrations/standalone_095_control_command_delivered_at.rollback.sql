-- 095 rollback：移除"已交付网关"时刻列（additive；回滚前应先导出 delivered_at）。

DROP INDEX IF EXISTS __EWOH_SCHEMA__.idx_ewoh_control_command_delivered;

ALTER TABLE __EWOH_SCHEMA__.ewoh_control_command
  DROP COLUMN IF EXISTS delivered_at;
