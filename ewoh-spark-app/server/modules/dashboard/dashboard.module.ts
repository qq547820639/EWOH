import { Module } from '@nestjs/common';
import { ApprovalModule } from '../approval/approval.module';
import { DashboardController } from './dashboard.controller';
import { DeviceContractController } from './device-contract.controller';
import { DashboardService } from './dashboard.service';
import { WorkbenchNowService } from './workbench-now.service';
import { ControlModule } from '../control/control.module';

@Module({
  // NO-21a：高风险能力恢复闸门要读审批实例（getApproval），必须装配 ApprovalModule。
  // 漏装时 @Optional() 会静默注入 undefined，"已获批"也会被判成 APPROVAL_INVALID——
  // 因此这里显式 import，并在 service 侧对"端口缺失"单独报错而非伪装成审批无效。
  // NO-77a：工作台聚合需要 ControlService 的投递积压实时快照（判定与巡检同一实现）。
  imports: [ApprovalModule, ControlModule],
  controllers: [DashboardController, DeviceContractController],
  providers: [DashboardService, WorkbenchNowService],
})
export class DashboardModule {}
