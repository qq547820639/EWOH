import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, eq, like } from 'drizzle-orm';
import { ewohSchedulerConfig } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export type ParameterDataType =
  | 'number'
  | 'integer'
  | 'string'
  | 'boolean'
  | 'json';

export const PARAMETER_DATA_TYPES: ParameterDataType[] = [
  'number',
  'integer',
  'string',
  'boolean',
  'json',
];

interface ParameterValidation {
  min?: number;
  max?: number;
  enum?: unknown[];
  pattern?: string;
}

export interface ParameterHistoryEntry {
  version: number;
  value: unknown;
  status: string;
  source: string;
  updatedBy: string;
  updatedAt: string;
  note?: string;
}

export interface ParameterValue {
  key: string;
  name: string;
  dataType: ParameterDataType;
  unit?: string;
  current: unknown;
  history: ParameterHistoryEntry[];
  status: 'draft' | 'pending' | 'active' | 'retired';
  version: number;
  source: string;
  approvalRequired: boolean;
  scope: {
    factoryId?: string;
    workCenterId?: string;
    deviceId?: string;
  };
  effectiveFrom?: string;
  effectiveUntil?: string;
  validation?: ParameterValidation;
  updatedBy: string;
  updatedAt: string;
}

interface ConfigRow {
  configKey: string;
  configValue: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

function nowIso(): string {
  return new Date().toISOString();
}

function configKeyFor(key: string): string {
  return `param.${key.startsWith('param.') ? key.slice('param.'.length) : key}`;
}

function plainKey(configKey: string): string {
  return configKey.startsWith('param.') ? configKey.slice('param.'.length) : configKey;
}

function validateValue(
  dataType: ParameterDataType,
  value: unknown,
  validation?: ParameterValidation,
): void {
  if (dataType === 'number' && typeof value !== 'number') {
    throw new BadRequestException('number parameter requires a number value');
  }
  if (dataType === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) {
    throw new BadRequestException('integer parameter requires an integer value');
  }
  if (dataType === 'boolean' && typeof value !== 'boolean') {
    throw new BadRequestException('boolean parameter requires a boolean value');
  }
  if (dataType === 'string' && typeof value !== 'string') {
    throw new BadRequestException('string parameter requires a string value');
  }
  if (dataType === 'json' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new BadRequestException('json parameter requires an object value');
  }
  if (typeof value === 'number' && validation) {
    if (validation.min !== undefined && value < validation.min) {
      throw new BadRequestException(`value below validation min ${validation.min}`);
    }
    if (validation.max !== undefined && value > validation.max) {
      throw new BadRequestException(`value above validation max ${validation.max}`);
    }
  }
  if (validation?.enum && !validation.enum.some((item) => item === value)) {
    throw new BadRequestException(`value is not in allowed enum ${JSON.stringify(validation.enum)}`);
  }
  if (validation?.pattern && typeof value === 'string' && !new RegExp(validation.pattern).test(value)) {
    throw new BadRequestException(`value does not match pattern ${validation.pattern}`);
  }
}

@Injectable()
export class ParametersService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  private parseParameter(row: ConfigRow): ParameterValue {
    const fallback: ParameterValue = {
      key: plainKey(row.configKey),
      name: row.configKey,
      dataType: 'string',
      current: '',
      history: [],
      status: 'active',
      version: 1,
      source: 'manual',
      approvalRequired: false,
      scope: {},
      updatedBy: row.updatedBy ?? 'system',
      updatedAt: row.updatedAt.toISOString(),
    };
    return {
      ...fallback,
      ...((row.configValue as Partial<ParameterValue> | null) ?? {}),
      key: plainKey(row.configKey),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async writeParameter(
    value: ParameterValue,
    actor?: OrgContext,
  ): Promise<ParameterValue> {
    const [row] = await this.db
      .insert(ewohSchedulerConfig)
      .values({
        configKey: configKeyFor(value.key),
        configValue: value as unknown as Record<string, unknown>,
        updatedBy: actor?.userId ?? 'system',
      })
      .onConflictDoUpdate({
        target: [ewohSchedulerConfig.orgId, ewohSchedulerConfig.configKey],
        set: {
          configValue: value as unknown as Record<string, unknown>,
          updatedBy: actor?.userId ?? 'system',
        },
      })
      .returning();
    return this.parseParameter(row);
  }

  private async readParameter(key: string): Promise<ParameterValue> {
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(eq(ewohSchedulerConfig.configKey, configKeyFor(key)));
    if (!row) {
      throw new NotFoundException(`Parameter ${key} not found`);
    }
    return this.parseParameter(row);
  }

  async register(
    body: {
      key: string;
      name: string;
      dataType?: ParameterDataType;
      current: unknown;
      unit?: string;
      source?: string;
      approvalRequired?: boolean;
      scope?: { factoryId?: string; workCenterId?: string; deviceId?: string };
      effectiveFrom?: string;
      effectiveUntil?: string;
      validation?: ParameterValidation;
    },
    actor?: OrgContext,
  ) {
    if (!body.key?.trim() || !body.name?.trim()) {
      throw new BadRequestException('key and name are required');
    }
    const dataType = body.dataType ?? 'string';
    if (!PARAMETER_DATA_TYPES.includes(dataType)) {
      throw new BadRequestException(`unsupported dataType: ${dataType}`);
    }
    validateValue(dataType, body.current, body.validation);
    const now = nowIso();
    const approvalRequired = body.approvalRequired === true;
    const value: ParameterValue = {
      key: body.key.trim(),
      name: body.name.trim(),
      dataType,
      unit: body.unit?.trim() || undefined,
      current: body.current,
      history: [],
      status: approvalRequired ? 'pending' : 'active',
      version: 1,
      source: body.source ?? 'manual',
      approvalRequired,
      scope: body.scope ?? {},
      effectiveFrom: body.effectiveFrom,
      effectiveUntil: body.effectiveUntil,
      validation: body.validation,
      updatedBy: actor?.userId ?? 'system',
      updatedAt: now,
    };
    const saved = await this.writeParameter(value, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'parameters.register',
      entityType: 'parameter',
      entityId: value.key,
      before: null,
      after: {
        name: value.name,
        dataType: value.dataType,
        status: value.status,
        version: value.version,
      },
    });
    return saved;
  }

