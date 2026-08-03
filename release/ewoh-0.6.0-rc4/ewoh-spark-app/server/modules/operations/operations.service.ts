import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohSchedulerConfig } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export const ASSET_CATEGORIES = ['device', 'tooling', 'utility'] as const;
export const MAINTENANCE_TASK_TYPES = [
  'inspection',
  'repair',
  'preventive',
  'calibration',
] as const;
export const WORK_CENTER_FLAG_KEYS = [
  'firstInspectionRequired',
  'materialConsumptionRequired',
  'reportReviewRequired',
  'handoverRequired',
  'scanRequired',
  'exoskeletonRequired',
  'riskConfirmationRequired',
  'toolingCheckRequired',
] as const;

export type WorkCenterFlags = Record<(typeof WORK_CENTER_FLAG_KEYS)[number], boolean>;

export function defaultWorkCenterFlags(): WorkCenterFlags {
  return Object.fromEntries(
    WORK_CENTER_FLAG_KEYS.map((key) => [key, false]),
  ) as WorkCenterFlags;
}

export function nextAssetStatus(
  current: string,
  action: string,
): string | null {
  switch (action) {
    case 'activate':
      return ['maintenance_required', 'decommissioned'].includes(current)
        ? 'active'
        : null;
    case 'flag_maintenance':
      return ['active', 'maintenance_required'].includes(current)
        ? 'maintenance_required'
        : null;
    case 'decommission':
      return ['active', 'maintenance_required'].includes(current)
        ? 'decommissioned'
        : null;
    default:
      return null;
  }
}

export function nextMaintenanceTaskStatus(
  current: string,
  action: string,
): string | null {
  switch (action) {
    case 'start':
      return current === 'planned' ? 'in_progress' : null;
    case 'complete':
      return current === 'in_progress' ? 'completed' : null;
    case 'cancel':
      return ['planned', 'in_progress'].includes(current) ? 'cancelled' : null;
    default:
      return null;
  }
}

export function nextToolStatus(current: string, action: string): string | null {
  switch (action) {
    case 'calibrate':
      return ['active', 'calibration_due'].includes(current) ? 'active' : null;
    case 'retire':
      return ['active', 'calibration_due'].includes(current) ? 'retired' : null;
    default:
      return null;
  }
}

interface ConfigRow {
  configKey: string;
  configValue: unknown;
  updatedBy: string | null;
  updatedAt: Date;
}

export interface AssetValue {
  assetId: string;
  name: string;
  category: string;
  location: string | null;
  strategy: string;
  intervalDays: number;
  status: string;
  nextDueAt: string;
  lastCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  history: Array<{ status: string; at: string; actor?: string; note?: string }>;
}

export interface MaintenanceTaskValue {
  taskId: string;
  assetId: string | null;
  title: string;
  taskType: string;
  priority: string;
  assigneeId: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  description: string | null;
  status: string;
  result: string | null;
  spareParts: Array<{ name: string; quantity: number }>;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  history: Array<{ status: string; at: string; actor?: string; note?: string }>;
}

export interface ToolValue {
  toolId: string;
  name: string;
  category: string;
  lifespanLimit: number | null;
  usageCount: number;
  calibrationIntervalDays: number;
  lastCalibratedAt: string | null;
  nextCalibrationAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  calibrationHistory: Array<{ at: string; actor?: string; note?: string }>;
}

export interface WorkCenterValue {
  workCenterId: string;
  name: string;
  location: string | null;
  capabilities: string[];
  flags: WorkCenterFlags;
  updatedBy: string | null;
  updatedAt: string;
}

export interface StandardHourValue {
  standardHourId: string;
  workCenterId: string;
  operationCode: string;
  operationName: string;
  standardMinutes: number;
  skillLevel: string;
  effectiveFrom: string;
  updatedAt: string;
}

