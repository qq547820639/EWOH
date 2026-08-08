/* v0.7 Batch10.2：影子评估自动化测试
 * 覆盖：
 *   - 每 N 次（10）事件驱动 run 自动触发影子评估（候选 v+1 vs 活跃）
 *   - 无候选版本 → 跳过不评估
 *   - 失败仅记日志不阻断
 */
/// <reference types="jest" />
import { SchedulerService } from '../scheduler.service';
import { WorldStateSnapshotService } from '../world-state.service';
import { PlanService } from '../plan.service';
import { SchedulingFeedbackService } from '../scheduling-feedback.service';

function makeFakeDb() {
  return {
    select: () => ({ from: () => Promise.resolve([]) }),
    update: () => ({ set: jest.fn(() => ({ where: jest.fn(() => Promise.resolve()) })) }),
  };
}

describe('v0.7 Batch10.2: 影子评估自动化', () => {
  function makeSvc(opts: {
    pendingCandidate?: boolean;
    listVersions?: jest.Mock;
    comparePolicyVersion?: jest.Mock;
  }) {
    const auditAppend = jest.fn().mockResolvedValue(undefined);
    const policyService = {
      getConfig: jest.fn().mockResolvedValue({ configVersion: 3 }),
      listVersions:
        opts.listVersions ??
        jest.fn().mockResolvedValue(
          opts.pendingCandidate === false ? [] : [{ configVersion: 4, active: false, updatedBy: 'u1', createdAt: '' }],
        ),
      getConfigByVersion: jest.fn(),
    };
    const comparePolicyVersion = opts.comparePolicyVersion ??
      jest.fn().mockResolvedValue({
        candidateVersion: 4,
        activeVersion: 3,
        feedbackKpis: { acceptanceRate: 0.85 },
        paramDeltas: [],
        objective: { before: 1, after: 0.9 },
        verdict: 'IMPROVE',
        readOnly: true,
      });
    const replanCoordinatorService = {
      handleTrigger: jest.fn().mockResolvedValue({
        run: { runId: 'RUN-S1', status: 'succeeded' },
        plans: [],
        debounced: false,
      }),
      dispatchStateTriggers: jest.fn().mockResolvedValue([]),
    };

    const svc = new SchedulerService(
      makeFakeDb() as never,
      { runInTransaction: jest.fn() } as never,
      { appendAuditLog: auditAppend } as never,
      { buildSnapshot: jest.fn().mockResolvedValue({ snapshotVersion: 'WS', ts: '' } as never) } as unknown as WorldStateSnapshotService,
      {} as never,
      {} as never,
      {} as unknown as PlanService,
      {} as never,
      {} as never,
      {} as never,
      policyService as never,
      { deriveKpis: jest.fn() } as unknown as SchedulingFeedbackService,
      undefined,
      replanCoordinatorService as never,
      undefined,
    );
    // 影子评估内部调用自身 comparePolicyVersion——用 spy 覆盖（非构造依赖）
    const compareSpy = opts.comparePolicyVersion ??
      jest.fn().mockResolvedValue({
        candidateVersion: 4,
        activeVersion: 3,
        feedbackKpis: { acceptanceRate: 0.85 },
        paramDeltas: [],
        objective: { before: 1, after: 0.9 },
        verdict: 'IMPROVE',
        readOnly: true,
      });
    (svc as unknown as { comparePolicyVersion: jest.Mock }).comparePolicyVersion = compareSpy;
    return { svc, auditAppend, comparePolicyVersion: compareSpy, policyService };
  }

  it('第 10 次事件驱动 run 且有候选版本 → 触发影子评估并写审计', async () => {
    const { svc, auditAppend, comparePolicyVersion, policyService } = makeSvc({ pendingCandidate: true });
    const ctx = { userId: 'u1', primaryOrgId: 'org1', accessibleOrgIds: ['org1'], isGlobalAdmin: false };

    for (let i = 0; i < 10; i++) {
      await svc.injectSchedulingEvent({ trigger: 'MANUAL' }, ctx);
    }

    // 调试断言：确认 getConfig/listVersions 被调用（影子评估走到候选查找）
    expect(policyService.getConfig).toHaveBeenCalled();
    expect(policyService.listVersions).toHaveBeenCalled();
    expect(comparePolicyVersion).toHaveBeenCalledTimes(1);
    expect(comparePolicyVersion).toHaveBeenCalledWith(4, expect.any(Object));
    expect(auditAppend).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scheduler.policy.shadow_eval' }),
    );
  });

  it('无候选版本 → 跳过评估', async () => {
    const { svc, comparePolicyVersion } = makeSvc({ pendingCandidate: false });
    const ctx = { userId: 'u1', primaryOrgId: 'org1', accessibleOrgIds: ['org1'], isGlobalAdmin: false };

    for (let i = 0; i < 10; i++) {
      await svc.injectSchedulingEvent({ trigger: 'MANUAL' }, ctx);
    }

    expect(comparePolicyVersion).not.toHaveBeenCalled();
  });
});
