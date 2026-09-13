-- 088 rollback：移除改进行动项台账（表为全新 additive；索引/约束/RLS 策略随表级联）。
-- 注意：回滚会丢掉"谁负责/是否完成/为什么放弃"的决定痕迹。生产回滚前应先导出
-- ewoh_improvement_action（action_id/status/owner/due_at/completed_*/decided_*）。

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_improvement_action;
