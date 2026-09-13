import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ExoSessionReminderService } from './exo-session-reminder.service';

/**
 * 外骨骼会话提醒 worker（NO-37a）。
 *
 * 与授权到期提醒 worker 同一模式：`OnApplicationBootstrap` 起定时器、tick 重入保护、
 * 单次失败只留痕不退出；`EXO_SESSION_REMINDER_WORKER_DISABLED=true` 或
 * `EXO_SESSION_REMINDER_WORKER_INTERVAL_MS<=0` 时禁用（默认 10 分钟——比授权到期
 * 阈值（2 小时）宽松得多，因此不需要 5 分钟那么密的扫描）。
 *
 * 幂等由通知 id 的确定性推导 + `notification_id` 唯一约束保证：多实例、重复 tick
 * 都不会重复提醒同一条会话。
 */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class ExoSessionReminderWorkerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExoSessionReminderWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(private readonly reminderService: ExoSessionReminderService) {}

  onApplicationBootstrap(): void {
    const disabled =
      String(process.env.EXO_SESSION_REMINDER_WORKER_DISABLED ?? '').toLowerCase() === 'true';
    const configured = Number(
      process.env.EXO_SESSION_REMINDER_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
    );
    const intervalMs = Number.isFinite(configured) ? configured : DEFAULT_INTERVAL_MS;
    if (disabled || intervalMs <= 0) {
      this.logger.log('外骨骼会话提醒 worker 已禁用（EXO_SESSION_REMINDER_WORKER_DISABLED/INTERVAL_MS）');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
    this.logger.log(`外骨骼会话提醒 worker 已启动（interval=${intervalMs}ms）`);
  }

  /** 单次扫描（也可被测试直接调用）。 */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const result = await this.reminderService.sweepAllActiveOrgs();
      if (result.created > 0 || result.failures.length > 0) {
        this.logger.log(
          `外骨骼会话提醒扫描：租户 ${result.orgs} 个，新增提醒 ${result.created} 条，`
            + `重复跳过 ${result.duplicates} 条，失败 ${result.failures.length} 个`,
        );
      }
    } catch (error) {
      this.logger.error(`外骨骼会话提醒扫描异常（不退出 worker）：${String(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
