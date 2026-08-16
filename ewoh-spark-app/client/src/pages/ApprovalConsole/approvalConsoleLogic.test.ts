/* ApprovalConsole 纯逻辑测试（node 可测；ADR-030 / NO-12f）。 */

import {
  formatRemaining,
  buildApprovalRows,
  notificationChannelLabel,
  notificationState,
  notificationSummary,
  agentApprovalActionable,
} from './approvalConsoleLogic';
import type { AgentPendingApproval, NotificationRecord, SchedulerPendingApproval } from '../../api/approvals';

function agentApproval(overrides: Partial<AgentPendingApproval> = {}): AgentPendingApproval {
  return {
    approvalId: 'appr-a1',
    agentId: 'agent:9f1c4a0e-5d0b-4f3a-9c1e-7d3b9a6f0a11',
    command: 'propose_plan',
    payload: {},
    roles: ['workshop_lead'],
    createdAt: '2026-08-16T08:00:00Z',
    expiresAtMs: Date.now() + 3600000,
    remainingMs: 3600000,
    expired: false,
    ...overrides,
  };
}

function schedulerApproval(overrides: Partial<SchedulerPendingApproval> = {}): SchedulerPendingApproval {
  return {
    approvalId: 'appr-s1',
    entityType: 'plan',
    entityId: 'PLN-1',
    createdAt: '2026-08-16T07:00:00Z',
    ...overrides,
  };
}

function notification(overrides: Partial<NotificationRecord> = {}): NotificationRecord {
  return {
    notificationId: 'NTF-1',
    recipientType: 'role',
    recipientId: 'workshop_lead',
    channel: 'app',
    title: 'Agent 命令待审批',
    body: null,
    severity: 'high',
    status: 'pending',
    externalRef: null,
    readAt: null,
    createdAt: '2026-08-16T08:00:00Z',
    sentAt: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('approvalConsoleLogic（NO-12f 客户端审批台）', () => {
  it('formatRemaining：小时/分钟/过期', () => {
    expect(formatRemaining(3600000, false)).toBe('1 小时 0 分');
    expect(formatRemaining(10 * 60000, false)).toBe('10 分钟');
    expect(formatRemaining(0, true)).toBe('已过期');
  });

  it('buildApprovalRows：两类合并并按时间排序', () => {
    const rows = buildApprovalRows([agentApproval()], [schedulerApproval()]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.kind).toBe('scheduler'); // 07:00 早于 08:00
    expect(rows[1]?.kind).toBe('agent');
    expect(rows[1]?.title).toContain('propose_plan');
  });

  it('agentApprovalActionable：过期显式禁用（§33 过期不静默可操作）', () => {
    expect(agentApprovalActionable(agentApproval())).toBe(true);
    expect(agentApprovalActionable(agentApproval({ expired: true, remainingMs: 0 }))).toBe(false);
    expect(agentApprovalActionable(agentApproval({ remainingMs: 0 }))).toBe(false);
  });

  it('notificationSummary：未读/已读分组', () => {
    const summary = notificationSummary([
      notification({ notificationId: 'NTF-1', status: 'pending' }),
      notification({ notificationId: 'NTF-2', status: 'pending' }),
      notification({ notificationId: 'NTF-3', status: 'read', readAt: '2026-08-16T09:00:00Z' }),
    ]);
    expect(summary.unread).toBe(2);
    expect(summary.read).toBe(1);
    expect(summary.pending.map((n) => n.notificationId)).toEqual(['NTF-1', 'NTF-2']);
  });

  it('notificationSummary：推送渠道独立分组（R-58），未读数只计 app', () => {
    const summary = notificationSummary([
      notification({ notificationId: 'NTF-A', channel: 'app', status: 'pending' }),
      notification({ notificationId: 'NTF-L1', channel: 'lark', status: 'pending' }),
      notification({ notificationId: 'NTF-L2', channel: 'lark', status: 'sent', sentAt: '2026-08-16T09:00:00Z' }),
      notification({ notificationId: 'NTF-L3', channel: 'lark', status: 'failed', errorMessage: 'lark_webhook_http_500' }),
    ]);
    expect(summary.unread).toBe(1);
    expect(summary.pending.map((n) => n.notificationId)).toEqual(['NTF-A']);
    expect(summary.push.map((n) => n.notificationId)).toEqual(['NTF-L1', 'NTF-L2', 'NTF-L3']);
    expect(summary.failedPush.map((n) => n.notificationId)).toEqual(['NTF-L3']);
  });

  it('notificationChannelLabel：封闭注册表 + 未知渠道原样透出（§33）', () => {
    expect(notificationChannelLabel('app')).toBe('应用内');
    expect(notificationChannelLabel('lark')).toBe('飞书');
    expect(notificationChannelLabel('email')).toBe('邮件');
    expect(notificationChannelLabel('sms')).toBe('sms');
  });

  it('notificationState：app/推送三态/未知分类', () => {
    expect(notificationState(notification({ channel: 'app', status: 'pending' }))).toBe('app');
    expect(notificationState(notification({ channel: 'lark', status: 'pending' }))).toBe('push-pending');
    expect(notificationState(notification({ channel: 'lark', status: 'sent' }))).toBe('push-sent');
    expect(notificationState(notification({ channel: 'lark', status: 'failed' }))).toBe('push-failed');
    expect(notificationState(notification({ channel: 'lark', status: 'weird' }))).toBe('unknown');
  });
});
