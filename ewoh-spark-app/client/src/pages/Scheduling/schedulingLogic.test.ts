/**
 * schedulingLogic.test.ts — Scheduling 数据页纯逻辑测试（ADR-082，§17/§33）。
 */
import {
  formatTime,
  isPendingStatus,
  isPlanStaleError,
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
