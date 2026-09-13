-- 089 rollback：移除多模态感知融合快照表（表为全新 additive；索引/约束/RLS 策略随表级联）。
-- 注意：回滚会丢掉"当时系统看到的是什么、可信吗"的历史快照（复盘与审计会失去这段记忆）。
-- 生产回滚前应先导出 ewoh_perception_fusion（fusion_id/subject_id/fused_at/record_json）。

DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_perception_fusion;
