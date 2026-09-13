import { Module } from '@nestjs/common';
import { ShiftService } from './shift.service';
import { ShiftController } from './shift.controller';
import { DeviceResponsibilityModule } from '../responsibility/device-responsibility.module';

/**
 * Shift 模块（standalone_074，DR-2 班次工作台）：班次定义 + 交接班记录。
 * 当前班次判定复用共享纯函数 resolveShiftAt（前后端同构）。
 */
@Module({
  // NO-52a：交接班时核对“接班班次责任人”（DeviceResponsibilityService 可选注入）。
  imports: [DeviceResponsibilityModule],
  controllers: [ShiftController],
  providers: [ShiftService],
  exports: [ShiftService],
})
export class ShiftModule {}
