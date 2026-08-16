import { Module } from '@nestjs/common';
import { WorkOrderService } from './workorder.service';
import { WorkOrderController } from './workorder.controller';

/**
 * WorkOrder 模块（ADR-012 / NO-05e-b）：工单 Execution 事实的唯一权威写路径
 * （create/list/transition 契约 fail-closed + ewoh_work_order 持久化 +
 * WorkOrderCreated/Completed 事件）。
 */
@Module({
  controllers: [WorkOrderController],
  providers: [WorkOrderService],
  exports: [WorkOrderService],
})
export class WorkOrderModule {}
