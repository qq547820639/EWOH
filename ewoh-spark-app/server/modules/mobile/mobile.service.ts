import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ewohScheduleTaskStep } from '@server/database/schema';
import { MesService } from '../mes/mes.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export const SCAN_PREFIXES = [
  ['WO:', 'work_order'],
  ['ORDER:', 'order'],
  ['STEP:', 'step'],
  ['DEVICE:', 'device'],
  ['DEV:', 'device'],
  ['MATERIAL:', 'material'],
  ['MAT:', 'material'],
  ['BATCH:', 'batch'],
  ['STATION:', 'station'],
  ['STN:', 'station'],
  ['FACTORY:', 'factory'],
  ['PLANT:', 'factory'],
] as const;

export type ScanType =
  | 'work_order'
  | 'order'
  | 'step'
  | 'device'
  | 'material'
  | 'batch'
  | 'station'
  | 'factory';

export interface ParsedScanValue {
  scanType: ScanType;
  reference: string;
}

export function parseScanValue(value: string): ParsedScanValue | null {
  const normalized = value?.trim() ?? '';
  const upper = normalized.toUpperCase();
  for (const [prefix, scanType] of SCAN_PREFIXES) {
    if (upper.startsWith(prefix)) {
      const reference = normalized.slice(prefix.length).trim();
      if (!reference) {
        return null;
      }
      return { scanType, reference };
    }
  }
  return null;
}

@Injectable()
export class MobileService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly mesService: MesService,
  ) {}

  async listWorkbench(personId: string, actor?: OrgContext) {
    if (!personId?.trim() || !actor?.primaryOrgId) {
      return [];
    }
    // NEST-412：水平越权收敛——仅本人（或 global_admin/管理角色）可查工作台，
    // 任意已认证用户传他人 personId 枚举他人工序的面关闭。
    const roles = actor?.roles ?? [];
    const isPrivileged =
      roles.includes('global_admin') ||
      roles.includes('dispatcher') ||
      roles.includes('workshop_lead');
    if (!isPrivileged && actor.userId !== personId) {
      throw new ForbiddenException(
        'workbench queries are limited to the caller (personId mismatch)',
      );
    }
    // NEST-444：raw SQL org 谓词改 eq()（drizzle 惯用写法，列类型由 schema 保证）。
    return this.db
      .select()
      .from(ewohScheduleTaskStep)
      .where(
        and(
          eq(ewohScheduleTaskStep.assignedPersonId, personId),
          eq(ewohScheduleTaskStep.orgId, actor.primaryOrgId),
          inArray(ewohScheduleTaskStep.status, [
            'pending',
            'in_progress',
            'paused',
          ]),
        ),
      )
      .orderBy(desc(ewohScheduleTaskStep.actualStart));
  }

  /** R2-SAM-002：scan/order 透传租户上下文（MES orgCondition 对
   * undefined actor 已 fail-closed，facade 不再是无 org 过滤的旁路）。 */
  async scan(value: string, actor?: OrgContext) {
    const normalized = value?.trim() ?? '';
    if (!normalized) {
      throw new BadRequestException('scanValue or orderId is required');
    }
    const parsed = parseScanValue(normalized);
    if (!parsed) {
      return this.scanOrder(normalized, actor);
    }
    if (parsed.scanType === 'work_order' || parsed.scanType === 'order') {
      return this.scanOrder(parsed.reference, actor);
    }
    if (parsed.scanType === 'step') {
      const step = await this.mesService.getStep(parsed.reference, actor);
      const workOrder = await this.mesService.getWorkOrder(
        step.scheduleTaskId,
        actor,
      );
      return { scanType: 'step', step, workOrder: workOrder.workOrder };
    }
    return {
      scanType: parsed.scanType,
      reference: parsed.reference,
      recognized: true,
      context: {
        scanValue: normalized,
        entityId: parsed.reference,
      },
    };
  }

  async scanOrder(orderId: string, actor?: OrgContext) {
    return this.mesService.getWorkOrder(orderId, actor);
  }

  async getOrder(orderId: string, actor?: OrgContext) {
    return this.mesService.getWorkOrder(orderId, actor);
  }

  async transitionStep(
    orderId: string,
    stepId: string,
    action: string,
    body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    return this.mesService.transitionStep(orderId, stepId, action, body, actor);
  }

  async forceResolveStep(
    orderId: string,
    stepId: string,
    body: {
      resolution: 'local' | 'server';
      idempotencyKey?: string;
      action?: string;
      payload?: Record<string, unknown>;
    },
    actor?: OrgContext,
  ) {
    return this.mesService.forceResolveStep(orderId, stepId, body, actor);
  }

  async inspectStep(
    orderId: string,
    body: {
      stepId: string;
      result: 'pass' | 'fail' | 'rework';
      defectCode?: string;
      quantity?: number;
      note?: string;
      idempotencyKey?: string;
    },
    actor?: OrgContext,
  ) {
    return this.mesService.qualityInspection(orderId, body, actor);
  }
}
