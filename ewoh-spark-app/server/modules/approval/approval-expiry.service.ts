import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, gt, sql } from 'drizzle-orm';
import { ewohEvent, ewohNotification } from '@server/database/schema';
import { ApprovalPersistenceService } from './approval-persistence.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { isLarkPushEnabled } from '../notification/channel-dispatcher.service';
import { isEmailPushEnabled } from '../notification/email-transport';
import { resolveNotificationsFor } from '../notification/notification-resolution.link';

/**
 * 执行边界授权的**到期主动提醒**（NO-30a）。
 *
 * 为什么需要它：NO-22a 给授权加了 24 小时有效期，NO-24a 让它在审批台可见——
 * 但那都是**被动**的：没人打开审批台，就不会有人知道"这张授权 40 分钟后失效"，
 * 现场执行时才撞 409。这一类"到期即失效的凭证"必须主动提醒（原则 5/6）。
 *
 * 语义：
 *   · 窗口：剩余有效期 ≤ 2 小时 → `expiring`；已过期但过期时间在 24 小时内 → `expired`；
 *   · 收件人：`safety_admin`（有权重新审批的角色）；正文写明发起人、能力、覆盖设备、
 *     剩余时间与审批号，便于立刻处理；
 *   · **幂等**：通知 id 由 (审批号, 桶) 确定性推导（`NTF-EXPR-<approval>-<bucket>`），
 *     靠 `notification_id` 唯一约束 + `ON CONFLICT DO NOTHING` 保证"同一次到期只提醒一次"
 *     （不是先查后写，没有竞态窗口）；
 *   · 渠道：app 恒发；lark/email 仅在已配置时发（未配置 = 渠道禁用，不写 doomed 行）；
 *   · 扫描是只读的：提醒不改变授权状态，也不代替人重新审批。
 */

/** 剩余有效期 ≤ 该值即提醒（2 小时：足够现场重新申请）。 */
export const EXPIRY_WARN_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 已过期后仍提醒的时间窗（24 小时：避免过期提醒变成永久噪音）。 */
export const EXPIRY_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ExpirySweepResult {
  orgId: string;
  scanned: number;
  expiringSoon: number;
  expired: number;
  created: number;
  duplicates: number;
  /**
   * NO-45a：本次因"授权已失效"而关闭的**催办**提醒条数（`expiring` 桶）。
   *
   * 为什么关掉它：那条提醒说的是"即将失效，请尽快处理"，授权一旦真的失效，
   * 它的前提就消失了——继续挂着只会让人反复看到一条已经无法执行的催促。
   * "已失效，请重新申请"由 `expired` 桶承载，**保持待办**（那是需要人做的决定）。
   */
  resolved: number;
  notifications: Array<{ approvalId: string; bucket: 'expiring' | 'expired'; notificationId: string; created: boolean }>;
  generatedAt: string;
}

