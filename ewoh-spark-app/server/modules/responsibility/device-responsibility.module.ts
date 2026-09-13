import { Module } from '@nestjs/common';
import {
  DeviceResponsibilityBatchController,
  DeviceResponsibilityController,
} from './device-responsibility.controller';
import { DeviceResponsibilityService } from './device-responsibility.service';

/**
 * 设备责任人模块（NO-49a）。
 *
 * 独立成模块（而不是塞进 dashboard/oee）的原因：责任关系被**多个提醒源**消费
 * （安灯开灯、安灯升级、将来的数据质量/维护提醒），把它放在任何单一业务模块里
 * 都会让其它模块反向依赖那个模块。这里只依赖 DRIZZLE + 全局 SharedModule（审计）。
 */
@Module({
  // 说明（NO-51a/NO-52a）：本模块**不**import ShiftModule——当前班次用"读班次表 +
  // 共享纯函数 resolveShiftAt"判定（同一口径），避免 Shift→Responsibility→Shift 的模块环；
  // 反向依赖（班次交接需要责任人核对快照）由 ShiftModule import 本模块，单向。
  controllers: [DeviceResponsibilityController, DeviceResponsibilityBatchController],
  providers: [DeviceResponsibilityService],
  exports: [DeviceResponsibilityService],
})
export class DeviceResponsibilityModule {}
