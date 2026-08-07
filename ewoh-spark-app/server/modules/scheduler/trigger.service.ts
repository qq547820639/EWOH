import { Injectable, Inject, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, and, desc } from 'drizzle-orm';
import {
  ewohSchedulingRun,
  ewohReplanTrigger,
} from '@server/database/schema';
import type { SchedulingRun, SchedulingTrigger } from '@shared/api.interface';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import type { OrgContext } from '../shared/org-context.interceptor';
import { SchedulingPolicyService } from './scheduling-policy.service';

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
 * 触发器服务：对每次触发做持久化幂等去重 + 冷却去抖，并创建一条排队的调度运行记录。
 * 去重与去抖均基于 ewohReplanTrigger 表，跨进程/实例可靠。
 */
@Injectable()
export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly policyService: SchedulingPolicyService,
  ) {}

  /**
   * 求值一次触发：若处于冷却去抖窗口内或已存在相同 triggerKey（幂等去重）则合并（返回 null），
   * 否则记录触发并创建一条 status='queued' 的调度运行记录后返回。
   */
  async evaluate(
    triggerType: SchedulingTrigger | string,
    entityId: string | null,
    ctx: OrgContext,
    eventVersion = 0,
  ): Promise<SchedulingRun | null> {
    const orgKey = ctx.primaryOrgId || 'ALL';
    const triggerKey = `${orgKey}:${triggerType}:${entityId ?? 'ALL'}:${eventVersion ?? 0}`;
    const cooldownMs =
      (await this.policyService.getConfig()).triggerCooldownMs ?? 30_000;

    const runId = `RUN-${Date.now()}-${this.randomSuffix()}`;

    const runRow = await this.requestDatabaseContext.runInTransaction(
      buildGucSettings(ctx),
      async () => {
        // 1) 冷却去抖：同 (orgId, triggerType) 最近一次触发在窗口内则合并。
        const recent = await this.db
          .select()
          .from(ewohReplanTrigger)
          .where(
            and(
              eq(ewohReplanTrigger.orgId, orgKey),
              eq(ewohReplanTrigger.triggerType, triggerType),
            ),
          )
          .orderBy(desc(ewohReplanTrigger.createdAt))
          .limit(1);

        if (
          recent[0] &&
          Date.now() - recent[0].createdAt.getTime() < cooldownMs
        ) {
          this.logger.debug(
            `trigger ${triggerType} debounced by cooldown (${triggerKey})`,
          );
          return null;
        }

        // 2) 幂等去重：triggerKey 已存在则视为重复触发。
        const existing = await this.db
          .select()
          .from(ewohReplanTrigger)
          .where(eq(ewohReplanTrigger.triggerKey, triggerKey))
          .limit(1);
        if (existing[0]) {
          this.logger.debug(`trigger ${triggerType} deduped (${triggerKey})`);
          return null;
        }

        // 3) 记录持久化触发。
        await this.db.insert(ewohReplanTrigger).values({
          triggerKey,
          orgId: orgKey,
          triggerType,
          entityId: entityId ?? 'ALL',
          eventVersion: eventVersion ?? 0,
          status: 'processed',
          runId: null,
        });

        // 4) 创建排队运行记录。
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

        // 5) 回填 runId 至触发记录。
        await this.db
          .update(ewohReplanTrigger)
          .set({ runId })
          .where(eq(ewohReplanTrigger.triggerKey, triggerKey));

        return row;
      },
    );

    if (!runRow) return null;

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