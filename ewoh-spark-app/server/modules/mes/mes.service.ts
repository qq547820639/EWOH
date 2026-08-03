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
  ewohEvent,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
} from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface MesStepInput {
  name: string;
  instruction?: string;
  assignedPersonId?: string;
  assignedDeviceId?: string;
  spatialEntityId?: string;
  plannedStart?: string;
  plannedEnd?: string;
}

export interface CreateWorkOrderDto {
  orderId?: string;
  title: string;
  productCode?: string;
  orderQty?: number;
  batchNo?: string;
  priority?: string;
  planStart?: string;
  planEnd?: string;
  steps: MesStepInput[];
}

export function nextWorkOrderStatus(current: string, action: string): string | null {
  switch (action) {
    case 'release':
      return current === 'draft' ? 'released' : null;
    case 'start':
      return current === 'released' ? 'in_progress' : null;
    case 'complete':
      return current === 'in_progress' ? 'completed' : null;
    case 'cancel':
      return ['draft', 'released'].includes(current) ? 'cancelled' : null;
    default:
      return null;
  }
}

export function nextStepStatus(current: string, action: string): string | null {
  switch (action) {
    case 'start':
      return current === 'pending' ? 'in_progress' : null;
    case 'report':
      return current === 'in_progress' ? 'reported' : null;
    case 'review':
      return current === 'reported' ? 'reviewed' : null;
    case 'handover':
      return current === 'reviewed' ? 'handed_over' : null;
    case 'pause':
      return current === 'in_progress' ? 'paused' : null;
    case 'resume':
      return current === 'paused' ? 'in_progress' : null;
    case 'cancel':
      return current === 'pending' ? 'cancelled' : null;
    default:
      return null;
  }
}

