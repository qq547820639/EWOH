import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';
import { MaintenanceController } from './maintenance.controller';
import { WorkOrderModule } from '../workorder/workorder.module';

/**
 * Maintenance 模块（ADR-010 / NO-05b）：维护状态契约 API + ewoh_maintenance_condition
 * 持久化 + MaintenanceConditionDetected/Resolved 事件（信封 ADR-009）。
 * NO-05e-b：work_order_created → WorkOrderModule（工单唯一权威写路径）。
 */
@Module({
  imports: [WorkOrderModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
