import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, or, eq, isNull, lte, sql } from 'drizzle-orm';
import { ewohWorkbenchExportTask } from '@server/database/schema';
import type {
  WorkbenchExportStore,
  WorkbenchExportTask,
} from './workbench-export.service';

/**
 * PostgreSQL-persisted, durable async export task registry.
 *
 * Backed by the `workbench_export_tasks` table from
 * `standalone_005_workbench_prod.sql`. Survives page refreshes / server restarts /
 * instance switches, supports an atomic outbox claim (two workers can never
 * process the same task), and keeps retry bookkeeping in-row.
 *
 * Org isolation is enforced by explicit `organization_id` scoping in addition to
 * the request transaction's `app.current_org_id` GUC.
 */

type ExportRow = typeof ewohWorkbenchExportTask.$inferSelect;

function fromRow(row: ExportRow): WorkbenchExportTask {
  const filterJson = (row.filterJson ?? {}) as { filter?: string; action?: string };
  return {
    id: row.taskId,
    role: row.role as WorkbenchExportTask['role'],
    listKey: row.listKey,
    filter: filterJson.filter ?? '',
    status: row.status as WorkbenchExportTask['status'],
    progress: row.progress,
    processed: row.processed,
    total: row.total,
    ownerId: row.ownerUserId,
    orgId: row.organizationId,
    action: filterJson.action ?? 'workbench.export',
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : new Date(row.createdAt).toISOString(),
    downloadUrl: row.downloadUrl ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    nextRetryAt: row.nextRetryAt ? new Date(row.nextRetryAt).toISOString() : undefined,
    claimedBy: row.claimedBy ?? undefined,
    claimedAt: row.claimedAt ? new Date(row.claimedAt).toISOString() : undefined,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : undefined,
    rowCount: row.rowCount ?? undefined,
    fileSize: row.fileSize ?? undefined,
  };
}

@Injectable()
export class PostgresWorkbenchExportStore implements WorkbenchExportStore {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async create(task: WorkbenchExportTask): Promise<WorkbenchExportTask> {
    const createdAt = new Date(task.createdAt ?? new Date().toISOString());
    await this.db.insert(ewohWorkbenchExportTask).values({
      taskId: task.id,
      organizationId: task.orgId,
      ownerUserId: task.ownerId,
      role: task.role,
      listKey: task.listKey,
      filterJson: { filter: task.filter ?? '', action: task.action },
      status: task.status,
      progress: task.progress,
      processed: task.processed,
      total: task.total,
      error: task.error ?? null,
      attempts: task.attempts ?? 0,
      nextRetryAt: task.nextRetryAt ? new Date(task.nextRetryAt) : null,
      claimedBy: task.claimedBy ?? null,
      claimedAt: task.claimedAt ? new Date(task.claimedAt) : null,
      startedAt: task.startedAt ? new Date(task.startedAt) : null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: task.expiresAt ? new Date(task.expiresAt) : null,
      downloadUrl: task.downloadUrl ?? null,
      fileSize: task.fileSize ?? null,
      rowCount: task.rowCount ?? null,
    });
    return task;
  }

  async get(id: string): Promise<WorkbenchExportTask | undefined> {
    const rows = await this.db
      .select()
      .from(ewohWorkbenchExportTask)
      .where(eq(ewohWorkbenchExportTask.taskId, id))
      .limit(1);
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  async update(id: string, patch: Partial<WorkbenchExportTask>): Promise<void> {
    await this.db
      .update(ewohWorkbenchExportTask)
      .set({
        status: patch.status ?? undefined,
        progress: patch.progress ?? undefined,
        processed: patch.processed ?? undefined,
        total: patch.total ?? undefined,
        error: patch.error ?? undefined,
        downloadUrl: patch.downloadUrl ?? null,
        nextRetryAt: patch.nextRetryAt ? new Date(patch.nextRetryAt) : undefined,
        claimedBy: patch.claimedBy ?? undefined,
        claimedAt: patch.claimedAt ? new Date(patch.claimedAt) : undefined,
        startedAt: patch.startedAt ? new Date(patch.startedAt) : undefined,
        finishedAt: patch.finishedAt ? new Date(patch.finishedAt) : undefined,
        rowCount: patch.rowCount ?? undefined,
        fileSize: patch.fileSize ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(ewohWorkbenchExportTask.taskId, id));
  }

  async claim(
    id: string,
    workerId: string,
    now = new Date(),
  ): Promise<WorkbenchExportTask | undefined> {
    const rows = await this.db
      .update(ewohWorkbenchExportTask)
      .set({
        status: 'running',
        claimedBy: workerId,
        claimedAt: now,
        startedAt: now,
        attempts: sql`${ewohWorkbenchExportTask.attempts} + 1`,
        nextRetryAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(ewohWorkbenchExportTask.taskId, id),
          or(
            eq(ewohWorkbenchExportTask.status, 'queued'),
            eq(ewohWorkbenchExportTask.status, 'expired'),
            and(
              eq(ewohWorkbenchExportTask.status, 'failed'),
              or(
                isNull(ewohWorkbenchExportTask.nextRetryAt),
                lte(ewohWorkbenchExportTask.nextRetryAt, now),
              ),
            ),
          ),
        ),
      )
      .returning();
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
}