import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { load } from 'js-yaml';
import {
  ewohAssetPackage,
  ewohFactoryProfile,
  ewohFactoryTemplate,
} from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export function nextTemplateStatus(current: string, action: string): string | null {
  switch (action) {
    case 'review':
      return current === 'draft' ? 'reviewed' : null;
    case 'certify':
      return current === 'reviewed' ? 'certified' : null;
    case 'publish':
      return current === 'certified' ? 'published' : null;
    case 'deprecate':
      return current === 'published' ? 'deprecated' : null;
    case 'retire':
      return ['deprecated', 'published'].includes(current) ? 'retired' : null;
    default:
      return null;
  }
}

interface GoldenFactorySpec {
  apiVersion: string;
  kind: string;
  metadata: { name: string; version: string };
  spec: {
    compatibleCore: string;
    modules: string[];
    defaults: Record<string, unknown>;
    requiredConnectors: Array<{
      id: string;
      version: string;
      runtime: string;
      protocol: string;
      outputEvents?: string[];
    }>;
    scenarioPacks: Array<{
      id: string;
      version: string;
      workflows: string[];
      policies: string[];
      acceptance: string;
    }>;
  };
}

@Injectable()
export class ScaleService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async registerTemplate(
    body: {
      templateId?: string;
      name: string;
      industry?: string;
      version: string;
      parentTemplateId?: string;
      inheritanceOrder?: number;
      config?: Record<string, unknown>;
      manifest?: Record<string, unknown>;
      compatibleCore?: string;
    },
    actor?: OrgContext,
  ) {
    if (!body.name?.trim() || !body.version?.trim()) {
      throw new BadRequestException('name and version are required');
    }
    const templateId = body.templateId?.trim() || `TPL-${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(ewohFactoryTemplate)
      .values({
        templateId,
        name: body.name.trim(),
        industry: body.industry ?? null,
        version: body.version.trim(),
        parentTemplateId: body.parentTemplateId ?? null,
        inheritanceOrder: body.inheritanceOrder ?? 0,
        lifecycleStatus: 'draft',
        configJson: body.config ?? {},
        manifestJson: body.manifest ?? {},
        compatibleCore: body.compatibleCore ?? null,
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.template.register',
      entityType: 'factory_template',
      entityId: templateId,
      before: null,
      after: { name: row.name, version: row.version, status: row.lifecycleStatus },
    });
    return row;
  }

  async listTemplates() {
    return this.db
      .select()
      .from(ewohFactoryTemplate)
      .orderBy(desc(ewohFactoryTemplate.createdAt));
  }

  async getTemplate(templateId: string) {
    const [row] = await this.db
      .select()
      .from(ewohFactoryTemplate)
      .where(eq(ewohFactoryTemplate.templateId, templateId));
    if (!row) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }
    return row;
  }

  async transitionTemplate(
    templateId: string,
    action: string,
    actor?: OrgContext,
  ) {
    const template = await this.getTemplate(templateId);
    const status = nextTemplateStatus(template.lifecycleStatus ?? 'draft', action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${template.lifecycleStatus}`,
      );
    }
    const [row] = await this.db
      .update(ewohFactoryTemplate)
      .set({
        lifecycleStatus: status,
        publishedAt:
          action === 'publish' ? new Date() : template.publishedAt,
      })
      .where(
        and(
          eq(ewohFactoryTemplate.templateId, templateId),
          eq(ewohFactoryTemplate.lifecycleStatus, template.lifecycleStatus),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `scale.template.${action}`,
      entityType: 'factory_template',
      entityId: templateId,
      before: { status: template.lifecycleStatus },
      after: { status: row.lifecycleStatus },
    });
    return row;
  }

  async installTemplate(
    templateId: string,
    body: { factoryName: string; config?: Record<string, unknown> },
    actor?: OrgContext,
  ) {
    const template = await this.getTemplate(templateId);
    if (template.lifecycleStatus !== 'published') {
      throw new BadRequestException(
        `Template must be published before install (current: ${template.lifecycleStatus})`,
      );
    }
    if (!body.factoryName?.trim()) {
      throw new BadRequestException('factoryName is required');
    }
    const profileId = `PRF-${randomUUID().slice(0, 8)}`;
    const [profile] = await this.db
      .insert(ewohFactoryProfile)
      .values({
        profileId,
        factoryName: body.factoryName.trim(),
        templateId,
        configJson: body.config ?? {},
        status: 'installed',
        installedAt: new Date(),
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.template.install',
      entityType: 'factory_profile',
      entityId: profileId,
      before: null,
      after: { templateId, factoryName: profile.factoryName },
    });
    return profile;
  }

  async listProfiles() {
    return this.db
      .select()
      .from(ewohFactoryProfile)
      .orderBy(desc(ewohFactoryProfile.createdAt));
  }

  async getProfile(profileId: string) {
    const [row] = await this.db
      .select()
      .from(ewohFactoryProfile)
      .where(eq(ewohFactoryProfile.profileId, profileId));
    if (!row) {
      throw new NotFoundException(`Factory profile ${profileId} not found`);
    }
    return row;
  }

  async replayProfile(profileId: string, actor?: OrgContext) {
    const profile = await this.getProfile(profileId);
    const template = await this.getTemplate(profile.templateId);
    const templateConfig =
      (template.configJson as Record<string, unknown> | null) ?? {};
    const profileConfig =
      (profile.configJson as Record<string, unknown> | null) ?? {};
    const mergedConfig = { ...templateConfig, ...profileConfig };
    const [updated] = await this.db
      .update(ewohFactoryProfile)
      .set({
        configJson: mergedConfig,
        status: 'replayed',
        installedAt: new Date(),
      })
      .where(eq(ewohFactoryProfile.profileId, profileId))
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.profile.replay',
      entityType: 'factory_profile',
      entityId: profileId,
      before: { status: profile.status, templateId: profile.templateId },
      after: { status: updated.status, templateId: updated.templateId },
    });
    return updated;
  }

  async registerAssetPackage(
    body: {
      packageId?: string;
      packageType: 'template' | 'connector' | 'scenario' | 'deploy';
      name: string;
      version: string;
      manifest?: Record<string, unknown>;
    },
    actor?: OrgContext,
  ) {
    if (!body.name?.trim() || !body.version?.trim() || !body.packageType) {
      throw new BadRequestException('name, version, and packageType are required');
    }
    const packageId = body.packageId?.trim() || `PKG-${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(ewohAssetPackage)
      .values({
        packageId,
        packageType: body.packageType,
        name: body.name.trim(),
        version: body.version.trim(),
        manifestJson: body.manifest ?? {},
        status: 'draft',
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.asset.register',
      entityType: 'asset_package',
      entityId: packageId,
      before: null,
      after: { name: row.name, version: row.version, type: row.packageType },
    });
    return row;
  }

  async registerConnector(
    body: {
      packageId?: string;
      name: string;
      version: string;
      runtime: string;
      protocol: string;
      inputProfile?: string;
      outputEvents?: string[];
      configSchema?: Record<string, unknown>;
      compatibility?: Record<string, unknown>;
    },
    actor?: OrgContext,
  ) {
    if (!body.runtime?.trim() || !body.protocol?.trim()) {
      throw new BadRequestException('runtime and protocol are required');
    }
    return this.registerAssetPackage(
      {
        packageId: body.packageId,
        packageType: 'connector',
        name: body.name,
        version: body.version,
        manifest: {
          runtime: body.runtime,
          protocol: body.protocol,
          inputProfile: body.inputProfile ?? null,
          outputEvents: body.outputEvents ?? [],
          configSchema: body.configSchema ?? {},
          compatibility: body.compatibility ?? {},
        },
      },
      actor,
    );
  }

  async listConnectors() {
    return this.db
      .select()
      .from(ewohAssetPackage)
      .where(eq(ewohAssetPackage.packageType, 'connector'))
      .orderBy(desc(ewohAssetPackage.createdAt));
  }

  async registerScenarioPack(
    body: {
      packageId?: string;
      name: string;
      version: string;
      requires?: Record<string, unknown>;
      workflows?: string[];
      policies?: string[];
      acceptance?: string;
    },
    actor?: OrgContext,
  ) {
    return this.registerAssetPackage(
      {
        packageId: body.packageId,
        packageType: 'scenario',
        name: body.name,
        version: body.version,
        manifest: {
          requires: body.requires ?? {},
          workflows: body.workflows ?? [],
          policies: body.policies ?? [],
          acceptance: body.acceptance ?? null,
        },
      },
      actor,
    );
  }

  async listScenarioPacks() {
    return this.db
      .select()
      .from(ewohAssetPackage)
      .where(eq(ewohAssetPackage.packageType, 'scenario'))
      .orderBy(desc(ewohAssetPackage.createdAt));
  }

  async listAssetPackages() {
    return this.db
      .select()
      .from(ewohAssetPackage)
      .orderBy(desc(ewohAssetPackage.createdAt));
  }

  async getAssetPackage(packageId: string) {
    const [row] = await this.db
      .select()
      .from(ewohAssetPackage)
      .where(eq(ewohAssetPackage.packageId, packageId));
    if (!row) {
      throw new NotFoundException(`Asset package ${packageId} not found`);
    }
    return row;
  }

  async runConformance(packageId: string, actor?: OrgContext) {
    const asset = await this.getAssetPackage(packageId);
    const manifest = (asset.manifestJson as Record<string, unknown> | null) ?? {};
    const checks: Array<{ check: string; passed: boolean; detail?: string }> = [];
    const push = (check: string, condition: boolean, detail?: string) =>
      checks.push({ check, passed: Boolean(condition), detail });

    if (asset.packageType === 'connector') {
      push('runtime', typeof manifest.runtime === 'string' && manifest.runtime.length > 0);
      push('protocol', typeof manifest.protocol === 'string' && manifest.protocol.length > 0);
      push('configSchema', manifest.configSchema !== undefined);
      push('compatibility', manifest.compatibility !== undefined);
      push(
        'outputEvents',
        Array.isArray(manifest.outputEvents),
        'outputEvents should be an array',
      );
    } else if (asset.packageType === 'scenario') {
      push('requires', manifest.requires !== undefined);
      push('workflows', Array.isArray(manifest.workflows));
      push('policies', Array.isArray(manifest.policies));
      push('acceptance', typeof manifest.acceptance === 'string');
    } else if (asset.packageType === 'template') {
      push('modules', Array.isArray(manifest.modules));
      push('scenarioPacks', Array.isArray(manifest.scenarioPacks));
    } else if (asset.packageType === 'deploy') {
      push('compatibleCore', typeof manifest.compatibleCore === 'string');
      push('config', manifest.config !== undefined);
    }
    push('version', /^\d+\.\d+\.\d+/.test(asset.version), 'semver-like version');

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.conformance.run',
      entityType: 'asset_package',
      entityId: packageId,
      before: null,
      after: { passed: checks.every((check) => check.passed), checks: checks.length },
    });
    return {
      packageId,
      packageType: asset.packageType,
      passed: checks.every((check) => check.passed),
      checks,
    };
  }

  async installScenarioPack(packageId: string, actor?: OrgContext) {
    const asset = await this.getAssetPackage(packageId);
    if (asset.packageType !== 'scenario') {
      throw new BadRequestException('packageType must be scenario');
    }
    const conformance = await this.runConformance(packageId, actor);
    if (!conformance.passed) {
      throw new BadRequestException(
        `Scenario pack ${packageId} does not pass conformance`,
      );
    }
    const [updated] = await this.db
      .update(ewohAssetPackage)
      .set({ status: 'installed', publishedAt: new Date() })
      .where(eq(ewohAssetPackage.packageId, packageId))
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.scenario.install',
      entityType: 'asset_package',
      entityId: packageId,
      before: { status: asset.status },
      after: { status: updated.status },
    });
    return updated;
  }

  async fleetUpgrade(packageId: string, actor?: OrgContext) {
    const conformance = await this.runConformance(packageId, actor);
    if (!conformance.passed) {
      throw new BadRequestException(
        `Package ${packageId} does not pass conformance`,
      );
    }
    const profiles = await this.listProfiles();
    let updated = 0;
    for (const profile of profiles) {
      await this.db
        .update(ewohFactoryProfile)
        .set({ status: 'upgraded', installedAt: new Date() })
        .where(eq(ewohFactoryProfile.profileId, profile.profileId));
      updated += 1;
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.fleet.upgrade',
      entityType: 'asset_package',
      entityId: packageId,
      before: null,
      after: { updatedProfiles: updated },
    });
    return { packageId, updatedProfiles: updated };
  }

  async fleetRollback(actor?: OrgContext) {
    const profiles = await this.listProfiles();
    let updated = 0;
    for (const profile of profiles) {
      await this.db
        .update(ewohFactoryProfile)
        .set({ status: 'rolled_back', installedAt: new Date() })
        .where(eq(ewohFactoryProfile.profileId, profile.profileId));
      updated += 1;
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.fleet.rollback',
      entityType: 'factory_profile',
      entityId: 'fleet',
      before: null,
      after: { rolledBackProfiles: updated },
    });
    return { rolledBackProfiles: updated };
  }

  private goldenSpec(): GoldenFactorySpec {
    const candidates = [
      resolve(process.cwd(), 'contracts/factory/golden-factory.yaml'),
      resolve(process.cwd(), '../contracts/factory/golden-factory.yaml'),
    ];
    const file = candidates.find((candidate) => existsSync(candidate));
    if (!file) {
      throw new BadRequestException('golden factory contract not found');
    }
    return load(readFileSync(file, 'utf8')) as GoldenFactorySpec;
  }

  private async findTemplateByTemplateId(templateId: string) {
    const [row] = await this.db
      .select()
      .from(ewohFactoryTemplate)
      .where(eq(ewohFactoryTemplate.templateId, templateId));
    return row;
  }

  private async findAssetByPackageId(packageId: string) {
    const [row] = await this.db
      .select()
      .from(ewohAssetPackage)
      .where(eq(ewohAssetPackage.packageId, packageId));
    return row;
  }

  private async findProfileByFactoryName(factoryName: string) {
    const [row] = await this.db
      .select()
      .from(ewohFactoryProfile)
      .where(eq(ewohFactoryProfile.factoryName, factoryName));
    return row;
  }

  private async publishAssetPackage(packageId: string) {
    await this.db
      .update(ewohAssetPackage)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(ewohAssetPackage.packageId, packageId));
  }

  private deterministicId(prefix: string, parts: string[]): string {
    const token = parts
      .join(' ')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return `${prefix}-${token}`;
  }

  async installGoldenFactory(
    body: { factoryName: string; config?: Record<string, unknown> },
    actor?: OrgContext,
  ) {
    if (!body.factoryName?.trim()) {
      throw new BadRequestException('factoryName is required');
    }
    const spec = this.goldenSpec();
    const templateId = this.deterministicId('TPL', [
      spec.metadata.name,
      spec.metadata.version,
    ]);
    const manifest = {
      modules: spec.spec.modules,
      scenarioPacks: spec.spec.scenarioPacks.map(
        (pack) => `${pack.id}@${pack.version}`,
      ),
      requiredConnectors: spec.spec.requiredConnectors.map(
        (connector) => `${connector.id}@${connector.version}`,
      ),
      compatibleCore: spec.spec.compatibleCore,
    };

    let template = await this.findTemplateByTemplateId(templateId);
    if (!template) {
      template = await this.registerTemplate(
        {
          templateId,
          name: spec.metadata.name,
          version: spec.metadata.version,
          config: spec.spec.defaults,
          manifest,
          compatibleCore: spec.spec.compatibleCore,
        },
        actor,
      );
    }
    if (template.lifecycleStatus !== 'published') {
      for (const action of ['review', 'certify', 'publish']) {
        template = await this.transitionTemplate(
          templateId,
          action,
          actor,
        );
      }
    }

    const connectors: string[] = [];
    for (const connector of spec.spec.requiredConnectors) {
      const packageId = this.deterministicId('PKG-CONN', [
        connector.id,
        connector.version,
      ]);
      const existing = await this.findAssetByPackageId(packageId);
      if (!existing) {
        await this.registerConnector(
          {
            packageId,
            name: connector.id,
            version: connector.version,
            runtime: connector.runtime,
            protocol: connector.protocol,
            outputEvents: connector.outputEvents ?? [],
          },
          actor,
        );
      }
      await this.publishAssetPackage(packageId);
      connectors.push(packageId);
    }

    const scenarioPacks: string[] = [];
    for (const pack of spec.spec.scenarioPacks) {
      const packageId = this.deterministicId('PKG-SCEN', [
        pack.id,
        pack.version,
      ]);
      const existing = await this.findAssetByPackageId(packageId);
      if (!existing) {
        await this.registerScenarioPack(
          {
            packageId,
            name: pack.id,
            version: pack.version,
            requires: { core: spec.spec.compatibleCore },
            workflows: pack.workflows,
            policies: pack.policies,
            acceptance: pack.acceptance,
          },
          actor,
        );
      }
      await this.installScenarioPack(packageId, actor);
      scenarioPacks.push(packageId);
    }

    const existingProfile = await this.findProfileByFactoryName(
      body.factoryName.trim(),
    );
    const profile = existingProfile
      ? existingProfile
      : await this.installTemplate(
          templateId,
          {
            factoryName: body.factoryName.trim(),
            config: { ...spec.spec.defaults, ...(body.config ?? {}) },
          },
          actor,
        );

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'scale.golden.install',
      entityType: 'factory_profile',
      entityId: profile.profileId,
      before: null,
      after: {
        specVersion: spec.metadata.version,
        templateId,
        reused: Boolean(existingProfile),
        connectors,
        scenarioPacks,
      },
    });

    return {
      specVersion: spec.metadata.version,
      templateId,
      profileId: profile.profileId,
      factoryName: profile.factoryName,
      connectors,
      scenarioPacks,
      reused: Boolean(existingProfile),
    };
  }
}
