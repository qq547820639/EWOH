/**
 * schedulingLogic.test.ts — Scheduling 数据页纯逻辑测试（ADR-082，§17/§33）。
 */
import {
  formatTime,
  isPendingStatus,
  extractStalenessReport,
  isPlanStaleError,
  orderStalenessChanges,
  stalenessFromError,
  buildPlanSubtitle,
  buildMetricsSummary,
  filterPlansByStatus,
  aggregateMutationErrors,
  buildRunSubtitle,
  STATUS_FILTERS,
  TRIGGER_LABELS,
} from './schedulingLogic';
import type { SchedulingRun } from './schedulingLogic';
import type { SchedulingPlanV2 } from '@shared/api.interface';

describe('schedulingLogic', () => {
  describe('formatTime', () => {
    it('formats ISO timestamp to zh-CN month/day HH:mm', () => {
      const result = formatTime('2026-08-16T08:00:00.000Z');
      expect(result).toMatch(/08[/-]16/);
      expect(result).toContain(':');
    });

    it('returns dash for null/undefined/empty', () => {
      expect(formatTime(null)).toBe('—');
      expect(formatTime(undefined)).toBe('—');
      expect(formatTime('')).toBe('—');
    });
  });

  describe('isPendingStatus', () => {
    it('draft and shadow are pending', () => {
      expect(isPendingStatus('draft')).toBe(true);
      expect(isPendingStatus('shadow')).toBe(true);
    });

    it('approved/dispatched/rejected/completed are not pending', () => {
      expect(isPendingStatus('approved')).toBe(false);
      expect(isPendingStatus('dispatched')).toBe(false);
      expect(isPendingStatus('rejected')).toBe(false);
      expect(isPendingStatus('completed')).toBe(false);
    });
  });

  describe('isPlanStaleError', () => {
    it('409 + PLAN_STALE is a stale error', () => {
      expect(
        isPlanStaleError({
          response: { status: 409, data: { message: 'PLAN_STALE: conflict' } },
        }),
      ).toBe(true);
    });

    it('409 without PLAN_STALE is not stale', () => {
      expect(isPlanStaleError({ response: { status: 409, data: { message: 'OTHER' } } })).toBe(
        false,
      );
    });

    it('409 + message-level PLAN_STALE is stale', () => {
      expect(isPlanStaleError({ response: { status: 409 }, message: 'PLAN_STALE: conflict' })).toBe(true);
    });

    it('PLAN_STALE without 409 status is not stale', () => {
      expect(isPlanStaleError({ message: 'PLAN_STALE' })).toBe(false);
    });

    it('non-409 errors are not stale', () => {
      expect(isPlanStaleError({ response: { status: 500 } })).toBe(false);
      expect(isPlanStaleError({})).toBe(false);
    });
  });

  describe('buildPlanSubtitle', () => {
    const plan = {
      version: 3,
      trigger: { type: 'DEVICE_OFFLINE', entityId: 'dev-1' },
      createdAt: '2026-08-16T08:00:00.000Z',
    } as unknown as SchedulingPlanV2;

    it('includes version, trigger label, and formatted time', () => {
      const subtitle = buildPlanSubtitle(plan);
      expect(subtitle).toContain('v3');
      expect(subtitle).toContain('设备离线');
      expect(subtitle).toContain('08/16');
    });

    it('falls back to raw trigger type for unknown triggers', () => {
      const unknownPlan = {
        ...plan,
        trigger: { type: 'UNKNOWN_TYPE', entityId: null },
      } as unknown as SchedulingPlanV2;
      expect(buildPlanSubtitle(unknownPlan)).toContain('UNKNOWN_TYPE');
    });
  });

  describe('buildMetricsSummary', () => {
    it('formats metrics with fixed decimals', () => {
      const plan = {
        metrics: {
          lateMinutes: 12.6,
          walkingMeters: 345.2,
          stationWaitMinutes: 5.1,
          maxWorkload: 0.85,
        },
      } as unknown as SchedulingPlanV2;
      const summary = buildMetricsSummary(plan);
      expect(summary).toContain('13min');  // 12.6 → 13
      expect(summary).toContain('345m');
      expect(summary).toContain('5min');
      expect(summary).toContain('85%');
    });

    it('handles zero metrics gracefully', () => {
      const plan = {
        metrics: {
          lateMinutes: 0,
          walkingMeters: 0,
          stationWaitMinutes: 0,
          maxWorkload: 0,
        },
      } as unknown as SchedulingPlanV2;
      const summary = buildMetricsSummary(plan);
      expect(summary).toContain('0min');
      expect(summary).toContain('0m');
      expect(summary).toContain('0%');
    });
  });

  describe('filterPlansByStatus', () => {
    const plans = [
      { status: 'draft' },
      { status: 'shadow' },
      { status: 'approved' },
      { status: 'dispatched' },
      { status: 'rejected' },
      { status: 'completed' },
    ] as unknown as SchedulingPlanV2[];

    it('all filter returns everything', () => {
      expect(filterPlansByStatus(plans, 'all')).toHaveLength(6);
    });

    it('pending filter returns draft and shadow only', () => {
      const pending = filterPlansByStatus(plans, 'pending');
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.status)).toEqual(['draft', 'shadow']);
    });

    it('approved filter returns approved + dispatched + executing + completed', () => {
      const approved = filterPlansByStatus(plans, 'approved');
      expect(approved.map((p) => p.status)).toEqual([
        'approved',
        'dispatched',
        'completed',
      ]);
    });
  });

  describe('aggregateMutationErrors', () => {
    it('joins error messages with semicolons', () => {
      const result = aggregateMutationErrors([
        new Error('approval failed'),
        new Error('dispatch timeout'),
      ]);
      expect(result).toBe('approval failed；dispatch timeout');
    });

    it('filters out non-Error values', () => {
      expect(aggregateMutationErrors([new Error('a'), null, 'string', undefined])).toBe('a');
    });

    it('returns null when empty', () => {
      expect(aggregateMutationErrors([])).toBeNull();
      expect(aggregateMutationErrors([null, undefined])).toBeNull();
    });
  });

  describe('buildRunSubtitle', () => {
    it('formats trigger, time, and plan count', () => {
      const run: SchedulingRun = {
        runId: 'run-1',
        status: 'succeeded',
        triggerType: 'BOTTLENECK_DETECTED',
        createdAt: '2026-08-16T10:00:00.000Z',
        planIds: ['p1', 'p2'],
      };
      const subtitle = buildRunSubtitle(run);
      expect(subtitle).toContain('瓶颈检测');
      expect(subtitle).toContain('方案 2 个');
    });
  });

  describe('constants', () => {
    it('STATUS_FILTERS has three entries', () => {
      expect(STATUS_FILTERS).toHaveLength(3);
      expect(STATUS_FILTERS.map((f) => f.value)).toEqual(['all', 'pending', 'approved']);
    });

    it('TRIGGER_LABELS covers known trigger types', () => {
      expect(Object.keys(TRIGGER_LABELS)).toContain('MANUAL');
      expect(Object.keys(TRIGGER_LABELS)).toContain('DEVICE_OFFLINE');
      expect(Object.keys(TRIGGER_LABELS)).toContain('SAFETY_EVENT');
    });
  });
});

