import { Module } from '@nestjs/common';
import { MobileController } from './mobile.controller';
import { MobileService } from './mobile.service';
import { MesModule } from '../mes/mes.module';
import { ControlModule } from '../control/control.module';

@Module({
  // NO-79a：工单详情需要"关联设备的执行状态"（我的工单为什么没动）——判定与
  // 执行边界同一实现（ControlService.listDeviceCommands summary）。
  imports: [MesModule, ControlModule],
  controllers: [MobileController],
  providers: [MobileService],
  exports: [MobileService],
})
export class MobileModule {}
