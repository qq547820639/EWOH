/* P0-8：CommandMap Plan 层选中方案选择（纯函数测试）。
 *
 * 背景：旧 PlanLayer 直接 `state.plans[0]`（无视用户选中的方案），而 SchedulePanel
 * 有独立 selectedPlanId 状态（初值 null，深链回退 plans[0]）——两者不同源，
 * 地图连线可能与面板展示的方案不一致。
 *
 * 修复：PlanLayer 通过 selectPlanForLayer(plans, selectedPlanId) 定位方案，
 * 只使用 selectedPlanId（不回退 plans[0]）。
 */
import { selectPlanForLayer } from './SchedulerLayers';
import type { SchedulingPlanV2 } from '@shared/api.interface';

function makePlan(planId: string): SchedulingPlanV2 {
  return {
    planId,
    version: 1,
    status: 'shadow',
    trigger: { type: 'MANUAL', entityId: null },
    snapshotVersion: 'WS',
    policyVersion: 1,
    solverVersion: 'heuristic-v2',
    solverStatus: 'HEURISTIC',
    horizonMinutes: 480,
    assignments: [],
    metrics: { lateMinutes: 0, walkingMeters: 0, stationWaitMinutes: 0, maxWorkload: 0, changeCost: 0 },
    baselineDelta: {},
    violations: [],
    createdAt: new Date().toISOString(),
  };
}

describe('P0-8: selectPlanForLayer（PlanLayer 选中方案）', () => {
  const plans = [makePlan('PLAN-A'), makePlan('PLAN-B')];

  it('有 selectedPlanId → 返回对应方案（而非 plans[0]）', () => {
    // PLAN-A 是 plans[0]，但选中 PLAN-B 时必须返回 PLAN-B。
    const plan = selectPlanForLayer(plans, 'PLAN-B');
    expect(plan?.planId).toBe('PLAN-B');
  });

  it('selectedPlanId 为 null → 返回 null（绝不回退 plans[0]）', () => {
    expect(selectPlanForLayer(plans, null)).toBeNull();
    expect(selectPlanForLayer(plans, undefined)).toBeNull();
  });

  it('未知 selectedPlanId → 返回 null（不渲染错误方案）', () => {
    expect(selectPlanForLayer(plans, 'PLAN-NOT-EXIST')).toBeNull();
  });

  it('空 plans → 返回 null', () => {
    expect(selectPlanForLayer([], 'PLAN-A')).toBeNull();
  });
});
