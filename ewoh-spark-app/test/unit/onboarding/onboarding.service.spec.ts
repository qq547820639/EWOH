import { OnboardingService } from '@server/modules/onboarding/onboarding.service';

function siteReadiness(factoryName: string) {
  return {
    factoryName,
    siteContact: 'site@example.com',
    items: [
      {
        id: 'DEV-INV',
        label: '设备台账',
        required: true,
        status: 'pass',
        evidence: 'device-inventory.xlsx',
      },
      {
        id: 'ERP-EP',
        label: 'ERP 端点',
        required: true,
        status: 'pass',
        evidence: 'erp-endpoint.json',
      },
    ],
  };
}

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

  it('returns the partner shadow checklist', () => {
    const service = new OnboardingService(
      {} as never,
      { appendAuditLog: jest.fn() } as never,
    );
    const checklist = service.partnerChecklist();
    expect(checklist.partner).toBe(true);
    expect(checklist.steps).toHaveLength(7);
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
      validateSiteReadiness: jest.fn().mockResolvedValue({
        ready: true,
        requiredCount: 2,
        requiredPassed: 2,
        requiredFailed: 0,
      }),
      installGoldenFactory: jest.fn().mockResolvedValue(golden),
      ensureConnectorInstalled: jest
        .fn()
        .mockImplementation(async (packageId: string) => ({
          packageId,
          name: packageId,
          version: '1.0.0',
          status: 'published',
        })),
      installScenarioPack: jest
        .fn()
        .mockImplementation(async (packageId: string) => ({
          packageId,
          name: packageId,
          version: '1.0.0',
          status: 'installed',
        })),
      runConformance: jest.fn().mockResolvedValue({ passed: true }),
      generateSupportBundle: jest
        .fn()
        .mockResolvedValue({ bundleId: 'SB-ONB' }),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OnboardingService(scaleService as never, audit as never);

    const result = await service.run(
      {
        factoryName: 'Factory Onboarding',
        config: { siteReadiness: siteReadiness('Factory Onboarding') },
      },
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );

    expect(result.overall).toBe('passed');
    expect(result.steps).toHaveLength(7);
    expect(result.steps.every((step) => step.passed)).toBe(true);
    expect(result.supportBundleId).toBe('SB-ONB');
    expect(scaleService.installGoldenFactory).toHaveBeenCalledTimes(1);
    expect(scaleService.validateSiteReadiness).toHaveBeenCalledWith(
      'Factory Onboarding',
      expect.objectContaining({ siteReadiness: expect.any(Object) }),
      { userId: 'user-1', primaryOrgId: 'org-1' },
    );
    expect(scaleService.ensureConnectorInstalled).toHaveBeenCalledTimes(2);
    expect(scaleService.installScenarioPack).toHaveBeenCalledTimes(2);
    expect(scaleService.runConformance).toHaveBeenCalledTimes(4);
    expect(audit.appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'scale.onboarding.run' }),
    );
  });

  it('reports failed steps when template install fails', async () => {
    const scaleService = {
      validateSiteReadiness: jest.fn().mockResolvedValue({
        ready: true,
        requiredCount: 2,
        requiredPassed: 2,
        requiredFailed: 0,
      }),
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

  it('marks partner shadow runs with partnerShadow config', async () => {
    const golden = {
      specVersion: '1.0.0',
      templateId: 'TPL-GOLDEN',
      profileId: 'PRF-PARTNER',
      factoryName: 'Partner Factory',
      connectors: ['PKG-CONN-A'],
      scenarioPacks: ['PKG-SCEN-A'],
      reused: false,
    };
    const scaleService = {
      validateSiteReadiness: jest.fn().mockResolvedValue({
        ready: true,
        requiredCount: 2,
        requiredPassed: 2,
        requiredFailed: 0,
      }),
      installGoldenFactory: jest.fn().mockResolvedValue(golden),
      ensureConnectorInstalled: jest
        .fn()
        .mockResolvedValue({ status: 'published' }),
      installScenarioPack: jest.fn().mockResolvedValue({ status: 'installed' }),
      runConformance: jest.fn().mockResolvedValue({ passed: true }),
      generateSupportBundle: jest
        .fn()
        .mockResolvedValue({ bundleId: 'SB-PARTNER' }),
    };
    const audit = { appendAuditLog: jest.fn().mockResolvedValue(undefined) };
    const service = new OnboardingService(scaleService as never, audit as never);

    const result = await service.partnerShadowRun({
      factoryName: 'Partner Factory',
      config: { siteReadiness: siteReadiness('Partner Factory') },
    });

    expect(result.partner).toBe(true);
    expect(result.overall).toBe('passed');
    expect(scaleService.installGoldenFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ partnerShadow: true }),
      }),
      undefined,
    );
  });
});
