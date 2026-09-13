import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DataQualityNotificationService } from './data-quality-notification.service';

/**
 * 数据质量"待核实"提醒 worker（NO-53a）。
 *
 * 与其它提醒 worker 同一模式：`OnApplicationBootstrap` 起定时器、tick 重入保护、
 * 单次失败只留痕不退出（`timer.unref()` 不阻塞进程退出）。
 * 默认 10 分钟：数据质量告警不像安灯那样以分钟计，10 分钟足够在"一个班次内"叫到人。
 * `DATA_QUALITY_SWEEP_WORKER_DISABLED=true` 或 `..._INTERVAL_MS<=0` 时禁用。
 */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class DataQualitySweepWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataQualitySweepWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly dataQualityNotifications: DataQualityNotificationService) {}

  onApplicationBootstrap(): void {
    const disabled = String(process.env.DATA_QUALITY_SWEEP_WORKER_DISABLED ?? '').toLowerCase() === 'true';
    const configured = Number(process.env.DATA_QUALITY_SWEEP_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    const intervalMs = Number.isFinite(configured) ? configured : DEFAULT_INTERVAL_MS;
    if (disabled || intervalMs <= 0) {
      this.logger.log('数据质量提醒 worker 已禁用（DATA_QUALITY_SWEEP_WORKER_DISABLED/INTERVAL_MS）');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(`数据质量提醒 worker 已启动（interval=${intervalMs}ms）`);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.dataQualityNotifications.sweepAllActiveOrgs();
      if (result.created > 0 || result.failures.length > 0) {
        this.logger.log(
          `数据质量提醒扫描：租户 ${result.orgs} 个，告警 ${result.scanned} 条，`
            + `新增提醒 ${result.created} 条，重复跳过 ${result.duplicates} 条，失败 ${result.failures.length} 个`,
        );
      }
    } catch (error) {
      this.logger.error(`数据质量提醒扫描异常（不退出 worker）：${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
