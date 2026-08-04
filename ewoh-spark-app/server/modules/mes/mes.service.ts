import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  ewohAssetPackage,
  ewohEvent,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
} from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import { IdempotencyService } from '../shared/idempotency.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface MesStepInput {
  name: string;
  instruction?: string;
  assignedPersonId?: string;
  assignedDeviceId?: string;
  spatialEntityId?: string;
  plannedStart?: string;
  plannedEnd?: string;
  sopId?: string;
  sopVersion?: string;
  sopMandatory?: boolean;
  requiredTools?: string[];
  requiredMaterials?: string[];
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

export interface ForceResolveResult {
  stepId: string;
  resolution: 'local' | 'server';
  applied: boolean;
  serverValue: unknown;
  note?: string;
  resolvedAt: string;
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

function sanitizeExceptionAttachments(value: unknown): Record<string, string>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const allowedKeys = ['id', 'filename', 'contentType', 'url'] as const;
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object',
    )
    .map((entry) => {
      const sanitized: Record<string, string> = {};
      for (const key of allowedKeys) {
        const field = entry[key];
        if (typeof field === 'string' && field.trim() !== '') {
          sanitized[key] = field;
        }
      }
      return sanitized;
    })
    .filter((entry) => Object.keys(entry).length > 0);
}

function assertWorkerStepAssignment(
  step: { assignedPersonId?: string | null },
  actor?: OrgContext,
) {
  if (actor?.role !== 'worker') {
    return;
  }
  if (!step.assignedPersonId || step.assignedPersonId !== actor.userId) {
    throw new ForbiddenException(
      'WORKER_STEP_ASSIGNMENT_REQUIRED: worker can only operate steps assigned to them',
    );
  }
}

function validateSopConfirmation(
  step: { resultJson?: unknown },
  action: string,
  body?: Record<string, unknown>,
  actor?: OrgContext,
) {
  if (action !== 'start' && action !== 'report') {
    return undefined;
  }
  const result = (step.resultJson as Record<string, unknown> | null) ?? {};
  const sop = (result.sop as Record<string, unknown> | undefined);
  if (!sop || sop.mandatory === false) {
    return undefined;
  }
  const bodyRecord = body ?? {};
  if (bodyRecord.sopSigned !== true) {
    throw new BadRequestException(
      'SOP_SIGN_REQUIRED: SOP sign-off is required before start/report',
    );
  }
  const requiredTools = Array.isArray(sop.requiredTools)
    ? (sop.requiredTools as string[])
    : [];
  const confirmedTools = Array.isArray(bodyRecord.confirmedTools)
    ? (bodyRecord.confirmedTools as string[])
    : [];
  const missingTools = requiredTools.filter(
    (tool) => !confirmedTools.includes(tool),
  );
  if (missingTools.length > 0) {
    throw new BadRequestException(
      `SOP_TOOLS_REQUIRED: missing tool confirmations: ${missingTools.join(', ')}`,
    );
  }
  const requiredMaterials = Array.isArray(sop.requiredMaterials)
    ? (sop.requiredMaterials as string[])
    : [];
  const confirmedMaterials = Array.isArray(bodyRecord.confirmedMaterials)
    ? (bodyRecord.confirmedMaterials as string[])
    : [];
  const missingMaterials = requiredMaterials.filter(
    (material) => !confirmedMaterials.includes(material),
  );
  if (missingMaterials.length > 0) {
    throw new BadRequestException(
      `SOP_MATERIALS_REQUIRED: missing material confirmations: ${missingMaterials.join(', ')}`,
    );
  }
  return {
    signedAt: new Date().toISOString(),
    signedBy: actor?.userId ?? bodyRecord.operatorId ?? null,
    tools: confirmedTools,
    materials: confirmedMaterials,
  };
}

