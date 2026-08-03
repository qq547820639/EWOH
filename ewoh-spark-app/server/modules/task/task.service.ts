import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, desc, eq } from 'drizzle-orm';
import { ewohProductionTask } from '@server/database/schema';
import { isValidUuid } from '@server/common/uuid';
import { AuditService } from '../shared/audit.service';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface CreateTaskDto {
  title: string;
  taskType: string;
  priority?: string;
  description?: string;
  assigneeId?: string;
  deviceId?: string;
  spatialEntityId?: string;
  planStart?: string;
  planEnd?: string;
}

export function nextTaskStatus(current: string, action: string): string | null {
  switch (action) {
    case 'submit':
      return current === 'draft' ? 'pending_confirm' : null;
    case 'request_approval':
      return current === 'pending_confirm' ? 'pending_approval' : null;
    case 'skip_approval':
      return current === 'pending_confirm' ? 'pending_dispatch' : null;
    case 'approve':
      return current === 'pending_approval' ? 'pending_dispatch' : null;
    case 'reject':
      return current === 'pending_approval' ? 'draft' : null;
    case 'dispatch':
      return current === 'pending_dispatch' ? 'dispatched' : null;
    case 'receive':
      return current === 'dispatched' ? 'received' : null;
    case 'start':
      return current === 'received' ? 'executing' : null;
    case 'pause':
      return current === 'executing' ? 'paused' : null;
    case 'resume':
      return current === 'paused' ? 'executing' : null;
    case 'exception':
      return current === 'executing' ? 'exception' : null;
    case 'resolve':
      return current === 'exception' ? 'executing' : null;
    case 'complete':
      return current === 'executing' ? 'completed' : null;
    case 'cancel':
      return [
        'draft',
        'pending_confirm',
        'pending_approval',
        'pending_dispatch',
        'dispatched',
        'received',
        'executing',
        'paused',
        'exception',
      ].includes(current)
        ? 'cancelled'
        : null;
    default:
      return null;
  }
}

@Injectable()
export class TaskService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly auditService: AuditService,
  ) {}

  async listTasks() {
    return this.db
      .select()
      .from(ewohProductionTask)
      .orderBy(desc(ewohProductionTask.createdAt));
  }

  async getTask(id: string) {
    if (!isValidUuid(id)) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    const [row] = await this.db
      .select()
      .from(ewohProductionTask)
      .where(eq(ewohProductionTask.id, id));
    if (!row) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return row;
  }

  async createTask(body: CreateTaskDto) {
    if (!body.title?.trim() || !body.taskType?.trim()) {
      throw new BadRequestException('title and taskType are required');
    }
    const [row] = await this.db
      .insert(ewohProductionTask)
      .values({
        title: body.title.trim(),
        taskType: body.taskType.trim(),
        priority: body.priority ?? 'medium',
        description: body.description ?? null,
        assigneeId: body.assigneeId ?? null,
        deviceId: body.deviceId ?? null,
        spatialEntityId: body.spatialEntityId ?? null,
        planStart: body.planStart ? new Date(body.planStart) : null,
        planEnd: body.planEnd ? new Date(body.planEnd) : null,
        status: 'draft',
        source: 'manual',
      })
      .returning();
    return row;
  }

  async transitionTaskState(id: string, action: string, actor?: OrgContext) {
    const task = await this.getTask(id);
    const status = nextTaskStatus(task.status, action);
    if (!status) {
      throw new BadRequestException(
        `Transition ${action} not allowed from ${task.status}`,
      );
    }
    const before = task.status;
    const [row] = await this.db
      .update(ewohProductionTask)
      .set({ status })
      .where(
        and(
          eq(ewohProductionTask.id, id),
          eq(ewohProductionTask.status, before),
        ),
      )
      .returning();
    if (!row) {
      throw new ConflictException('STATE_CONFLICT');
    }
    await this.auditService.appendAuditLog({
      actorId: actor?.userId ?? 'system',
      orgId: actor?.primaryOrgId ?? '',
      action: `task.${action}`,
      entityType: 'production_task',
      entityId: row.id,
      before: { status: before },
      after: { status: row.status },
    });
    return row;
  }
}
