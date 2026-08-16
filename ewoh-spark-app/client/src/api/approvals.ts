import { axiosForBackend } from '../lib/http';

/** ADR-030 / NO-12f：审批交互面 API 客户端（待批清单 + 通知读写）。 */

export interface SchedulerPendingApproval {
  approvalId: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string | null;
}

export interface AgentPendingApproval {
  approvalId: string;
  agentId: string;
  command: string;
  payload: Record<string, unknown>;
  roles: string[];
  createdAt: string;
  expiresAtMs: number;
  remainingMs: number;
  expired: boolean;
}

export interface ApprovalStep {
  id: string;
  role: string;
  status: string;
  reason?: string;
  delegateTo?: string;
}

export interface ApprovalDetail {
  id: string;
  entityType?: string;
  entityId?: string;
  status?: string;
  createdAt?: string;
  steps?: ApprovalStep[];
}

export interface NotificationRecord {
  notificationId: string;
  recipientType: string;
  recipientId: string;
  channel: string;
  title: string;
  body: string | null;
  severity: string;
  status: string;
  externalRef: string | null;
  readAt: string | null;
  createdAt: string | null;
  /** R-58 / ADR-037：推送投递时间/失败理由（推送渠道；app 通知恒 null）。 */
  sentAt: string | null;
  errorMessage: string | null;
}

export async function listSchedulerPendingApprovals(): Promise<SchedulerPendingApproval[]> {
  const res = await axiosForBackend({ url: '/api/approvals/pending', method: 'GET' });
  return res.data;
}

export async function listAgentPendingApprovals(): Promise<AgentPendingApproval[]> {
  const res = await axiosForBackend({ url: '/api/agents/approvals', method: 'GET' });
  return res.data;
}

export async function getApprovalDetail(approvalId: string): Promise<ApprovalDetail> {
  const res = await axiosForBackend({ url: `/api/approvals/${approvalId}`, method: 'GET' });
  return res.data;
}

export async function resolveAgentApproval(
  approvalId: string,
  approved: boolean,
): Promise<Record<string, unknown>> {
  const res = await axiosForBackend({
    url: `/api/agents/approvals/${approvalId}/resolve`,
    method: 'POST',
    data: { approved },
  });
  return res.data;
}

export async function stepApprovalAction(
  approvalId: string,
  stepId: string,
  action: 'approve' | 'reject',
  reason?: string,
): Promise<Record<string, unknown>> {
  const res = await axiosForBackend({
    url: `/api/approvals/${approvalId}/steps/${stepId}/state`,
    method: 'POST',
    params: { action },
    data: { reason },
  });
  return res.data;
}

export async function listNotifications(status?: 'pending' | 'read'): Promise<NotificationRecord[]> {
  const res = await axiosForBackend({
    url: '/api/notifications',
    method: 'GET',
    params: status ? { status } : undefined,
  });
  return res.data;
}

export async function markNotificationRead(notificationId: string): Promise<NotificationRecord> {
  const res = await axiosForBackend({
    url: `/api/notifications/${notificationId}/read`,
    method: 'POST',
  });
  return res.data;
}

/** 推送通知人工重试（failed → pending，R-58 / ADR-037）。 */
export async function retryNotification(notificationId: string): Promise<NotificationRecord> {
  const res = await axiosForBackend({
    url: `/api/notifications/${notificationId}/retry`,
    method: 'POST',
  });
  return res.data;
}
