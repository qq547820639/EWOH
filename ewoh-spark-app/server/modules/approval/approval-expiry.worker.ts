import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ApprovalExpiryService } from './approval-expiry.service';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { buildGucSettings } from '../shared/org-context.interceptor';

/**
 * 授权到期提醒 worker（NO-30a）。
 *
 * 与 Workbench 导出 worker 同一模式：`OnApplicationBootstrap` 起定时器，
 * tick 重入保护，单次失败只留痕不退出；开关 `APPROVAL_EXPIRY_WORKER_DISABLED=true`
 * 或 `APPROVAL_EXPIRY_WORKER_INTERVAL_MS<=0` 时禁用（默认 5 分钟）。
 *
 * 幂等由通知 id 的确定性推导保证：多实例/重复 tick 不会重复提醒同一次到期。
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class ApprovalExpiryWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ApprovalExpiryWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly expiryService: ApprovalExpiryService,
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  onApplicationBootstrap(): void {
    const disabled = String(process.env.APPROVAL_EXPIRY_WORKER_DISABLED ?? '').toLowerCase() === 'true';
    const configured = Number(process.env.APPROVAL_EXPIRY_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    const intervalMs = Number.isFinite(configured) ? configured : DEFAULT_INTERVAL_MS;
    if (disabled || intervalMs <= 0) {
      this.logger.log('授权到期提醒 worker 已禁用（APPROVAL_EXPIRY_WORKER_DISABLED/INTERVAL_MS）');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // 不阻塞进程退出（与其它 worker 一致）
    this.timer.unref?.();
    this.logger.log(`授权到期提醒 worker 已启动（interval=${intervalMs}ms）`);
  }

  /**
   * 单次扫描：逐租户（GUC 事务）跑同一实现。
   *
   * 为什么必须自己开上下文：后台 tick 没有请求上下文，而 `ewoh_event` 开着 RLS——
   * 不带 GUC 的跨租户读**返回 0 行而不是报错**（V207 实测：owner 看到 1 个租户，
   * `ewoh_api` 无上下文看到 0；同一前提经 HTTP 带上下文扫描落 2 条提醒）。
   * 本文件此前直接调 `sweepAllActiveOrgs()`（内部自己列租户、自己循环），
   * 于是"到点自己扫"这条生产恢复路径**从未产出过任何提醒**，且日志上一片干净。
   * 修法照抄仓内已经存在的两个同形 worker（投递积压、改进行动项逾期）。
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const orgIds = await this.requestDatabaseContext.systemGlobalAdminTransaction(
        () => this.expiryService.listOrgsWithRecentApprovalInstances(),
      );
      let created = 0;
      let failures = 0;
      for (const orgId of orgIds) {
        try {
          const result = await this.requestDatabaseContext.runInTransaction(
            buildGucSettings({ userId: 'system:approval-expiry', primaryOrgId: orgId }),
            async () => this.expiryService.sweep({
              userId: 'system:approval-expiry',
              primaryOrgId: orgId,
            } as never),
          );
          created += result.created;
        } catch (error) {
          failures += 1;
          this.logger.warn(`授权到期扫描 org=${orgId} 失败（不中断其它租户）：${String(error)}`);
        }
      }
      if (created > 0 || failures > 0) {
        this.logger.log(
          `授权到期扫描：租户 ${orgIds.length} 个，新增提醒 ${created} 条，失败 ${failures} 个`,
        );
      }
    } catch (error) {
      this.logger.error(`授权到期扫描异常（不退出 worker）：${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
