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
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { parseDateInput } from '../shared/parse-date-input';
import { computeFingerprint } from '../shared/idempotency.service';
import {
  ewohAssetPackage,
  ewohEvent,
  ewohResourceBinding,
  ewohScheduleTask,
  ewohScheduleTaskStep,
} from '@server/database/schema';
import { workOrderTransitionAllowed } from '@shared/workorder';
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

/**
 * NEST-322/323（2026-08-17 审计整改）：MES 工单状态机与 ADR-012 契约对齐。
 *
 * 事实源 = shared/workorder.ts 的 WORK_ORDER_LIFECYCLE + TRANSITIONS（契约
 * 冻结层 contracts/workorder/*.schema.json 的 TS 消费面）。MES 的
 * draft/released 是 ADR-012 created/scheduled 的历史 UI 别名，这里以显式
 * alias 映射衔接（不修改冻结契约、不改存量数据），转移合法性全部委托
 * workOrderTransitionAllowed——漂移由 mes.state-machine.spec.ts 契约测试钉死。
 */
export const MES_WORK_ORDER_STATUS_TO_CONTRACT: Readonly<Record<string, string>> = {
  draft: 'created',
  released: 'scheduled',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
};

export const CONTRACT_WORK_ORDER_STATUS_TO_MES: Readonly<Record<string, string>> = {
  created: 'draft',
  scheduled: 'released',
  in_progress: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
};

/** MES 动作 → ADR-012 目标状态（合法性由契约 TRANSITIONS 裁决）。 */
const ACTION_TO_CONTRACT_TARGET: Readonly<Record<string, string>> = {
  release: 'scheduled',
  start: 'in_progress',
  complete: 'completed',
  cancel: 'cancelled',
};

export function nextWorkOrderStatus(current: string, action: string): string | null {
  const canonicalCurrent = MES_WORK_ORDER_STATUS_TO_CONTRACT[current];
  const canonicalTarget = ACTION_TO_CONTRACT_TARGET[action];
  if (!canonicalCurrent || !canonicalTarget) {
    return null;
  }
  if (!workOrderTransitionAllowed(canonicalCurrent, canonicalTarget)) {
    return null;
  }
  return CONTRACT_WORK_ORDER_STATUS_TO_MES[canonicalTarget] ?? null;
}

