-- 087 rollback：移除运行记忆信号台账（表为全新 additive；索引/约束/RLS 策略随表级联）。
-- 注意：回滚会丢掉"人已经忽略/已转提案"的决定痕迹。生产回滚前应先导出
-- ewoh_learning_signal（signal_id/status/decided_*），否则审计链会断。

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_learning_signal;