@Injectable()
export class MesService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async listWorkOrders() {
    return this.db
      .select()
      .from(ewohScheduleTask)
      .where(eq(ewohScheduleTask.source, 'mes'))
      .orderBy(desc(ewohScheduleTask.createdAt));
  }

  async createWorkOrder(body: CreateWorkOrderDto, actor?: OrgContext) {
    if (!body.title?.trim() || !Array.isArray(body.steps) || body.steps.length === 0) {
      throw new BadRequestException('title and at least one step are required');
    }
    const orderId = body.orderId?.trim() || `WO-${randomUUID().slice(0, 8)}`;
    const now = new Date();
    const [row] = await this.db
      .insert(ewohScheduleTask)
      .values({
        scheduleTaskId: orderId,
        title: body.title.trim(),
        description: JSON.stringify({
          productCode: body.productCode ?? null,
          orderQty: body.orderQty ?? null,
          batchNo: body.batchNo ?? null,
          mes: true,
        }),
        status: 'draft',
        priority: body.priority ?? 'medium',
        source: 'mes',
        planStart: body.planStart ? new Date(body.planStart) : null,
        planEnd: body.planEnd ? new Date(body.planEnd) : null,
        isSimulation: false,
        progress: 0,
      })
      .returning();

    const steps = body.steps.map((step, index) => ({
      stepId: `${orderId}-S${index + 1}`,
      scheduleTaskId: orderId,
      stepNo: index + 1,
      name: step.name.trim(),
      instruction: step.instruction ?? null,
      status: 'pending',
      plannedStart: step.plannedStart ? new Date(step.plannedStart) : null,
      plannedEnd: step.plannedEnd ? new Date(step.plannedEnd) : null,
      assignedPersonId: step.assignedPersonId ?? null,
      assignedDeviceId: step.assignedDeviceId ?? null,
      spatialEntityId: step.spatialEntityId ?? null,
      progress: 0,
    }));
    if (steps.length > 0) {
      await this.db.insert(ewohScheduleTaskStep).values(steps);
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'mes.work_order.create',
      entityType: 'schedule_task',
      entityId: orderId,
      before: null,
      after: {
        title: row.title,
        status: row.status,
        stepCount: steps.length,
        createdAt: now.toISOString(),
      },
    });
    return this.getWorkOrder(orderId);
  }

  async getWorkOrder(orderId: string) {
    const [workOrder] = await this.db
      .select()
      .from(ewohScheduleTask)
      .where(eq(ewohScheduleTask.scheduleTaskId, orderId));
    if (!workOrder) {
      throw new NotFoundException(`Work order ${orderId} not found`);
    }
    const steps = await this.db
      .select()
      .from(ewohScheduleTaskStep)
      .where(eq(ewohScheduleTaskStep.scheduleTaskId, orderId))
      .orderBy(ewohScheduleTaskStep.stepNo);
    const materials = await this.db
      .select()
      .from(ewohResourceBinding)
      .where(
        and(
          eq(ewohResourceBinding.targetId, orderId),
          eq(ewohResourceBinding.bindingType, 'material_consumption'),
        ),
      )
      .orderBy(ewohResourceBinding.startTime);
    return { workOrder, steps, materials };
  }

  async transitionWorkOrder(
    orderId: string,
    action: string,
    _body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    const current = await this.getWorkOrder(orderId);
    const status = nextWorkOrderStatus(current.workOrder.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${current.workOrder.status}`,
      );
    }
    if (action === 'complete') {
      const unfinished = current.steps.filter(
        (step) => step.status !== 'handed_over',
      );
      if (unfinished.length > 0) {
        throw new BadRequestException(
          `All steps must be handed over before completion; pending: ${unfinished.map((step) => step.stepId).join(', ')}`,
        );
      }
    }
    const before = current.workOrder.status;
    const [row] = await this.db
      .update(ewohScheduleTask)
      .set({
        status,
        actualStart: action === 'start' ? new Date() : current.workOrder.actualStart,
        actualEnd: action === 'complete' ? new Date() : current.workOrder.actualEnd,
        progress: action === 'complete' ? 100 : current.workOrder.progress,
      })
      .where(
        and(
          eq(ewohScheduleTask.scheduleTaskId, orderId),
          eq(ewohScheduleTask.status, before),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `mes.work_order.${action}`,
      entityType: 'schedule_task',
      entityId: orderId,
      before: { status: before },
      after: { status: row.status },
    });
    return row;
  }

  async transitionStep(
    orderId: string,
    stepId: string,
    action: string,
    body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    const workOrder = await this.getWorkOrder(orderId);
    const step = workOrder.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found in work order ${orderId}`);
    }
    if (action === 'start' && !['released', 'in_progress'].includes(workOrder.workOrder.status)) {
      throw new BadRequestException('Work order must be released or in progress');
    }
    const status = nextStepStatus(step.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from step status ${step.status}`,
      );
    }
    const before = step.status;
    const resultJson = { ...((step.resultJson as Record<string, unknown> | null) ?? {}) };
    if (action === 'report') {
      resultJson.report = {
        quantity: body?.quantity ?? null,
        note: body?.note ?? null,
        reportedAt: new Date().toISOString(),
        operator: actor?.userId ?? body?.operatorId ?? null,
      };
    }
    if (action === 'review') {
      resultJson.review = {
        decision: body?.decision ?? 'approved',
        reviewer: actor?.userId ?? body?.reviewer ?? null,
        reviewedAt: new Date().toISOString(),
      };
    }
    if (action === 'handover') {
      resultJson.handover = {
        receiver: body?.receiver ?? null,
        handedOverAt: new Date().toISOString(),
      };
    }
    const [row] = await this.db
      .update(ewohScheduleTaskStep)
      .set({
        status,
        actualStart: action === 'start' ? new Date() : step.actualStart,
        actualEnd: ['report', 'review', 'handover'].includes(action)
          ? new Date()
          : step.actualEnd,
        resultJson,
        progress: action === 'handover' ? 100 : step.progress,
      })
      .where(
        and(
          eq(ewohScheduleTaskStep.stepId, stepId),
          eq(ewohScheduleTaskStep.status, before),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `mes.step.${action}`,
      entityType: 'schedule_task_step',
      entityId: stepId,
      before: { status: before },
      after: { status: row.status },
    });
    return row;
  }

  async consumeMaterial(
    orderId: string,
    body: { materialId: string; quantity: number; reason?: string; operatorId?: string },
    actor?: OrgContext,
  ) {
    const workOrder = await this.getWorkOrder(orderId);
    if (['completed', 'cancelled'].includes(workOrder.workOrder.status)) {
      throw new BadRequestException('Work order is not consumable in its current state');
    }
    const quantity = Number(body.quantity);
    if (!body.materialId?.trim() || !Number.isFinite(quantity) || quantity <= 0) {
      throw new BadRequestException('materialId and positive quantity are required');
    }
    const bindingId = `MAT-${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(ewohResourceBinding)
      .values({
        bindingId,
        bindingType: 'material_consumption',
        resourceType: 'material',
        resourceId: body.materialId.trim(),
        targetType: 'work_order',
        targetId: orderId,
        status: 'active',
        operatorId: body.operatorId ?? actor?.userId ?? null,
        quantity: String(quantity),
        reason: body.reason ?? null,
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'mes.material.consume',
      entityType: 'resource_binding',
      entityId: bindingId,
      before: null,
      after: {
        workOrderId: orderId,
        materialId: body.materialId,
        quantity,
      },
    });
    return row;
  }

  async listMaterials(orderId: string) {
    await this.getWorkOrder(orderId);
    return this.db
      .select()
      .from(ewohResourceBinding)
      .where(
        and(
          eq(ewohResourceBinding.targetId, orderId),
          eq(ewohResourceBinding.bindingType, 'material_consumption'),
        ),
      )
      .orderBy(ewohResourceBinding.startTime);
  }

  async qualityInspection(
    orderId: string,
    body: {
      stepId: string;
      inspectorId?: string;
      result: 'pass' | 'fail' | 'rework';
      defectCode?: string;
      quantity?: number;
      note?: string;
    },
    actor?: OrgContext,
  ) {
    const workOrder = await this.getWorkOrder(orderId);
    const step = workOrder.steps.find((candidate) => candidate.stepId === body.stepId);
    if (!step) {
      throw new NotFoundException(`Step ${body.stepId} not found`);
    }
    if (!['in_progress', 'reported', 'reviewed'].includes(step.status)) {
      throw new BadRequestException(
        `Inspection is not allowed from step status ${step.status}`,
      );
    }
    if (!['pass', 'fail', 'rework'].includes(body.result)) {
      throw new BadRequestException('result must be pass, fail, or rework');
    }
    const resultJson = { ...((step.resultJson as Record<string, unknown> | null) ?? {}) };
    resultJson.quality = {
      inspectorId: body.inspectorId ?? actor?.userId ?? null,
      result: body.result,
      defectCode: body.defectCode ?? null,
      quantity: body.quantity ?? null,
      note: body.note ?? null,
      inspectedAt: new Date().toISOString(),
    };
    await this.db
      .update(ewohScheduleTaskStep)
      .set({ resultJson })
      .where(eq(ewohScheduleTaskStep.stepId, body.stepId));

    const eventId = `QI-${randomUUID().slice(0, 8)}`;
    await this.db.insert(ewohEvent).values({
      eventId,
      deviceId: step.assignedDeviceId ?? null,
      eventCode: 'QUALITY_INSPECTION',
      eventType: 'quality',
      severity: body.result === 'pass' ? 'L1' : body.result === 'rework' ? 'L2' : 'L3',
      title: `质量检验-${body.result}`,
      status: 'open',
      createdAt: new Date(),
      sourceType: 'real',
      evidenceJson: {
        workOrderId: orderId,
        stepId: body.stepId,
        result: body.result,
        defectCode: body.defectCode ?? null,
        quantity: body.quantity ?? null,
        note: body.note ?? null,
      },
    });
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'mes.quality.inspect',
      entityType: 'schedule_task_step',
      entityId: body.stepId,
      before: null,
      after: { workOrderId: orderId, result: body.result },
    });
    return { stepId: body.stepId, eventId, result: body.result };
  }
}
