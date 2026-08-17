import { Module } from '@nestjs/common';
import { ControlController } from './control.controller';
import { ControlService } from './control.service';
import { ApprovalModule } from '../approval/approval.module';

@Module({
  // R2-SMI-001（INV-005）：control 依赖 approval——高危物理指令创建时联动
  // 生成审批实例，审批 approved 后才允许 sendCommand。
  imports: [ApprovalModule],
  controllers: [ControlController],
  providers: [ControlService],
  exports: [ControlService],
})
export class ControlModule {}
