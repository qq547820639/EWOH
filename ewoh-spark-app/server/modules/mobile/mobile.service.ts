import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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
    return this.db
      .select()
      .from(ewohScheduleTaskStep)
      .where(
        and(
          eq(ewohScheduleTaskStep.assignedPersonId, personId),
          sql`${ewohScheduleTaskStep}.org_id = ${actor.primaryOrgId}::uuid`,
          inArray(ewohScheduleTaskStep.status, [
            'pending',
            'in_progress',
            'paused',
          ]),
        ),
      )
      .orderBy(desc(ewohScheduleTaskStep.actualStart));
  }

  async scan(value: string) {
    const normalized = value?.trim() ?? '';
    if (!normalized) {
      throw new BadRequestException('scanValue or orderId is required');
    }
    const parsed = parseScanValue(normalized);
    if (!parsed) {
      return this.scanOrder(normalized);
    }
    if (parsed.scanType === 'work_order' || parsed.scanType === 'order') {
      return this.scanOrder(parsed.reference);
    }
    if (parsed.scanType === 'step') {
      const step = await this.mesService.getStep(parsed.reference);
      const workOrder = await this.mesService.getWorkOrder(step.scheduleTaskId);
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

  async scanOrder(orderId: string) {
    return this.mesService.getWorkOrder(orderId);
  }

  async getOrder(orderId: string) {
    return this.mesService.getWorkOrder(orderId);
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
    },
    actor?: OrgContext,
  ) {
    return this.mesService.qualityInspection(orderId, body, actor);
  }
}
