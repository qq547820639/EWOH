import { OnboardingService } from '@server/modules/onboarding/onboarding.service';

describe('OnboardingService', () => {
  it('returns the F0-F6 onboarding checklist', () => {
    const service = new OnboardingService(
      {} as never,
      { appendAuditLog: jest.fn() } as never,
    );
    const checklist = service.checklist();

    expect(checklist.version).toBe('1.0.0');
    expect(checklist.steps).toHaveLength(7);
    expect(checklist.steps[0].code).toBe('F0');
    expect(checklist.steps[6].code).toBe('F6');
  });

  it('runs all steps and reports passed', async () => {
    const golden = {
      specVersion: '1.0.0',
      templateId: 'TPL-GOLDEN',
      profileId: 'PRF-ONB',
      factoryName: 'Factory Onboarding',
      connectors: ['PKG-CONN-A', 'PKG-CONN-B'],
      scenarioPacks: ['PKG-SCEN-A', 'PKG-SCEN-B'],
      reused: false,
    };
    const scaleService = {
      installGoldenFactory: jest.fn().mockResolvedValue(golden),
      runConformance: jest.fn().mockResolvedValue({ passed: true }),
      generateSupportBundle: jest
        .fn()
        .mockResolvedValue({ bundleId: 'SB-ONB' }),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OnboardingService(scaleService as never, audit as never);

    const result = await service.run(
      { factoryName: 'Factory Onboarding' },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.overall).toBe('passed');
    expect(result.steps).toHaveLength(7);
    expect(result.steps.every((step) => step.passed)).toBe(true);
    expect(result.supportBundleId).toBe('SB-ONB');
    expect(scaleService.installGoldenFactory).toHaveBeenCalledTimes(1);
    expect(scaleService.runConformance).toHaveBeenCalledTimes(4);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.onboarding.run' }),
    );
  });

  it('reports failed steps when template install fails', async () => {
    const scaleService = {
      installGoldenFactory: jest
        .fn()
        .mockRejectedValue(new Error('template not published')),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OnboardingService(scaleService as never, audit as never);

    const result = await service.run({ factoryName: 'Broken Factory' });

    expect(result.overall).toBe('failed');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].passed).toBe(true);
    expect(result.steps[1].passed).toBe(false);
    expect(result.steps[1].detail).toContain('template not published');
  });
});
