import { axiosForBackend } from '../lib/http';
import type { ObjectDescriptor } from '@shared/api.interface';

/** ADR-030 / NO-12f：审批交互面 API 客户端（待批清单 + 通知读写）。 */

export interface SchedulerPendingApproval {
  approvalId: string;
  entityType: string | null;
  entityId: string | null;
  createdAt: string | null;
  /**
   * OD-1：对象描述符快照（后端 `listPending` 从 evidenceJson 读出）。
   * 可选且向后兼容——老审批行不含该字段，消费方须回退到 entityType + entityId 渲染。
   */
  subject?: ObjectDescriptor;
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
  /** NO-22a：审批通过时间（高风险执行边界授权的时效依据；未通过时缺失）。 */
  approvedAt?: string;
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
  /**
   * NO-44a：处置结果（NULL = 未被处置关闭）。
   * 与 `status='read'` 的区别：read = "人看过了"；resolution = "这件事被某次处置了结"。
   */
  resolution?: string | null;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  /** 处置指向的引用（更正=新会话号；收工/中止=会话号）。 */
  resolutionRef?: string | null;
}

export async function listSchedulerPendingApprovals(): Promise<SchedulerPendingApproval[]> {
  const res = await axiosForBackend({ url: '/api/approvals/pending', method: 'GET' });
  return res.data;
}

/**
 * NO-24a：执行边界授权视图（已授权 + 时效 + 消耗）。
 * 与待批清单互补：回答"哪些授权还能用、何时失效、已经用在哪"。
 */
export interface CapabilityAuthorization {
  approvalId: string;
  entityType: string;
  entityId: string;
  status: string;
  createdAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  remainingMs: number | null;
  subject?: ObjectDescriptor;
  usage: Array<{ usageKey: string; usedBy: string; at: string | null; note: string | null }>;
}

export async function listCapabilityAuthorizations(): Promise<CapabilityAuthorization[]> {
  const res = await axiosForBackend({ url: '/api/approvals/authorizations', method: 'GET' });
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
    url: `/api/agents/approvals/${encodeURIComponent(approvalId)}/resolve`,
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
    url: `/api/approvals/${encodeURIComponent(approvalId)}/steps/${encodeURIComponent(stepId)}/state`,
    method: 'POST',
    params: { action },
    data: { reason },
  });
  return res.data;
}

/**
 * 通知列表。`status` 省略 = 全部（含已处置，绝不静默隐藏）；
 * `resolved` = 已随主事实处置关闭（NO-44a：与"已读"是两件事）。
 */
export async function listNotifications(
  status?: 'pending' | 'read' | 'resolved',
): Promise<NotificationRecord[]> {
  const res = await axiosForBackend({
    url: '/api/notifications',
    method: 'GET',
    params: status ? { status } : undefined,
  });
  return res.data;
}

/* ── NO-46a：提醒治理与处置度量 ─────────────────────────────────────── */

export interface NotificationKindGroupDto {
  kind: string;
  label: string;
  total: number;
  pending: number;
  read: number;
  resolved: number;
  failedDelivery: number;
  comparable: number;
  notComparable: number;
  medianTimeToResolveMs: number | null;
  meanTimeToResolveMs: number | null;
  oldestPendingAgeMs: number | null;
}

export interface NotificationAgingBucketDto {
  key: string;
  label: string;
  count: number;
}

export interface NotificationTopSourceDto {
  externalRef: string;
  kind: string;
  kindLabel: string;
  total: number;
  pending: number;
  resolved: number;
}

export interface NotificationGovernanceSummary {
  generatedAt: string;
  windowDays: number;
  minSample: number;
  scanned: number;
  truncated: boolean;
  totals: { total: number; pending: number; read: number; resolved: number; failedDelivery: number };
  /** 样本不足 → null（页面必须显示"证据不足"，不显示 0%）。 */
  dispositionRate: number | null;
  medianTimeToResolveMs: number | null;
  meanTimeToResolveMs: number | null;
  comparable: number;
  notComparable: number;
  aging: NotificationAgingBucketDto[];
  byKind: NotificationKindGroupDto[];
  topSources: NotificationTopSourceDto[];
  notes: string[];
}

/**
 * 提醒治理度量（只读）。作用域与通知列表一致：数字不会覆盖"我看不到也处理不了"的提醒。
 * `days` 由服务端规范化（默认 30，上限 365）。
 */
export async function getNotificationMetrics(days?: number): Promise<NotificationGovernanceSummary> {
  const res = await axiosForBackend({
    url: '/api/notifications/metrics',
    method: 'GET',
    params: days ? { days } : undefined,
  });
  return res.data as NotificationGovernanceSummary;
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
