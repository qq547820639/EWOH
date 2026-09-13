import { Module } from '@nestjs/common';
import { ControlController, ControlDeliveryBacklogController, ControlGatewayController } from './control.controller';
import { ControlService } from './control.service';
import { ApprovalModule } from '../approval/approval.module';
import { ControlDeliveryBacklogWorkerService } from './control-delivery-backlog.worker';

@Module({
  // R2-SMI-001（INV-005）：control 依赖 approval——高危物理指令创建时联动
  // 生成审批实例，审批 approved 后才允许 sendCommand。
  imports: [ApprovalModule],
  // NO-60a：网关命令面（边缘轮询下行）与人工请求面分开装配，便于按角色/密钥治理。
  // NO-68a：投递积压巡检面独立成控制器（租户级跨设备操作，不是 request 的子资源）。
  controllers: [ControlController, ControlDeliveryBacklogController, ControlGatewayController],
  // NO-68a：投递积压巡检 worker（定时把"下发后迟迟没投出去"叫到人）。
  //
  // ⚠️ 不要在这里本地 provide AuditService（2026-09-13 实测回归）：SharedModule
  // 虽是 @Global，但 `DatabaseAuditSink` **不在 exports 里**——本地实例化的
  // AuditService 拿不到 DB sink，@Optional() 静默退化为 InMemoryAuditSink：
  // 审计照常打日志、**永远不落库**（control-actuator E2E 的 9d/20 两条断言
  // 因此变红）。纪律同 oee.module 的注释：业务模块一律用全局导出的 AuditService。
  providers: [ControlService, ControlDeliveryBacklogWorkerService],
  exports: [ControlService],
})
export class ControlModule {}