export interface EfficiencyEntryValue {
  entryId: string;
  workerId: string;
  workCenterId: string;
  operationCode: string;
  actualMinutes: number;
  standardMinutes: number;
  deviationMinutes: number;
  efficiencyPercent: number;
  completedAt: string;
  reason: string | null;
  source: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function addDays(date: string, days: number): string {
  return new Date(new Date(date).getTime() + days * 86_400_000).toISOString();
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function parseConfigValue<T>(row: ConfigRow, fallback: T): T {
  return (row.configValue as T | null) ?? fallback;
}

function configKey(namespace: string, id: string): string {
  return `${namespace}.${id}`;
}

@Injectable()
export class OperationsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  private async writeConfig(
    key: string,
    value: Record<string, unknown>,
    actor?: OrgContext,
  ) {
    const [row] = await this.db
      .insert(ewohSchedulerConfig)
      .values({
        configKey: key,
        configValue: value,
        updatedBy: actor?.userId ?? 'system',
      })
      .onConflictDoUpdate({
        target: [ewohSchedulerConfig.orgId, ewohSchedulerConfig.configKey],
        set: {
          configValue: value,
          updatedBy: actor?.userId ?? 'system',
        },
      })
      .returning();
    return row;
  }

  private async readConfig(key: string): Promise<ConfigRow> {
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(eq(ewohSchedulerConfig.configKey, key));
    if (!row) {
      throw new NotFoundException(`Operations record ${key} not found`);
    }
    return row;
  }

  private async listConfigs(prefix: string): Promise<ConfigRow[]> {
    return this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(like(ewohSchedulerConfig.configKey, `${prefix}.%`))
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
  }

  private parseAsset(row: ConfigRow): AssetValue {
    return parseConfigValue<AssetValue>(row, {
      assetId: row.configKey,
      name: row.configKey,
      category: 'utility',
      location: null,
      strategy: 'periodic',
      intervalDays: 90,
      status: 'active',
      nextDueAt: nowIso(),
      lastCompletedAt: null,
      createdAt: nowIso(),
      updatedAt: row.updatedAt.toISOString(),
      history: [],
    });
  }

  private parseTask(row: ConfigRow): MaintenanceTaskValue {
    return parseConfigValue<MaintenanceTaskValue>(row, {
      taskId: row.configKey,
      assetId: null,
      title: row.configKey,
      taskType: 'inspection',
      priority: 'medium',
      assigneeId: null,
      scheduledStart: null,
      scheduledEnd: null,
      description: null,
      status: 'planned',
      result: null,
      spareParts: [],
      completedAt: null,
      createdAt: nowIso(),
      updatedAt: row.updatedAt.toISOString(),
      history: [],
    });
  }

  private parseTool(row: ConfigRow): ToolValue {
    return parseConfigValue<ToolValue>(row, {
      toolId: row.configKey,
      name: row.configKey,
      category: 'tooling',
      lifespanLimit: null,
      usageCount: 0,
      calibrationIntervalDays: 180,
      lastCalibratedAt: null,
      nextCalibrationAt: nowIso(),
      status: 'active',
      createdAt: nowIso(),
      updatedAt: row.updatedAt.toISOString(),
      calibrationHistory: [],
    });
  }

  private parseWorkCenter(row: ConfigRow): WorkCenterValue {
    return parseConfigValue<WorkCenterValue>(row, {
      workCenterId: row.configKey,
      name: row.configKey,
      location: null,
      capabilities: [],
      flags: defaultWorkCenterFlags(),
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private parseStandardHour(row: ConfigRow): StandardHourValue {
    return parseConfigValue<StandardHourValue>(row, {
      standardHourId: row.configKey,
      workCenterId: '',
      operationCode: '',
      operationName: '',
      standardMinutes: 0,
      skillLevel: 'general',
      effectiveFrom: nowIso(),
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  private parseEfficiencyEntry(row: ConfigRow): EfficiencyEntryValue {
    return parseConfigValue<EfficiencyEntryValue>(row, {
      entryId: row.configKey,
      workerId: '',
      workCenterId: '',
      operationCode: '',
      actualMinutes: 0,
      standardMinutes: 0,
      deviationMinutes: 0,
      efficiencyPercent: 0,
      completedAt: nowIso(),
      reason: null,
      source: 'manual',
      updatedAt: row.updatedAt.toISOString(),
    });
  }

  async registerAsset(
    body: {
      assetId?: string;
      name: string;
      category?: string;
      location?: string;
      strategy?: string;
      intervalDays?: number;
      nextDueAt?: string;
      description?: string;
    },
    actor?: OrgContext,
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('asset name is required');
    }
    const category = body.category ?? 'device';
    if (!ASSET_CATEGORIES.includes(category as never)) {
      throw new BadRequestException(`unsupported asset category: ${category}`);
    }
    const intervalDays = Number(body.intervalDays ?? 90);
    if (!Number.isFinite(intervalDays) || intervalDays <= 0) {
      throw new BadRequestException('intervalDays must be positive');
    }
    const assetId = body.assetId?.trim() || newId('AST');
    const now = nowIso();
    const baseDate = body.nextDueAt ?? now;
    const value: AssetValue = {
      assetId,
      name: body.name.trim(),
      category,
      location: body.location?.trim() ?? null,
      strategy: body.strategy ?? 'periodic',
      intervalDays,
      status: 'active',
      nextDueAt: addDays(baseDate, intervalDays),
      lastCompletedAt: null,
      createdAt: now,
      updatedAt: now,
      history: [
        {
          status: 'active',
          at: now,
          actor: actor?.userId ?? 'system',
          note: body.description ?? undefined,
        },
      ],
    };
    const key = configKey('eam.asset', assetId);
    const row = await this.writeConfig(key, value as unknown as Record<string, unknown>, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'operations.asset.register',
      entityType: 'maintenance_asset',
      entityId: assetId,
      before: null,
      after: { name: value.name, category: value.category, status: value.status },
    });
    return this.parseAsset(row);
  }

  async listAssets() {
    const rows = await this.listConfigs('eam.asset');
    return rows.map((row) => this.parseAsset(row));
  }

  async transitionAsset(
    assetId: string,
    action: string,
    actor?: OrgContext,
  ) {
    const key = configKey('eam.asset', assetId);
    const row = await this.readConfig(key);
    const value = this.parseAsset(row);
    const status = nextAssetStatus(value.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${value.status}`,
      );
    }
    const before = value.status;
    value.status = status;
    value.updatedAt = nowIso();
    value.history.push({
      status,
      at: value.updatedAt,
      actor: actor?.userId ?? 'system',
      note: action,
    });
    const updated = await this.writeConfig(
      key,
      value as unknown as Record<string, unknown>,
      actor,
    );
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `operations.asset.${action}`,
      entityType: 'maintenance_asset',
      entityId: assetId,
      before: { status: before },
      after: { status },
    });
    return this.parseAsset(updated);
  }

  async registerMaintenanceTask(
    body: {
      taskId?: string;
      assetId?: string;
      title: string;
      taskType?: string;
      priority?: string;
      assigneeId?: string;
      scheduledStart?: string;
      scheduledEnd?: string;
      description?: string;
      spareParts?: Array<{ name: string; quantity: number }>;
    },
    actor?: OrgContext,
  ) {
    if (!body.title?.trim()) {
      throw new BadRequestException('task title is required');
    }
    const taskType = body.taskType ?? 'inspection';
    if (!MAINTENANCE_TASK_TYPES.includes(taskType as never)) {
      throw new BadRequestException(`unsupported task type: ${taskType}`);
    }
    const taskId = body.taskId?.trim() || newId('MT');
    const now = nowIso();
    const value: MaintenanceTaskValue = {
      taskId,
      assetId: body.assetId?.trim() ?? null,
      title: body.title.trim(),
      taskType,
      priority: body.priority ?? 'medium',
      assigneeId: body.assigneeId?.trim() ?? null,
      scheduledStart: body.scheduledStart ?? null,
      scheduledEnd: body.scheduledEnd ?? null,
      description: body.description?.trim() ?? null,
      status: 'planned',
      result: null,
      spareParts: body.spareParts ?? [],
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      history: [{ status: 'planned', at: now, actor: actor?.userId ?? 'system' }],
    };
    const key = configKey('eam.task', taskId);
    const row = await this.writeConfig(key, value as unknown as Record<string, unknown>, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'operations.task.register',
      entityType: 'maintenance_task',
      entityId: taskId,
      before: null,
      after: { title: value.title, taskType: value.taskType, status: value.status },
    });
    return this.parseTask(row);
  }

  async listMaintenanceTasks() {
    const rows = await this.listConfigs('eam.task');
    return rows.map((row) => this.parseTask(row));
  }

  async transitionMaintenanceTask(
    taskId: string,
    action: string,
    body: { result?: string; note?: string },
    actor?: OrgContext,
  ) {
    const key = configKey('eam.task', taskId);
    const row = await this.readConfig(key);
    const value = this.parseTask(row);
    const status = nextMaintenanceTaskStatus(value.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${value.status}`,
      );
    }
    const before = value.status;
    value.status = status;
    value.updatedAt = nowIso();
    if (action === 'complete') {
      value.result = body.result?.trim() ?? null;
      value.completedAt = value.updatedAt;
    }
    value.history.push({
      status,
      at: value.updatedAt,
      actor: actor?.userId ?? 'system',
      note: body.note ?? undefined,
    });
    await this.writeConfig(key, value as unknown as Record<string, unknown>, actor);

    if (action === 'complete' && value.assetId) {
      await this.refreshAssetAfterMaintenance(value.assetId, value.updatedAt, actor);
    }

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `operations.task.${action}`,
      entityType: 'maintenance_task',
      entityId: taskId,
      before: { status: before },
      after: { status, result: value.result },
    });
    return this.parseTask(await this.readConfig(key));
  }

  private async refreshAssetAfterMaintenance(
    assetId: string,
    completedAt: string,
    actor?: OrgContext,
  ) {
    const key = configKey('eam.asset', assetId);
    try {
      const row = await this.readConfig(key);
      const asset = this.parseAsset(row);
      asset.status = 'active';
      asset.lastCompletedAt = completedAt;
      asset.nextDueAt = addDays(completedAt, asset.intervalDays);
      asset.updatedAt = nowIso();
      asset.history.push({
        status: 'active',
        at: asset.updatedAt,
        actor: actor?.userId ?? 'system',
        note: 'maintenance completed',
      });
      await this.writeConfig(
        key,
        asset as unknown as Record<string, unknown>,
        actor,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new BadRequestException(
          `maintenance task references missing asset ${assetId}`,
        );
      }
      throw error;
    }
  }

  async registerTool(
    body: {
      toolId?: string;
      name: string;
      category?: string;
      lifespanLimit?: number;
      usageCount?: number;
      calibrationIntervalDays?: number;
      lastCalibratedAt?: string;
    },
    actor?: OrgContext,
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('tool name is required');
    }
    const calibrationIntervalDays = Number(body.calibrationIntervalDays ?? 180);
    if (!Number.isFinite(calibrationIntervalDays) || calibrationIntervalDays <= 0) {
      throw new BadRequestException('calibrationIntervalDays must be positive');
    }
    const toolId = body.toolId?.trim() || newId('TL');
    const now = nowIso();
    const lastCalibratedAt = body.lastCalibratedAt ?? null;
    const usageCount = Math.max(0, Number(body.usageCount ?? 0));
    const value: ToolValue = {
      toolId,
      name: body.name.trim(),
      category: body.category ?? 'tooling',
      lifespanLimit: body.lifespanLimit ?? null,
      usageCount,
      calibrationIntervalDays,
      lastCalibratedAt,
      nextCalibrationAt: lastCalibratedAt
        ? addDays(lastCalibratedAt, calibrationIntervalDays)
        : addDays(now, calibrationIntervalDays),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      calibrationHistory: [],
    };
    const key = configKey('eam.tool', toolId);
    const row = await this.writeConfig(key, value as unknown as Record<string, unknown>, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'operations.tool.register',
      entityType: 'maintenance_tool',
      entityId: toolId,
      before: null,
      after: { name: value.name, category: value.category, status: value.status },
    });
    return this.parseTool(row);
  }

