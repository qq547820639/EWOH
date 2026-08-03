import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, asc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ewohEvent, ewohEventChain } from '@server/database/schema';
import type {
  ApprovalInstance,
  ApprovalStep,
  ApprovalStepAction,
  ApprovalStepStatus,
  CreateApprovalRequest,
} from '@shared/api.interface';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { aggregateApprovalStatus } from './approval.service';

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

  async createApproval(
    input: CreateApprovalRequest,
    _actor?: OrgContext,
  ): Promise<ApprovalInstance> {
    if (
      !input.entityType?.trim() ||
      !input.entityId?.trim() ||
      !input.roles?.length
    ) {
      throw new BadRequestException('entityType, entityId and roles are required');
    }
    const now = new Date();
    const id = randomUUID();
    const entityType = input.entityType.trim();
    const entityId = input.entityId.trim();
    const steps: ApprovalStep[] = input.roles.map((role) => ({
      id: randomUUID(),
      role,
      status: 'pending',
    }));

    await this.db.insert(ewohEvent).values({
      eventId: id,
      eventType: 'approval_instance',
      title: `Approval for ${entityType} ${entityId}`,
      status: 'pending',
      createdAt: now,
      sourceType: 'approval',
      evidenceJson: {
        entityType,
        entityId,
        createdAt: now.toISOString(),
      },
    });
    await this.db.insert(ewohEventChain).values(
      steps.map((step) => ({
        eventId: step.id,
        parentEventId: id,
        causalType: 'approval_step',
        description: serializeStep(step),
        createdAt: now,
      })),
    );

    return {
      id,
      entityType,
      entityId,
      status: 'pending',
      steps,
      createdAt: now.toISOString(),
    };
  }

  async getApproval(id: string): Promise<ApprovalInstance> {
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
    const instance = await this.getApproval(id);
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

    const [updatedStep] = await this.db
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
    if (!updatedStep) {
      throw new ConflictException('STATE_CONFLICT');
    }

    const nextSteps = instance.steps.map((candidate) =>
      candidate.id === stepId ? nextStep : candidate,
    );
    const nextStatus = aggregateApprovalStatus(nextSteps);
    const [updatedInstance] = await this.db
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
    if (!updatedInstance) {
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
    const instance = await this.getApproval(id);
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

    for (const step of pendingSteps) {
      const nextStep = nextSteps.find(
        (candidate) => candidate.id === step.id,
      )!;
      const [updatedStep] = await this.db
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

    const [updatedInstance] = await this.db
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

    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'approval.bypass',
      entityType: 'approval',
      entityId: id,
      before: { instanceStatus: instance.status, steps: instance.steps },
      after: { instanceStatus: 'bypassed', steps: nextSteps },
    });

    return { ...instance, status: 'bypassed', steps: nextSteps };
  }

  async cancel(id: string, actor?: OrgContext): Promise<ApprovalInstance> {
    const instance = await this.getApproval(id);
    if (
      instance.status === 'approved' ||
      instance.status === 'rejected' ||
      instance.status === 'bypassed'
    ) {
      throw new BadRequestException(`Approval ${id} is terminal`);
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
    return {
      id: event.eventId,
      entityType:
        typeof evidence.entityType === 'string' ? evidence.entityType : '',
      entityId: typeof evidence.entityId === 'string' ? evidence.entityId : '',
      status: event.status as ApprovalInstance['status'],
      steps,
      createdAt,
    };
  }
}
