-- 080: 遥测佩戴人（ewoh_telemetry.worker_id）
--
-- 背景（NO-41a，2026-09-11）：
--
-- 外骨骼会话是**人工声明**的佩戴事实（谁戴了哪台）；而设备遥测里本来就有"当时是谁在戴"
-- 这一路的证据（边缘统一帧的 `worker_id`，能力台账 `observe.wearer` 的字段）。
-- 但平台的 `ExoskeletonFrameDto` 从未接收该字段，落库时被丢弃——于是：
--   · 世界模型只有一条"声明"，没有第二证据源，无法回答"他真的是本人戴的吗/他真的在戴吗"；
--   · 现场最常见的两类问题都无从发现：会话说 A 在戴、遥测显示是 B；会话还开着、
--     遥测显示设备早已无活动（人走了没收工）。
--
-- 本迁移只加一列 + 一个索引（不改任何既有语义）：
--   · `worker_id`：遥测帧里的佩戴人（原样保存；NULL = 该帧未上报佩戴人，
--     这是**数据缺口**，不是"没人戴"）；
--   · `(org_id, device_id, ts DESC)`：支撑"每台设备最近一帧"的查询
--     （既有索引是 (org_id, ts)，按设备过滤会退化成扫窗口）。

ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry
  ADD COLUMN IF NOT EXISTS worker_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_telemetry.worker_id IS
  '遥测上报的佩戴人（observe.wearer 的 worker_id）。NULL = 该帧未上报佩戴人（数据缺口），不等于"没人佩戴"。';

CREATE INDEX IF NOT EXISTS idx_ewoh_telemetry_org_device_ts
  ON __EWOH_SCHEMA__.ewoh_telemetry (org_id, device_id, ts DESC);
