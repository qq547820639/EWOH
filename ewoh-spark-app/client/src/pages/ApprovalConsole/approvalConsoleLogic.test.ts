/* ApprovalConsole 纯逻辑测试（node 可测；ADR-030 / NO-12f）。 */

import {
  formatRemaining,
  buildApprovalRows,
  buildAuthorizationRows,
  authorizationSummary,
  entityTypeLabel,
  notificationChannelLabel,
  notificationState,
  notificationSummary,
  notificationResolutionText,
  buildNotificationGovernanceView,
  agentApprovalActionable,
  AUTHORIZATION_EXPIRING_SOON_MS,
} from './approvalConsoleLogic';
import type {
  AgentPendingApproval,
  CapabilityAuthorization,
  NotificationRecord,
  SchedulerPendingApproval,
} from '../../api/approvals';

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

  // ---- OD-1：对象描述符渲染（消除审批台裸 UUID）----

  it('有 subject 时用人类可读标题与中文类型标签，且在标题中呈现对象名', () => {
    const rows = buildApprovalRows(
      [],
      [
        schedulerApproval({
          entityType: 'control_request',
          subject: {
            objectType: 'control_request',
            objectId: 'ctl-9',
            title: '3 号产线急停指令',
            summary: '延期 42.6min · 负荷 87%',
          },
        }),
      ],
    );
    const row = rows[0];
    expect(row?.title).toContain('3 号产线急停指令');
    expect(row?.title).toContain('高危控制指令');
    expect(row?.detail).toBe('延期 42.6min · 负荷 87%');
  });

  it('有 subject 时生成深链；未显式给 deepLink 时按 objectType/objectId 兜底', () => {
    const rows = buildApprovalRows(
      [],
      [
        schedulerApproval({
          subject: { objectType: 'task', objectId: 'T-1', title: '任务 A' },
        }),
      ],
    );
    expect(rows[0]?.deepLink).toBe('/o/task/T-1');
  });

  it('subject 自带 deepLink 时优先使用', () => {
    const rows = buildApprovalRows(
      [],
      [
        schedulerApproval({
          subject: {
            objectType: 'task',
            objectId: 'T-1',
            title: '任务 A',
            deepLink: '/o/task/T-1?tab=evidence',
          },
        }),
      ],
    );
    expect(rows[0]?.deepLink).toBe('/o/task/T-1?tab=evidence');
  });

  it('无 subject（老数据）时回退且不带深链，不白屏', () => {
    const rows = buildApprovalRows([], [schedulerApproval({ entityType: 'task' })]);
    expect(rows[0]?.title).toContain('生产任务');
    expect(rows[0]?.detail).toContain('appr-s1');
    expect(rows[0]?.deepLink).toBeUndefined();
    expect(rows[0]?.subject).toBeUndefined();
  });

  it('未登记类型不再被一律标成「调度审批」（F-3 文案误导修复）', () => {
    const rows = buildApprovalRows([], [schedulerApproval({ entityType: 'dangerous_action' })]);
    expect(rows[0]?.title).not.toContain('调度审批');
    expect(rows[0]?.title).toContain('危险作业');
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

  it('NO-44a：已处置是独立分组——既不算未读，也不算已读，且必须列出处置依据', () => {
    const summary = notificationSummary([
      notification({ notificationId: 'NTF-P', status: 'pending' }),
      notification({ notificationId: 'NTF-R', status: 'read', readAt: '2026-08-16T09:00:00Z' }),
      notification({
        notificationId: 'NTF-X',
        status: 'resolved',
        resolution: 'session_ended',
        resolvedAt: '2026-08-16T10:00:00Z',
        resolvedBy: 'lead.chen',
        externalRef: 'exo-session:S1',
        resolutionRef: 'exo-session:S1',
      }),
    ]);
    expect(summary.unread).toBe(1);
    expect(summary.read).toBe(1);
    expect(summary.resolved).toBe(1);
    expect(summary.pending.map((n) => n.notificationId)).toEqual(['NTF-P']);
    expect(summary.resolvedList.map((n) => n.notificationId)).toEqual(['NTF-X']);
    // 处置说明必须写清"哪种处置 + 谁 + 何时"
    const text = notificationResolutionText(summary.resolvedList[0]);
    expect(text).toContain('收工');
    expect(text).toContain('lead.chen');
    expect(text).toContain('2026');
  });

  it('NO-44a：投递失败（failed）不能混进"已处置"（否则失败被悄悄吞掉）', () => {
    const summary = notificationSummary([
      notification({ notificationId: 'NTF-F', channel: 'lark', status: 'failed', errorMessage: 'http_500' }),
    ]);
    expect(summary.resolved).toBe(0);
    expect(summary.resolvedList).toHaveLength(0);
    expect(summary.failedPush.map((n) => n.notificationId)).toEqual(['NTF-F']);
  });

  it('NO-44a：未登记的处置码原样透出（不翻译成已知结论）；无处置信息→null', () => {
    const unknown = notification({ status: 'resolved', resolution: 'session_paused_v2', resolvedBy: 'lead.chen' });
    expect(notificationResolutionText(unknown)).toContain('session_paused_v2');
    expect(notificationResolutionText(notification())).toBeNull();
  });

  it('NO-45a：审批侧处置码同样能翻成"人话"（授权失效 / 被新审批取代）', () => {
    const expired = notification({
      status: 'resolved',
      resolution: 'approval_expired',
      resolvedBy: 'system:expiry-sweep',
      externalRef: 'AP-1',
      resolutionRef: 'AP-1',
    });
    expect(notificationResolutionText(expired)).toContain('失效');
    expect(notificationResolutionText(expired)).toContain('system:expiry-sweep');
    const superseded = notification({
      status: 'resolved',
      resolution: 'approval_superseded',
      resolvedBy: 'admin',
      externalRef: 'AP-1',
      resolutionRef: 'AP-2',
    });
    expect(notificationResolutionText(superseded)).toContain('新审批');
    expect(notificationResolutionText(superseded)).toContain('AP-2');
  });

  it('NO-44a：更正关闭的提醒指向新会话（resolutionRef ≠ externalRef 时才显示）', () => {
    const corrected = notification({
      status: 'resolved',
      resolution: 'session_corrected',
      resolvedBy: 'lead.chen',
      resolvedAt: '2026-08-16T10:00:00Z',
      externalRef: 'exo-session:OLD',
      resolutionRef: 'exo-session:NEW',
    });
    expect(notificationResolutionText(corrected)).toContain('exo-session:NEW');
    // 收工/中止时 ref 与 externalRef 相同 → 不重复显示
    const ended = notification({
      status: 'resolved',
      resolution: 'session_ended',
      resolvedBy: 'lead.chen',
      externalRef: 'exo-session:S1',
      resolutionRef: 'exo-session:S1',
    });
    expect(notificationResolutionText(ended)).not.toContain('指向');
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

  // ── NO-24a：执行边界授权视图（时效 + 消耗）──────────────────────────────
  describe('执行边界授权（NO-24a）', () => {
    const auth = (overrides: Partial<CapabilityAuthorization> = {}): CapabilityAuthorization => ({
      approvalId: 'AP-1',
      entityType: 'device_capability_change',
      entityId: 'capability:exo-lift',
      status: 'approved',
      createdAt: '2026-09-12T08:00:00.000Z',
      approvedAt: '2026-09-12T08:00:00.000Z',
      expiresAt: '2026-09-13T08:00:00.000Z',
      expired: false,
      remainingMs: 6 * 3_600_000,
      subject: {
        objectType: 'device_capability_change',
        objectId: 'capability:exo-lift',
        title: '恢复高风险能力：exo-lift（2 台设备）',
        summary: '…',
        metrics: { capabilityKey: 'exo-lift', deviceIds: 'EXO-1,EXO-2' },
      },
      usage: [],
      ...overrides,
    });

    it('实体类型标签覆盖能力类审批（不把 task_capability_change 原样甩给现场）', () => {
      expect(entityTypeLabel('task_capability_change')).toBe('任务能力放宽');
      expect(entityTypeLabel('device_capability_change')).toBe('设备能力恢复');
      expect(entityTypeLabel('control_request')).toBe('高危控制指令');
      expect(entityTypeLabel('unheard_of')).toBe('unheard_of');
    });

    it('状态分级：有效 / 即将过期（2 小时内）/ 已过期 / 待批 / 已驳回', () => {
      const rows = buildAuthorizationRows([
        auth({ approvalId: 'AP-OK', remainingMs: 6 * 3_600_000 }),
        auth({ approvalId: 'AP-SOON', remainingMs: AUTHORIZATION_EXPIRING_SOON_MS - 1000 }),
        auth({ approvalId: 'AP-EXPIRED', expired: true, remainingMs: 0 }),
        auth({ approvalId: 'AP-PENDING', status: 'pending', approvedAt: null, expiresAt: null, remainingMs: null }),
        auth({ approvalId: 'AP-REJECTED', status: 'rejected', approvedAt: null, expiresAt: null, remainingMs: null }),
      ]);
      const byId = new Map(rows.map((r) => [r.approvalId, r]));
      expect(byId.get('AP-OK')).toMatchObject({ state: 'usable', usableNow: true, stateLabel: '有效' });
      expect(byId.get('AP-SOON')).toMatchObject({ state: 'expiring-soon', usableNow: true });
      expect(byId.get('AP-SOON')?.stateLabel).toContain('即将过期');
      expect(byId.get('AP-EXPIRED')).toMatchObject({ state: 'expired', usableNow: false });
      expect(byId.get('AP-EXPIRED')?.stateLabel).toContain('不可用');
      expect(byId.get('AP-PENDING')).toMatchObject({ state: 'pending', usableNow: false });
      expect(byId.get('AP-REJECTED')).toMatchObject({ state: 'rejected', usableNow: false });
      // 排序：即将过期 → 有效 → 已过期 → 待批 → 已驳回
      expect(rows.map((r) => r.state)).toEqual([
        'expiring-soon',
        'usable',
        'expired',
        'pending',
        'rejected',
      ]);
    });

    it('范围与用量逐条如实渲染（谁/何时/备注；未使用就写未使用）', () => {
      const [row] = buildAuthorizationRows([auth()]);
      expect(row.scope).toContain('exo-lift');
      expect(row.scope).toContain('覆盖 2 台');
      expect(row.scope).toContain('EXO-1,EXO-2');
      expect(row.usageDetail).toBe('尚未使用');
      expect(row.consumedCount).toBe(0);

      const [used] = buildAuthorizationRows([
        auth({
          usage: [
            { usageKey: 'capability:exo-lift|device:EXO-1', usedBy: 'admin', at: '2026-09-12T09:00:00.000Z', note: '检修完成' },
            { usageKey: 'capability:exo-lift|device:EXO-2', usedBy: 'worker.li', at: null, note: null },
          ],
        }),
      ]);
      expect(used.consumedCount).toBe(2);
      expect(used.usageDetail).toContain('admin');
      expect(used.usageDetail).toContain('检修完成');
      expect(used.usageDetail).toContain('时间未记录');
    });

    it('任务侧放宽的授权也能读出范围（放宽了哪些高风险能力）', () => {
      const [row] = buildAuthorizationRows([
        auth({
          entityType: 'task_capability_change',
          entityId: 'T-1',
          subject: {
            objectType: 'task_capability_change',
            objectId: 'T-1',
            title: '放宽高风险能力要求：crane',
            summary: '…',
            metrics: { relaxedHighRiskCapabilities: 'crane', resultingDeviceCapabilities: '' },
          },
        }),
      ]);
      expect(row.entityTypeLabel).toBe('任务能力放宽');
      expect(row.scope).toContain('crane');
    });

    it('汇总：有效/即将过期/已过期/待批计数 + 已消耗对象总数；空列表也要说清楚', () => {
      const rows = buildAuthorizationRows([
        auth({ approvalId: 'A', remainingMs: 6 * 3_600_000 }),
        auth({ approvalId: 'B', remainingMs: 1000 }),
        auth({ approvalId: 'C', expired: true, remainingMs: 0 }),
        auth({
          approvalId: 'D',
          usage: [{ usageKey: 'k', usedBy: 'u', at: null, note: null }],
        }),
      ]);
      const summary = authorizationSummary(rows);
      // A（6h 有效）+ D（默认 6h，已消耗 1 次）都是"有效"，B 即将过期、C 已过期
      expect(summary).toMatchObject({ usable: 2, expiringSoon: 1, expired: 1, consumed: 1 });
      expect(summary.label).toContain('已过期 1');
      expect(authorizationSummary([]).label).toContain('当前没有执行边界授权记录');
    });

    it('审批未携带指纹时范围如实写"未记录"，不编造能力名', () => {
      const [row] = buildAuthorizationRows([
        auth({ subject: undefined, entityId: '', metrics: undefined } as never),
      ]);
      expect(row.scope).toBe('范围未记录');
    });
  });
});

/* ── NO-46a：提醒治理卡片（运行记忆）的展示换算 ───────────────────────── */

function governance(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-09-12T12:00:00.000Z',
    windowDays: 30,
    minSample: 3,
    scanned: 10,
    truncated: false,
    totals: { total: 10, pending: 4, read: 2, resolved: 4, failedDelivery: 1 },
    dispositionRate: 0.4,
    medianTimeToResolveMs: 90 * 60_000,
    meanTimeToResolveMs: 2 * 3_600_000,
    comparable: 3,
    notComparable: 1,
    aging: [
      { key: 'lt1h', label: '1 小时内', count: 1 },
      { key: 'lt8h', label: '1–8 小时', count: 0 },
      { key: 'lt24h', label: '8–24 小时', count: 2 },
      { key: 'gte24h', label: '超过 24 小时', count: 1 },
      { key: 'unknown', label: '时间未记录', count: 0 },
    ],
    byKind: [
      {
        kind: 'session_overdue',
        label: '会话超时未收工',
        total: 6,
        pending: 3,
        read: 1,
        resolved: 2,
        failedDelivery: 1,
        comparable: 2,
        notComparable: 0,
        medianTimeToResolveMs: 45 * 60_000,
        meanTimeToResolveMs: 45 * 60_000,
        oldestPendingAgeMs: 30 * 3_600_000,
      },
    ],
    topSources: [
      { externalRef: 'exo-session:A', kind: 'session_overdue', kindLabel: '会话超时未收工', total: 4, pending: 2, resolved: 2 },
    ],
    notes: ['口径：按创建时间取最近 30 天。', '样本少于 3 条时不给比率。'],
    ...overrides,
  } as never;
}

describe('buildNotificationGovernanceView（NO-46a）', () => {
  it('逐项给出可读文案：口径/概览/处置率/处置时长/账龄/类型/反复出现对象', () => {
    const view = buildNotificationGovernanceView(governance());
    expect(view.scopeLabel).toContain('最近 30 天');
    expect(view.scopeLabel).toContain('扫描 10 条');
    expect(view.totalsLabel).toContain('已处置 4');
    expect(view.totalsLabel).toContain('待处理 4');
    expect(view.totalsLabel).toContain('投递失败 1');
    expect(view.dispositionRateLabel).toContain('40%');
    expect(view.dispositionRateLabel).toContain('4/10');
    expect(view.latencyLabel).toContain('中位 1 小时 30 分');
    expect(view.latencyLabel).toContain('可比 3 条');
    expect(view.latencyLabel).toContain('不可比 1 条');
    // 账龄为 0 的桶不渲染（不制造一排 0 的假信息）
    expect(view.agingRows.map((r) => r.label)).toEqual(['1 小时内', '8–24 小时', '超过 24 小时']);
    expect(view.kindRows[0]?.summary).toContain('最久待办 1 天 6 小时');
    expect(view.topSourceRows[0]?.externalRef).toBe('exo-session:A');
    expect(view.notes).toHaveLength(2);
    expect(view.empty).toBe(false);
  });

  it('样本不足 → 明确"证据不足（不给比率）"，绝不显示 0%', () => {
    const view = buildNotificationGovernanceView(
      governance({ scanned: 2, dispositionRate: null, totals: { total: 2, pending: 1, read: 1, resolved: 0, failedDelivery: 0 } }),
    );
    expect(view.dispositionRateLabel).toContain('证据不足');
    expect(view.dispositionRateLabel).toContain('少于 3 条');
    expect(view.dispositionRateLabel).not.toContain('0%');
  });

  it('没有可比样本 → 说"暂无可计算的处置时长"，并报出不可比条数', () => {
    const view = buildNotificationGovernanceView(
      governance({ medianTimeToResolveMs: null, meanTimeToResolveMs: null, comparable: 0, notComparable: 4 }),
    );
    expect(view.latencyLabel).toContain('暂无可计算的处置时长');
    expect(view.latencyLabel).toContain('不可比 4 条');
  });

  it('命中取数上限 → 明说结论只覆盖已取到的行（不假装是全体）', () => {
    const view = buildNotificationGovernanceView(governance({ truncated: true }));
    expect(view.scopeLabel).toContain('只覆盖已取到的行');
  });

  it('没有数据/读取失败 → 明确"尚未取到"，而不是显示 0', () => {
    const view = buildNotificationGovernanceView(null);
    expect(view.scopeLabel).toContain('尚未取到');
    expect(view.totalsLabel).toBe('—');
    expect(view.dispositionRateLabel).toBe('—');
    expect(view.empty).toBe(true);
  });

  it('窗口内没有任何提醒 → empty=true（页面可据此说"这段时间没有提醒"）', () => {
    const view = buildNotificationGovernanceView(
      governance({ scanned: 0, totals: { total: 0, pending: 0, read: 0, resolved: 0, failedDelivery: 0 }, byKind: [], topSources: [], aging: [] }),
    );
    expect(view.empty).toBe(true);
    expect(view.agingRows).toEqual([]);
    expect(view.kindRows).toEqual([]);
  });
});
