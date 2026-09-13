-- ============================================================================
-- standalone_100：确定性通知号的唯一键从**全局**收敛为 **org 内**（FR2 上游项）。
--
-- 背景：通知号是确定性的（NTF-<域>-<业务号>-<桶>-<收件人>-<渠道>，NO-47a/48a），
-- 但 business 段（externalRef，如安灯/会话的业务 id）只保证 **org 内**唯一；
-- notification_id 却被建了**全局** UNIQUE 约束。两个租户若产生相同 (域+业务号+
-- 桶+收件人+渠道)，第二家的 INSERT 被 ON CONFLICT DO NOTHING 静默吞掉——
-- **跨租户通知压制**，且 duplicates++ 把它伪装成幂等命中（原则 7/8 双违反）。
--
-- 修复：DROP 全局 UNIQUE **约束**（注意：是 CONSTRAINT，不能 DROP INDEX——
-- 其底层索引由约束持有，直接 DROP INDEX 会报 dependency 错误）；
-- 改 (org_id, notification_id) 复合唯一索引（org_id 自 standalone_057 起 NOT NULL，
-- 无需 NULL 归一；drizzle 调用点的 conflict target 同步为两列，见
-- deterministic-notifications.ts）。
--
-- 幂等语义：同 org 内同通知号仍被压（"重放不重发"）；跨 org 各自独立——
-- 通知是租户事实，幂等键本就该租户作用域。
-- ============================================================================

ALTER TABLE __EWOH_SCHEMA__.ewoh_notification
  DROP CONSTRAINT IF EXISTS ewoh_notification_notification_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_notification_org_notification_id
  ON __EWOH_SCHEMA__.ewoh_notification (org_id, notification_id);
