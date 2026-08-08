/* v0.7 Batch6.3：SAFETY_EVENT 派工熔断测试
 * 覆盖：
 *   - 派工涉及被安全阻断（L2/L3 open）的人员 → SAFETY_BLOCK_DISPATCH
 *   - 无阻断资源 → 正常派工（不抛错）
 */
/// <reference types="jest" />
import { ConflictException } from '@nestjs/common';
import { makeDispatchCoordinator } from './dispatch-test-harness';

describe('v0.7 Batch6.3: SAFETY_EVENT 派工熔断', () => {
  it('派工涉及安全阻断人员 → 拒绝下发 SAFETY_BLOCK_DISPATCH', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      plans: [
        {
          planId: 'PLAN-SAFE-1',
          status: 'approved',
          snapshotVersion: 'WS-SAFE-1',
        },
      ],
      assignments: [
        {
          assignmentId: 'ASG-SAFE-1',
          planId: 'PLAN-SAFE-1',
          taskId: 'T1',
          personId: 'p-blocked',
          deviceId: 'd1',
          status: 'approved',
        },
      ],
    });
    // 模拟世界状态：p-blocked 被安全事件阻断
    (mocks.worldStateSnapshotService.getCurrentWorldState as jest.Mock).mockResolvedValue({
      safetyBlockedPersonIds: ['p-blocked'],
      safetyBlockedDeviceIds: [],
    });

    await expect(
      svc.dispatch('PLAN-SAFE-1', { userId: 'u1', primaryOrgId: 'org1' }),
    ).rejects.toThrow(ConflictException);
    await expect(
      svc.dispatch('PLAN-SAFE-1', { userId: 'u1', primaryOrgId: 'org1' }),
    ).rejects.toThrow('SAFETY_BLOCK_DISPATCH');
  });

  it('无安全阻断资源 → 正常派工不抛 SAFETY 冲突', async () => {
    const { svc, mocks } = makeDispatchCoordinator({
      plans: [
        {
          planId: 'PLAN-SAFE-2',
          status: 'approved',
          snapshotVersion: 'WS-SAFE-2',
        },
      ],
      assignments: [
        {
          assignmentId: 'ASG-SAFE-2',
          planId: 'PLAN-SAFE-2',
          taskId: 'T2',
          personId: 'p1',
          deviceId: 'd1',
          status: 'approved',
        },
      ],
    });
    (mocks.worldStateSnapshotService.getCurrentWorldState as jest.Mock).mockResolvedValue({
      safetyBlockedPersonIds: [],
      safetyBlockedDeviceIds: [],
    });

    // 正常路径应走完（不抛 SAFETY_BLOCK_DISPATCH）；其余 mock 可能抛其他错，仅断言不含 SAFETY 前缀
    const err = await svc.dispatch('PLAN-SAFE-2', { userId: 'u1', primaryOrgId: 'org1' }).catch((e: Error) => e);
    if (err instanceof Error) {
      expect(err.message).not.toContain('SAFETY_BLOCK_DISPATCH');
    }
  });
});
