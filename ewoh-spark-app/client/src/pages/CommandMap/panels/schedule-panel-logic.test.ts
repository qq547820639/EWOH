/* Task 4 / P1：SchedulePanel 对比方案选取纯逻辑测试。
 *
 * 核心约束：**绝不回退列表首个方案**——没有可对比的其他方案时返回 null
 * （面板展示空/禁用态），且「对比」双方不能是同一方案。
 */
import { pickComparePlanId } from './schedule-panel-logic';
import type { SchedulingPlanV2 } from '@shared/api.interface';

function makePlan(planId: string): SchedulingPlanV2 {
  return {
    planId,
    planName: planId,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    horizonMinutes: 480,
    assignments: [],
    metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: '',
  };
}

describe('pickComparePlanId（绝不回退列表首个方案）', () => {
  const plans = [makePlan('PLAN-A'), makePlan('PLAN-B'), makePlan('PLAN-C')];

  it('有选中方案 + 存在其他方案 → 返回第一个不同的方案（不为选中方案本身）', () => {
    const picked = pickComparePlanId(plans, 'PLAN-A');
    expect(picked).toBe('PLAN-B');
    expect(picked).not.toBe('PLAN-A'); // 对比双方不能是同一方案
  });

  it('选中非首个方案 → 返回列表首位（首个不同方案）', () => {
    expect(pickComparePlanId(plans, 'PLAN-B')).toBe('PLAN-A');
  });

  it('只有一个方案 → null（不取该方案自身兜底）', () => {
    expect(pickComparePlanId([makePlan('PLAN-A')], 'PLAN-A')).toBeNull();
  });

  it('plans 为空 → null', () => {
    expect(pickComparePlanId([], 'PLAN-A')).toBeNull();
  });

  it('无选中方案 → null（无从对比）', () => {
    expect(pickComparePlanId(plans, null)).toBeNull();
    expect(pickComparePlanId(plans, undefined)).toBeNull();
  });

  it('选中方案不在列表中 → 视其他方案为「另一方案」', () => {
    expect(pickComparePlanId(plans, 'PLAN-NOT-EXIST')).toBe('PLAN-A');
  });
});
