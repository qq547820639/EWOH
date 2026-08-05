import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
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

// ---------------------------------------------------------------------------
// 样例工厂（sample factory）安全守卫
// ---------------------------------------------------------------------------
// 目标：可重复 init + 安全 clear，且绝不污染真实生产数据。
//  - 所有样例数据都放在明确标记的「演示」工厂名（前缀）下；
//  - init/clear 都必须在请求体携带 guard token，且 token 必须与
//    EWOH_SAMPLE_FACTORY_TOKEN 环境变量匹配（未配置时在非生产环境允许
//    内置开发 token，生产环境直接 BLOCKED）；
//  - 真实数据库不可用时返回明确的 BLOCKED，绝不假装成功。

/** 演示工厂名前缀，所有样例数据都以此为标识，便于安全、可重入地清理。 */
export const SAMPLE_FACTORY_PREFIX = '【演示】';

/** guard token 环境变量名。 */
export const SAMPLE_FACTORY_TOKEN_ENV = 'EWOH_SAMPLE_FACTORY_TOKEN';

/** 非生产环境下的内置开发 token（生产环境必须显式配置，否则 BLOCKED）。 */
export const SAMPLE_FACTORY_DEV_TOKEN = 'ewoh-demo-2026';

export type SampleFactoryGuardReason =
  | 'GUARD_TOKEN_NOT_CONFIGURED'
  | 'GUARD_TOKEN_MISMATCH';

export type SampleFactoryBlockedReason =
  | SampleFactoryGuardReason
  | 'DATABASE_UNAVAILABLE';

/** 解析应生效的 guard token。未配置且处于生产环境时返回 null（BLOCKED）。 */
export function resolveSampleFactoryGuardToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env[SAMPLE_FACTORY_TOKEN_ENV]?.trim();
  if (configured) return configured;
  return env.NODE_ENV === 'production' ? null : SAMPLE_FACTORY_DEV_TOKEN;
}

/** 校验 guard token（纯函数，便于单测）。 */
export function assertSampleFactoryGuard(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; reason: SampleFactoryGuardReason } {
  const expected = resolveSampleFactoryGuardToken(env);
  if (!expected) return { ok: false, reason: 'GUARD_TOKEN_NOT_CONFIGURED' };
  if (token !== expected) return { ok: false, reason: 'GUARD_TOKEN_MISMATCH' };
  return { ok: true };
}

/** 强制校验演示前缀，避免样例数据落到生产工厂名下。 */
export function ensureSampleFactoryName(
  factoryName: string,
  fallback = `${SAMPLE_FACTORY_PREFIX}样例工厂`,
): string {
  const name = factoryName?.trim() || fallback;
  if (!name.startsWith(SAMPLE_FACTORY_PREFIX)) {
    throw new BadRequestException(
      `样例工厂名称必须以演示前缀「${SAMPLE_FACTORY_PREFIX}」开头`,
    );
  }
  return name;
}

/** 由失败的 guard 结果构建明确的 ForbiddenException（BLOCKED）。 */
function sampleFactoryForbidden(
  guard: { ok: false; reason: SampleFactoryGuardReason },
): ForbiddenException {
  return new ForbiddenException({
    code: guard.reason,
    message:
      guard.reason === 'GUARD_TOKEN_NOT_CONFIGURED'
        ? '样例工厂未启用：请配置 EWOH_SAMPLE_FACTORY_TOKEN 环境变量'
        : '样例工厂 guard token 不匹配，已阻止操作',
  });
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

  /**
   * 样例工厂状态：报告数据库是否可用、演示数据是否存在。此端点无需 guard
   * token（只读），但会明确给出 BLOCKED 状态与原因。
   */
  async sampleFactoryStatus(actor?: OrgContext) {
    const dbAvailable = await this.scaleService.isDatabaseAvailable();
    let demoProfiles: Array<{ profileId: string; factoryName: string }> = [];
    if (dbAvailable) {
      const profiles = await this.scaleService.listDemoProfiles(
        SAMPLE_FACTORY_PREFIX,
      );
      demoProfiles = profiles.map((profile) => ({
        profileId: profile.profileId,
        factoryName: profile.factoryName,
      }));
    }
    return {
      status: dbAvailable ? 'ready' : 'BLOCKED',
      reason: dbAvailable ? undefined : ('DATABASE_UNAVAILABLE' as const),
      prefix: SAMPLE_FACTORY_PREFIX,
      dbAvailable,
      demoProfileCount: demoProfiles.length,
      demoProfiles,
      guardConfigured: Boolean(resolveSampleFactoryGuardToken()),
      actorId: actor?.userId ?? 'system',
    };
  }

  /**
   * 样例工厂初始化（可重复）：校验 guard token + 数据库可用性，然后在演示
   * 前缀下创建样例工厂。任何守卫失败都抛明确错误，绝不假装成功。
   */
  async sampleFactoryInit(
    body: { token: string; factoryName?: string },
    actor?: OrgContext,
  ) {
    const guard = assertSampleFactoryGuard(body?.token);
    if (guard.ok === false) {
      throw sampleFactoryForbidden(guard);
    }
    const dbAvailable = await this.scaleService.isDatabaseAvailable();
    if (!dbAvailable) {
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE',
        message:
          '真实数据库不可用，样例工厂初始化已阻止，未写入任何数据。请先恢复数据库连接。',
      });
    }
    const factoryName = ensureSampleFactoryName(body?.factoryName);
    const result = await this.scaleService.installGoldenFactory(
      {
        factoryName,
        config: { demo: true, sampleFactory: true, upgradeRing: 'dev' },
      },
      actor,
    );
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.sample_factory.init',
      entityType: 'factory_profile',
      entityId: result.profileId,
      before: null,
      after: {
        factoryName: result.factoryName,
        templateId: result.templateId,
        reused: result.reused,
      },
    });
    return {
      status: 'created',
      factoryName: result.factoryName,
      profileId: result.profileId,
      templateId: result.templateId,
      reused: result.reused,
    };
  }

  /**
   * 样例工厂安全清理：校验 guard token + 数据库可用性，仅删除演示前缀下的
   * 数据，绝不触碰生产工厂。
   */
  async sampleFactoryClear(
    body: { token: string },
    actor?: OrgContext,
  ) {
    const guard = assertSampleFactoryGuard(body?.token);
    if (guard.ok === false) {
      throw sampleFactoryForbidden(guard);
    }
    const dbAvailable = await this.scaleService.isDatabaseAvailable();
    if (!dbAvailable) {
      throw new ServiceUnavailableException({
        code: 'DATABASE_UNAVAILABLE',
        message:
          '真实数据库不可用，样例工厂清理已阻止。',
      });
    }
    const { removed, profileIds } =
      await this.scaleService.clearDemoProfiles(
        SAMPLE_FACTORY_PREFIX,
        actor,
      );
    return {
      status: 'cleared',
      removed,
      profileIds,
      prefix: SAMPLE_FACTORY_PREFIX,
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
