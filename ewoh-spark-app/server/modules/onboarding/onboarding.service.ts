import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ScaleService } from '../scale/scale.service';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

const ONBOARDING_STEPS = [
  {
    code: 'F0',
    name: 'factory_profile_select',
    description: 'Select and validate the factory profile',
  },
  {
    code: 'F1',
    name: 'template_publish',
    description: 'Ensure the factory template is published',
  },
  {
    code: 'F2',
    name: 'connector_install',
    description: 'Publish required connector packages',
  },
  {
    code: 'F3',
    name: 'scenario_install',
    description: 'Install TCK-passing scenario packs',
  },
  {
    code: 'F4',
    name: 'profile_install',
    description: 'Install the factory profile',
  },
  {
    code: 'F5',
    name: 'conformance',
    description: 'Run asset conformance checks',
  },
  {
    code: 'F6',
    name: 'evidence_bundle',
    description: 'Generate the support/evidence bundle',
  },
] as const;

export interface OnboardingStepResult {
  code: string;
  name: string;
  passed: boolean;
  skipped?: boolean;
  detail?: string;
  durationMs: number;
  data?: unknown;
}

interface GoldenResult {
  specVersion: string;
  templateId: string;
  profileId: string;
  factoryName: string;
  connectors: string[];
  scenarioPacks: string[];
  reused: boolean;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly scaleService: ScaleService,
    private readonly auditService: AuditService,
  ) {}

  checklist() {
    return {
      version: '1.0.0',
      steps: ONBOARDING_STEPS,
    };
  }

  partnerChecklist() {
    return {
      version: '1.0.0',
      partner: true,
      steps: ONBOARDING_STEPS,
    };
  }

  async partnerShadowRun(
    body: {
      factoryName: string;
      config?: Record<string, unknown>;
    },
    actor?: OrgContext,
  ) {
    const result = await this.run(
      {
        factoryName: body.factoryName,
        config: { ...(body.config ?? {}), partnerShadow: true },
      },
      actor,
    );
    return { ...result, partner: true };
  }

  async run(
    body: {
      factoryName: string;
      config?: Record<string, unknown>;
    },
    actor?: OrgContext,
  ) {
    const startedAt = new Date().toISOString();
    const runId = `ONB-${randomUUID().slice(0, 8)}`;
    const steps: OnboardingStepResult[] = [];
    let templateId = '';
    let profileId = '';
    let factoryName = body.factoryName;
    let supportBundleId = '';
    let golden: GoldenResult | undefined;

    const execute = async (
      step: (typeof ONBOARDING_STEPS)[number],
      operation: () => Promise<{ detail?: string; data?: unknown }>,
    ) => {
      const started = Date.now();
      try {
        const result = await operation();
        steps.push({
          code: step.code,
          name: step.name,
          passed: true,
          detail: result.detail,
          durationMs: Date.now() - started,
          data: result.data,
        });
        return true;
      } catch (error) {
        steps.push({
          code: step.code,
          name: step.name,
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - started,
        });
        return false;
      }
    };

    let passed = await execute(ONBOARDING_STEPS[0], async () => {
      const readiness = await this.scaleService.validateSiteReadiness(
        body.factoryName,
        body.config,
        actor,
      );
      return {
        detail: `site readiness validated: ${readiness.requiredPassed}/${readiness.requiredCount} required checks passed`,
        data: { config: body.config ?? {}, readiness },
      };
    });

    if (passed) {
      passed = await execute(ONBOARDING_STEPS[1], async () => {
        const result = await this.scaleService.installGoldenFactory(body, actor);
        golden = result;
        templateId = result.templateId;
        profileId = result.profileId;
        factoryName = result.factoryName;
        return {
          detail: `template ${result.templateId} published`,
          data: { templateId: result.templateId, reused: result.reused },
        };
      });
    }

    if (passed) {
      passed = await execute(ONBOARDING_STEPS[2], async () => {
        const installed = [];
        for (const packageId of golden!.connectors) {
          const connector = await this.scaleService.ensureConnectorInstalled(
            packageId,
            actor,
          );
          installed.push({
            packageId,
            name: connector.name,
            version: connector.version,
            status: connector.status,
          });
        }
        return {
          detail: `${installed.length} connectors published/verified`,
          data: { connectors: installed },
        };
      });
    }

    if (passed) {
      passed = await execute(ONBOARDING_STEPS[3], async () => {
        const installed = [];
        for (const packageId of golden!.scenarioPacks) {
          const scenario = await this.scaleService.installScenarioPack(
            packageId,
            actor,
          );
          installed.push({
            packageId,
            name: scenario.name,
            version: scenario.version,
            status: scenario.status,
          });
        }
        return {
          detail: `${installed.length} scenario packs installed/verified`,
          data: { scenarioPacks: installed },
        };
      });
    }

    if (passed) {
      passed = await execute(ONBOARDING_STEPS[4], async () => {
        profileId = golden!.profileId;
        return {
          detail: `profile ${golden!.profileId} installed`,
          data: { profileId: golden!.profileId, reused: golden!.reused },
        };
      });
    }

    if (passed) {
      passed = await execute(ONBOARDING_STEPS[5], async () => {
        const checks = [];
        for (const packageId of [
          ...golden!.connectors,
          ...golden!.scenarioPacks,
        ]) {
          const result = await this.scaleService.runConformance(
            packageId,
            actor,
          );
          checks.push({ packageId, passed: result.passed });
        }
        return {
          detail: `${checks.length} assets checked`,
          data: { checks },
        };
      });
    }

    if (passed) {
      passed = await execute(ONBOARDING_STEPS[6], async () => {
        const bundle = await this.scaleService.generateSupportBundle(actor);
        supportBundleId = bundle.bundleId;
        return {
          detail: `support bundle ${bundle.bundleId} generated`,
          data: { bundleId: bundle.bundleId },
        };
      });
    }

    const completedAt = new Date().toISOString();
    const passedSteps = steps.filter((step) => step.passed).length;
    const failedSteps = steps.filter((step) => !step.passed).length;
    const overall = passedSteps === ONBOARDING_STEPS.length ? 'passed' : 'failed';

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.onboarding.run',
      entityType: 'factory_profile',
      entityId: profileId || 'onboarding',
      before: null,
      after: {
        runId,
        factoryName,
        templateId,
        profileId,
        supportBundleId,
        overall,
        passedSteps,
        failedSteps,
      },
    });

    return {
      runId,
      startedAt,
      completedAt,
      factoryName,
      templateId,
      profileId,
      supportBundleId,
      overall,
      steps,
    };
  }
}
