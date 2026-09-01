import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohEvent, ewohEventChain } from '@server/database/schema';
import type {
  ApprovalInstance,
  ApprovalStep,
  ApprovalStepAction,
  ApprovalStepStatus,
  CreateApprovalRequest,
  ObjectDescriptor,
} from '@shared/api.interface';

/**
 * OD-1：从 evidenceJson 还原对象描述符快照。
 *
 * evidenceJson 是无 `$type` 约束的 jsonb（见 `server/database/schema.ts`），
 * 老数据不含 subject，故一律以 undefined 返回，由消费方回退到 entityType+entityId 渲染。
 */
function readSubject(evidence: Record<string, unknown>): ObjectDescriptor | undefined {
  const raw = evidence.subject;
  if (!raw || typeof raw !== 'object') return undefined;
  const subject = raw as Partial<ObjectDescriptor>;
  if (typeof subject.objectType !== 'string' || typeof subject.objectId !== 'string') {
    return undefined;
  }
  if (typeof subject.title !== 'string') return undefined;
  return subject as ObjectDescriptor;
}
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { assertTenantVisible } from '../scheduler/plan-tenant-guard';
import { aggregateApprovalStatus } from './approval.service';

/** approval.yaml role:high_privilege_admin 在系统角色表中的映射（最高权限角色）。 */
const HIGH_PRIVILEGE_ROLE = 'global_admin';

/**
 * R2-SMI-003：审批图（谁批什么）由服务端决定——entityType → 必需审批步骤
 * 角色映射。请求体 input.roles 仅作展示性输入，不再作为审批角色来源；
 * 未登记的 entityType 一律拒绝（fail-closed，防自造审批链）。
 */
export const APPROVAL_ROLE_POLICY: Readonly<Record<string, readonly string[]>> = {
  /** 生产任务相关审批：车间主管复核 + 安全管理员把关。 */
  task: ['workshop_lead', 'safety_admin'],
  /** 危险作业审批：安全管理员。 */
  dangerous_action: ['safety_admin'],
  /** R2-SMI-001/INV-005：高危物理控制指令审批；safety_admin 扮演
   * control.yaml pending_approval→approved 的 approver 角色。 */
  control_request: ['safety_admin'],
};

const STEP_STATUSES = new Set<ApprovalStepStatus>([
  'pending',
  'approved',
  'rejected',
  'delegated',
  'skipped',
  'expired',
]);

const STEP_ACTIONS = new Set<ApprovalStepAction>([
  'approve',
  'reject',
  'delegate',
  'skip',
  'expire',
]);

interface EventRow {
  eventId: string;
  eventType: string | null;
  title: string | null;
  status: string | null;
  createdAt: Date | string | null;
  evidenceJson: unknown;
}

interface ChainRow {
  eventId: string;
  description: string | null;
}

function serializeStep(step: ApprovalStep): string {
  return JSON.stringify({
    role: step.role,
    status: step.status,
    reason: step.reason ?? null,
    delegateTo: step.delegateTo ?? null,
  });
}

