/**
 * deterministic-notifications.ts — 确定性通知写入的**单一实现**（NO-53a 抽取）。
 *
 * 为什么抽出来：通知号是**幂等键**（重复扫描/重放只提醒一次），而"桶 + 收件人 + 渠道"
 * 三段式身份已经在外骨骼会话（NO-37a）、安灯（NO-47a）、数据质量（NO-53a）三处重复。
 * 三处各写一遍必然会漂移（前缀不同、收件人段漏了、渠道策略不一致），
 * 因此收敛到这里；各域只提供**前缀与桶词表**。
 *
 * 身份格式：`<prefix><bucket>-<role|user>-<收件人清洗>-<渠道>`
 *   · prefix 由各域给出（如 `NTF-ANDON-<安灯号>-`、`NTF-DQ-<告警号>-`）；
 *   · 收件人进身份：同一桶对不同人各发一条，互不覆盖；
 *   · 渠道进身份：app 恒发，lark/email 仅在已配置时发（未配置 = 渠道显式禁用）。
 */
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ewohNotification } from '@server/database/schema';
import { isLarkPushEnabled } from './channel-dispatcher.service';
import { isEmailPushEnabled } from './email-transport';

export type NotificationInsertExecutor = Pick<PostgresJsDatabase, 'insert'>;

/** 通知号片段清洗：只允许 `[A-Za-z0-9_.-]`（身份的一部分，脏字符不进幂等键）。 */
export function sanitizeNotificationSegment(value: string, maxLength = 80): string {
  return String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, maxLength);
}

/** 本实例启用的渠道（app 恒发；推送渠道按配置显式开关）。 */
export function enabledNotificationChannels(): string[] {
  const channels = ['app'];
  if (isLarkPushEnabled()) channels.push('lark');
  if (isEmailPushEnabled()) channels.push('email');
  return channels;
}

export function deterministicNotificationId(params: {
  prefix: string;
  bucket: string;
  recipientType: 'role' | 'user';
  recipientId: string;
  channel: string;
}): string {
  const recipient = `${params.recipientType}-${sanitizeNotificationSegment(params.recipientId, 40)}`;
  return `${params.prefix}${params.bucket}-${recipient}-${params.channel}`.slice(0, 250);
}

export interface DeterministicNotificationInput {
  orgId: string | null;
  /** 主事实引用（安灯号 / 数据质量告警号…）：处置侧按它定位"这条事实的提醒"。 */
  externalRef: string;
  /** 通知号前缀（含主事实标识），由各域提供。 */
  prefix: string;
  /** 桶（封闭词表由各域维护）。 */
  bucket: string;
  recipients: Array<{ recipientType: 'role' | 'user'; recipientId: string }>;
  title: string;
  body: string;
  severity: string;
}

export interface DeterministicNotificationResult {
  created: number;
  duplicates: number;
  notificationIds: string[];
}

/**
 * 按（主事实 + 桶 + 收件人 + 渠道）幂等写入；重复调用只累加 duplicates。
 * 可在调用方事务里执行（传 tx 作为 executor）。
 */
export async function insertDeterministicNotifications(
  db: NotificationInsertExecutor,
  input: DeterministicNotificationInput,
): Promise<DeterministicNotificationResult> {
  const result: DeterministicNotificationResult = { created: 0, duplicates: 0, notificationIds: [] };
  for (const recipient of input.recipients) {
    for (const channel of enabledNotificationChannels()) {
      const notificationId = deterministicNotificationId({
        prefix: input.prefix,
        bucket: input.bucket,
        recipientType: recipient.recipientType,
        recipientId: recipient.recipientId,
        channel,
      });
      const inserted = await db
        .insert(ewohNotification)
        .values({
          orgId: input.orgId,
          recipientType: recipient.recipientType,
          recipientId: recipient.recipientId,
          title: input.title,
          body: input.body,
          severity: input.severity,
          status: 'pending',
          externalRef: input.externalRef,
          channel,
          notificationId,
        })
        .onConflictDoNothing({
          // standalone_100：唯一性收敛为 (org_id, notification_id)——target 必须与
          // 仲裁索引**逐列一致**，否则 PG 报"没有匹配的 unique 约束"（实测事故）。
          target: [ewohNotification.orgId, ewohNotification.notificationId],
        })
        .returning({ notificationId: ewohNotification.notificationId });
      const wasCreated = Array.isArray(inserted) ? inserted.length > 0 : Boolean(inserted);
      if (wasCreated) result.created += 1;
      else result.duplicates += 1;
      result.notificationIds.push(notificationId);
    }
  }
  return result;
}