/**
 * MES 工序状态机（pending→in_progress→reported→reviewed→handed_over 等）。
 * 注意：contracts/state-machines/ 中无工序级契约（task.yaml 是生产任务机，
 * 状态词表不同）；本表为 MES 局部状态机，行为由
 * mes.state-machine.spec.ts 钉死，若后续契约层落地工序 yaml 必须切换同源。
 */
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
  // NEST-356：附件数量上限（防任意长度数组落库）。
  const MAX_ATTACHMENTS = 20;
  return value
    .slice(0, MAX_ATTACHMENTS)
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
  // R2-SBZ-001：worker 判定必须用 roles 数组（AccessTokenGuard 从 JWT 注入）。
  // OrgContext.role 是可选的单一解析字段，常规请求恒为空 → 旧实现恒走
  // fail-open 分支（归属校验死代码）。仅 worker 角色受步骤归属约束；
  // 其他角色（workshop_lead/global_admin 等）按既有 RBAC 面放行。
  const roles = actor?.roles ?? [];
  if (!roles.includes('worker')) {
    return;
  }
  // assignedPersonId is a personnel-domain ID. Workers may only act through the
  // signed account↔person binding; auth userId is a different identity space.
  const signedPersonId = actor?.personId?.trim() ?? '';
  if (
    !signedPersonId ||
    !step.assignedPersonId ||
    step.assignedPersonId !== signedPersonId
  ) {
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

  /**
   * NEST-301~304 等租户隔离（2026-08-17 审计整改）：MES 读写全部带 org 谓词。
   * global_admin 显式放行（与 RLS 例外路径一致）；无租户上下文的写路径
   * fail-closed（业务表 insert 必须显式 orgId，NEST-302）。
   */
  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: mes operations require tenant context',
      );
    }
    return orgId;
  }

  /**
   * org 谓词：global_admin 不加过滤；其余按 primaryOrgId 严格匹配。
   * R2-SAM-002：actor 完全缺省（undefined）由"不过滤"收敛为 fail-closed
   * （requireOrgId 抛 400）——内部调用方（如 mobile 扫码 facade）必须显式
   * 透传租户上下文；不再依赖"信任 undefined + DB 层 RLS 兜底"的纵深缺口。
   */
  private orgCondition(
    column: typeof ewohScheduleTask.orgId | typeof ewohEvent.orgId | typeof ewohAssetPackage.orgId | typeof ewohResourceBinding.orgId | typeof ewohScheduleTaskStep.orgId,
    actor?: OrgContext,
  ): SQL | undefined {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    return eq(column, this.requireOrgId(actor)) as SQL;
  }

  /**
   * 审计 orgId 统一（NEST-335）：取 actor.primaryOrgId（global_admin 跨租户
   * 操作也记自己 org）；内部调用无 actor 时取行归属，不再静默回退空串。
   */
  private auditOrgId(actor: OrgContext | undefined, rowOrgId?: string | null): string {
    return actor?.primaryOrgId ?? rowOrgId ?? '';
  }

  async listWorkOrders(actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohScheduleTask.orgId, actor);
    return this.db
      .select()
      .from(ewohScheduleTask)
      .where(
        orgCond
          ? and(eq(ewohScheduleTask.source, 'mes'), orgCond)
          : eq(ewohScheduleTask.source, 'mes'),
      )
      .orderBy(desc(ewohScheduleTask.createdAt));
  }

  async createWorkOrder(body: CreateWorkOrderDto, actor?: OrgContext) {
    if (!body.title?.trim() || !Array.isArray(body.steps) || body.steps.length === 0) {
      throw new BadRequestException('title and at least one step are required');
    }
    // NEST-302：ewoh_schedule_task 写入显式 orgId（缺租户上下文 fail-closed）。
    const orgId = this.requireOrgId(actor);
    const orderId = body.orderId?.trim() || `WO-${randomUUID().slice(0, 8)}`;
    const now = new Date();
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
    const row = await this.writeScheduleOrder(
      {
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
        // P1（2026-08-19 审计）：日期入参显式校验（非法字符串原产生 Invalid
        // Date → postgres 22007 → 稳定 500；现 400 fail-fast）。
        planStart: parseDateInput(body.planStart, 'planStart'),
        planEnd: parseDateInput(body.planEnd, 'planEnd'),
        isSimulation: false,
        progress: 0,
        orgId,
      },
      steps.map((step) => ({ ...step, orgId })),
    );
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId,
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
    return this.getWorkOrder(orderId, actor);
  }

  /**
   * Canonical write path for ewoh_schedule_task + ewoh_schedule_task_step.
   * MES 与 ERP 共用此入口，避免双方各自直写调度表；调用方各自保留自己的
   * source、校验与审计语义（orgId 由调用方在 task/steps 中显式携带）。
   * NEST-320：task + steps 同事务落库（steps 失败不留孤儿 task）。
   */
  async writeScheduleOrder(
    task: typeof ewohScheduleTask.$inferInsert,
    steps: typeof ewohScheduleTaskStep.$inferInsert[],
  ) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(ewohScheduleTask)
        .values(task)
        .returning();
      if (steps.length > 0) {
        await tx.insert(ewohScheduleTaskStep).values(steps);
      }
      return row;
    });
  }

  async getStep(stepId: string, actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohScheduleTaskStep.orgId, actor);
    const [step] = await this.db
      .select()
      .from(ewohScheduleTaskStep)
      .where(
        orgCond
          ? and(eq(ewohScheduleTaskStep.stepId, stepId), orgCond)
          : eq(ewohScheduleTaskStep.stepId, stepId),
      );
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found`);
    }
    return step;
  }

  async getWorkOrder(orderId: string, actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohScheduleTask.orgId, actor);
    const [workOrder] = await this.db
      .select()
      .from(ewohScheduleTask)
      .where(
        orgCond
          ? and(eq(ewohScheduleTask.scheduleTaskId, orderId), orgCond)
          : eq(ewohScheduleTask.scheduleTaskId, orderId),
      );
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

  async getTrace(orderId: string, actor?: OrgContext) {
    const detail = await this.getWorkOrder(orderId, actor);
    // NEST-303：quality 事件按 workOrderId + orgId 在数据库侧过滤
    // （原先全表加载后内存过滤，无界且跨租户）。
    const eventOrgCond = this.orgCondition(ewohEvent.orgId, actor);
    const qualityEvents = await this.db
      .select()
      .from(ewohEvent)
      .where(
        eventOrgCond
          ? and(
              eq(ewohEvent.eventType, 'quality'),
              sql`${ewohEvent.evidenceJson}->>'workOrderId' = ${orderId}`,
              eventOrgCond,
            )
          : and(
              eq(ewohEvent.eventType, 'quality'),
              sql`${ewohEvent.evidenceJson}->>'workOrderId' = ${orderId}`,
            ),
      );
    const inspections = qualityEvents;
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
    const current = await this.getWorkOrder(orderId, actor);
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
    const orgCond = this.orgCondition(ewohScheduleTask.orgId, actor);
    const [row] = await this.db
      .update(ewohScheduleTask)
      .set({
        status,
        actualStart: action === 'start' ? new Date() : current.workOrder.actualStart,
        actualEnd: action === 'complete' ? new Date() : current.workOrder.actualEnd,
        progress: action === 'complete' ? 100 : current.workOrder.progress,
      })
      .where(
        orgCond
          ? and(
              eq(ewohScheduleTask.scheduleTaskId, orderId),
              eq(ewohScheduleTask.status, before),
              orgCond,
            )
          : and(
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
      orgId: this.auditOrgId(actor, row.orgId),
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
    // Offline writes carry an idempotency key so a delivered-but-mistaken-for-
    // failed replay returns the first result WITHOUT re-executing the side
    // effect (and a different payload on the same key is rejected with 409).
    const idempotencyKey = (body as { idempotencyKey?: string } | undefined)
      ?.idempotencyKey;
    if (idempotencyKey?.trim()) {
      return this.idempotencyService.executeWithPayload(
        idempotencyKey.trim(),
        { orderId, stepId, action, body },
        () => this.doTransitionStep(orderId, stepId, action, body, actor),
      );
    }
    return this.doTransitionStep(orderId, stepId, action, body, actor);
  }

  private async doTransitionStep(
    orderId: string,
    stepId: string,
    action: string,
    body: Record<string, unknown> | undefined,
    actor?: OrgContext,
  ) {
    const workOrder = await this.getWorkOrder(orderId, actor);
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
    const orgCond = this.orgCondition(ewohScheduleTaskStep.orgId, actor);
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
        orgCond
          ? and(
              eq(ewohScheduleTaskStep.stepId, stepId),
              eq(ewohScheduleTaskStep.status, before),
              orgCond,
            )
          : and(
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
      orgId: this.auditOrgId(actor, row.orgId),
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
   *
   * 缺省 key（客户端未显式传 idempotencyKey 时）必须绑定"本次冲突的本地操作"
   * （action + payload 指纹），不能只用 orderId/stepId/resolution——否则同一工序
   * 稍后的另一次冲突会 lookup 命中上一次的记录，把过期的 serverValue 当"当前
   * 服务端状态"返回（调用方按过期状态裁决 = 伪造确定事实）。同 payload 的重放
   * （离线客户端未收到响应时的重试）仍命中同 key → 幂等保留。org 归属校验
   * （getWorkOrder）前移到 lookup 之前：缓存命中也必须先过租户可见性。
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
    const workOrder = await this.getWorkOrder(orderId, actor);
    const step = workOrder.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found in work order ${orderId}`);
    }
    const conflictOpFingerprint = createHash('sha256')
      .update(computeFingerprint({ action: body?.action ?? null, payload: body?.payload ?? {} }))
      .digest('hex')
      .slice(0, 16);
    const idempotencyKey =
      body?.idempotencyKey?.trim() ||
      `force-resolve:${orderId}:${stepId}:${resolution}:${body?.action ?? ''}:${conflictOpFingerprint}`;
    const recorded = await this.idempotencyService.lookup<ForceResolveResult>(
      idempotencyKey,
    );
    if (recorded) {
      return recorded;
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
          // 仅并发冲突被显式吸收为 note（服务端状态权威，本地不再覆写）。
          note = 'LOCAL_CONFLICT_PERSISTS';
        } else {
          // NEST-336：非冲突错误（SOP 签名缺失、非法转移等业务校验失败）
          // 原样上抛——调用方必须看到失败原因，不能被 applied=false 吞掉。
          throw error;
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
      orgId: this.auditOrgId(actor, step.orgId),
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
    const workOrder = await this.getWorkOrder(orderId, actor);
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
        orgId: this.auditOrgId(actor, workOrder.workOrder.orgId),
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: this.auditOrgId(actor, workOrder.workOrder.orgId),
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

  async listMaterials(orderId: string, actor?: OrgContext) {
    await this.getWorkOrder(orderId, actor);
    const orgCond = this.orgCondition(ewohResourceBinding.orgId, actor);
    return this.db
      .select()
      .from(ewohResourceBinding)
      .where(
        orgCond
          ? and(
              eq(ewohResourceBinding.targetId, orderId),
              eq(ewohResourceBinding.bindingType, 'material_consumption'),
              orgCond,
            )
          : and(
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
    const orgId = this.requireOrgId(actor);
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
        orgId,
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId,
      action: 'mes.sop.register',
      entityType: 'asset_package',
      entityId: sopId,
      before: null,
      after: { title: row.name, version: row.version, stepCount: body.steps.length },
    });
    return row;
  }

  async listSops(actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohAssetPackage.orgId, actor);
    return this.db
      .select()
      .from(ewohAssetPackage)
      .where(
        orgCond
          ? and(eq(ewohAssetPackage.packageType, 'sop'), orgCond)
          : eq(ewohAssetPackage.packageType, 'sop'),
      )
      .orderBy(desc(ewohAssetPackage.createdAt));
  }

  async getSop(sopId: string, actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohAssetPackage.orgId, actor);
    const [row] = await this.db
      .select()
      .from(ewohAssetPackage)
      .where(
        orgCond
          ? and(
              eq(ewohAssetPackage.packageId, sopId),
              eq(ewohAssetPackage.packageType, 'sop'),
              orgCond,
            )
          : and(
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
    const sop = await this.getSop(sopId, actor);
    if (sop.status === 'published') {
      return sop;
    }
    const orgCond = this.orgCondition(ewohAssetPackage.orgId, actor);
    const [updated] = await this.db
      .update(ewohAssetPackage)
      .set({ status: 'published', publishedAt: new Date() })
      .where(
        orgCond
          ? and(eq(ewohAssetPackage.packageId, sopId), orgCond)
          : eq(ewohAssetPackage.packageId, sopId),
      )
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: this.auditOrgId(actor, updated.orgId),
      action: 'mes.sop.publish',
      entityType: 'asset_package',
      entityId: sopId,
      before: { status: sop.status },
      after: { status: updated.status },
    });
    return updated;
  }

  async diffSops(fromId: string, toId: string, actor?: OrgContext) {
    const from = await this.getSop(fromId, actor);
    const to = await this.getSop(toId, actor);
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
    const orgId = this.requireOrgId(actor);
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
        orgId,
      })
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId,
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

  async listQualitySchemes(actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohAssetPackage.orgId, actor);
    return this.db
      .select()
      .from(ewohAssetPackage)
      .where(
        orgCond
          ? and(eq(ewohAssetPackage.packageType, 'quality_scheme'), orgCond)
          : eq(ewohAssetPackage.packageType, 'quality_scheme'),
      )
      .orderBy(desc(ewohAssetPackage.createdAt));
  }

  async getQualityScheme(schemeId: string, actor?: OrgContext) {
    const orgCond = this.orgCondition(ewohAssetPackage.orgId, actor);
    const [row] = await this.db
      .select()
      .from(ewohAssetPackage)
      .where(
        orgCond
          ? and(
              eq(ewohAssetPackage.packageId, schemeId),
              eq(ewohAssetPackage.packageType, 'quality_scheme'),
              orgCond,
            )
          : and(
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
    const scheme = await this.getQualityScheme(schemeId, actor);
    if (scheme.status === 'published') {
      return scheme;
    }
    const orgCond = this.orgCondition(ewohAssetPackage.orgId, actor);
    const [updated] = await this.db
      .update(ewohAssetPackage)
      .set({ status: 'published', publishedAt: new Date() })
      .where(
        orgCond
          ? and(eq(ewohAssetPackage.packageId, schemeId), orgCond)
          : eq(ewohAssetPackage.packageId, schemeId),
      )
      .returning();
    if (!updated) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: this.auditOrgId(actor, updated.orgId),
      action: 'mes.quality_scheme.publish',
      entityType: 'asset_package',
      entityId: schemeId,
      before: { status: scheme.status },
      after: { status: updated.status },
    });
    return updated;
  }

  async matchQualitySchemes(
    filters: {
      deviceId?: string;
      stepType?: string;
      productCode?: string;
    },
    actor?: OrgContext,
  ) {
    const schemes = await this.listQualitySchemes(actor);
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
    actor?: OrgContext,
  ) {
    const scheme = await this.getQualityScheme(schemeId, actor);
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
      idempotencyKey?: string;
    },
    actor?: OrgContext,
  ) {
    if (body.idempotencyKey?.trim()) {
      return this.idempotencyService.executeWithPayload(
        body.idempotencyKey.trim(),
        { orderId, body },
        () => this.doQualityInspection(orderId, body, actor),
      );
    }
    return this.doQualityInspection(orderId, body, actor);
  }

  private async doQualityInspection(
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
    const workOrder = await this.getWorkOrder(orderId, actor);
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
        actor,
      );
      if (schemeInfo.hasFail && body.result === 'pass') {
        throw new BadRequestException(
          'QUALITY_RESULT_MISMATCH: failed check items require fail or rework result',
        );
      }
    }
    const resultJson = { ...((step.resultJson as Record<string, unknown> | null) ?? {}) };
    resultJson.quality = {
      inspectorId: body.inspectorId ?? actor?.personId ?? actor?.userId ?? null,
      result: body.result,
      defectCode: body.defectCode ?? null,
      quantity: body.quantity ?? null,
      note: body.note ?? null,
      inspectedAt: new Date().toISOString(),
      scheme: schemeInfo ?? null,
    };
    const eventId = `QI-${randomUUID().slice(0, 8)}`;
    const orgId = this.auditOrgId(actor, workOrder.workOrder.orgId);
    const stepOrgCond = this.orgCondition(ewohScheduleTaskStep.orgId, actor);
    // NEST-321：step 更新与 quality 事件同事务落库（部分失败不再产生
    // 「结果已写、事件缺失」的不一致）。
    // 状态 CAS：resultJson 是整体读-改-写（基于读取时的 step 快照）。若不带
    // eq(status, 读取时状态) 守卫，与 report/pause 等工序转移并发时，本更新会在
    // 锁等待后命中已前移的行，用旧快照覆写整份 resultJson——并发方刚写入的
    // report/pause 记录被静默抹掉（状态已 reported 而报工记录消失 = 伪造事实）。
    // CAS 未命中显式 409（与 doTransitionStep 同语义），调用方以新状态重试；
    // 状态未变的复检不受影响（质检不改状态，同状态重复检验仍可写）。
    await this.db.transaction(async (tx) => {
      const [updatedStep] = await tx
        .update(ewohScheduleTaskStep)
        .set({ resultJson })
        .where(
          and(
            eq(ewohScheduleTaskStep.stepId, body.stepId),
            eq(ewohScheduleTaskStep.status, step.status),
            ...(stepOrgCond ? [stepOrgCond] : []),
          ),
        )
        .returning({ stepId: ewohScheduleTaskStep.stepId });
      if (!updatedStep) {
        throw new ConflictException({
          message: 'STATE_CONFLICT',
          serverValue: step,
        });
      }
      await tx.insert(ewohEvent).values({
        eventId,
        deviceId: step.assignedDeviceId ?? null,
        eventCode: 'QUALITY_INSPECTION',
        eventType: 'quality',
        // B7（2026-08-19 审计）：事件严重度统一 canonical（原 legacy L1/L2/L3，
        // 与 ingest/ERP 等模块的 canonical 词表分裂 → 安全封锁/优先级加权失配）。
        severity: body.result === 'pass' ? 'low' : body.result === 'rework' ? 'high' : 'critical',
        title: `质量检验-${body.result}`,
        status: 'open',
        createdAt: new Date(),
        sourceType: 'real',
        orgId,
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: new Date(),
        receivedAt: new Date(),
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
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
    });
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId,
      action: 'mes.quality.inspect',
      entityType: 'schedule_task_step',
      entityId: body.stepId,
      before: null,
      after: { workOrderId: orderId, result: body.result },
    });
    return { stepId: body.stepId, eventId, result: body.result };
  }
}