function parseStep(row: ChainRow): ApprovalStep {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.description ?? '{}');
  } catch {
    throw new InternalServerErrorException(
      `Approval step ${row.eventId} has invalid description`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InternalServerErrorException(
      `Approval step ${row.eventId} has invalid description`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.role !== 'string' ||
    typeof record.status !== 'string' ||
    !STEP_STATUSES.has(record.status as ApprovalStepStatus)
  ) {
    throw new InternalServerErrorException(
      `Approval step ${row.eventId} has invalid description`,
    );
  }
  return {
    id: row.eventId,
    role: record.role,
    status: record.status as ApprovalStepStatus,
    reason: typeof record.reason === 'string' ? record.reason : undefined,
    delegateTo:
      typeof record.delegateTo === 'string' ? record.delegateTo : undefined,
  };
}

@Injectable()
export class ApprovalPersistenceService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  /** NO-12f/ADR-030：待批清单（org 作用域，最近创建优先）。 */
  async listPending(orgId: string): Promise<Array<Record<string, unknown>>> {
    if (!orgId?.trim()) {
      throw new BadRequestException('orgId 缺失：审批待批查询必须带租户上下文');
    }
    const rows = await this.db
      .select()
      .from(ewohEvent)
      .where(and(
        eq(ewohEvent.orgId, orgId),
        eq(ewohEvent.eventType, 'approval_instance'),
        eq(ewohEvent.status, 'pending'),
      ))
      .orderBy(desc(ewohEvent.createdAt))
      .limit(200);
    return rows.map((r) => {
      const evidence = (r.evidenceJson ?? {}) as Record<string, unknown>;
      const subject = readSubject(evidence);
      return {
        approvalId: r.eventId,
        entityType: evidence.entityType ?? null,
        entityId: evidence.entityId ?? null,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
        // OD-1：老数据无 subject → undefined，前端回退既有渲染，不允许白屏。
        ...(subject ? { subject } : {}),
      };
    });
  }

  async createApproval(
    input: CreateApprovalRequest,
    actor?: OrgContext,
  ): Promise<ApprovalInstance> {
    if (!input.entityType?.trim() || !input.entityId?.trim()) {
      throw new BadRequestException('entityType and entityId are required');
    }
    // NEST-401：HTTP 创建必须带租户上下文（org 缺失 401，绝不静默写全局行）。
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new UnauthorizedException(
        'org 上下文缺失：审批创建必须带租户上下文',
      );
    }
    const entityType = input.entityType.trim();
    const entityId = input.entityId.trim();
    // R2-SMI-003：审批角色按 entityType 由服务端映射——请求体 roles 不可
    // 指定审批图；未登记 entityType 拒绝（fail-closed）。
    const requiredRoles = APPROVAL_ROLE_POLICY[entityType];
    if (!requiredRoles?.length) {
      throw new BadRequestException(
        `Unknown approval entityType '${entityType}' (allowed: ${Object.keys(APPROVAL_ROLE_POLICY).join(', ')})`,
      );
    }
    const now = new Date();
    const id = randomUUID();
    const steps: ApprovalStep[] = requiredRoles.map((role) => ({
      id: randomUUID(),
      role,
      status: 'pending',
    }));
    // OD-1：对象描述符快照（可选，向后兼容）。未登记的 entityType 已在上面 fail-closed 拒绝。
    const subject = input.subject;

    // R2-SMI-004：instance（ewoh_event）与 steps（ewoh_event_chain）同事务
    // 提交——chain 失败不再留下无 steps 的孤儿 instance 行。
    await this.db.transaction(async (tx) => {
      await tx.insert(ewohEvent).values({
        eventId: id,
        eventType: 'approval_instance',
        // OD-1：优先存人类可读标题，缺失时回退既有文案（避免 DB 里落裸 ID）。
        title: subject?.title?.trim() || `Approval for ${entityType} ${entityId}`,
        status: 'pending',
        createdAt: now,
        // ADR-009 / standalone_066: Event Envelope fields.
        occurredAt: now,
        receivedAt: now,
        schemaVersion: '1.0.0',
        correlationId: null,
        causationId: null,
        confidence: null,
        sourceType: 'approval',
        // NEST-401：写入显式携带 orgId。
        orgId,
        evidenceJson: {
          entityType,
          entityId,
          createdAt: now.toISOString(),
          // NEST-405：记录发起人（cancel/发起人回避的 initiator 校验依据）。
          createdBy: actor?.userId ?? 'system',
          // OD-1：对象描述符快照（jsonb 无 $type 约束，加字段无需 DB 迁移）。
          ...(subject ? { subject } : {}),
        },
      });
      await tx.insert(ewohEventChain).values(
        steps.map((step) => ({
          eventId: step.id,
          parentEventId: id,
          causalType: 'approval_step',
          description: serializeStep(step),
          createdAt: now,
        })),
      );
    });

    return {
      id,
      entityType,
      entityId,
      status: 'pending',
      steps,
      createdAt: now.toISOString(),
      ...(subject ? { subject } : {}),
    };
  }

  /** NEST-402：读取带 org 守卫（NULL legacy 行/同 org/global_admin 放行，跨租户 404）。 */
  async getApproval(id: string, actor?: OrgContext): Promise<ApprovalInstance> {
    const [event] = await this.db
      .select()
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventId, id),
          eq(ewohEvent.eventType, 'approval_instance'),
        ),
      );
    if (!event) {
      throw new NotFoundException(`Approval ${id} not found`);
    }
    assertTenantVisible(
      (event as EventRow & { orgId?: string | null }).orgId,
      actor,
      `Approval ${id}`,
    );
    const chainRows = await this.db
      .select()
      .from(ewohEventChain)
      .where(
        and(
          eq(ewohEventChain.parentEventId, id),
          eq(ewohEventChain.causalType, 'approval_step'),
        ),
      )
      .orderBy(asc(ewohEventChain.createdAt));
    const steps = chainRows.map((row) =>
      parseStep({ eventId: row.eventId, description: row.description }),
    );
    return this.toInstance(event as EventRow, steps);
  }

  /**
   * R2-SMI-001：按 (entityType, entityId) 查最近一条审批实例（control 审批
   * 闸门联动查询）。org 守卫与 getApproval 一致（跨租户 404）。
   */
  async findLatestForEntity(
    entityType: string,
    entityId: string,
    actor?: OrgContext,
  ): Promise<ApprovalInstance | null> {
    const rows = await this.db
      .select({ eventId: ewohEvent.eventId })
      .from(ewohEvent)
      .where(
        and(
          eq(ewohEvent.eventType, 'approval_instance'),
          sql`${ewohEvent.evidenceJson}->>'entityType' = ${entityType}`,
          sql`${ewohEvent.evidenceJson}->>'entityId' = ${entityId}`,
        ),
      )
      .orderBy(desc(ewohEvent.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return this.getApproval(row.eventId, actor);
  }

  async stepAction(
    id: string,
    stepId: string,
    action: ApprovalStepAction,
    reason?: string,
    delegateTo?: string,
    actor?: OrgContext,
  ): Promise<ApprovalInstance> {
    if (!STEP_ACTIONS.has(action)) {
      throw new BadRequestException(`Unsupported approval action ${action}`);
    }
    const instance = await this.getApproval(id, actor);
    if (instance.status !== 'pending') {
      throw new BadRequestException(`Approval ${id} is not pending`);
    }
    const step = instance.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new NotFoundException(`Step ${stepId} not found`);
    }
    if (step.status !== 'pending') {
      throw new BadRequestException(`Step ${stepId} is not pending`);
    }
    // NEST-403：step 角色匹配（global_admin 越权放行；角色不满足 403）。
    const actorRoles = actor?.roles ?? [];
    if (
      !actorRoles.includes(HIGH_PRIVILEGE_ROLE) &&
      !actorRoles.includes(step.role)
    ) {
      throw new ForbiddenException(
        `Step ${stepId} requires role '${step.role}' (actor roles: ${actorRoles.join(', ') || 'none'})`,
      );
    }
    // R2-SMI-003：职责分离（segregation of duties）——发起人回避。发起人
    // 不得审批/操作自己发起的实例上的任何步骤（global_admin 亦回避；
    // 紧急通道走 approval.bypass，另行 high_risk 审计）。legacy 行无
    // createdBy 时不适用（无从判定发起人）。
    if (actor) {
      const [evidenceRow] = await this.db
        .select({ evidenceJson: ewohEvent.evidenceJson })
        .from(ewohEvent)
        .where(eq(ewohEvent.eventId, id));
      const evidence =
        ((evidenceRow?.evidenceJson as Record<string, unknown> | null) ?? {});
      const createdBy =
        typeof evidence.createdBy === 'string' ? evidence.createdBy : null;
      if (createdBy && createdBy === actor.userId) {
        throw new ForbiddenException(
          'approval.stepAction 发起人回避：不得审批自己发起的实例（segregation of duties）',
        );
      }
    }

    const nextStep: ApprovalStep = { ...step };
    switch (action) {
      case 'approve':
        nextStep.status = 'approved';
        break;
      case 'reject':
        nextStep.status = 'rejected';
        break;
      case 'delegate':
        nextStep.status = 'delegated';
        nextStep.delegateTo = delegateTo;
        break;
      case 'skip':
        nextStep.status = 'skipped';
        break;
      case 'expire':
        nextStep.status = 'expired';
        break;
    }
    if (reason !== undefined) {
      nextStep.reason = reason;
    }

    const nextSteps = instance.steps.map((candidate) =>
      candidate.id === stepId ? nextStep : candidate,
    );
    const nextStatus = aggregateApprovalStatus(nextSteps);

    // R2-SMI-004：step 与 instance 双 UPDATE 同事务——instance CAS 失败时
    // step 变更一并回滚，不再留下 step/聚合状态永裂的脏审批。
    const [updatedStep, updatedInstance] = await this.db.transaction(
      async (tx) => {
        const [stepRow] = await tx
          .update(ewohEventChain)
          .set({ description: serializeStep(nextStep) })
          .where(
            and(
              eq(ewohEventChain.eventId, stepId),
              eq(ewohEventChain.parentEventId, id),
              sql`${ewohEventChain.description}::jsonb->>'status' = ${step.status}`,
            ),
          )
          .returning();
        if (!stepRow) {
          throw new ConflictException('STATE_CONFLICT');
        }
        const [instanceRow] = await tx
          .update(ewohEvent)
          .set({ status: nextStatus })
          .where(
            and(
              eq(ewohEvent.eventId, id),
              eq(ewohEvent.eventType, 'approval_instance'),
              eq(ewohEvent.status, instance.status),
            ),
          )
          .returning();
        if (!instanceRow) {
          throw new ConflictException('STATE_CONFLICT');
        }
        return [stepRow, instanceRow] as const;
      },
    );
    if (!updatedStep || !updatedInstance) {
      throw new ConflictException('STATE_CONFLICT');
    }

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `approval.${action}`,
      entityType: 'approval',
      entityId: id,
      before: {
        instanceStatus: instance.status,
        stepStatus: step.status,
        reason: step.reason ?? null,
        delegateTo: step.delegateTo ?? null,
      },
      after: {
        instanceStatus: nextStatus,
        stepStatus: nextStep.status,
        reason: nextStep.reason ?? null,
        delegateTo: nextStep.delegateTo ?? null,
      },
    });

    return { ...instance, status: nextStatus, steps: nextSteps };
  }

  async bypass(
    id: string,
    reason: string,
    actor?: OrgContext,
  ): Promise<ApprovalInstance> {
    // NEST-404：approval.yaml 要求 high_privilege_admin（映射 global_admin）；
    // 原 fallback 仅 workshop_lead/safety_admin 即可绕过。
    const actorRoles = actor?.roles ?? [];
    if (!actorRoles.includes(HIGH_PRIVILEGE_ROLE)) {
      throw new ForbiddenException(
        'approval.bypass requires high_privilege_admin (global_admin)',
      );
    }
    const instance = await this.getApproval(id, actor);
    if (instance.status !== 'pending') {
      throw new BadRequestException(`Approval ${id} is not pending`);
    }
    const pendingSteps = instance.steps.filter(
      (step) => step.status === 'pending',
    );
    const nextSteps = instance.steps.map((step) =>
      step.status === 'pending'
        ? { ...step, status: 'skipped' as const, reason: reason || step.reason }
        : step,
    );

    // R2-SMI-004：bypass 的全部 step UPDATE 与 instance UPDATE 同事务——
    // 中途任一 CAS 失败整体回滚，不再留下「部分 skipped + instance 仍 pending」。
    await this.db.transaction(async (tx) => {
      for (const step of pendingSteps) {
        const nextStep = nextSteps.find(
          (candidate) => candidate.id === step.id,
        )!;
        const [updatedStep] = await tx
          .update(ewohEventChain)
          .set({ description: serializeStep(nextStep) })
          .where(
            and(
              eq(ewohEventChain.eventId, step.id),
              eq(ewohEventChain.parentEventId, id),
              sql`${ewohEventChain.description}::jsonb->>'status' = 'pending'`,
            ),
          )
          .returning();
        if (!updatedStep) {
          throw new ConflictException('STATE_CONFLICT');
        }
      }

      const [updatedInstance] = await tx
        .update(ewohEvent)
        .set({ status: 'bypassed' })
        .where(
          and(
            eq(ewohEvent.eventId, id),
            eq(ewohEvent.eventType, 'approval_instance'),
            eq(ewohEvent.status, instance.status),
          ),
        )
        .returning();
      if (!updatedInstance) {
        throw new ConflictException('STATE_CONFLICT');
      }
    });

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'approval.bypass',
      entityType: 'approval',
      entityId: id,
      // NEST-415：approval.yaml audit:high_risk——bypass 显式标 risk:true。
      risk: true,
      before: { instanceStatus: instance.status, steps: instance.steps },
      after: { instanceStatus: 'bypassed', steps: nextSteps },
    });

    return { ...instance, status: 'bypassed', steps: nextSteps };
  }

  async cancel(id: string, actor?: OrgContext): Promise<ApprovalInstance> {
    const instance = await this.getApproval(id, actor);
    if (
      instance.status === 'approved' ||
      instance.status === 'rejected' ||
      instance.status === 'bypassed'
    ) {
      throw new BadRequestException(`Approval ${id} is terminal`);
    }
    // NEST-405：approval.yaml 要求 role:initiator——非发起人（且非
    // global_admin）不可取消；legacy 行（无 createdBy）保持可操作不锁死。
    const actorRoles = actor?.roles ?? [];
    if (
      actor &&
      !actorRoles.includes(HIGH_PRIVILEGE_ROLE)
    ) {
      const [evidenceRow] = await this.db
        .select({ evidenceJson: ewohEvent.evidenceJson })
        .from(ewohEvent)
        .where(eq(ewohEvent.eventId, id));
      const evidence =
        ((evidenceRow?.evidenceJson as Record<string, unknown> | null) ?? {});
      const createdBy =
        typeof evidence.createdBy === 'string' ? evidence.createdBy : null;
      if (createdBy && createdBy !== actor.userId) {
        throw new ForbiddenException(
          'approval.cancel requires the initiator (or global_admin)',
        );
      }
    }
    const [updatedInstance] = await this.db
      .update(ewohEvent)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(ewohEvent.eventId, id),
          eq(ewohEvent.eventType, 'approval_instance'),
          eq(ewohEvent.status, instance.status),
        ),
      )
      .returning();
    if (!updatedInstance) {
      throw new ConflictException('STATE_CONFLICT');
    }

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'approval.cancel',
      entityType: 'approval',
      entityId: id,
      before: { instanceStatus: instance.status },
      after: { instanceStatus: 'cancelled' },
    });

    return { ...instance, status: 'cancelled' };
  }

  private toInstance(event: EventRow, steps: ApprovalStep[]): ApprovalInstance {
    const evidence = (event.evidenceJson ?? {}) as Record<string, unknown>;
    const createdAt =
      event.createdAt instanceof Date
        ? event.createdAt.toISOString()
        : event.createdAt
          ? new Date(event.createdAt).toISOString()
          : typeof evidence.createdAt === 'string'
            ? evidence.createdAt
            : new Date().toISOString();
    const subject = readSubject(evidence);
    return {
      id: event.eventId,
      entityType:
        typeof evidence.entityType === 'string' ? evidence.entityType : '',
      entityId: typeof evidence.entityId === 'string' ? evidence.entityId : '',
      status: event.status as ApprovalInstance['status'],
      steps,
      createdAt,
      // OD-1：对象描述符快照；老数据缺失时为 undefined，消费方回退渲染。
      ...(subject ? { subject } : {}),
    };
  }
}
