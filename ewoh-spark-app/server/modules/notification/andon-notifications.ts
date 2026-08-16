// andon-notifications.ts — 安灯通知创建共享助手（ADR-037/ADR-040/ADR-041，§31）。
//
// oee.openAndon/SLA 升级（云侧触发）与 ingest 边缘 AndonRaised 投影
// 共享同一通知创建语义：app 恒建 + lark 配置时建 + email 配置时建
// （未配置 = 渠道显式禁用，不建 doomed 行）；orgId 租户作用域（§15）；
// externalRef 指向 Andon 事件主事实（通知是派生事实）。
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { randomUUID } from 'node:crypto';
import { ewohNotification } from '@server/database/schema';
import { isLarkPushEnabled } from './channel-dispatcher.service';
import { isEmailPushEnabled } from './email-transport';

export interface AndonNotificationInput {
  recipientId: string;
  externalRef: string;
  title: string;
  body: string;
  severity: string;
}

export async function insertAndonNotifications(
  db: PostgresJsDatabase,
  orgId: string | null,
  input: AndonNotificationInput,
): Promise<void> {
  const base = {
    orgId,
    recipientType: 'role',
    recipientId: input.recipientId,
    title: input.title,
    body: input.body,
    severity: input.severity,
    status: 'pending',
    externalRef: input.externalRef,
  };
  await db.insert(ewohNotification).values({
    ...base,
    notificationId: `NTF-${randomUUID().slice(0, 8)}`,
    channel: 'app',
  });
  if (isLarkPushEnabled()) {
    await db.insert(ewohNotification).values({
      ...base,
      notificationId: `NTF-${randomUUID().slice(0, 8)}`,
      channel: 'lark',
    });
  }
  if (isEmailPushEnabled()) {
    await db.insert(ewohNotification).values({
      ...base,
      notificationId: `NTF-${randomUUID().slice(0, 8)}`,
      channel: 'email',
    });
  }
}
