import { Module } from '@nestjs/common';
import { OeeController } from './oee.controller';
import { OeeService } from './oee.service';
import { AndonSlaService } from './andon-sla.service';
import { AndonSlaWorkerService } from './andon-sla.worker';
import { DeviceResponsibilityModule } from '../responsibility/device-responsibility.module';

@Module({
  // NO-49a：安灯提醒要"点名到设备责任人"，因此依赖责任人模块（只读解析）。
  imports: [DeviceResponsibilityModule],
  controllers: [OeeController],
  // AuditService 由 @Global SharedModule 提供（不要在业务模块重复 provide，
  // 否则会出现第二个审计实例/写入通道分叉）。
  providers: [OeeService, AndonSlaService, AndonSlaWorkerService],
  exports: [OeeService, AndonSlaService],
})
export class OeeModule {}