  async listTools() {
    const rows = await this.listConfigs('eam.tool');
    return rows.map((row) => this.parseTool(row));
  }

  async transitionTool(
    toolId: string,
    action: string,
    actor?: OrgContext,
  ) {
    const key = configKey('eam.tool', toolId);
    const row = await this.readConfig(key);
    const value = this.parseTool(row);
    const status = nextToolStatus(value.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${value.status}`,
      );
    }
    const before = value.status;
    value.status = status;
    value.updatedAt = nowIso();
    if (action === 'calibrate') {
      value.lastCalibratedAt = value.updatedAt;
      value.nextCalibrationAt = addDays(
        value.updatedAt,
        value.calibrationIntervalDays,
      );
      value.calibrationHistory.push({
        at: value.updatedAt,
        actor: actor?.userId ?? 'system',
      });
    }
    const updated = await this.writeConfig(
      key,
      value as unknown as Record<string, unknown>,
      actor,
    );
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `operations.tool.${action}`,
      entityType: 'maintenance_tool',
      entityId: toolId,
      before: { status: before },
      after: { status, nextCalibrationAt: value.nextCalibrationAt },
    });
    return this.parseTool(updated);
  }

  async upsertWorkCenter(
    body: {
      workCenterId?: string;
      name: string;
      location?: string;
      capabilities?: string[];
      flags?: Partial<WorkCenterFlags>;
    },
    actor?: OrgContext,
  ) {
    if (!body.name?.trim()) {
      throw new BadRequestException('workCenter name is required');
    }
    const workCenterId = body.workCenterId?.trim() || newId('WC');
    const flags = { ...defaultWorkCenterFlags(), ...(body.flags ?? {}) };
    for (const key of WORK_CENTER_FLAG_KEYS) {
      if (typeof flags[key] !== 'boolean') {
        throw new BadRequestException(`flag ${key} must be boolean`);
      }
    }
    const now = nowIso();
    const value: WorkCenterValue = {
      workCenterId,
      name: body.name.trim(),
      location: body.location?.trim() ?? null,
      capabilities: body.capabilities ?? [],
      flags,
      updatedBy: actor?.userId ?? 'system',
      updatedAt: now,
    };
    const key = configKey('ops.workcenter', workCenterId);
    const row = await this.writeConfig(key, value as unknown as Record<string, unknown>, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'operations.workcenter.upsert',
      entityType: 'work_center',
      entityId: workCenterId,
      before: null,
      after: { name: value.name, flags: value.flags },
    });
    return this.parseWorkCenter(row);
  }

  async listWorkCenters() {
    const rows = await this.listConfigs('ops.workcenter');
    return rows.map((row) => this.parseWorkCenter(row));
  }

  async registerStandardHour(
    body: {
      standardHourId?: string;
      workCenterId: string;
      operationCode: string;
      operationName: string;
      standardMinutes: number;
      skillLevel?: string;
      effectiveFrom?: string;
    },
    actor?: OrgContext,
  ) {
    if (!body.workCenterId?.trim() || !body.operationCode?.trim()) {
      throw new BadRequestException(
        'workCenterId and operationCode are required',
      );
    }
    const standardMinutes = Number(body.standardMinutes);
    if (!Number.isFinite(standardMinutes) || standardMinutes <= 0) {
      throw new BadRequestException('standardMinutes must be positive');
    }
    const standardHourId = body.standardHourId?.trim() || newId('SH');
    const now = nowIso();
    const value: StandardHourValue = {
      standardHourId,
      workCenterId: body.workCenterId.trim(),
      operationCode: body.operationCode.trim(),
      operationName: body.operationName?.trim() || body.operationCode.trim(),
      standardMinutes,
      skillLevel: body.skillLevel ?? 'general',
      effectiveFrom: body.effectiveFrom ?? now,
      updatedAt: now,
    };
    const key = configKey('ops.standard-hour', standardHourId);
    const row = await this.writeConfig(key, value as unknown as Record<string, unknown>, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'operations.standard-hour.register',
      entityType: 'standard_hour',
      entityId: standardHourId,
      before: null,
      after: {
        workCenterId: value.workCenterId,
        operationCode: value.operationCode,
        standardMinutes: value.standardMinutes,
      },
    });
    return this.parseStandardHour(row);
  }

  async listStandardHours() {
    const rows = await this.listConfigs('ops.standard-hour');
    return rows.map((row) => this.parseStandardHour(row));
  }

  async registerEfficiencyEntry(
    body: {
      entryId?: string;
      workerId: string;
      workCenterId: string;
      operationCode: string;
      actualMinutes: number;
      standardMinutes?: number;
      completedAt?: string;
      reason?: string;
      source?: string;
    },
    actor?: OrgContext,
  ) {
    if (!body.workerId?.trim() || !body.workCenterId?.trim()) {
      throw new BadRequestException('workerId and workCenterId are required');
    }
    const actualMinutes = Number(body.actualMinutes);
    if (!Number.isFinite(actualMinutes) || actualMinutes <= 0) {
      throw new BadRequestException('actualMinutes must be positive');
    }
    let standardMinutes = Number(body.standardMinutes);
    if (!Number.isFinite(standardMinutes) || standardMinutes <= 0) {
      const standardRows = await this.listConfigs('ops.standard-hour');
      const matched = standardRows
        .map((row) => this.parseStandardHour(row))
        .find(
          (row) =>
            row.workCenterId === body.workCenterId.trim() &&
            row.operationCode === body.operationCode.trim(),
        );
      if (!matched) {
        throw new BadRequestException(
          `no standard hour for ${body.workCenterId}/${body.operationCode}`,
        );
      }
      standardMinutes = matched.standardMinutes;
    }
    const entryId = body.entryId?.trim() || newId('EF');
    const now = nowIso();
    const deviationMinutes = Number((actualMinutes - standardMinutes).toFixed(3));
    const efficiencyPercent = Number(
      ((standardMinutes / actualMinutes) * 100).toFixed(1),
    );
    const value: EfficiencyEntryValue = {
      entryId,
      workerId: body.workerId.trim(),
      workCenterId: body.workCenterId.trim(),
      operationCode: body.operationCode?.trim() || '',
      actualMinutes,
      standardMinutes,
      deviationMinutes,
      efficiencyPercent,
      completedAt: body.completedAt ?? now,
      reason: body.reason?.trim() ?? null,
      source: body.source ?? 'manual',
      updatedAt: now,
    };
    const key = configKey('ops.efficiency', entryId);
    const row = await this.writeConfig(key, value as unknown as Record<string, unknown>, actor);
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'operations.efficiency.register',
      entityType: 'efficiency_entry',
      entityId: entryId,
      before: null,
      after: {
        workerId: value.workerId,
        workCenterId: value.workCenterId,
        actualMinutes: value.actualMinutes,
        standardMinutes: value.standardMinutes,
        efficiencyPercent: value.efficiencyPercent,
      },
    });
    return this.parseEfficiencyEntry(row);
  }

  async listEfficiencyEntries() {
    const rows = await this.listConfigs('ops.efficiency');
    return rows.map((row) => this.parseEfficiencyEntry(row));
  }

  async efficiencySummary() {
    const entries = await this.listEfficiencyEntries();
    const byWorker = new Map<string, number[]>();
    for (const entry of entries) {
      const values = byWorker.get(entry.workerId) ?? [];
      values.push(entry.efficiencyPercent);
      byWorker.set(entry.workerId, values);
    }
    const workerEfficiencies = [...byWorker.values()].map(
      (values) => values.reduce((sum, value) => sum + value, 0) / values.length,
    );
    const average =
      workerEfficiencies.length === 0
        ? 0
        : workerEfficiencies.reduce((sum, value) => sum + value, 0) /
          workerEfficiencies.length;
    const variance =
      workerEfficiencies.length === 0
        ? 0
        : workerEfficiencies.reduce(
            (sum, value) => sum + (value - average) ** 2,
            0,
          ) / workerEfficiencies.length;
    const standardDeviation = Number(Math.sqrt(variance).toFixed(1));
    return {
      entryCount: entries.length,
      workerCount: byWorker.size,
      averageEfficiencyPercent: Number(average.toFixed(1)),
      fairnessStdDev: standardDeviation,
      bySource: entries.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.source] = (acc[entry.source] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }

  async summary() {
    const [assets, tasks, tools, workCenters, standardHours, efficiency] =
      await Promise.all([
        this.listAssets(),
        this.listMaintenanceTasks(),
        this.listTools(),
        this.listWorkCenters(),
        this.listStandardHours(),
        this.listEfficiencyEntries(),
      ]);
    const now = nowIso();
    return {
      assetCount: assets.length,
      activeAssetCount: assets.filter((asset) => asset.status === 'active').length,
      maintenanceRequiredCount: assets.filter(
        (asset) => asset.status === 'maintenance_required',
      ).length,
      taskCount: tasks.length,
      plannedTasks: tasks.filter((task) => task.status === 'planned').length,
      inProgressTasks: tasks.filter((task) => task.status === 'in_progress').length,
      completedTasks: tasks.filter((task) => task.status === 'completed').length,
      cancelledTasks: tasks.filter((task) => task.status === 'cancelled').length,
      toolCount: tools.length,
      calibrationDueCount: tools.filter(
        (tool) =>
          tool.status !== 'retired' && tool.nextCalibrationAt <= now,
      ).length,
      workCenterCount: workCenters.length,
      standardHourCount: standardHours.length,
      efficiencyEntryCount: efficiency.length,
      nextMaintenanceDue: assets
        .filter((asset) => asset.status !== 'decommissioned')
        .sort((left, right) => left.nextDueAt.localeCompare(right.nextDueAt))
        .slice(0, 5)
        .map((asset) => ({
          assetId: asset.assetId,
          name: asset.name,
          nextDueAt: asset.nextDueAt,
        })),
    };
  }
}
