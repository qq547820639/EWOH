import { deriveNarrationStatus, NARRATION_PENDING_WINDOW_MS } from './narration';
import type { SchedulingPlanV2 } from '@shared/api.interface';

/** 构造最小可用方案（仅取派生所需字段，其余留空）。 */
function plan(aiNarration: string | null, createdAt: string): SchedulingPlanV2 {
  return {
    planId: 'PLN-1',
    version: 1,
    status: 'draft',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'snap',
    policyVersion: 1,
    solverVersion: 'test',
    horizonMinutes: 480,
    assignments: [],
    metrics: {
      lateMinutes: 0,
      walkingMeters: 0,
      stationWaitMinutes: 0,
      maxWorkload: 0,
      changeCost: 0,
    },
    baselineDelta: {},
    violations: [],
    createdAt,
    aiNarration,
  } as SchedulingPlanV2;
}

const NOW = Date.parse('2026-09-01T10:00:00.000Z');

describe('deriveNarrationStatus（OD-6 异步可见）', () => {
  it('有解读内容时判定为 done', () => {
    expect(deriveNarrationStatus(plan('这是 AI 解读', '2026-09-01T09:59:00.000Z'), NOW)).toBe(
      'done',
    );
  });

  it('空白字符串视为无内容', () => {
    expect(deriveNarrationStatus(plan('   ', '2026-09-01T09:59:00.000Z'), NOW)).not.toBe('done');
  });

  it('无内容且在窗口内判定为 pending（此前此处是永久空白）', () => {
    const created = new Date(NOW - 60_000).toISOString();
    expect(deriveNarrationStatus(plan(null, created), NOW)).toBe('pending');
  });

  it('无内容且超出窗口判定为 unavailable', () => {
    const created = new Date(NOW - NARRATION_PENDING_WINDOW_MS - 1).toISOString();
    expect(deriveNarrationStatus(plan(null, created), NOW)).toBe('unavailable');
  });

  it('窗口边界：恰好等于阈值时不再是 pending', () => {
    const created = new Date(NOW - NARRATION_PENDING_WINDOW_MS).toISOString();
    expect(deriveNarrationStatus(plan(null, created), NOW)).toBe('unavailable');
  });

  it('createdAt 非法时不抛错，降级为 unavailable', () => {
    expect(deriveNarrationStatus(plan(null, 'not-a-date'), NOW)).toBe('unavailable');
  });

  it('方案缺失时返回 unavailable 而非抛错', () => {
    expect(deriveNarrationStatus(null, NOW)).toBe('unavailable');
  });
});
