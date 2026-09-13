/* ApprovalConsole 纯逻辑（node 可测；ADR-030 / NO-12f 客户端审批台）。 */

import type {
  AgentPendingApproval,
  CapabilityAuthorization,
  NotificationRecord,
  SchedulerPendingApproval,
} from '../../api/approvals';
import type { ObjectDescriptor } from '@shared/api.interface';
import { notificationResolutionLabel } from '@shared/notification-resolution';
import type { NotificationGovernanceSummary } from '@client/src/api/approvals';

/**
 * 审批对象类型中文标签。
 *
 * 取值必须与服务端 `APPROVAL_ROLE_POLICY` 白名单一致
 * （`server/modules/approval/approval-persistence.service.ts:38-46`）：
 * 仅 `task` / `dangerous_action` / `control_request` 三类，未登记类型会被 fail-closed 拒绝。
 *
 * ⚠️ 此前前端把所有非 agent 审批一律标为「调度审批」（v1.0 的 F-3 文案误导）——
 * 实际承载的往往是 `control_request`（高危物理控制指令，安全关键）。
 */
export const ENTITY_TYPE_LABELS: Record<string, string> = {
  task: '生产任务',
  dangerous_action: '危险作业',
  control_request: '高危控制指令',
  // NO-21a/22a：执行边界授权（任务侧放宽 / 设备侧恢复）——不登记就会把原始
  // entityType 直接甩到界面上（现场看不懂 task_capability_change 是什么）
  task_capability_change: '任务能力放宽',
  device_capability_change: '设备能力恢复',
  // NO-31a：`control_request`（高危控制指令）此前只出现在待批清单里，现在也进入
  // 执行边界授权视图与到期提醒——它同样是"批准一次即授予执行权力"的凭证。
};

export function entityTypeLabel(entityType: string | null | undefined): string {
  if (!entityType) return '审批';
  return ENTITY_TYPE_LABELS[entityType] ?? entityType;
}

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
  /** OD-1 对象描述符快照；老数据缺失时消费方一律回退渲染，禁止白屏。 */
  subject?: ObjectDescriptor;
  /** 深链目标（对象工作台路由）；无描述符时为 undefined。 */
  deepLink?: string;
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
    // OD-1：优先用对象描述符渲染人类可读标题与决策摘要。
    // 老数据无 subject（evidenceJson 未快照）时回退到类型 + entityId，
    // 保证灰度期不白屏；新建审批均带 subject，老 pending 随审批时效自然消亡。
    const label = entityTypeLabel(s.entityType);
    const subject = s.subject;
    const deepLink =
      subject?.deepLink ??
      (subject ? `/o/${subject.objectType}/${subject.objectId}` : undefined);
    rows.push({
      key: `scheduler:${s.approvalId}`,
      kind: 'scheduler',
      approvalId: s.approvalId,
      title: subject ? `${label}：${subject.title}` : `${label}：${s.entityId ?? ''}`.trim(),
      detail: subject?.summary ?? `审批实例 ${s.approvalId}`,
      createdAt: s.createdAt,
      expired: false,
      remainingMs: 0,
      ...(subject ? { subject } : {}),
      ...(deepLink ? { deepLink } : {}),
    });
  }
  rows.sort((x, y) => (x.createdAt ?? '').localeCompare(y.createdAt ?? ''));
  return rows;
}

