import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  ApprovalInstance,
  ApprovalStep,
  ApprovalStepAction,
  CreateApprovalRequest,
} from '@shared/api.interface';

export type {
  ApprovalInstance,
  ApprovalInstanceStatus,
  ApprovalStep,
  ApprovalStepAction,
  ApprovalStepStatus,
  CreateApprovalRequest,
} from '@shared/api.interface';

/**
 * Synchronous in-memory approval service retained for unit smoke coverage
 * (`test/scenarios`). The HTTP module is wired to ApprovalPersistenceService,
 * which maps approvals to ewoh_event/ewoh_event_chain/ewoh_audit_log.
 */
let seq = 0;

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${Date.now()}-${seq}`;
}

export function aggregateApprovalStatus(
  steps: ApprovalStep[],
): ApprovalInstance['status'] {
  if (steps.some((step) => step.status === 'rejected')) {
    return 'rejected';
  }
  if (steps.every((step) => step.status === 'approved' || step.status === 'skipped')) {
    return 'approved';
  }
  if (steps.some((step) => step.status === 'expired')) {
    return 'expired';
  }
  return 'pending';
}

@Injectable()
export class ApprovalService {
  private readonly instances = new Map<string, ApprovalInstance>();

  createApproval(input: CreateApprovalRequest): ApprovalInstance {
    if (!input.entityType?.trim() || !input.entityId?.trim() || !input.roles?.length) {
      throw new BadRequestException('entityType, entityId and roles are required');
    }
    const instance: ApprovalInstance = {
      id: nextId('appr'),
      entityType: input.entityType,
      entityId: input.entityId,
      status: 'pending',
      steps: input.roles.map((role) => ({ id: nextId('step'), role, status: 'pending' })),
      createdAt: new Date().toISOString(),
    };
    this.instances.set(instance.id, instance);
    return instance;
  }

  getApproval(id: string): ApprovalInstance {
    const instance = this.instances.get(id);
    if (!instance) {
      throw new NotFoundException(`Approval ${id} not found`);
    }
    return instance;
  }

  stepAction(
    id: string,
    stepId: string,
    action: ApprovalStepAction,
    reason?: string,
    delegateTo?: string,
  ): ApprovalInstance {
    const instance = this.getApproval(id);
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
    switch (action) {
      case 'approve':
        step.status = 'approved';
        break;
      case 'reject':
        step.status = 'rejected';
        break;
      case 'delegate':
        step.status = 'delegated';
        step.delegateTo = delegateTo;
        break;
      case 'skip':
        step.status = 'skipped';
        break;
      case 'expire':
        step.status = 'expired';
        break;
    }
    if (reason !== undefined) {
      step.reason = reason;
    }
    instance.status = aggregateApprovalStatus(instance.steps);
    return instance;
  }

  bypass(id: string, reason: string): ApprovalInstance {
    const instance = this.getApproval(id);
    if (instance.status !== 'pending') {
      throw new BadRequestException(`Approval ${id} is not pending`);
    }
    instance.status = 'bypassed';
    instance.steps.forEach((step) => {
      if (step.status === 'pending') {
        step.status = 'skipped';
        step.reason = reason;
      }
    });
    return instance;
  }

  cancel(id: string): ApprovalInstance {
    const instance = this.getApproval(id);
    if (instance.status === 'approved' || instance.status === 'rejected' || instance.status === 'bypassed') {
      throw new BadRequestException(`Approval ${id} is terminal`);
    }
    instance.status = 'cancelled';
    return instance;
  }
}
