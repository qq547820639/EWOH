import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { ChannelDispatcherService } from './channel-dispatcher.service';
import { NotificationController } from './notification.controller';

/**
 * Notification 模块（ADR-030 / NO-12f，§17）：in-app 通知读写闭环
 * （租户 + 角色作用域查询 + 幂等已读标记）+ 推送渠道派发器
 * （R-58 / ADR-037：lark webhook 投递 + 失败显式 + 人工重试）。
 */
@Module({
  controllers: [NotificationController],
  providers: [NotificationService, ChannelDispatcherService],
  exports: [NotificationService, ChannelDispatcherService],
})
export class NotificationModule {}