/** 通知分组：未读数 + 按状态拆分（R-58：推送渠道独立分组；NO-44a：已处置独立分组）。 */
export function notificationSummary(notifications: NotificationRecord[]): {
  unread: number;
  read: number;
  /** NO-44a：已随主事实处置关闭的条数（**不等于已读**，也不算未读）。 */
  resolved: number;
  pending: NotificationRecord[];
  /** 已处置的通知（含谁/何时/因哪次处置——由处置列承载）。 */
  resolvedList: NotificationRecord[];
  /** 推送渠道（非 app）通知：pending 待投递 / sent 已投递 / failed 可重试。 */
  push: NotificationRecord[];
  /** 投递失败待人工重试的推送通知。 */
  failedPush: NotificationRecord[];
} {
  const pending = notifications.filter((n) => n.channel === 'app' && n.status === 'pending');
  const read = notifications.filter((n) => n.channel === 'app' && n.status === 'read');
  // 处置终态与渠道无关：应用内通知与尚未投递的推送都可能被处置关闭。
  // 但 `sent`/`failed` 是投递事实，不能混进"已处置"里（否则投递失败会被悄悄吞掉）。
  const resolvedList = notifications.filter(
    (n) => n.status === 'resolved' || String(n.resolution ?? '').trim() !== '',
  );
  const push = notifications.filter((n) => n.channel !== 'app' && n.status !== 'resolved');
  const failedPush = push.filter((n) => n.status === 'failed');
  return {
    unread: pending.length,
    read: read.length,
    resolved: notifications.filter((n) => n.status === 'resolved').length,
    pending,
    resolvedList,
    push,
    failedPush,
  };
}

/* ── NO-46a：提醒治理度量（运行记忆）的展示换算 ─────────────────────── */

/** 治理卡片的一行（服务端只给事实与计数，前端只排版、不下新结论）。 */
export interface NotificationGovernanceView {
  /** 口径行："最近 N 天 · 扫描 M 条"（截断时明说只覆盖已取到的行）。 */
  scopeLabel: string;
  /** 概览："已处置 X · 待处理 Y · 已读未处置 Z · 投递失败 W"。 */
  totalsLabel: string;
  /** 处置率文案；样本不足 → "证据不足（不给比率）"。 */
  dispositionRateLabel: string;
  /** 处置时长文案；无样本 → "暂无可计算的处置时长"。 */
  latencyLabel: string;
  /** 待办账龄（只列非零桶，避免一排 0 的假信息）。 */
  agingRows: Array<{ key: string; label: string; count: number }>;
  /** 反复出现的主事实（Top N）。 */
  topSourceRows: Array<{ externalRef: string; kindLabel: string; summary: string }>;
  /** 按类型的计数与时长（读作"哪类提醒最费人"）。 */
  kindRows: Array<{ kind: string; label: string; summary: string }>;
  notes: string[];
  empty: boolean;
}

/** 毫秒 → 可读时长（无样本 → null，由调用方给文案）。 */
function formatLatency(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '不足 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`;
}

/**
 * 纯函数：治理度量 → 卡片文案。
 *
 * 诚实口径：样本不足不给比率；时长缺样本不给数字；账龄为 0 的桶不渲染；
 * 口径说明逐条透出（服务端 notes 原样展示，不在前端改写）。
 */
