import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { AndonSlaService } from './andon-sla.service';

/**
 * 安灯"超时未接手"升级 worker（NO-48a）。
 *
 * 与其它提醒 worker 同一模式：`OnApplicationBootstrap` 起定时器、tick 重入保护、
 * 单次失败只留痕不退出（`timer.unref()` 不阻塞进程退出）。
 *
 * 默认 5 分钟扫一次：安灯 SLA 默认 15 分钟，5 分钟粒度足以在超期后"一个扫描周期内"叫人，
 * 又不会把扫描压成热路径。`ANDON_SLA_WORKER_DISABLED=true` 或
 * `ANDON_SLA_WORKER_INTERVAL_MS<=0` 时禁用。
 *
 * 幂等由确定性通知号 + `notification_id` 唯一约束保证：重复 tick、多实例都不会
 * 对同一条安灯重复升级（只累加 duplicates）。
 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

@Injectable()
export class AndonSlaWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AndonSlaWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly andonSla: AndonSlaService) {}

  onApplicationBootstrap(): void {
    const disabled = String(process.env.ANDON_SLA_WORKER_DISABLED ?? '').toLowerCase() === 'true';
    const configured = Number(process.env.ANDON_SLA_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    const intervalMs = Number.isFinite(configured) ? configured : DEFAULT_INTERVAL_MS;
    if (disabled || intervalMs <= 0) {
      this.logger.log('安灯 SLA 升级 worker 已禁用（ANDON_SLA_WORKER_DISABLED/INTERVAL_MS）');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(`安灯 SLA 升级 worker 已启动（interval=${intervalMs}ms）`);
  }

  /** 单次扫描（也可被测试直接调用）。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.andonSla.sweepAllActiveOrgs();
      if (result.created > 0 || result.failures.length > 0) {
        this.logger.log(
          `安灯 SLA 扫描：租户 ${result.orgs} 个，超期未接手 ${result.breached} 条，`
            + `新增升级提醒 ${result.created} 条，重复跳过 ${result.duplicates} 条，`
            + `无法判定 ${result.undecidable} 条，失败 ${result.failures.length} 个`,
        );
      }
    } catch (error) {
      this.logger.error(`安灯 SLA 扫描异常（不退出 worker）：${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