  async list() {
    const rows = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(like(ewohSchedulerConfig.configKey, 'param.%'))
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => this.parseParameter(row));
  }

  async get(key: string) {
    return this.readParameter(key);
  }

  async update(
    key: string,
    body: {
      current: unknown;
      note?: string;
      effectiveUntil?: string;
      validation?: ParameterValidation;
    },
    actor?: OrgContext,
  ) {
    const current = await this.readParameter(key);
    validateValue(current.dataType, body.current, body.validation ?? current.validation);
    const now = nowIso();
    const updated: ParameterValue = {
      ...current,
      current: body.current,
      validation: body.validation ?? current.validation,
      effectiveUntil: body.effectiveUntil ?? current.effectiveUntil,
      status: current.approvalRequired ? 'pending' : 'active',
      version: current.version + 1,
      history: [
        ...current.history,
        {
          version: current.version,
          value: current.current,
          status: current.status,
          source: current.source,
          updatedBy: current.updatedBy,
          updatedAt: current.updatedAt,
          note: body.note,
        },
      ],
      updatedBy: actor?.userId ?? 'system',
      updatedAt: now,
    };
    const saved = await this.writeParameter(updated, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'parameters.update',
      entityType: 'parameter',
      entityId: key,
      before: { version: current.version, status: current.status },
      after: { version: saved.version, status: saved.status },
    });
    return saved;
  }

  async approve(key: string, actor?: OrgContext) {
    const current = await this.readParameter(key);
    if (current.status !== 'pending') {
      throw new ConflictException(`Parameter ${key} is not pending`);
    }
    const updated = { ...current, status: 'active' as const, updatedBy: actor?.userId ?? 'system', updatedAt: nowIso() };
    const saved = await this.writeParameter(updated, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'parameters.approve',
      entityType: 'parameter',
      entityId: key,
      before: { status: current.status },
      after: { status: 'active' },
    });
    return saved;
  }

  async rollback(key: string, actor?: OrgContext) {
    const current = await this.readParameter(key);
    if (current.history.length === 0) {
      throw new ConflictException(`Parameter ${key} has no previous version`);
    }
    const previous = current.history[current.history.length - 1];
    const now = nowIso();
    const updated: ParameterValue = {
      ...current,
      current: previous.value,
      status: current.approvalRequired ? 'pending' : 'active',
      version: current.version + 1,
      history: [
        ...current.history.slice(0, -1),
        {
          version: current.version,
          value: current.current,
          status: current.status,
          source: current.source,
          updatedBy: current.updatedBy,
          updatedAt: current.updatedAt,
          note: `rolled back from v${current.version}`,
        },
      ],
      updatedBy: actor?.userId ?? 'system',
      updatedAt: now,
    };
    const saved = await this.writeParameter(updated, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'parameters.rollback',
      entityType: 'parameter',
      entityId: key,
      before: { version: current.version, value: current.current },
      after: { version: saved.version, value: saved.current },
    });
    return saved;
  }

  async retire(key: string, actor?: OrgContext) {
    const current = await this.readParameter(key);
    if (current.status === 'retired') {
      throw new ConflictException(`Parameter ${key} is already retired`);
    }
    const updated = { ...current, status: 'retired' as const, updatedBy: actor?.userId ?? 'system', updatedAt: nowIso() };
    const saved = await this.writeParameter(updated, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'parameters.retire',
      entityType: 'parameter',
      entityId: key,
      before: { status: current.status },
      after: { status: 'retired' },
    });
    return saved;
  }

  async summary() {
    const parameters = await this.list();
    const now = nowIso();
    return {
      totalCount: parameters.length,
      statusCounts: parameters.reduce<Record<string, number>>((acc, parameter) => {
        acc[parameter.status] = (acc[parameter.status] ?? 0) + 1;
        return acc;
      }, {}),
      dataTypeCounts: parameters.reduce<Record<string, number>>((acc, parameter) => {
        acc[parameter.dataType] = (acc[parameter.dataType] ?? 0) + 1;
        return acc;
      }, {}),
      expiredCount: parameters.filter(
        (parameter) =>
          parameter.status !== 'retired' &&
          parameter.effectiveUntil !== undefined &&
          parameter.effectiveUntil <= now,
      ).length,
      pendingApprovalCount: parameters.filter(
        (parameter) => parameter.status === 'pending',
      ).length,
    };
  }
}
