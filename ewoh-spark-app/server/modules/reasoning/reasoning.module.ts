import { Module } from '@nestjs/common';
import { ReasoningService } from './reasoning.service';
import { ReasoningController } from './reasoning.controller';
import { InferenceModule } from '../inference/inference.module';
import { LearningModule } from '../learning/learning.module';

/**
 * 工业推理模块（ADR-020 / NO-08b，Level 4 独立工业推理层）：结构化事实 →
 * 结论的确定性规则引擎（§18 模板渲染，非 LLM 编造）+ 结论 L4 台账落账
 * （ADR-019 ewoh_inference_result 复用，不新建表）。ADR-026 反馈腿接线：
 * 评估时经 LearningModule 读取本租户 approved 提案的阈值覆盖（人审激活）。
 */
@Module({
  imports: [InferenceModule, LearningModule],
  controllers: [ReasoningController],
  providers: [ReasoningService],
  exports: [ReasoningService],
})
export class ReasoningModule {}
