-- 081: 通知的"处置结果"（ewoh_notification 增加 resolution 四列 + 待处置索引）
--
-- 背景（NO-44a，2026-09-12）：
--
-- 通知是**派生事实**：`NTF-EXO-…-telemetry_wearer_mismatch…` 说的是"会话说 A 在戴、
-- 遥测说是 B，请核实"。NO-43a 之后，人已经能核实并把结论落成事实（收工 / 中止 /
-- 按实际佩戴人更正），但**提醒本身没有任何终态**：
--   · 现场处置完，通知仍挂在"未读"里 → 班组长每次打开都在看已经处理完的事（噪音）；
--   · 手工点"已读"只能表达"我看过了"，无法表达"这件事已经按某次处置关闭"；
--   · 事后审计无法回答"这条提醒最后是怎么了结的、谁了结的、依据哪次处置"。
--
-- 本迁移只加四列 + 一个部分索引（不改任何既有语义、不改 status 取值集合的既有含义）：
--   · `resolution`：处置类型（封闭词表：session_ended / session_aborted / session_corrected），
--     NULL = 未被处置关闭（仍可能是 pending / read / sent / failed）；
--   · `resolved_at` / `resolved_by`：谁在何时把它了结（人可追溯）；
--   · `resolution_ref`：处置指向的引用（更正时=新会话号；收工时=会话号），
--     用于从提醒反查那次处置；
--   · `idx_ewoh_notification_pending_external_ref`：部分索引（仅 pending 行），
--     支撑"按 external_ref 找出该主事实下所有待处置提醒"的更新（全表扫描会随
--     历史通知无限增长）。
--
-- 状态机（不新增 status 取值，只把"已处置"作为新终态值 'resolved'）：
--   pending → resolved（处置关闭；resolution 非空）
--   read    → 保持 read，但补写 resolution 四列（人已看过、之后事实也被处置了）
--   sent / failed（推送投递）→ **不动**：投递故障是运维事件，与业务处置无关。

ALTER TABLE __EWOH_SCHEMA__.ewoh_notification
  ADD COLUMN IF NOT EXISTS resolution varchar(50);

ALTER TABLE __EWOH_SCHEMA__.ewoh_notification
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz(3);

ALTER TABLE __EWOH_SCHEMA__.ewoh_notification
  ADD COLUMN IF NOT EXISTS resolved_by varchar(255);

ALTER TABLE __EWOH_SCHEMA__.ewoh_notification
  ADD COLUMN IF NOT EXISTS resolution_ref varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_notification.resolution IS
  '处置类型（封闭词表 session_ended/session_aborted/session_corrected）。NULL = 未被处置关闭。'
  '与 status=''read'' 的区别：read 表示"人看过了"，resolution 表示"这件事被某次处置了结"。';

CREATE INDEX IF NOT EXISTS idx_ewoh_notification_pending_external_ref
  ON __EWOH_SCHEMA__.ewoh_notification (org_id, external_ref)
  WHERE status = 'pending';
