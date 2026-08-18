// channel-dispatcher.service.ts — 通知推送渠道派发器（R-58/ADR-037 + R-62/ADR-041，§17/§20）。
//
// Andon Loop 推送腿：把 ewoh_notification 中 channel ∈ PUSH_CHANNELS 的
// 待发通知派发到飞书自定义机器人 webhook（纯 HTTPS POST）与邮件
// （标准库 SMTP 客户端，R-62）——均无新依赖。
//
// 语义边界（§33/§20 对齐）：
// - 封闭渠道注册表 PUSH_CHANNELS=['lark','email']——只注册有真实投递
//   实现的渠道；
// - 渠道未配置（webhook 空 / SMTP host/from/to 缺一）→ 该渠道显式禁用
//   （log + 不建 doomed 行），绝不静默假装投递；
// - 投递状态落在权威通知行：pending → sent（sentAt）/ failed（errorMessage）；
//   CAS 更新（WHERE status='pending' RETURNING）防多实例重复投递；
// - 失败显式留痕、绝不吞异常；人工重试走 POST /api/notifications/:id/retry。
import { Injectable, Inject, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import { ewohNotification } from '@server/database/schema';
import { RequestDatabaseContext } from '../../database/request-database-context';
import {
  buildEmailMessage,
  emailConfig,
  isEmailPushEnabled,
  sendEmail,
  type EmailConfig,
  type EmailMessage,
  type SmtpConnector,
} from './email-transport';

/** 封闭推送渠道注册表（lark=飞书 webhook；email=SMTP，均真实投递）。 */
export const PUSH_CHANNELS = ['lark', 'email'] as const;
export type PushChannel = (typeof PUSH_CHANNELS)[number];

export const DEFAULT_DISPATCH_INTERVAL_MS = 15_000;
export const DEFAULT_DISPATCH_BATCH = 50;
export const DISPATCH_TIMEOUT_MS = 5_000;

export interface LarkMessage {
  msg_type: 'text';
  content: { text: string };
}

/** 投递传输（可注入测试双；生产默认 = 真实 fetch POST）。 */
export interface LarkTransport {
  (message: LarkMessage, url: string): Promise<void>;
}

/** 飞书自定义机器人 webhook 地址（未配置 → null = 渠道显式禁用）。 */
export function larkWebhookUrl(): string | null {
  const raw = (process.env.EWOH_LARK_WEBHOOK_URL ?? '').trim();
  return raw === '' ? null : raw;
}

export function isLarkPushEnabled(): boolean {
  return larkWebhookUrl() != null;
}

/** 渠道启用判定（未配置 = 显式禁用；绝不在派发期建 doomed 行）。 */
export function isChannelEnabled(channel: string): boolean {
  if (channel === 'lark') return isLarkPushEnabled();
  if (channel === 'email') return isEmailPushEnabled();
  return false;
}

export function dispatchIntervalMs(): number {
  const raw = Number((process.env.EWOH_NOTIFICATION_DISPATCH_INTERVAL_MS ?? '').trim());
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_DISPATCH_INTERVAL_MS;
}

export interface NotificationLike {
  notificationId: string;
  title: string;
  body: string | null;
  severity: string;
  externalRef: string | null;
  deviceId?: string | null;
}

/** 飞书消息体（纯函数，node 可测）：安灯/通知事实渲染，无 LLM 编造。 */
export function buildLarkMessage(notification: NotificationLike): LarkMessage {
  const lines = [`【EWOH 通知】${notification.title}`];
  if (notification.deviceId) lines.push(`设备：${notification.deviceId}`);
  lines.push(`严重度：${notification.severity}`);
  if (notification.body) lines.push(notification.body);
  if (notification.externalRef) lines.push(`关联：${notification.externalRef}`);
  return { msg_type: 'text', content: { text: lines.join('\n') } };
}

/** 生产默认传输：真实 HTTPS POST（超时 5s；非 2xx → 显式抛错）。 */
export const realLarkTransport: LarkTransport = async (message, url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`lark_webhook_http_${res.status}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`lark_webhook_timeout_${DISPATCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export interface DispatchSummary {
  claimed: number;
  sent: number;
  failed: number;
}

/**
 * 通知推送派发器：定时领取 channel ∈ PUSH_CHANNELS 且 status='pending'
 * 且已到 scheduledAt 的通知 → 投递 → CAS 写回 sent/failed。
 */
@Injectable()
export class ChannelDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChannelDispatcherService.name);
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private readonly larkTransport: LarkTransport;
  private readonly emailSender: (
    config: EmailConfig,
    message: EmailMessage,
  ) => Promise<void>;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Optional() transport?: LarkTransport,
    @Optional() emailConnector?: SmtpConnector,
    /** P1-GUC（2026-08-19 审计）：定时器回调无 ALS store → 根句柄无 GUC。 */
    @Optional() private readonly requestDatabaseContext?: RequestDatabaseContext,
  ) {
    this.larkTransport = transport ?? realLarkTransport;
    this.emailSender = (config, message) =>
      emailConnector
        ? sendEmail(config, message, emailConnector)
        : sendEmail(config, message);
  }

  onModuleInit(): void {
    const enabled = PUSH_CHANNELS.filter((channel) => isChannelEnabled(channel));
    if (enabled.length === 0) {
      this.logger.log('push channels disabled（lark/email 均未配置，渠道显式关闭）');
      return;
    }
    const intervalMs = dispatchIntervalMs();
    this.logger.log(`notification channel dispatcher started（channels=${enabled.join(',')} interval=${intervalMs}ms）`);
    this.timer = setInterval(() => {
      void this.dispatchPending().catch((error) => {
        this.logger.warn(`dispatch tick failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async dispatchPending(batch: number = DEFAULT_DISPATCH_BATCH): Promise<DispatchSummary> {
    if (this.dispatching) {
      return { claimed: 0, sent: 0, failed: 0 }; // 单实例内防重叠
    }
    const enabledChannels = PUSH_CHANNELS.filter((channel) => isChannelEnabled(channel));
    if (enabledChannels.length === 0) {
      this.logger.debug('push channels disabled，跳过派发');
      return { claimed: 0, sent: 0, failed: 0 };
    }
    this.dispatching = true;
    try {
      // P1-GUC（2026-08-19 审计）：本方法由 setInterval 定时器触发（无请求
      // ALS store）——`this.db` 回落根句柄且无 GUC，而 ewoh_notification 有
      // RLS（ewoh_service_all: USING ewoh_org_visible(org_id)），无 GUC 时
      // 恒 false → 查询静默读空 → 全部租户通知永不派发。派发器是必须跨 org
      // 读写的可信系统设施：每条 DB 语句经 systemGlobalAdminTransaction 显式
      // 建立全局管理员上下文（app.is_global_admin='true' 使 ewoh_org_visible
      // 对所有 org 返回 true——与 DB 全局行判定同一 idiom）。事务只包 DB 语句
      // （HTTP 投递在事务外），批量 50×5s 的外呼不再占用池连接。
      const rows = await this.withGuc(() => this.claimPending(enabledChannels, batch));
      const summary: DispatchSummary = { claimed: rows.length, sent: 0, failed: 0 };
      for (const row of rows) {
        // NEST-643（2026-08-17 审计裁决，文档化）：NotificationLike 支持
        // deviceId 字段（buildLarkMessage/buildEmailMessage 均渲染「设备：X」），
        // 但 ewoh_notification 无 device_id 列——deviceId 无法从台账行透传，
        // 设备信息目前仅存在于 body 文案（如「设备 X 安灯已开」）。补列属
        // DB 迁移域（db/migrations，W1 归属）；列落地后此处仅需
        // `deviceId: row.deviceId` 一行接线。
        const notification = {
          notificationId: row.notificationId,
          title: row.title,
          body: row.body,
          severity: row.severity,
          externalRef: row.externalRef,
        };
        try {
          if (row.channel === 'lark') {
            const url = larkWebhookUrl();
            if (!url) throw new Error('lark_webhook_not_configured');
            await this.larkTransport(buildLarkMessage(notification), url);
          } else if (row.channel === 'email') {
            const config = emailConfig();
            if (!config) throw new Error('email_not_configured');
            await this.emailSender(config, buildEmailMessage(notification, config));
          } else {
            throw new Error(`unknown_push_channel:${row.channel}`);
          }
          const updated = await this.withGuc(() => this.casMarkStatus(row.notificationId, {
            status: 'sent',
            sentAt: new Date(),
            errorMessage: null,
          }));
          if (updated) summary.sent += 1; // CAS 未命中 = 他实例已投递，跳过（幂等）
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.warn(`push dispatch failed ${row.channel} ${row.notificationId}: ${reason}`);
          const updated = await this.withGuc(() => this.casMarkStatus(row.notificationId, {
            status: 'failed',
            errorMessage: reason,
          }));
          if (updated) summary.failed += 1;
        }
      }
      return summary;
    } finally {
      this.dispatching = false;
    }
  }

  /** DB 操作经全局管理员 GUC 事务执行（无 RequestDatabaseContext 的测试环境直通）。 */
  private withGuc<T>(op: () => Promise<T>): Promise<T> {
    if (!this.requestDatabaseContext) return op();
    return this.requestDatabaseContext.systemGlobalAdminTransaction(op);
  }

  private claimPending(
    enabledChannels: readonly PushChannel[],
    batch: number,
  ) {
    return this.db
      .select()
      .from(ewohNotification)
      .where(
        and(
          inArray(ewohNotification.channel, enabledChannels as readonly string[]),
          eq(ewohNotification.status, 'pending'),
          or(isNull(ewohNotification.scheduledAt), lte(ewohNotification.scheduledAt, new Date())),
        ),
      )
      .orderBy(asc(ewohNotification.createdAt))
      .limit(batch);
  }

  /** CAS 写回（WHERE status='pending' RETURNING；未命中 = 他实例已处理）。 */
  private async casMarkStatus(
    notificationId: string,
    patch: { status: 'sent' | 'failed'; sentAt?: Date; errorMessage?: string | null },
  ): Promise<boolean> {
    const values: Record<string, unknown> = { status: patch.status, updatedAt: new Date() };
    if (patch.sentAt != null) values.sentAt = patch.sentAt;
    if (patch.errorMessage !== undefined) values.errorMessage = patch.errorMessage;
    const [updated] = await this.db
      .update(ewohNotification)
      .set(values as never)
      .where(
        and(
          eq(ewohNotification.notificationId, notificationId),
          eq(ewohNotification.status, 'pending'),
        ),
      )
      .returning();
    return updated != null;
  }
}