export function buildNotificationGovernanceView(
  summary: NotificationGovernanceSummary | null | undefined,
): NotificationGovernanceView {
  if (!summary) {
    return {
      scopeLabel: '尚未取到提醒治理数据',
      totalsLabel: '—',
      dispositionRateLabel: '—',
      latencyLabel: '—',
      agingRows: [],
      topSourceRows: [],
      kindRows: [],
      notes: [],
      empty: true,
    };
  }
  const totals = summary.totals;
  const readNotDisposed = totals.read;
  return {
    scopeLabel:
      `最近 ${summary.windowDays} 天 · 扫描 ${summary.scanned} 条`
      + (summary.truncated ? '（命中取数上限：结论只覆盖已取到的行）' : ''),
    totalsLabel:
      `已处置 ${totals.resolved} · 待处理 ${totals.pending} · 已读未处置 ${readNotDisposed}`
      + ` · 投递失败 ${totals.failedDelivery}`,
    dispositionRateLabel:
      summary.dispositionRate === null
        ? `处置率：证据不足（样本少于 ${summary.minSample} 条，不给比率）`
        : `处置率 ${Math.round(summary.dispositionRate * 100)}%（${totals.resolved}/${summary.scanned}）`,
    latencyLabel: (() => {
      const median = formatLatency(summary.medianTimeToResolveMs);
      const mean = formatLatency(summary.meanTimeToResolveMs);
      if (median === null) {
        return `暂无可计算的处置时长（可比样本 0 条，不可比 ${summary.notComparable} 条）`;
      }
      return `处置时长：中位 ${median}${mean ? `｜平均 ${mean}` : ''}（可比 ${summary.comparable} 条，不可比 ${summary.notComparable} 条）`;
    })(),
    agingRows: summary.aging
      .filter((bucket) => bucket.count > 0)
      .map((bucket) => ({ key: bucket.key, label: bucket.label, count: bucket.count })),
    topSourceRows: summary.topSources
      .filter((source) => source.total > 0)
      .map((source) => ({
        externalRef: source.externalRef,
        kindLabel: source.kindLabel,
        summary: `共 ${source.total} 条（待处理 ${source.pending} · 已处置 ${source.resolved}）`,
      })),
    kindRows: summary.byKind.map((group) => {
      const latency = formatLatency(group.medianTimeToResolveMs);
      return {
        kind: group.kind,
        label: group.label,
        summary:
          `共 ${group.total}（待处理 ${group.pending} · 已处置 ${group.resolved}）`
          + (latency ? `｜中位处置 ${latency}` : '｜暂无可计算的处置时长')
          + (group.oldestPendingAgeMs !== null
            ? `｜最久待办 ${formatLatency(group.oldestPendingAgeMs) ?? '时间未记录'}`
            : ''),
      };
    }),
    notes: Array.isArray(summary.notes) ? summary.notes : [],
    empty: summary.scanned === 0,
  };
}

/**
 * NO-44a：一条通知的处置说明（"谁、何时、因哪次处置"）。
 *
 * 未登记的处置码→原样透出（原则 7：不把未知翻译成已知结论）；没有处置信息→null。
 */