describe('NO-62c 方案过期诊断（客户端解析与排序）', () => {
  const report = {
    snapshotVersion: 'WS-1',
    snapshotFound: true,
    stale: true,
    summary: '检测到 2 项外部变化，另有 1 项本方案自身效果',
    checkedAt: '2026-09-12T03:00:00.000Z',
    externalChangeCount: 2,
    selfInflictedCount: 1,
    changes: [
      {
        kind: 'entity_version' as const,
        entityKey: 'task:T-9',
        entityType: 'task',
        entityId: 'T-9',
        change: 'changed' as const,
        selfInflicted: true,
        label: 'task 版本 1 → 2',
      },
      {
        kind: 'entity_version' as const,
        entityKey: 'device:AGV-2',
        entityType: 'device',
        entityId: 'AGV-2',
        change: 'removed' as const,
        selfInflicted: false,
        label: 'device 消失（快照后被移除）',
      },
      {
        kind: 'reservation' as const,
        entityKey: 'reservation:person:P-1',
        entityType: 'person',
        entityId: 'P-1',
        change: 'added' as const,
        selfInflicted: false,
        label: '新增资源预占 person:P-1',
      },
    ],
  };

  it('fromError：从 409 响应体里取出诊断（审批被拒时的现场可见性）', () => {
    expect(stalenessFromError({ response: { status: 409, data: { staleness: report } } })?.summary)
      .toBe(report.summary);
  });

  it('拿不到结构化诊断时返回 null（不编造"状态已变化"来假装有诊断）', () => {
    expect(stalenessFromError({ response: { status: 409, data: { message: 'PLAN_STALE' } } })).toBeNull();
    expect(stalenessFromError(new Error('boom'))).toBeNull();
    expect(extractStalenessReport(null)).toBeNull();
    // 直接传报告本身（GET /staleness 的响应体形状）也要认得
    expect(extractStalenessReport(report)?.stale).toBe(true);
  });

  it('差异排序：外部变化排在本方案自身效果之前 + 截断计数', () => {
    const { shown, hiddenCount } = orderStalenessChanges(report as never, 2);
    expect(shown.map((c) => c.selfInflicted)).toEqual([false, false]);
    expect(shown[0].entityKey < shown[1].entityKey).toBe(true);
    expect(hiddenCount).toBe(1);
  });

  it('截断上限大于差异数时不丢项', () => {
    const { shown, hiddenCount } = orderStalenessChanges(report as never, 10);
    expect(shown).toHaveLength(3);
    expect(hiddenCount).toBe(0);
  });
});
