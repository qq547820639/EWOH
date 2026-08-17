import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, like } from 'drizzle-orm';
import { ewohSchedulerConfig } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';

export const AAS_VALUE_TYPES = [
  'string',
  'integer',
  'number',
  'boolean',
  'dateTime',
  'json',
] as const;

export interface AasElement {
  idShort: string;
  value: unknown;
  valueType: string;
  unit?: string;
  semanticId?: string;
}

export interface AasSubmodelInput {
  id: string;
  idShort?: string;
  elements?: AasElement[];
}

export interface AasAssetRecord {
  assetId: string;
  idShort: string;
  submodels: Array<{
    id: string;
    idShort: string;
    elements: AasElement[];
  }>;
  importedBy: string;
  importedAt: string;
}

interface ConfigRow {
  configKey: string;
  configValue: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

function validateElements(elements: unknown): AasElement[] {
  if (!Array.isArray(elements)) {
    throw new BadRequestException('AAS submodel elements must be an array');
  }
  return elements.map((element) => {
    if (!element || typeof element !== 'object') {
      throw new BadRequestException('AAS element must be an object');
    }
    const record = element as Partial<AasElement>;
    if (!record.idShort?.trim()) {
      throw new BadRequestException('AAS element requires idShort');
    }
    const valueType = record.valueType ?? 'string';
    if (!AAS_VALUE_TYPES.includes(valueType as never)) {
      throw new BadRequestException(`unsupported AAS valueType: ${valueType}`);
    }
    return {
      idShort: record.idShort.trim(),
      value: record.value,
      valueType,
      unit: record.unit,
      semanticId: record.semanticId,
    };
  });
}

function validateSubmodels(submodels: unknown) {
  if (!Array.isArray(submodels)) {
    throw new BadRequestException('AAS submodels must be an array');
  }
  return submodels.map((submodel) => {
    if (!submodel || typeof submodel !== 'object') {
      throw new BadRequestException('AAS submodel must be an object');
    }
    const record = submodel as Partial<AasSubmodelInput>;
    if (!record.id?.trim()) {
      throw new BadRequestException('AAS submodel requires id');
    }
    return {
      id: record.id.trim(),
      idShort: record.idShort?.trim() || record.id.trim(),
      elements: validateElements(record.elements ?? []),
    };
  });
}

@Injectable()
export class AasService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  private parseRecord(row: ConfigRow): AasAssetRecord {
    const value = (row.configValue as Partial<AasAssetRecord> | null) ?? {};
    return {
      assetId: value.assetId ?? row.configKey.replace(/^aas\./, ''),
      idShort: value.idShort ?? row.configKey,
      submodels: value.submodels ?? [],
      importedBy: value.importedBy ?? row.updatedBy ?? 'system',
      importedAt: value.importedAt ?? row.updatedAt.toISOString(),
    };
  }

  async importAsset(
    body: {
      assetId: string;
      idShort?: string;
      submodels?: AasSubmodelInput[];
    },
    actor?: OrgContext,
  ) {
    if (!body.assetId?.trim()) {
      throw new BadRequestException('AAS assetId is required');
    }
    // NEST-420：写入显式携带 orgId（onConflict target 含 orgId 而插入省略，
    // NULL 不参与唯一冲突 → 无限插入新行）。
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：AAS 资产导入必须带租户上下文',
      );
    }
    const record: AasAssetRecord = {
      assetId: body.assetId.trim(),
      idShort: body.idShort?.trim() || body.assetId.trim(),
      submodels: validateSubmodels(body.submodels ?? []),
      importedBy: actor?.userId ?? 'system',
      importedAt: new Date().toISOString(),
    };
    const [row] = await this.db
      .insert(ewohSchedulerConfig)
      .values({
        configKey: `aas.${record.assetId}`,
        configValue: record as unknown as Record<string, unknown>,
        updatedBy: actor?.userId ?? 'system',
        orgId,
      })
      .onConflictDoUpdate({
        target: [ewohSchedulerConfig.orgId, ewohSchedulerConfig.configKey],
        set: {
          configValue: record as unknown as Record<string, unknown>,
          updatedBy: actor?.userId ?? 'system',
        },
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'aas.asset.import',
      entityType: 'aas_asset',
      entityId: record.assetId,
      before: null,
      after: {
        idShort: record.idShort,
        submodelCount: record.submodels.length,
      },
    });
    return this.parseRecord(row);
  }

  /** NEST-421：org 过滤（global_admin 放行；org 缺失 401）。 */
  async listAssets(actor?: OrgContext) {
    const orgId = actor?.primaryOrgId?.trim();
    if (!actor?.isGlobalAdmin && !orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：AAS 资产列表必须带租户上下文',
      );
    }
    const rows = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(
        actor?.isGlobalAdmin
          ? like(ewohSchedulerConfig.configKey, 'aas.%')
          : and(
              eq(ewohSchedulerConfig.orgId, orgId as string),
              like(ewohSchedulerConfig.configKey, 'aas.%'),
            ),
      )
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => this.parseRecord(row));
  }

  /** NEST-421：单条读 org 守卫（跨租户 404）。 */
  async getAsset(assetId: string, actor?: OrgContext) {
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(eq(ewohSchedulerConfig.configKey, `aas.${assetId}`));
    if (!row) {
      throw new NotFoundException(`AAS asset ${assetId} not found`);
    }
    assertTenantVisible(row.orgId, actor, `AAS asset ${assetId}`);
    return this.parseRecord(row);
  }

  async getSemantics(assetId: string, actor?: OrgContext) {
    const record = await this.getAsset(assetId, actor);
    return {
      assetId: record.assetId,
      idShort: record.idShort,
      semantics: record.submodels.map((submodel) => submodel.idShort),
      submodels: record.submodels.map((submodel) => ({
        id: submodel.id,
        idShort: submodel.idShort,
        properties: submodel.elements.map((element) => ({
          name: element.idShort,
          value: element.value,
          valueType: element.valueType,
          unit: element.unit,
          semanticId: element.semanticId,
        })),
      })),
    };
  }
}