export function notificationResolutionText(n: NotificationRecord): string | null {
  const code = String(n.resolution ?? '').trim();
  if (code === '') return null;
  const label = notificationResolutionLabel(code) ?? code;
  const parts = [label];
  if (n.resolvedBy) parts.push(`处置人 ${n.resolvedBy}`);
  if (n.resolvedAt) parts.push(new Date(n.resolvedAt).toLocaleString('zh-CN'));
  if (n.resolutionRef && n.resolutionRef !== n.externalRef) parts.push(`指向 ${n.resolutionRef}`);
  return parts.join(' · ');
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

// ── NO-24a：执行边界授权（已授权 + 时效 + 消耗）─────────────────────────────

export type AuthorizationState =
  | 'usable'
  | 'expiring-soon'
  | 'expired'
  | 'pending'
  | 'rejected'
  | 'cancelled'
  | 'unknown';

export interface AuthorizationRow {
  approvalId: string;
  entityType: string;
  entityTypeLabel: string;
  /** 人类可读范围：能力名 + 覆盖设备/对象（来自审批指纹 metrics）。 */
  scope: string;
  state: AuthorizationState;
  stateLabel: string;
  /** 还能用多久（已过期/待批时为 null）。 */
  remainingLabel: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  /** 已消耗对象数（同一份授权逐台/逐个消耗）。 */
  consumedCount: number;
  usageDetail: string;
  /** 明确"此刻能不能用"——过期/待批/驳回必须一眼可辨（原则 6）。 */
  usableNow: boolean;
}

/** 即将过期阈值：2 小时内提醒（现场足够重新申请；太短会来不及）。 */
export const AUTHORIZATION_EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;

function authorizationState(a: CapabilityAuthorization): AuthorizationState {
  if (a.status === 'approved') {
    if (a.expired) return 'expired';
    if (a.remainingMs !== null && a.remainingMs <= AUTHORIZATION_EXPIRING_SOON_MS) return 'expiring-soon';
    return 'usable';
  }
  if (a.status === 'pending') return 'pending';
  if (a.status === 'rejected') return 'rejected';
  if (a.status === 'cancelled') return 'cancelled';
  return 'unknown';
}

const AUTHORIZATION_STATE_LABELS: Record<AuthorizationState, string> = {
  usable: '有效',
  'expiring-soon': '即将过期',
  expired: '已过期（不可用）',
  pending: '待审批（尚不可用）',
  rejected: '已驳回（不可用）',
  cancelled: '已撤销（不可用）',
  unknown: '状态未知（不得据此放行）',
};

function authorizationScope(a: CapabilityAuthorization): string {
  const metrics = a.subject?.metrics ?? {};
  const capability = metrics.capabilityKey || a.subject?.objectId || a.entityId;
  const devices = String(metrics.deviceIds ?? '').trim();
  if (devices) return `${capability} · 覆盖 ${devices.split(',').length} 台（${devices}）`;
  const relaxed = String(metrics.relaxedHighRiskCapabilities ?? '').trim();
  if (relaxed) return `${capability} · 放宽 ${relaxed}`;
  return String(capability || '范围未记录');
}

/**
 * 授权行（按"最快失效优先 → 已过期 → 待批/终态"排序，与服务端同口径）。
 *
 * 关键：**已过期不是隐藏而是明确标注不可用**——现场需要看到"我有过一张授权，
 * 但它失效了、要重新申请"，而不是以为系统没给过。
 */
export function buildAuthorizationRows(authorizations: CapabilityAuthorization[]): AuthorizationRow[] {
  const order: Record<AuthorizationState, number> = {
    'expiring-soon': 0,
    usable: 1,
    expired: 2,
    pending: 3,
    rejected: 4,
    cancelled: 5,
    unknown: 6,
  };
  return authorizations
    .map((a): AuthorizationRow => {
      const state = authorizationState(a);
      const usageDetail =
        a.usage.length === 0
          ? '尚未使用'
          : a.usage
              .map((u) => {
                const who = u.usedBy || '未知操作人';
                const when = u.at ? new Date(u.at).toLocaleString('zh-CN') : '时间未记录';
                const note = u.note ? ` · ${u.note}` : '';
                return `${u.usageKey || '对象未记录'} ← ${who} · ${when}${note}`;
              })
              .join('；');
      return {
        approvalId: a.approvalId,
        entityType: a.entityType,
        entityTypeLabel: entityTypeLabel(a.entityType),
        scope: authorizationScope(a),
        state,
        stateLabel: AUTHORIZATION_STATE_LABELS[state],
        remainingLabel:
          state === 'usable' || state === 'expiring-soon'
            ? formatRemaining(a.remainingMs ?? 0, false)
            : null,
        approvedAt: a.approvedAt,
        expiresAt: a.expiresAt,
        consumedCount: a.usage.length,
        usageDetail,
        usableNow: state === 'usable' || state === 'expiring-soon',
      };
    })
    .sort((x, y) => {
      const diff = order[x.state] - order[y.state];
      if (diff !== 0) return diff;
      return x.approvalId.localeCompare(y.approvalId);
    });
}

/** 顶部汇总：可用 / 即将过期 / 已过期 / 待批 + 已消耗对象总数（原则 5/6）。 */
export function authorizationSummary(rows: AuthorizationRow[]): {
  usable: number;
  expiringSoon: number;
  expired: number;
  pending: number;
  consumed: number;
  /** 实验室可读的一句话（空列表也要说清楚"当前没有授权"）。 */
  label: string;
} {
  const usable = rows.filter((r) => r.state === 'usable').length;
  const expiringSoon = rows.filter((r) => r.state === 'expiring-soon').length;
  const expired = rows.filter((r) => r.state === 'expired').length;
  const pending = rows.filter((r) => r.state === 'pending').length;
  const consumed = rows.reduce((sum, r) => sum + r.consumedCount, 0);
  const label =
    rows.length === 0
      ? '当前没有执行边界授权记录（能力放宽/设备恢复都会在这里留下授权与用量）'
      : `有效 ${usable} · 即将过期 ${expiringSoon} · 已过期 ${expired} · 待批 ${pending}｜已消耗对象 ${consumed}`;
  return { usable, expiringSoon, expired, pending, consumed, label };
}
