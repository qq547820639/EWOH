import { Module } from '@nestjs/common';
import { PerceptionFusionService } from './perception-fusion.service';
import { PerceptionFusionController } from './perception-fusion.controller';
import { SharedModule } from '../shared/shared.module';

/**
 * 感知融合模块（NO-56a，`docs/architecture/embodied_factory.md` §5）。
 *
 * 多源观测（UWB 定位 / 外骨骼 IMU / 视觉检测 / 工位语义 / 任务上下文）→
 * 一致性、冲突、可解释加权置信度、被排除证据与规则留痕 → 快照入库。
 * 依赖 SharedModule（审计）；只读感知事实，不写回任何源。
 */
@Module({
  imports: [SharedModule],
  controllers: [PerceptionFusionController],
  providers: [PerceptionFusionService],
  exports: [PerceptionFusionService],
})
export class PerceptionModule {}
