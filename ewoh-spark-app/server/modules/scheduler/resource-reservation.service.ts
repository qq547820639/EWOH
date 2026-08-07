import { Inject, Injectable, Logger, ConflictException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohResourceReservation } from '@server/database/schema';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';

export interface ReservationInput {
  resourceType:
    | 'person'
    | 'device'
    | 'station'
    | 'tool'
    | 'material'
    | 'vehicle';
  resourceId: string;
  startMs: number;
  endMs: number;
}

export interface ReservationResult {
  reservationId: string;
  resourceType: string;
  resourceId: string;
  startMs: number;
  endMs: number;
}

const ACTIVE_STATUSES = ['reserved', 'active'] as const;

/** 资源预占：reserve/release/list，基于事务内 check-then-insert 防双重占用。 */
@Injectable()
export class ResourceReservationService {
  private readonly logger = new Logger(ResourceReservationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  /**
   * 在单个事务内为指定资源时间窗预占。若任一资源在重叠时间窗内已有
   * reserved/active 占用，则抛 RESOURCE_CONFLICT，整个事务回滚。
   */
  async reserve(
    planId: string,
    assignmentId: string,
    taskId: string | null,
    inputs: ReservationInput[],
    ctx: OrgContext,
  ): Promise<ReservationResult[]> {
    const results: ReservationResult[] = [];
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        for (const input of inputs) {
          const conflicts = await this.db
            .select({ id: ewohResourceReservation.id })
            .from(ewohResourceReservation)
            .where(
              and(
                eq(ewohResourceReservation.resourceType, input.resourceType),
                eq(ewohResourceReservation.resourceId, input.resourceId),
                inArray(ewohResourceReservation.status, [...ACTIVE_STATUSES]),
                lt(ewohResourceReservation.startMs, input.endMs),
                gt(ewohResourceReservation.endMs, input.startMs),
              ),
            )
            .limit(1);
          if (conflicts.length > 0) {
            throw new ConflictException('RESOURCE_CONFLICT');
          }

          const reservationId = `RSV-${Date.now()}-${this.randomSuffix()}`;
          const [row] = await this.db
            .insert(ewohResourceReservation)
            .values({
              reservationId,
              resourceType: input.resourceType,
              resourceId: input.resourceId,
              assignmentId: assignmentId ?? null,
              planId,
              taskId: taskId ?? null,
              startMs: input.startMs,
              endMs: input.endMs,
              status: 'reserved',
              version: 1,
              orgId: ctx.primaryOrgId || null,
              createdBy: ctx.userId,
            })
            .returning();

          results.push({
            reservationId: row.reservationId,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
            startMs: row.startMs,
            endMs: row.endMs,
          });
        }
      },
    );
    return results;
  }

  /** 释放某方案下的全部预占，返回受影响行数。 */
  async releaseForPlan(planId: string, ctx: OrgContext): Promise<number> {
    let count = 0;
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        const rows = await this.db
          .update(ewohResourceReservation)
          .set({ status: 'released' })
          .where(eq(ewohResourceReservation.planId, planId))
          .returning();
        count = rows.length;
      },
    );
    return count;
  }

  /** 列出所有活跃预占（reserved/active）。 */
  async listActive(): Promise<ReservationResult[]> {
    const rows = await this.db
      .select()
      .from(ewohResourceReservation)
      .where(inArray(ewohResourceReservation.status, [...ACTIVE_STATUSES]));
    return rows.map((r) => ({
      reservationId: r.reservationId,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      startMs: r.startMs,
      endMs: r.endMs,
    }));
  }

  /** 给定资源时间窗是否与现有活跃预占冲突。 */
  async hasConflict(
    resourceType: string,
    resourceId: string,
    startMs: number,
    endMs: number,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: ewohResourceReservation.id })
      .from(ewohResourceReservation)
      .where(
        and(
          eq(ewohResourceReservation.resourceType, resourceType),
          eq(ewohResourceReservation.resourceId, resourceId),
          inArray(ewohResourceReservation.status, [...ACTIVE_STATUSES]),
          lt(ewohResourceReservation.startMs, endMs),
          gt(ewohResourceReservation.endMs, startMs),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private randomSuffix(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 4; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }
}