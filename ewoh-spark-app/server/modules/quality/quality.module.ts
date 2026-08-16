import { Module } from '@nestjs/common';
import { QualityService } from './quality.service';
import { QualityController } from './quality.controller';
import { WorkOrderModule } from '../workorder/workorder.module';

/**
 * Quality 模块（ADR-010 / NO-05b）：质量发现契约 API + ewoh_quality_finding 持久化
 * + QualityFindingDetected/Dispositioned 事件（信封 ADR-009）。
 * NO-05e-b：disposition=rework → WorkOrderModule（工单唯一权威写路径）。
 */
@Module({
  imports: [WorkOrderModule],
  controllers: [QualityController],
  providers: [QualityService],
  exports: [QualityService],
})
export class QualityModule {}
