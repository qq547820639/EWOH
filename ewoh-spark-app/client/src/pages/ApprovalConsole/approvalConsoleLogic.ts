/* ApprovalConsole 纯逻辑（node 可测；ADR-030 / NO-12f 客户端审批台）。 */

import type { AgentPendingApproval, NotificationRecord, SchedulerPendingApproval } from '../../api/approvals';

/** 剩余时间人类可读（≥1h 显示小时，否则分钟；过期/耗尽显示 已过期）。 */
export function formatRemaining(remainingMs: number, expired: boolean): string {
  if (expired || remainingMs <= 0) return '已过期';
  const minutes = Math.floor(remainingMs / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

/** 合并两类待批为统一行（类型区分，Agent 审批可操作/调度审批进详情）。 */
export interface ApprovalRow {
  key: string;
  kind: 'agent' | 'scheduler';
  approvalId: string;
  title: string;
  detail: string;
  createdAt: string | null;
  expired: boolean;
  remainingMs: number;
  agent?: AgentPendingApproval;
}

export function buildApprovalRows(
  agent: AgentPendingApproval[],
  scheduler: SchedulerPendingApproval[],
): ApprovalRow[] {
  const rows: ApprovalRow[] = agent.map((a) => ({
    key: `agent:${a.approvalId}`,
    kind: 'agent',
    approvalId: a.approvalId,
    title: `Agent 命令审批：${a.command}`,
    detail: `agent=${a.agentId}，角色=${a.roles.join('、')}`,
    createdAt: a.createdAt,
    expired: a.expired,
    remainingMs: a.remainingMs,
    agent: a,
  }));
  for (const s of scheduler) {
    rows.push({
      key: `scheduler:${s.approvalId}`,
      kind: 'scheduler',
      approvalId: s.approvalId,
      title: `调度审批：${s.entityType ?? 'unknown'} ${s.entityId ?? ''}`.trim(),
      detail: `审批实例 ${s.approvalId}`,
      createdAt: s.createdAt,
      expired: false,
      remainingMs: 0,
    });
  }
  rows.sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''));
  return rows;
}

/** 通知分组：未读数 + 按状态拆分（R-58：推送渠道独立分组）。 */
export function notificationSummary(notifications: NotificationRecord[]): {
  unread: number;
  read: number;
  pending: NotificationRecord[];
  /** 推送渠道（非 app）通知：pending 待投递 / sent 已投递 / failed 可重试。 */
  push: NotificationRecord[];
  /** 投递失败待人工重试的推送通知。 */
  failedPush: NotificationRecord[];
} {
  const pending = notifications.filter((n) => n.channel === 'app' && n.status === 'pending');
  const read = notifications.filter((n) => n.channel === 'app' && n.status === 'read');
  const push = notifications.filter((n) => n.channel !== 'app');
  const failedPush = push.filter((n) => n.status === 'failed');
  return { unread: pending.length, read: read.length, pending, push, failedPush };
}

/** 渠道展示文案（封闭注册表；未知渠道原样透出，§33 不当作正常）。 */
export function notificationChannelLabel(channel: string): string {
  if (channel === 'app') return '应用内';
  if (channel === 'lark') return '飞书';
  if (channel === 'email') return '邮件';
  return channel;
}

export type NotificationPushState = 'app' | 'push-pending' | 'push-sent' | 'push-failed' | 'unknown';

/** 推送状态分类（展示层；不参与投递决策）。 */
export function notificationState(n: NotificationRecord): NotificationPushState {
  if (n.channel === 'app') return 'app';
  if (n.status === 'failed') return 'push-failed';
  if (n.status === 'sent') return 'push-sent';
  if (n.status === 'pending') return 'push-pending';
  return 'unknown';
}

/** Agent 审批是否可操作：未过期才允许批准/驳回（过期显式禁用，§33）。 */
export function agentApprovalActionable(a: AgentPendingApproval): boolean {
  return !a.expired && a.remainingMs > 0;
}
