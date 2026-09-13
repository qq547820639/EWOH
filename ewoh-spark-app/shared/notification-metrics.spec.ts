/* 提醒治理度量（NO-46a）纯函数测试。
 *
 * 钉死：类型分类（确定性、不猜）、处置率样本门槛（不足 → null）、
 * 处置时长只算可比样本（缺时间戳/倒流不计入 0）、待办账龄分布（无法解析 → 时间未记录）、
 * 反复出现的主事实 Top N、投递失败与处置分开计数。
 */
/// <reference types="jest" />
import {
  classifyNotificationKind,
  notificationKindLabel,
  summarizeNotificationDisposition,
  type NotificationMetricRow,
} from './notification-metrics';

const NOW = new Date('2026-09-12T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

function row(overrides: Partial<NotificationMetricRow> = {}): NotificationMetricRow {
  return {
    notificationId: 'NTF-EXO-exo-sessionS1-overdue-app',
    status: 'pending',
    channel: 'app',
    externalRef: 'exo-session:S1',
    resolution: null,
    createdAt: iso(NOW.getTime() - 2 * HOUR),
    readAt: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe('classifyNotificationKind', () => {
  it('外骨骼提醒按标签分类（含"点名到人"与渠道后缀形态）', () => {
    expect(classifyNotificationKind('NTF-EXO-exo-sessionS1-overdue-app')).toBe('session_overdue');
    expect(classifyNotificationKind('NTF-EXO-exo-sessionS1-overdue-user-worker.zhangwei-app')).toBe('session_overdue');
    expect(classifyNotificationKind('NTF-EXO-exo-sessionS1-long_running-app')).toBe('session_long_running');
    expect(classifyNotificationKind('NTF-EXO-exo-sessionS1-telemetry_wearer_mismatch-app')).toBe(
      'telemetry_wearer_mismatch',
    );
    expect(classifyNotificationKind('NTF-EXO-exo-sessionS1-telemetry_inactive_suspect-lark')).toBe(
      'telemetry_inactive_suspect',
    );
  });

  it('审批到期提醒按桶分类（expiring 与 expired 不混淆）', () => {
    expect(classifyNotificationKind('NTF-EXPR-AP-1-expiring-app')).toBe('approval_expiring');
    expect(classifyNotificationKind('NTF-EXPR-AP-1-expired-user-approver.li-app')).toBe('approval_expired');
  });

  it('未登记形态归入 other/unknown，不猜成已知类型', () => {
    expect(classifyNotificationKind('NTF-ANDON-1-app')).toBe('andon');
    expect(classifyNotificationKind('NTF-EXO-exo-sessionS1-something_new-app')).toBe('other');
    expect(classifyNotificationKind('NTF-EXPR-AP-1-unknownbucket-app')).toBe('other');
    expect(classifyNotificationKind('SOMETHING-ELSE')).toBe('unknown');
    expect(classifyNotificationKind('')).toBe('unknown');
  });

  it('每种已登记类型都有中文文案（页面不显示裸码）', () => {
    for (const kind of [
      'session_overdue',
      'session_long_running',
      'telemetry_wearer_mismatch',
      'telemetry_inactive_suspect',
      'approval_expiring',
      'approval_expired',
      'andon',
      'other',
      'unknown',
    ]) {
      expect(notificationKindLabel(kind)).not.toBe(kind);
    }
    expect(notificationKindLabel('not_registered')).toBe('not_registered');
  });
});

describe('summarizeNotificationDisposition', () => {
  it('样本不足（< minSample）→ 处置率为 null，绝不用 0% 冒充', () => {
    const summary = summarizeNotificationDisposition(
      [row({ status: 'resolved', resolvedAt: iso(NOW.getTime() - HOUR) })],
      { now: NOW, minSample: 3 },
    );
    expect(summary.scanned).toBe(1);
    expect(summary.totals.resolved).toBe(1);
    expect(summary.dispositionRate).toBeNull();
    expect(summary.notes.join('')).toContain('证据不足');
  });

  it('处置率与处置时长：只统计可比样本，缺时间戳/时间倒流计入不可比', () => {
    const summary = summarizeNotificationDisposition(
      [
        // 可比：2 小时处置完
        row({ notificationId: 'NTF-EXO-S1-overdue-app', status: 'resolved', resolvedAt: iso(NOW.getTime() - 10 * HOUR), createdAt: iso(NOW.getTime() - 12 * HOUR) }),
        // 可比：4 小时处置完
        row({ notificationId: 'NTF-EXO-S2-overdue-app', status: 'resolved', resolvedAt: iso(NOW.getTime() - 8 * HOUR), createdAt: iso(NOW.getTime() - 12 * HOUR) }),
        // 不可比：缺 resolvedAt
        row({ notificationId: 'NTF-EXO-S3-overdue-app', status: 'resolved', resolvedAt: null }),
        // 不可比：时间倒流（处置早于创建）
        row({ notificationId: 'NTF-EXO-S4-overdue-app', status: 'resolved', createdAt: iso(NOW.getTime() - HOUR), resolvedAt: iso(NOW.getTime() - 3 * HOUR) }),
        // 待处理
        row({ notificationId: 'NTF-EXO-S5-overdue-app', status: 'pending' }),
      ],
      { now: NOW, minSample: 3 },
    );
    expect(summary.scanned).toBe(5);
    expect(summary.totals.resolved).toBe(4);
    expect(summary.totals.pending).toBe(1);
    expect(summary.comparable).toBe(2);
    expect(summary.notComparable).toBe(2);
    // 中位数 = (2h + 4h) / 2 = 3h；均值同为 3h
    expect(summary.medianTimeToResolveMs).toBe(3 * HOUR);
    expect(summary.meanTimeToResolveMs).toBe(3 * HOUR);
    expect(summary.dispositionRate).toBeCloseTo(4 / 5, 5);
    expect(summary.notes.join('')).toContain('不按 0 参与统计');
  });

  it('待办账龄分布：按创建时间分桶，无法解析归入"时间未记录"', () => {
    const summary = summarizeNotificationDisposition(
      [
        row({ notificationId: 'NTF-A', status: 'pending', createdAt: iso(NOW.getTime() - 30 * 60_000) }),
        row({ notificationId: 'NTF-B', status: 'pending', createdAt: iso(NOW.getTime() - 3 * HOUR) }),
        row({ notificationId: 'NTF-C', status: 'pending', createdAt: iso(NOW.getTime() - 12 * HOUR) }),
        row({ notificationId: 'NTF-D', status: 'pending', createdAt: iso(NOW.getTime() - 40 * HOUR) }),
        row({ notificationId: 'NTF-E', status: 'pending', createdAt: null }),
        row({ notificationId: 'NTF-F', status: 'resolved', resolvedAt: iso(NOW.getTime() - HOUR), createdAt: iso(NOW.getTime() - 2 * HOUR) }),
      ],
      { now: NOW },
    );
    const byKey = Object.fromEntries(summary.aging.map((bucket) => [bucket.key, bucket.count]));
    expect(byKey).toEqual({ lt1h: 1, lt8h: 1, lt24h: 1, gte24h: 1, unknown: 1 });
    // 已处置的行不进待办账龄
    expect(summary.aging.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(5);
    // 账龄文案可读
    expect(summary.aging.find((b) => b.key === 'gte24h')?.label).toContain('24 小时');
  });

  it('按类型分组：计数、最久待办与单位置时长口径齐备，按总量倒序', () => {
    const summary = summarizeNotificationDisposition(
      [
        row({ notificationId: 'NTF-EXO-S1-overdue-app', status: 'pending', createdAt: iso(NOW.getTime() - 30 * HOUR) }),
        row({ notificationId: 'NTF-EXO-S2-overdue-app', status: 'resolved', createdAt: iso(NOW.getTime() - 6 * HOUR), resolvedAt: iso(NOW.getTime() - 4 * HOUR) }),
        row({ notificationId: 'NTF-EXO-S3-telemetry_wearer_mismatch-app', status: 'read', createdAt: iso(NOW.getTime() - 5 * HOUR) }),
        row({ notificationId: 'NTF-EXPR-AP-1-expiring-app', status: 'resolved', externalRef: 'AP-1', createdAt: iso(NOW.getTime() - 3 * HOUR), resolvedAt: iso(NOW.getTime() - 2 * HOUR) }),
      ],
      { now: NOW },
    );
    const overdue = summary.byKind.find((g) => g.kind === 'session_overdue');
    expect(overdue).toMatchObject({ total: 2, pending: 1, resolved: 1, comparable: 1, medianTimeToResolveMs: 2 * HOUR });
    expect(overdue?.oldestPendingAgeMs).toBe(30 * HOUR);
    const mismatch = summary.byKind.find((g) => g.kind === 'telemetry_wearer_mismatch');
    expect(mismatch).toMatchObject({ total: 1, read: 1, resolved: 0, medianTimeToResolveMs: null });
    expect(mismatch?.oldestPendingAgeMs).toBeNull();
    // 排序：总量多的在前
    expect(summary.byKind[0]?.kind).toBe('session_overdue');
    // 每种类型都有中文标签
    expect(summary.byKind.every((g) => g.label.length > 0 && g.label !== g.kind)).toBe(true);
  });

  it('投递失败单独计数（不掩盖、也不被当成"没处置"）', () => {
    const summary = summarizeNotificationDisposition(
      [
        row({ notificationId: 'NTF-EXO-S1-overdue-lark', status: 'failed', channel: 'lark' }),
        row({ notificationId: 'NTF-EXO-S1-overdue-app', status: 'resolved', createdAt: iso(NOW.getTime() - 2 * HOUR), resolvedAt: iso(NOW.getTime() - HOUR) }),
      ],
      { now: NOW },
    );
    expect(summary.totals.failedDelivery).toBe(1);
    expect(summary.totals.resolved).toBe(1);
    expect(summary.byKind.find((g) => g.kind === 'session_overdue')?.failedDelivery).toBe(1);
    expect(summary.notes.join('')).toContain('投递');
  });

  it('反复出现的主事实：按 externalRef 聚合取 Top N，无引用归到"未关联主事实"', () => {
    const many = (ref: string, count: number) =>
      Array.from({ length: count }, (_, i) =>
        row({ notificationId: `NTF-EXO-${ref}-overdue-app-${i}`, externalRef: ref, status: 'pending' }),
      );
    const summary = summarizeNotificationDisposition(
      [...many('exo-session:A', 3), ...many('exo-session:B', 2), row({ externalRef: null, notificationId: 'NTF-1' })],
      { now: NOW, topSources: 2 },
    );
    expect(summary.topSources).toHaveLength(2);
    expect(summary.topSources[0]).toMatchObject({ externalRef: 'exo-session:A', total: 3, pending: 3, resolved: 0 });
    expect(summary.topSources[1]?.externalRef).toBe('exo-session:B');
  });

  it('空列表也给出完整形状（页面不需要特判，也不会显示假比率）', () => {
    const summary = summarizeNotificationDisposition([], { now: NOW });
    expect(summary.scanned).toBe(0);
    expect(summary.totals).toEqual({ total: 0, pending: 0, read: 0, resolved: 0, failedDelivery: 0 });
    expect(summary.dispositionRate).toBeNull();
    expect(summary.medianTimeToResolveMs).toBeNull();
    expect(summary.meanTimeToResolveMs).toBeNull();
    expect(summary.byKind).toEqual([]);
    expect(summary.topSources).toEqual([]);
    expect(summary.aging).toHaveLength(5);
    expect(summary.aging.every((b) => b.count === 0)).toBe(true);
    expect(summary.notes.length).toBeGreaterThan(0);
  });

  it('未登记类型的提醒进 other/unknown 分组（不被静默丢弃）', () => {
    const summary = summarizeNotificationDisposition(
      [row({ notificationId: 'ODD-ID-1' }), row({ notificationId: 'NTF-EXO-S1-brand_new_tag-app' })],
      { now: NOW },
    );
    const kinds = summary.byKind.map((g) => g.kind).sort();
    expect(kinds).toEqual(['other', 'unknown']);
    expect(summary.scanned).toBe(2);
  });
});
