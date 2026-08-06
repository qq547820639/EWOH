import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AuditService } from '../shared/audit.service';
import {
  canAccessWorkbenchRole,
  type WorkbenchRole,
} from './workbench-access';
import { WORKBENCH_ROLES } from './workbench-access';
import {
  assertTransition,
  canTransition,
  isTerminal,
  type WorkbenchExportStatus,
} from './workbench-export-state';

/**
 * Async large-data export for the Role Workbench.
 *
 * Replaces the old client-side Blob CSV path: the server owns the export, so a
 * large result set is streamed/produced asynchronously. The task carries
 * progress, an expiry deadline, the requesting actor's permission gate, and an
 * audit trail (via AuditService).
 *
 * The task registry is injectable: the in-memory store works in unit tests and
 * single-instance dev; the PostgreSQL-backed store (PostgresWorkbenchExportStore)
 * is wired in production for durable, multi-instance, cross-restart storage.
 */

export interface WorkbenchExportSpec {
  role: WorkbenchRole;
  listKey: string;
  filter?: string;
}

export interface WorkbenchExportTask {
  id: string;
  role: WorkbenchRole;
  listKey: string;
  filter: string;
  status: WorkbenchExportStatus;
  progress: number;
  processed: number;
  total: number;
  ownerId: string;
  orgId: string;
  action: string;
  createdAt: string;
  expiresAt: string;
  downloadUrl?: string;
  error?: string;
  attempts?: number;
  nextRetryAt?: string;
  claimedBy?: string;
  claimedAt?: string;
  startedAt?: string;
  rowCount?: number;
  fileSize?: number;
  finishedAt?: string;
}

export interface WorkbenchExportStore {
  create(task: WorkbenchExportTask): Promise<WorkbenchExportTask>;
  get(id: string): Promise<WorkbenchExportTask | undefined>;
  update(id: string, patch: Partial<WorkbenchExportTask>): Promise<void>;
  /**
   * Atomically claim a task for a worker instance. Only a claimable task
   * (queued, or a failed task whose retry deadline has passed) is handed back;
   * in-flight tasks owned by another worker are left untouched. Returns the
   * claimed task (now `running`) or `undefined` when the task is not claimable.
   */
  claim(
    id: string,
    workerId: string,
    now?: Date,
  ): Promise<WorkbenchExportTask | undefined>;
}

export class InMemoryWorkbenchExportStore implements WorkbenchExportStore {
  private readonly tasks = new Map<string, WorkbenchExportTask>();

  async create(task: WorkbenchExportTask): Promise<WorkbenchExportTask> {
    this.tasks.set(task.id, task);
    return task;
  }

  async get(id: string): Promise<WorkbenchExportTask | undefined> {
    return this.tasks.get(id);
  }

  async update(id: string, patch: Partial<WorkbenchExportTask>): Promise<void> {
    const existing = this.tasks.get(id);
    if (existing) {
      this.tasks.set(id, { ...existing, ...patch });
    }
  }

  async claim(
    id: string,
    workerId: string,
    now = new Date(),
  ): Promise<WorkbenchExportTask | undefined> {
    const existing = this.tasks.get(id);
    if (!existing) return undefined;
    const claimable =
      existing.status === 'queued' ||
      (existing.status === 'failed' &&
        (!existing.nextRetryAt || new Date(existing.nextRetryAt).getTime() <= now.getTime())) ||
      existing.status === 'expired';
    if (!claimable) return undefined;
    const claimed: WorkbenchExportTask = {
      ...existing,
      status: 'running',
      claimedBy: workerId,
      claimedAt: now.toISOString(),
      startedAt: existing.startedAt ?? now.toISOString(),
      attempts: (existing.attempts ?? 0) + 1,
      nextRetryAt: undefined,
    };
    this.tasks.set(id, claimed);
    return claimed;
  }

  clear(): void {
    this.tasks.clear();
  }
}

export const WORKBENCH_EXPORT_STORE = Symbol('WORKBENCH_EXPORT_STORE');

export interface WorkbenchExportActor {
  userId: string;
  primaryOrgId: string;
  roles?: string[];
}

const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000; // 24h expiry

@Injectable()
export class WorkbenchExportService {
  constructor(
    @Optional() @Inject(WORKBENCH_EXPORT_STORE)
    private readonly store: WorkbenchExportStore = new InMemoryWorkbenchExportStore(),
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private async appendAudit(
    actor: WorkbenchExportActor,
    action: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditService) return;
    await this.auditService.appendAuditLog({
      actorId: actor.userId,
      orgId: actor.primaryOrgId,
      action,
      entityType: 'workbench_export',
      entityId: String(metadata.id ?? ''),
      metadata,
      risk: action === 'workbench.export.failed',
    });
  }

