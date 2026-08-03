import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { desc, eq, like } from 'drizzle-orm';
import { ewohSchedulerConfig } from '@server/database/schema';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';
import { WorkflowService } from './workflow.service';

interface WorkflowInstanceValue {
  workflow: unknown;
  workflowId: string;
  entityId: string;
  currentStep: string;
  status: string;
  history: Array<{
    step: string;
    action?: string;
    at: string;
    actor?: string;
  }>;
}

@Injectable()
export class WorkflowInstanceService {
  constructor(
    private readonly workflowService: WorkflowService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  private parseInstance(row: {
    configKey: string;
    configValue: unknown;
    updatedBy: string | null;
    updatedAt: Date;
  }) {
    const value = (row.configValue as WorkflowInstanceValue | null) ?? {
      workflowId: '',
      entityId: '',
      currentStep: '',
      status: 'unknown',
      history: [],
    };
    return {
      key: row.configKey,
      workflowId: value.workflowId,
      entityId: value.entityId,
      currentStep: value.currentStep,
      status: value.status,
      history: value.history,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async start(
    body: { workflow: unknown; entityId: string },
    actor?: OrgContext,
  ) {
    if (!body.entityId?.trim()) {
      throw new BadRequestException('entityId is required');
    }
    const workflow = this.workflowService.validate(body.workflow);
    const configKey = `workflow.${workflow.workflowId}.${body.entityId.trim()}`;
    const now = new Date().toISOString();
    const value: WorkflowInstanceValue = {
      workflow: body.workflow,
      workflowId: workflow.workflowId,
      entityId: body.entityId.trim(),
      currentStep: workflow.start,
      status: 'active',
      history: [
        { step: workflow.start, at: now, actor: actor?.userId ?? 'system' },
      ],
    };
    const [row] = await this.db
      .insert(ewohSchedulerConfig)
      .values({
        configKey,
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
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'workflow.instance.start',
      entityType: 'workflow_instance',
      entityId: configKey,
      before: null,
      after: { workflowId: workflow.workflowId, currentStep: workflow.start },
    });
    return this.parseInstance(row);
  }

  async list() {
    const rows = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(like(ewohSchedulerConfig.configKey, 'workflow.%'))
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => this.parseInstance(row));
  }

  async advance(
    key: string,
    body: { roles: string[]; toStep?: string },
    actor?: OrgContext,
  ) {
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(eq(ewohSchedulerConfig.configKey, key));
    if (!row) {
      throw new NotFoundException(`Workflow instance ${key} not found`);
    }
    const value = row.configValue as WorkflowInstanceValue;
    const result = this.workflowService.advance(
      value.workflow,
      value.currentStep,
      body.roles,
    );
    if (!result.currentActionAllowed) {
      throw new BadRequestException(
        `Current step ${value.currentStep} is not allowed for the caller roles`,
      );
    }
    const targetName = body.toStep ?? result.allowedNextSteps[0]?.name;
    const target = result.allowedNextSteps.find(
      (step) => step.name === targetName,
    );
    if (!target) {
      throw new BadRequestException(
        `No allowed next step from ${value.currentStep} for the caller roles`,
      );
    }
    const now = new Date().toISOString();
    value.currentStep = target.name;
    value.history.push({
      step: target.name,
      action: target.action,
      at: now,
      actor: actor?.userId ?? 'system',
    });
    const [updated] = await this.db
      .update(ewohSchedulerConfig)
      .set({
        configValue: value,
        updatedBy: actor?.userId ?? 'system',
      })
      .where(eq(ewohSchedulerConfig.configKey, key))
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: 'workflow.instance.advance',
      entityType: 'workflow_instance',
      entityId: key,
      before: { currentStep: value.history[value.history.length - 2]?.step },
      after: { currentStep: target.name, action: target.action },
    });
    return this.parseInstance(updated);
  }
}
