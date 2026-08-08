/* P1-5 Production Demo 隔离测试：演示方案识别（不可审批/驳回/派工）。 */
import { isNonAuthoritativePlan } from './schedule-panel-demo';

describe('P1-5 isNonAuthoritativePlan（演示方案识别）', () => {
  it('planId 以 DEMO 开头 → 非权威（禁止审批/派工）', () => {
    expect(isNonAuthoritativePlan({ planId: 'DEMO-123', snapshotVersion: 'WS-1' })).toBe(true);
  });

  it('snapshotVersion 为 demo-snapshot → 非权威', () => {
    expect(isNonAuthoritativePlan({ planId: 'PLAN-1', snapshotVersion: 'demo-snapshot' })).toBe(true);
  });

  it('正常方案（无 DEMO 前缀、非 demo snapshot）→ 权威可操作', () => {
    expect(
      isNonAuthoritativePlan({ planId: 'PLAN-abc', snapshotVersion: 'WS-20260808-0001' }),
    ).toBe(false);
  });

  it('null → 非权威（无方案不可操作）', () => {
    expect(isNonAuthoritativePlan(null)).toBe(false);
  });
});
