import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
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
}