  /** Creates an async export task after a server-side permission gate. */
  async createExportTask(
    actor: WorkbenchExportActor,
    spec: WorkbenchExportSpec,
  ): Promise<WorkbenchExportTask> {
    if (!WORKBENCH_ROLES.includes(spec.role)) {
      throw new BadRequestException(
        `role must be one of ${WORKBENCH_ROLES.join(', ')}`,
      );
    }
    if (!canAccessWorkbenchRole(actor.roles ?? [], spec.role)) {
      throw new ForbiddenException(
        `You are not authorized to export the '${spec.role}' workbench`,
      );
    }
    const now = Date.now();
    const task: WorkbenchExportTask = {
      id: randomUUID(),
      role: spec.role,
      listKey: spec.listKey,
      filter: spec.filter ?? '',
      status: 'queued',
      progress: 0,
      processed: 0,
      total: 0,
      ownerId: actor.userId,
      orgId: actor.primaryOrgId,
      action: 'workbench.export',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEFAULT_TASK_TTL_MS).toISOString(),
    };
    await this.store.create(task);
    await this.appendAudit(actor, 'workbench.export.requested', {
      id: task.id,
      role: task.role,
      listKey: task.listKey,
    });
    return task;
  }

  /** Advances progress while the export runs. Only valid from `running`. */
  async advance(taskId: string, progress: number, processed: number, total: number): Promise<void> {
    const task = await this.store.get(taskId);
    if (task) assertTransition(task.status, 'running');
    await this.store.update(taskId, {
      status: 'running',
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      processed,
      total,
    });
  }

  /** Marks the export as finished and records the download target. */
  async complete(taskId: string, downloadUrl: string, meta?: { rowCount?: number; fileSize?: number }): Promise<void> {
    const task = await this.store.get(taskId);
    if (task) assertTransition(task.status, 'succeeded');
    await this.store.update(taskId, {
      status: 'succeeded',
      progress: 100,
      downloadUrl,
      rowCount: meta?.rowCount,
      fileSize: meta?.fileSize,
      finishedAt: new Date().toISOString(),
    });
  }

  /** Marks the export as failed. */
  async fail(taskId: string, error: string): Promise<void> {
    const task = await this.store.get(taskId);
    if (task) assertTransition(task.status, 'failed');
    await this.store.update(taskId, {
      status: 'failed',
      error,
      finishedAt: new Date().toISOString(),
    });
  }

  /**
   * Atomically claims a task for a worker. Only queued (or retryable) tasks are
   * handed back, so two workers can never claim the same export.
   */
  async claimExportTask(taskId: string, workerId: string): Promise<WorkbenchExportTask | undefined> {
    return this.store.claim(taskId, workerId);
  }

  /** Requests cancellation. Queued tasks are cancelled immediately. */
  async cancelExportTask(
    taskId: string,
    actor: WorkbenchExportActor,
  ): Promise<WorkbenchExportTask> {
    const task = await this.store.get(taskId);
    if (!task) throw new NotFoundException('export task not found');
    if (task.ownerId !== actor.userId && !(actor.roles ?? []).includes('global_admin')) {
      throw new ForbiddenException('You may only cancel your own export tasks');
    }
    const from = task.status;
    if (from === 'queued') {
      assertTransition(from, 'cancelled');
      await this.store.update(taskId, { status: 'cancelled', finishedAt: new Date().toISOString() });
    } else if (from === 'running') {
      assertTransition(from, 'cancelling');
      await this.store.update(taskId, { status: 'cancelling' });
    } else {
      throw new BadRequestException(`Cannot cancel an export in '${from}' state`);
    }
    await this.appendAudit(actor, 'workbench.export.cancelled', { id: taskId });
    return (await this.store.get(taskId)) as WorkbenchExportTask;
  }

  /**
   * Acknowledges that a worker has honoured cancellation (`cancelling → cancelled`)
   * or could not honour it (`cancelling → failed`).
   */
  async confirmCancellation(
    taskId: string,
    success: boolean,
    error?: string,
  ): Promise<void> {
    const task = await this.store.get(taskId);
    if (!task) return;
    assertTransition(task.status, success ? 'cancelled' : 'failed');
    await this.store.update(taskId, {
      status: success ? 'cancelled' : 'failed',
      error: success ? task.error : error,
      finishedAt: new Date().toISOString(),
    });
  }

  /** Requeues a failed/expired task for another attempt (with backoff deadline). */
  async retryExportTask(taskId: string, retryAfterMs = 30 * 1000): Promise<void> {
    const task = await this.store.get(taskId);
    if (!task) throw new NotFoundException('export task not found');
    if (!canTransition(task.status, 'running')) {
      throw new BadRequestException(`Cannot retry an export in '${task.status}' state`);
    }
    const now = new Date();
    await this.store.update(taskId, {
      status: 'queued',
      nextRetryAt: new Date(now.getTime() + retryAfterMs).toISOString(),
      error: undefined,
    });
  }

  /**
   * Reads a task for the requesting actor. Enforces ownership (or global admin)
   * and returns an `expired` status when the task's deadline has passed instead
   * of leaking queued data. Records an audit entry on expiry.
   */
  async getExportTask(
    taskId: string,
    actor: WorkbenchExportActor,
    now = Date.now(),
  ): Promise<WorkbenchExportTask> {
    const task = await this.store.get(taskId);
    if (!task) {
      throw new NotFoundException('export task not found');
    }
    const isOwner = task.ownerId === actor.userId;
    const isAdmin = (actor.roles ?? []).includes('global_admin');
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('You may only inspect your own export tasks');
    }
    if (!isTerminal(task.status) && now > new Date(task.expiresAt).getTime()) {
      assertTransition(task.status, 'expired');
      await this.store.update(taskId, { status: 'expired' });
      await this.appendAudit(actor, 'workbench.export.expired', { id: taskId });
      return { ...task, status: 'expired' };
    }
    return task;
  }
}