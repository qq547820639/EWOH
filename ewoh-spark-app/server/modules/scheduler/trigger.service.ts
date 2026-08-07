import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { ewohSchedulingRun } from '@server/database/schema';
import type { SchedulingRun, SchedulingTrigger } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';

/** 支持的 10 种调度触发类型。 */
export const SCHEDULING_TRIGGER_TYPES: SchedulingTrigger[] = [
  'MANUAL',
  'TASK_CREATED',
  'TASK_UPDATED',
  'PERSON_UNAVAILABLE',
  'DEVICE_OFFLINE',
  'DEVICE_LOW_BATTERY',
  'BOTTLENECK_DETECTED',
  'DEADLINE_AT_RISK',
  'SAFETY_EVENT',
  'ZONE_RESTRICTED',
];

/**
 * 触发器服务：对每次触发做冷却去抖，并创建一条排队的调度运行记录。
 */
@Injectable()
export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);

  /** 每种触发类型的冷却窗口（毫秒），窗口内合并触发。 */
  private readonly cooldownMs = 30_000;

  /** 每种触发类型最近一次的触发时间戳。 */
  private readonly lastTriggeredAt = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  /**
   * 求值一次触发：若处于冷却去抖窗口内则合并（返回 null），
   * 否则创建一条 status='queued' 的调度运行记录并返回。
   */
  async evaluate(
    triggerType: SchedulingTrigger | string,
    entityId: string | null,
    ctx: OrgContext,
  ): Promise<SchedulingRun | null> {
    const now = Date.now();
    const last = this.lastTriggeredAt.get(triggerType) ?? 0;
    if (now - last < this.cooldownMs) {
      this.logger.debug(
        `trigger ${triggerType} debounced (last ${now - last}ms ago)`,
      );
      return null;
    }
    this.lastTriggeredAt.set(triggerType, now);

    const runId = `RUN-${now}-${this.randomSuffix()}`;
    const runRow = await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        const [row] = await this.db
          .insert(ewohSchedulingRun)
          .values({
            runId,
            triggerType,
            triggerEntityId: entityId ?? null,
            status: 'queued',
            orgId: ctx.primaryOrgId || null,
          })
          .returning();
        return row;
      },
    );

    this.logger.log(`scheduling run created: ${runId} via ${triggerType}`);
    return this.toRun(runRow);
  }

  private toRun(r: typeof ewohSchedulingRun.$inferSelect): SchedulingRun {
    return {
      runId: r.runId,
      triggerType: (r.triggerType ?? 'MANUAL') as SchedulingTrigger | string,
      triggerEntityId: r.triggerEntityId ?? null,
      status: (r.status ?? 'queued') as SchedulingRun['status'],
      snapshotVersion: r.snapshotVersion ?? null,
      planIds: (r.planIds as string[] | null) ?? [],
      orgId: r.orgId ?? null,
      error: r.error ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : new Date().toISOString(),
    };
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