// andon-notifications.ts — 安灯通知创建共享助手（ADR-037/ADR-040/ADR-041，§31）。
//
// oee.openAndon / SLA 升级 / 超时未接手升级 / 重新开灯（NO-48a）与 ingest 边缘
// AndonRaised 投影共享同一通知创建语义：app 恒建 + lark 配置时建 + email 配置时建
// （未配置 = 渠道显式禁用，不建 doomed 行）；orgId 租户作用域（§15）；
// externalRef 指向 Andon 事件主事实（通知是派生事实）。
//
// NO-47a 起通知号是**确定性**的；NO-48a 起 id 里带上**桶 + 收件人**：
//   `NTF-ANDON-<安灯事件号清洗>-<桶>-<role|user>-<收件人清洗>-<渠道>`
// 三个理由：
//   1. **幂等**：重复上行/投影重放/重复扫描不会制造第二条同样的提醒；
//   2. **可分类**：治理度量按 id 约定识别提醒类型（随机 id 只能落进"其它"）；
//   3. **可多收件人**：升级要同时叫到调度、班组长、安全员——没有收件人段就会互相覆盖。
import {
  deterministicNotificationId,
  insertDeterministicNotifications,
  sanitizeNotificationSegment,
  type NotificationInsertExecutor,
} from './deterministic-notifications';

/**
 * 安灯提醒的桶（封闭词表）：
 *   · `raised` 开灯；
 *   · `sla_escalation` 接手晚了（有人接手，但超过 SLA 才接）；
 *   · `sla_breach_l1` / `sla_breach_l2` **没人接手**的超时升级（NO-48a，按 SLA 倍数分档）；
 *   · `reopened` 挂账后重新开灯（NO-48a：不能因为"关过一次"就静默）。
 */
export const ANDON_NOTIFICATION_BUCKETS = [
  'raised',
  'sla_escalation',
  'sla_breach_l1',
  'sla_breach_l2',
  'reopened',
] as const;
export type AndonNotificationBucket = (typeof ANDON_NOTIFICATION_BUCKETS)[number];

/**
 * 重开桶带**发生序号**：第 1 次 = `reopened`，第 N 次（N≥2）= `reopened-N`。
 *
 * 为什么桶不能恒为 `reopened`：通知号是幂等键（standalone_100 起唯一性收敛为
 * `(org_id, notification_id)` 复合 + ON CONFLICT DO NOTHING），同一安灯第二次重开若仍用 `reopened`，id 与第一次
 * 完全相同 → 插入被静默吞掉（只累加 duplicates）——第二次重开**没有任何人
 * 被告知**，恰恰复现 NO-48a 要消灭的"关过一次就静默"。序号取自 evidence
 * timeline 里 reopen 事实的累计次数：重放同一次转移得到同一序号（幂等保持），
 * 新一次重开得到新序号（必然落新行）。关灯处置仍按 `NTF-ANDON-<安灯号>-`
 * 前缀 + external_ref 双重限定，全部序号的提醒一并了结。
 */
export type AndonNotificationBucketValue = AndonNotificationBucket | `reopened-${number}`;

/** 由"本次重开是第几次"推导桶词表值（非正数/非法输入一律按第 1 次处理，不猜更高序号）。 */
export function andonReopenedBucket(reopenCount: number): AndonNotificationBucketValue {
  return Number.isFinite(reopenCount) && reopenCount >= 2 ? `reopened-${Math.floor(reopenCount)}` : 'reopened';
}

/** 清洗 id 片段（复用通用实现，保证各域身份规则一致）。 */
function sanitizeIdSegment(value: string): string {
  return sanitizeNotificationSegment(value, 80);
}

/** 安灯提醒的通知号前缀（处置侧据此把范围钉死到"这条安灯的提醒"）。 */
export function andonNotificationPrefix(eventId: string): string {
  return `NTF-ANDON-${sanitizeIdSegment(eventId)}-`;
}

/** 单个收件人的完整通知号（桶 + 收件人 + 渠道，确定性可幂等）。 */
export function andonNotificationId(params: {
  eventId: string;
  bucket: AndonNotificationBucketValue;
  recipientType: 'role' | 'user';
  recipientId: string;
  channel: string;
}): string {
  return deterministicNotificationId({
    prefix: andonNotificationPrefix(params.eventId),
    bucket: params.bucket,
    recipientType: params.recipientType,
    recipientId: params.recipientId,
    channel: params.channel,
  });
}

export interface AndonNotificationInput {
  /** 收件人（角色或点名到人）。 */
  recipients: Array<{ recipientType: 'role' | 'user'; recipientId: string }>;
  externalRef: string;
  title: string;
  body: string;
  severity: string;
  /** 桶：默认 `raised`（开灯）；重开传 `andonReopenedBucket(第几次)`（带发生序号）。 */
  bucket?: AndonNotificationBucketValue;
}

export interface AndonNotificationResult {
  created: number;
  duplicates: number;
  notificationIds: string[];
}

export async function insertAndonNotifications(
  db: NotificationInsertExecutor,
  orgId: string | null,
  input: AndonNotificationInput,
): Promise<AndonNotificationResult> {
  // 身份与幂等由通用实现统一负责（NO-53a 抽取）；本函数只提供安灯的前缀与桶。
  return insertDeterministicNotifications(db, {
    orgId,
    externalRef: input.externalRef,
    prefix: andonNotificationPrefix(input.externalRef),
    bucket: input.bucket ?? 'raised',
    recipients: input.recipients,
    title: input.title,
    body: input.body,
    severity: input.severity,
  });
}
