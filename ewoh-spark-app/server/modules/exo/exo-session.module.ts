import { Module } from '@nestjs/common';
import { ExoSessionService } from './exo-session.service';
import { ExoSessionController } from './exo-session.controller';
import { ExoConfigService } from './exo-config.service';
import { ExoConfigController } from './exo-config.controller';
import { ExoSessionReminderService } from './exo-session-reminder.service';
import { ExoSessionReminderWorkerService } from './exo-session-reminder.worker';

/**
 * Exo 模块（ADR-032/ADR-051/ADR-052 / §7）：
 * - Session 台账（绑定是显式、临时且可审计——契约 fail-closed + 活跃唯一
 *   机器强制 + 状态机终态 + 目录事件）；
 * - Configuration 台账（Support Mode/Assist Profile/Fit/Calibration 配置
 *   事实——契约门 + 幂等 + active 唯一 supersede + 目录事件）。
 */
@Module({
  controllers: [ExoSessionController, ExoConfigController],
  providers: [
    ExoSessionService,
    ExoConfigService,
    // NO-37a：平台侧主动提醒（扫描只读；worker 默认 10 分钟，可 env 关闭）
    ExoSessionReminderService,
    ExoSessionReminderWorkerService,
  ],
  exports: [ExoSessionService, ExoConfigService, ExoSessionReminderService],
})
export class ExoSessionModule {}
