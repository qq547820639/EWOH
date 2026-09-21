import { SchedulerEventApplicationService } from '../scheduler-event-application.service';

describe('SchedulerEventApplicationService approval policy failures', () => {
  it('requires human approval instead of auto-replanning when policy consult is unavailable', async () => {
    const handleTrigger = jest.fn();
    const enqueue = jest.fn().mockResolvedValue(undefined);
    const svc = new SchedulerEventApplicationService(
      {
        analyzeImpactV2: jest.fn().mockRejectedValue(new Error('impact store unavailable')),
        handleTrigger,
      } as never,
      {
        previewReplan: jest.fn().mockResolvedValue({ previewId: 'preview-1' }),
      } as never,
      { enqueue } as never,
      undefined,
      undefined as never,
      {
        resolveReplanApprovalConfig: jest.fn().mockResolvedValue({
          autoMaxAffectedRatio: 0.5,
          autoMaxChurnRatio: 0.4,
          requireApprovalOnSafetyCritical: true,
          requireApprovalOnHumanLock: true,
        }),
      } as never,
      {
        consultReplanApproval: jest.fn(),
      } as never,
      { appendAuditLog: jest.fn() } as never,
      undefined as never,
      async () => {
        throw new Error('comparison unavailable');
      },
    );

    const result = await svc.injectSchedulingEvent(
      { trigger: 'DEVICE_OFFLINE', entityId: 'device-1' },
      {
        userId: 'user-1',
        primaryOrgId: 'org-1',
        accessibleOrgIds: ['org-1'],
        isGlobalAdmin: false,
      } as never,
    );

    expect(result.approval).toEqual({
      decision: 'HUMAN_APPROVAL_REQUIRED',
      reasons: ['approval_policy_unavailable'],
    });
    expect(handleTrigger).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      'replan.approval_required',
      'device-1',
      expect.objectContaining({ triggerType: 'DEVICE_OFFLINE', preview: { previewId: 'preview-1' } }),
      'org-1',
    );
  });
});
