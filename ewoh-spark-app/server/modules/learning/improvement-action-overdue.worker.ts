import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ImprovementActionService } from './improvement-action.service';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';
import { AuditService } from '../shared/audit.service';

/**
 * 改进行动项"逾期未完成"提醒 worker（NO-56b）。
 *
 * 为什么需要定时：逾期提醒的价值就在"没人主动看"的时候——
 * 靠页面/交接去看只会静默堆积。与其它到期类 worker 同纪律：
 *   · 逐租户开 GUC 事务（后台没有请求上下文，RLS 会把行全部挡住）；
 *   · 单次失败只留痕不退出；
 *   · 默认 30 分钟一次，`IMPROVEMENT_ACTION_OVERDUE_WORKER_DISABLED=1` 可关。
 */
/**
 * 巡检间隔解析：正有限数才接受，非法/缺失回退默认（invalid 时回调留痕）。
 *
 * 与 `control-delivery-backlog.worker.ts#backlogIntervalMs` 同一条纪律：Node 把
 * `setInterval(fn, NaN)` 当成 **1ms**（本机实测 120ms 窗口内回调 96 次），所以
 * "把表达式写进 env"这类手误会让 30 分钟巡检变成每毫秒扫一次库的热循环。
 * 配置错误必须可见，不许静默变成最坏值。
 */
export function overdueIntervalMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  fallback = 30 * 60_000,
  onInvalid?: (message: string) => void,
): number {
  const raw = env.IMPROVEMENT_ACTION_OVERDUE_WORKER_INTERVAL_MS;
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    onInvalid?.(`非法 IMPROVEMENT_ACTION_OVERDUE_WORKER_INTERVAL_MS "${raw}"，回退默认 ${fallback}ms（配置错误必须可见）`);
    return fallback;
  }
  return Math.floor(parsed);
}

@Injectable()
export class ImprovementActionOverdueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImprovementActionOverdueWorkerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly actions: ImprovementActionService,
    private readonly requestDatabaseContext: RequestDatabaseContext,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit(): void {
    if (process.env.IMPROVEMENT_ACTION_OVERDUE_WORKER_DISABLED === '1') {
      this.logger.log('改进行动项逾期 worker 已禁用（IMPROVEMENT_ACTION_OVERDUE_WORKER_DISABLED=1）');
      return;
    }
    const intervalMs = overdueIntervalMs(process.env, 30 * 60_000, (message) => this.logger.warn(message));
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    this.logger.log(`改进行动项逾期 worker 已启动（interval=${intervalMs}ms）`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 单次扫描：逐租户（GUC 事务）跑同一实现。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const orgIds = await this.activeOrgIds();
      for (const orgId of orgIds) {
        try {
          const result = await this.requestDatabaseContext.runInTransaction(
            buildGucSettings({ userId: 'system:improvement-overdue', primaryOrgId: orgId }),
            async () => this.actions.sweepOverdue({
              userId: 'system:improvement-overdue',
              primaryOrgId: orgId,
            } as never),
          );
          if (result.created > 0 || result.unresolvedOwners.length > 0) {
            this.logger.log(
              `逾期提醒 org=${orgId} scanned=${result.scanned} created=${result.created} `
              + `负责人缺账号=${result.unresolvedOwners.length}`,
            );
          }
        } catch (error) {
          this.logger.warn(`逾期提醒 org=${orgId} 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      this.logger.warn(`逾期提醒扫描失败：${error instanceof Error ? error.message : String(error)}`);
      await this.auditService.appendAuditLog({
        actorId: 'system:improvement-overdue',
        orgId: '',
        action: 'learning.action_overdue_sweep_failed',
        entityType: 'improvement_action',
        entityId: 'worker',
        reason: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    } finally {
      this.running = false;
    }
  }

  /**
   * 有未完成行动项的租户。
   *
   * 与其它 worker 同口径：后台没有 GUC → 直接查业务表会被 RLS 挡住（表现为"worker 静默 0 条"）。
   * 这里同样只能取 org_id，明细在逐租户 GUC 事务里读。
   */
  private async activeOrgIds(): Promise<string[]> {
    const rows = await this.requestDatabaseContext.runInTransaction(
      buildGucSettings({ userId: 'system:improvement-overdue', primaryOrgId: '' }),
      async () => this.actions.listOrgsWithOpenActions(),
    );
    return rows;
  }
}
