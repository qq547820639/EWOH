import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq, like } from 'drizzle-orm';
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

  /**
   * R2-SNZ-003（收敛 NEST-625）：缺租户一律 fail-closed 400——原先
   * `!actor?.primaryOrgId` 分支直接放行无租户过滤（fail-open），与
   * world/oee/system/task 等模块已确立的 fail-closed 模式相悖。
   */
  private requireOrgId(actor?: OrgContext): string {
    const orgId = actor?.primaryOrgId?.trim();
    if (!orgId) {
      throw new BadRequestException(
        'org context missing: workflow instance operations require tenant context',
      );
    }
    return orgId;
  }

  /** global_admin 显式放行（与 RLS 例外路径一致）；其余强制本租户谓词。 */
  private orgCondition(actor?: OrgContext) {
    if (actor?.isGlobalAdmin) {
      return undefined;
    }
    return eq(ewohSchedulerConfig.orgId, this.requireOrgId(actor));
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
    // NEST-625 + R2-SNZ-003：写入显式 orgId（ewoh_scheduler_config.org_id
    // NOT NULL）；缺租户 fail-closed 拒绝，不再省略依赖 GUC 兜底。
    const orgId = this.requireOrgId(actor);
    const [row] = await this.db
      .insert(ewohSchedulerConfig)
      .values({
        configKey,
        configValue: value,
        updatedBy: actor?.userId ?? 'system',
        orgId,
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
      orgId: orgId ?? row.orgId ?? '',
      action: 'workflow.instance.start',
      entityType: 'workflow_instance',
      entityId: configKey,
      before: null,
      after: { workflowId: workflow.workflowId, currentStep: workflow.start },
    });
    return this.parseInstance(row);
  }

  async list(actor?: OrgContext) {
    // NEST-625 + R2-SNZ-003：org 过滤（global_admin 放行，与 RLS 例外
    // 一致）；缺租户 fail-closed 400（原先放行 = 全租户实例可见）。
    const orgCond = this.orgCondition(actor);
    const rows = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(
        orgCond
          ? and(like(ewohSchedulerConfig.configKey, 'workflow.%'), orgCond)
          : like(ewohSchedulerConfig.configKey, 'workflow.%'),
      )
      .orderBy(desc(ewohSchedulerConfig.updatedAt));
    return rows.map((row) => this.parseInstance(row));
  }

  async advance(
    key: string,
    body: { roles: string[]; toStep?: string },
    actor?: OrgContext,
  ) {
    // R2-SNZ-003：缺租户 fail-closed 400（原先放行 = 可跨租户推进实例）。
    const orgCond = this.orgCondition(actor);
    const [row] = await this.db
      .select()
      .from(ewohSchedulerConfig)
      .where(
        orgCond
          ? and(eq(ewohSchedulerConfig.configKey, key), orgCond)
          : eq(ewohSchedulerConfig.configKey, key),
      );
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
      .where(
        orgCond
          ? and(eq(ewohSchedulerConfig.configKey, key), orgCond)
          : eq(ewohSchedulerConfig.configKey, key),
      )
      .returning();
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? row.orgId ?? '',
      action: 'workflow.instance.advance',
      entityType: 'workflow_instance',
      entityId: key,
      before: { currentStep: value.history[value.history.length - 2]?.step },
      after: { currentStep: target.name, action: target.action },
    });
    return this.parseInstance(updated);
  }
}
