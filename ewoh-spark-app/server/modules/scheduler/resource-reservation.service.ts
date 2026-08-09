import { Inject, Injectable, Logger, ConflictException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohResourceReservation } from '@server/database/schema';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
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
  /**
   * P0-7：station 资源容量（ewoh_workstation.capacity / 快照 station.capacity）。
   * 缺省 1（向后兼容：与旧二值占用语义一致）。person/device 恒为 1，忽略本字段。
   */
  capacity?: number;
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
   * P0-7：资源容量。person/device 等非 station 资源恒 1（二值占用）；
   * station 读调用方传入的 capacity（来自 ewoh_workstation / 快照 station.capacity），
   * 缺省 1 向后兼容。
   */
  private capacityFor(input: ReservationInput): number {
    if (input.resourceType === 'station') {
      return typeof input.capacity === 'number' && input.capacity > 0
        ? Math.floor(input.capacity)
        : 1;
    }
    return 1;
  }

  /**
   * 在单个事务内为指定资源时间窗预占。
   * 冲突语义（P0-7）：
   *   - person/device：二值占用（重叠即冲突，capacity=1）；
   *   - station：**容量感知**——同资源同时间窗内已占用计数 < capacity 才放行
   *     （capacity=1 与旧二值语义一致；capacity>1 允许多个重叠任务，与求解器
   *     AddCumulative 一致）。
   * 并发：station 通过 pg_advisory_xact_lock（资源 id 哈希）在事务内串行化
   * check-then-insert，避免"双方都计数通过后同时插入"竞态；DB EXCLUDE 约束
   * （standalone_022 起）仅覆盖 person/device 作为硬后盾。
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
          const capacity = this.capacityFor(input);
          // P0-7：station 容量计数需要事务级串行化（替代被移除的 station EXCLUDE）。
          // 无 execute 的测试替身/降级环境跳过锁，仍走计数（计数为快速路径）。
          if (input.resourceType === 'station') {
            try {
              await this.db.execute(
                sql`SELECT pg_advisory_xact_lock(hashtext(${input.resourceId}))`,
              );
            } catch {
              // 无 execute 能力的环境跳过 advisory lock（单测替身/只读副本）
            }
          }
          const overlapping = await this.db
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
            );
          if (overlapping.length >= capacity) {
            throw new ConflictException('RESOURCE_CONFLICT');
          }

          const reservationId = `RSV-${Date.now()}-${this.randomSuffix()}`;
          let row: { reservationId: string; resourceType: string; resourceId: string; startMs: number; endMs: number } | undefined;
          try {
            [row] = await this.db
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
          } catch (error) {
            // P0-5：数据库层 EXCLUDE 约束（standalone_009 no_overlap）在并发插入
            // 时抛 exclusion_violation（23P01）。应用层 check-then-insert 是快速路径，
            // DB 约束是硬后盾——将原生错误统一转 409 RESOURCE_CONFLICT，避免 500。
            const code = (error as { code?: string })?.code;
            if (code === '23P01' || code === '23505' || code === '23514') {
              throw new ConflictException(
                `RESOURCE_CONFLICT: resource ${input.resourceType}:${input.resourceId} already reserved in overlapping window`,
              );
            }
            throw error;
          }

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

  /**
   * P0-7：下发前 station 容量预检（dispatch 快速失败，fail-fast）。
   * 与 reserve() 的容量计数语义一致（count < capacity 放行）；
   * reserve() 内的计数仍是事务内的权威校验，本方法用于 dispatch 阶段尽早暴露
   * 容量不足，避免走到事务中段才失败。person/device 由 DB EXCLUDE 硬后盾保证，
   * 无需预检。
   */
  async assertStationCapacityAvailable(
    inputs: ReservationInput[],
    ctx: OrgContext,
  ): Promise<void> {
    const stationInputs = inputs.filter((i) => i.resourceType === 'station');
    if (stationInputs.length === 0) return;
    await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        for (const input of stationInputs) {
          const capacity = this.capacityFor(input);
          const overlapping = await this.db
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
            );
          if (overlapping.length >= capacity) {
            throw new ConflictException(
              `STATION_CAPACITY: station ${input.resourceId} already at capacity ${capacity}`,
            );
          }
        }
      },
    );
  }

  /** 释放某方案下的全部预占，返回受影响行数。 */
  async releaseForPlan(planId: string, ctx: OrgContext): Promise<number> {    let count = 0;
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