@Injectable()
export class ApprovalExpiryService {
  private readonly logger = new Logger(ApprovalExpiryService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly approvals: ApprovalPersistenceService,
  ) {}

  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException('org 上下文缺失：授权到期扫描必须带租户上下文');
    }
    return orgId;
  }

  /** 单个租户的到期扫描（幂等；可重复调用）。 */
  async sweep(actor: OrgContext | undefined, options: { now?: Date } = {}): Promise<ExpirySweepResult> {
    const orgId = this.requireOrgId(actor);
    const now = options.now ?? new Date();
    const authorizations = await this.approvals.listCapabilityAuthorizations(orgId);
    const notifications: ExpirySweepResult['notifications'] = [];
    let expiringSoon = 0;
    let expired = 0;
    let created = 0;
    let duplicates = 0;
    let resolved = 0;

    for (const authorization of authorizations) {
      if (authorization.status !== 'approved' || !authorization.expiresAt) continue;
      const expiresMs = Date.parse(authorization.expiresAt);
      if (!Number.isFinite(expiresMs)) continue;
      const remainingMs = expiresMs - now.getTime();
      let bucket: 'expiring' | 'expired' | null = null;
      if (remainingMs > 0 && remainingMs <= EXPIRY_WARN_WINDOW_MS) bucket = 'expiring';
      else if (remainingMs <= 0 && now.getTime() - expiresMs <= EXPIRY_RETENTION_MS) bucket = 'expired';
      if (!bucket) continue;
      if (bucket === 'expiring') expiringSoon += 1;
      else expired += 1;

      const metrics = authorization.subject?.metrics ?? {};
      const capability =
        metrics.capabilityKey ?? authorization.subject?.objectId ?? authorization.entityId;
      const scope = metrics.deviceIds
        ? `覆盖 ${String(metrics.deviceIds).split(',').length} 台设备（${metrics.deviceIds}）`
        : metrics.relaxedHighRiskCapabilities
          ? `放宽 ${metrics.relaxedHighRiskCapabilities}`
          : '范围未记录';
      const hours = Math.max(0, Math.round(remainingMs / 3_600_000));
      const minutes = Math.max(0, Math.round(remainingMs / 60_000));
      const remainingText =
        bucket === 'expiring'
          ? remainingMs >= 3_600_000
            ? `剩余约 ${hours} 小时`
            : `剩余约 ${minutes} 分钟`
          : `已于 ${new Date(expiresMs).toLocaleString('zh-CN')} 失效`;
      const title =
        bucket === 'expiring'
          ? `执行边界授权即将失效：${capability}`
          : `执行边界授权已失效：${capability}`;
      const body =
        `${remainingText}｜审批号 ${authorization.approvalId}｜${scope}` +
        `｜发起人 ${authorization.createdBy ?? '未记录'}` +
        `｜已消耗 ${authorization.usage.length} 个对象` +
        (bucket === 'expiring'
          ? '｜如需在有效期内执行，请尽快处理；否则需重新申请审批'
          : '｜该授权已不可用：如需执行请重新申请审批');

      // 收件人：安全管理员（有权重新审批）+ **发起人本人**（正在等这张授权的人）。
      // 不能只发角色通知：发起人往往不是 safety_admin，等在现场却收不到任何提醒（NO-32a）。
      const recipients: Array<{ recipientType: 'role' | 'user'; recipientId: string }> = [
        { recipientType: 'role', recipientId: 'safety_admin' },
      ];
      const requester = (authorization.createdBy ?? '').trim();
      if (requester && requester !== 'system') {
        recipients.push({ recipientType: 'user', recipientId: requester });
      }

      for (const recipient of recipients) {
        for (const channel of this.channels(bucket)) {
          // 用户级通知 id 需要带上收件人（同一桶对不同人要各发一条），并清洗为
          // 身份允许的字符集（与其它确定性 id 同一约束）。
          const recipientTag =
            recipient.recipientType === 'user'
              ? `-user-${recipient.recipientId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40)}`
              : '';
          const notificationId =
            `NTF-EXPR-${authorization.approvalId}-${bucket}${recipientTag}-${channel}`.slice(0, 250);
          const [row] = await this.db
            .insert(ewohNotification)
            .values({
              orgId,
              notificationId,
              recipientType: recipient.recipientType,
              recipientId: recipient.recipientId,
              channel,
              title: title.slice(0, 255) + (recipient.recipientType === 'user' ? '（你发起的）' : ''),
              body,
              severity: bucket === 'expiring' ? 'high' : 'medium',
              status: 'pending',
              externalRef: authorization.approvalId,
            })
            .onConflictDoNothing({
        // standalone_100：唯一性收敛为 (org_id, notification_id)——target 必须与
        // 仲裁索引逐列一致（与 deterministic-notifications 同步修改，实测事故）。
        target: [ewohNotification.orgId, ewohNotification.notificationId],
      })
            .returning({ notificationId: ewohNotification.notificationId });
          const wasCreated = Array.isArray(row) ? row.length > 0 : Boolean(row);
          if (wasCreated) created += 1;
          else duplicates += 1;
          notifications.push({ approvalId: authorization.approvalId, bucket, notificationId, created: wasCreated });
        }
      }

      // NO-45a：授权已失效 → 关闭它的"即将失效"催办提醒（`expired` 桶保持待办）。
      // 与 NO-44a 的会话处置不同，这里是**扫描任务的收敛写**：即使两步之间进程崩溃，
      // 下次扫描也会重跑（发出幂等、关闭幂等），不会留下半成品。
      if (bucket === 'expired') {
        const closed = await resolveNotificationsFor(this.db, {
          orgId,
          externalRef: authorization.approvalId,
          notificationIdPrefix: `NTF-EXPR-${authorization.approvalId}-expiring`,
          resolution: 'approval_expired',
          resolvedBy: 'system:expiry-sweep',
          resolutionRef: authorization.approvalId,
          now,
        });
        resolved += closed.closed;
      }
    }

    return {
      orgId,
      scanned: authorizations.length,
      expiringSoon,
      expired,
      created,
      duplicates,
      resolved,
      notifications,
      generatedAt: now.toISOString(),
    };
  }

  /** 渠道：app 恒发；lark/email 仅在配置存在时发（未配置 = 显式禁用）。 */
  private channels(bucket: 'expiring' | 'expired'): string[] {
    const list = ['app'];
    if (isLarkPushEnabled()) list.push('lark');
    if (isEmailPushEnabled()) list.push('email');
    return list;
  }

  /**
   * 列出"最近 N 天内有审批实例"的租户（有授权才可能有到期），供 worker 逐租户扫描。
   *
   * 这是一条**跨租户**读：`ewoh_event` 开着 RLS，没有上下文时它一律返回 0 行而不是报错
   * （V207 实测：owner 视角 1 个租户、`ewoh_api` 无 GUC 视角 0 行，而同一个前提经 HTTP
   * 带上下文扫描能落 2 条提醒）。所以本方法**自己不开上下文**——谁调谁负责：
   * worker 走 `systemGlobalAdminTransaction`（P1-GUC 约定，与投递积压巡检同形），
   * HTTP 路径由请求拦截器给上下文。
   */
  async listOrgsWithRecentApprovalInstances(lookbackDays = 7): Promise<string[]> {
    const rows = (await this.db.execute(sql`
      SELECT DISTINCT org_id
      FROM "ewoh_event"
      WHERE event_type = 'approval_instance'
        AND org_id IS NOT NULL
        AND created_at > now() - (${lookbackDays} || ' days')::interval
    `)) as unknown as Array<{ org_id?: string | null }>;
    return rows
      .map((row) => String(row.org_id ?? '').trim())
      .filter((orgId) => orgId !== '');
  }
}