@Injectable()
export class MesService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
    @Optional()
    private readonly idempotencyService: IdempotencyService = new IdempotencyService(),
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
      resultJson: step.sopId
        ? {
            sop: {
              sopId: step.sopId,
              version: step.sopVersion ?? null,
              mandatory: step.sopMandatory ?? true,
              requiredTools: step.requiredTools ?? [],
              requiredMaterials: step.requiredMaterials ?? [],
            },
          }
        : null,
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

  async getStep(stepId: string) {
    const [step] = await this.db
      .select()
      .from(ewohScheduleTaskStep)
      .where(eq(ewohScheduleTaskStep.stepId, stepId));
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found`);
    }
    return step;
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

  async getTrace(orderId: string) {
    const detail = await this.getWorkOrder(orderId);
    const qualityEvents = await this.db
      .select()
      .from(ewohEvent)
      .where(eq(ewohEvent.eventType, 'quality'));
    const inspections = qualityEvents.filter(
      (event) =>
        (event.evidenceJson as Record<string, unknown> | null)?.workOrderId ===
        orderId,
    );
    const nodes = [
      {
        id: detail.workOrder.scheduleTaskId,
        type: 'work_order',
        label: detail.workOrder.title,
      },
      ...detail.steps.map((step) => ({
        id: step.stepId,
        type: 'step',
        label: step.name,
      })),
      ...detail.materials.map((material) => ({
        id: material.bindingId,
        type: 'material',
        label: material.resourceId,
      })),
      ...inspections.map((event) => ({
        id: event.eventId,
        type: 'inspection',
        label: event.title,
      })),
    ];
    const links = [
      ...detail.steps.map((step) => ({
        from: detail.workOrder.scheduleTaskId,
        to: step.stepId,
        type: 'has_step',
      })),
      ...detail.materials.map((material) => ({
        from: detail.workOrder.scheduleTaskId,
        to: material.bindingId,
        type: 'consumed',
      })),
      ...inspections.map((event) => ({
        from: String(
          (event.evidenceJson as Record<string, unknown> | null)?.stepId ??
            detail.workOrder.scheduleTaskId,
        ),
        to: event.eventId,
        type: 'inspected',
      })),
    ];
    return {
      workOrder: detail.workOrder,
      steps: detail.steps,
      materials: detail.materials,
      inspections,
      nodes,
      links,
    };
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
    assertWorkerStepAssignment(step, actor);
    const sopSignature = validateSopConfirmation(step, action, body, actor);
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
    if (action === 'pause') {
      resultJson.exception = {
        code: body?.code ?? null,
        note: body?.note ?? body?.reason ?? null,
        reportedAt: new Date().toISOString(),
        operator: actor?.userId ?? body?.operatorId ?? null,
        attachments: sanitizeExceptionAttachments(body?.attachments),
      };
    }
    if (action === 'resume') {
      resultJson.resume = {
        note: body?.note ?? null,
        resumedAt: new Date().toISOString(),
        operator: actor?.userId ?? body?.operatorId ?? null,
      };
    }
    if (sopSignature) {
      resultJson.sop = {
        ...((resultJson.sop as Record<string, unknown> | null) ?? {}),
        signatures: sopSignature,
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
      throw new ConflictException({
        message: 'STATE_CONFLICT',
        serverValue: step,
      });
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

  /**
   * Idempotently resolves a step state conflict. The state machine is
   * authoritative and is never bypassed here:
   *  - `resolution: 'server'` keeps the current server state (records the
   *    decision, no mutation).
   *  - `resolution: 'local'` re-applies the caller's local action through the
   *    normal transition path; if the transition is still not allowed the
   *    server state stands and `applied` is `false` so the caller is never
   *    silently overwritten.
   * Repeated calls with the same `idempotencyKey` return the recorded result.
   */
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
  ): Promise<ForceResolveResult> {
    const resolution = body?.resolution;
    if (resolution !== 'local' && resolution !== 'server') {
      throw new BadRequestException('resolution must be local or server');
    }
    const idempotencyKey =
      body?.idempotencyKey?.trim() ||
      `force-resolve:${orderId}:${stepId}:${resolution}`;
    const recorded = await this.idempotencyService.lookup<ForceResolveResult>(
      idempotencyKey,
    );
    if (recorded) {
      return recorded;
    }
    const workOrder = await this.getWorkOrder(orderId);
    const step = workOrder.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found in work order ${orderId}`);
    }
    const resolvedAt = new Date().toISOString();
    let applied = false;
    let serverValue: unknown = step;
    let note: string | undefined;

    if (resolution === 'local' && body?.action) {
      try {
        const updated = await this.transitionStep(
          orderId,
          stepId,
          body.action,
          body.payload,
          actor,
        );
        applied = true;
        serverValue = updated;
      } catch (error) {
        if (error instanceof ConflictException) {
          note = 'LOCAL_CONFLICT_PERSISTS';
        } else {
          note = error instanceof Error ? error.message : 'LOCAL_APPLY_FAILED';
        }
      }
    }

    const result: ForceResolveResult = {
      stepId,
      resolution,
      applied,
      serverValue,
      note,
      resolvedAt,
    };
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `mes.step.force_resolve.${resolution}`,
      entityType: 'schedule_task_step',
      entityId: stepId,
      before: { status: step.status },
      after: {
        status: applied
          ? (serverValue as { status?: string }).status ?? undefined
          : step.status,
      },
      metadata: { orderId, idempotencyKey, applied, note },
    });
    await this.idempotencyService.store(idempotencyKey, result);
    return result;
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

  async registerSop(
    body: {
      sopId?: string;
      title: string;
      version: string;
      steps: Array<{
        name: string;
        instruction?: string;
        mandatory?: boolean;
        media?: string[];
        tools?: string[];
        materials?: string[];
      }>;
      effectiveFrom?: string;
      effectiveTo?: string;
      checksum?: string;
    },
    actor?: OrgContext,
  ) {
    if (
      !body.title?.trim() ||
      !body.version?.trim() ||
      !Array.isArray(body.steps) ||
      body.steps.length === 0
    ) {
      throw new BadRequestException(
        'title, version, and non-empty steps are required',
      );
    }
    const sopId = body.sopId?.trim() || `SOP-${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(ewohAssetPackage)
      .values({
        packageId: sopId,
        packageType: 'sop',
        name: body.title.trim(),
        version: body.version.trim(),
        manifestJson: {
          sopSchemaVersion: 'v1',
          effectiveFrom: body.effectiveFrom ?? null,
          effectiveTo: body.effectiveTo ?? null,
          checksum: body.checksum ?? null,
          steps: body.steps,
        },
        status: 'draft',
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'mes.sop.register',
      entityType: 'asset_package',
      entityId: sopId,
      before: null,
      after: { title: row.name, version: row.version, stepCount: body.steps.length },
    });
    return row;
  }

  async listSops() {
    return this.db
      .select()
      .from(ewohAssetPackage)
      .where(eq(ewohAssetPackage.packageType, 'sop'))
      .orderBy(desc(ewohAssetPackage.createdAt));
  }

  async getSop(sopId: string) {
    const [row] = await this.db
      .select()
      .from(ewohAssetPackage)
      .where(
        and(
          eq(ewohAssetPackage.packageId, sopId),
          eq(ewohAssetPackage.packageType, 'sop'),
        ),
      );
    if (!row) {
      throw new NotFoundException(`SOP ${sopId} not found`);
    }
    return row;
  }

  async publishSop(sopId: string, actor?: OrgContext) {
    const sop = await this.getSop(sopId);
    if (sop.status === 'published') {
      return sop;
    }
    const [updated] = await this.db
      .update(ewohAssetPackage)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(ewohAssetPackage.packageId, sopId))
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'mes.sop.publish',
      entityType: 'asset_package',
      entityId: sopId,
      before: { status: sop.status },
      after: { status: updated.status },
    });
    return updated;
  }

  async diffSops(fromId: string, toId: string) {
    const from = await this.getSop(fromId);
    const to = await this.getSop(toId);
    const fromSteps = (
      (from.manifestJson as { steps?: Array<{ name: string }> } | null)
        ?.steps ?? []
    );
    const toSteps = (
      (to.manifestJson as { steps?: Array<{ name: string }> } | null)?.steps ?? []
    );
    const fromMap = new Map(fromSteps.map((step) => [step.name, step]));
    const toMap = new Map(toSteps.map((step) => [step.name, step]));
    return {
      fromId,
      toId,
      added: toSteps
        .filter((step) => !fromMap.has(step.name))
        .map((step) => step.name),
      removed: fromSteps
        .filter((step) => !toMap.has(step.name))
        .map((step) => step.name),
      changed: [...fromMap.keys()].filter(
        (name) =>
          toMap.has(name) &&
          JSON.stringify(fromMap.get(name)) !== JSON.stringify(toMap.get(name)),
      ),
    };
  }

  async registerQualityScheme(
    body: {
      schemeId?: string;
      name: string;
      version: string;
      stage: 'first' | 'in_process' | 'final';
      checkItems: Array<{
        itemId: string;
        name: string;
        required?: boolean;
        defectCode?: string;
      }>;
      deviceIds?: string[];
      stepTypes?: string[];
      productCodes?: string[];
    },
    actor?: OrgContext,
  ) {
    if (
      !body.name?.trim() ||
      !body.version?.trim() ||
      !['first', 'in_process', 'final'].includes(body.stage) ||
      !Array.isArray(body.checkItems) ||
      body.checkItems.length === 0
    ) {
      throw new BadRequestException(
        'name, version, stage, and non-empty checkItems are required',
      );
    }
    const schemeId =
      body.schemeId?.trim() || `QS-${randomUUID().slice(0, 8)}`;
    const [row] = await this.db
      .insert(ewohAssetPackage)
      .values({
        packageId: schemeId,
        packageType: 'quality_scheme',
        name: body.name.trim(),
        version: body.version.trim(),
        manifestJson: {
          qualitySchemaVersion: 'v1',
          stage: body.stage,
          checkItems: body.checkItems,
          deviceIds: body.deviceIds ?? [],
          stepTypes: body.stepTypes ?? [],
          productCodes: body.productCodes ?? [],
        },
        status: 'draft',
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'mes.quality_scheme.register',
      entityType: 'asset_package',
      entityId: schemeId,
      before: null,
      after: {
        name: row.name,
        version: row.version,
        stage: body.stage,
        checkCount: body.checkItems.length,
      },
    });
    return row;
  }

  async listQualitySchemes() {
    return this.db
      .select()
      .from(ewohAssetPackage)
      .where(eq(ewohAssetPackage.packageType, 'quality_scheme'))
      .orderBy(desc(ewohAssetPackage.createdAt));
  }

  async getQualityScheme(schemeId: string) {
    const [row] = await this.db
      .select()
      .from(ewohAssetPackage)
      .where(
        and(
          eq(ewohAssetPackage.packageId, schemeId),
          eq(ewohAssetPackage.packageType, 'quality_scheme'),
        ),
      );
    if (!row) {
      throw new NotFoundException(`Quality scheme ${schemeId} not found`);
    }
    return row;
  }

  async publishQualityScheme(schemeId: string, actor?: OrgContext) {
    const scheme = await this.getQualityScheme(schemeId);
    if (scheme.status === 'published') {
      return scheme;
    }
    const [updated] = await this.db
      .update(ewohAssetPackage)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(ewohAssetPackage.packageId, schemeId))
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'mes.quality_scheme.publish',
      entityType: 'asset_package',
      entityId: schemeId,
      before: { status: scheme.status },
      after: { status: updated.status },
    });
    return updated;
  }

  async matchQualitySchemes(filters: {
    deviceId?: string;
    stepType?: string;
    productCode?: string;
  }) {
    const schemes = await this.listQualitySchemes();
    return schemes
      .filter((scheme) => scheme.status === 'published')
      .filter((scheme) => {
        const manifest = (scheme.manifestJson as Record<string, unknown>) ?? {};
        const deviceIds = Array.isArray(manifest.deviceIds)
          ? (manifest.deviceIds as string[])
          : [];
        const stepTypes = Array.isArray(manifest.stepTypes)
          ? (manifest.stepTypes as string[])
          : [];
        const productCodes = Array.isArray(manifest.productCodes)
          ? (manifest.productCodes as string[])
          : [];
        if (deviceIds.length > 0 && filters.deviceId && !deviceIds.includes(filters.deviceId)) {
          return false;
        }
        if (stepTypes.length > 0 && filters.stepType && !stepTypes.includes(filters.stepType)) {
          return false;
        }
        if (productCodes.length > 0 && filters.productCode && !productCodes.includes(filters.productCode)) {
          return false;
        }
        return true;
      })
      .map((scheme) => ({
        schemeId: scheme.packageId,
        name: scheme.name,
        version: scheme.version,
        stage: (scheme.manifestJson as { stage?: string } | null)?.stage ?? null,
      }));
  }

  private async validateQualityScheme(
    schemeId: string,
    stage: string | undefined,
    checkResults: Array<{ itemId: string; result: 'pass' | 'fail'; note?: string }> | undefined,
  ) {
    const scheme = await this.getQualityScheme(schemeId);
    if (scheme.status !== 'published') {
      throw new BadRequestException('QUALITY_SCHEME_NOT_PUBLISHED');
    }
    const manifest = (scheme.manifestJson as {
      stage?: string;
      checkItems?: Array<{ itemId: string; required?: boolean }>;
    }) ?? {};
    if (manifest.stage !== stage) {
      throw new BadRequestException(
        `QUALITY_STAGE_MISMATCH: expected ${manifest.stage}, got ${stage ?? 'none'}`,
      );
    }
    const results = Array.isArray(checkResults) ? checkResults : [];
    for (const item of manifest.checkItems ?? []) {
      if (
        item.required !== false &&
        !results.some((result) => result.itemId === item.itemId)
      ) {
        throw new BadRequestException(`QUALITY_CHECK_REQUIRED: ${item.itemId}`);
      }
    }
    return {
      schemeId,
      version: scheme.version,
      stage: manifest.stage,
      checkResults: results,
      hasFail: results.some((result) => result.result === 'fail'),
    };
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
      schemeId?: string;
      stage?: 'first' | 'in_process' | 'final';
      checkResults?: Array<{
        itemId: string;
        result: 'pass' | 'fail';
        note?: string;
      }>;
    },
    actor?: OrgContext,
  ) {
    const workOrder = await this.getWorkOrder(orderId);
    const step = workOrder.steps.find((candidate) => candidate.stepId === body.stepId);
    if (!step) {
      throw new NotFoundException(`Step ${body.stepId} not found`);
    }
    assertWorkerStepAssignment(step, actor);
    if (!['in_progress', 'reported', 'reviewed'].includes(step.status)) {
      throw new BadRequestException(
        `Inspection is not allowed from step status ${step.status}`,
      );
    }
    if (!['pass', 'fail', 'rework'].includes(body.result)) {
      throw new BadRequestException('result must be pass, fail, or rework');
    }
    let schemeInfo: Awaited<ReturnType<typeof this.validateQualityScheme>> | undefined;
    if (body.schemeId) {
      schemeInfo = await this.validateQualityScheme(
        body.schemeId,
        body.stage,
        body.checkResults,
      );
      if (schemeInfo.hasFail && body.result === 'pass') {
        throw new BadRequestException(
          'QUALITY_RESULT_MISMATCH: failed check items require fail or rework result',
        );
      }
    }
    const resultJson = { ...((step.resultJson as Record<string, unknown> | null) ?? {}) };
    resultJson.quality = {
      inspectorId: body.inspectorId ?? actor?.userId ?? null,
      result: body.result,
      defectCode: body.defectCode ?? null,
      quantity: body.quantity ?? null,
      note: body.note ?? null,
      inspectedAt: new Date().toISOString(),
      scheme: schemeInfo ?? null,
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
        schemeId: body.schemeId ?? null,
        stage: body.stage ?? null,
        checkResults: body.checkResults ?? [],
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
