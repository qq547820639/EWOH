import { Module } from '@nestjs/common';
import { DataQualityService } from './data-quality.service';
import { DataQualityController } from './data-quality.controller';
import { SharedModule } from '../shared/shared.module';
import { AlertModule } from '../alert/alert.module';
import { DataQualityNotificationService } from './data-quality-notification.service';
import { DataQualitySweepWorkerService } from './data-quality-notification.worker';
import { DeviceResponsibilityModule } from '../responsibility/device-responsibility.module';

/**
 * Data Quality 模块（standalone_076，DR-4 闭环第②步）：数据质量人工确认台账。
 * 依赖 SharedModule（审计）；AlertModule 可选（confirmed 联动 resolve
 * DataQualityAlert——装配缺失时显式降级为"仅记录确认"，不阻断主事实）。
 */
@Module({
  // NO-53a：数据质量"待核实"提醒要按**设备责任人**（班次路由）点名，因此依赖责任人模块。
  imports: [SharedModule, AlertModule, DeviceResponsibilityModule],
  controllers: [DataQualityController],
  providers: [DataQualityService, DataQualityNotificationService, DataQualitySweepWorkerService],
  exports: [DataQualityService, DataQualityNotificationService],
})
export class DataQualityModule {}
