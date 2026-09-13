import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ApprovalExpiryService } from './approval-expiry.service';

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

  constructor(private readonly expiryService: ApprovalExpiryService) {}

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

  /** 单次扫描（也可被测试直接调用）。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.expiryService.sweepAllActiveOrgs();
      if (result.created > 0 || result.failures.length > 0) {
        this.logger.log(
          `授权到期扫描：租户 ${result.orgs} 个，新增提醒 ${result.created} 条，重复跳过 ${result.duplicates} 条，失败 ${result.failures.length} 个`,
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
