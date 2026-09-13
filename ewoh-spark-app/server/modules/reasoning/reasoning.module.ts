import { Module } from '@nestjs/common';
import { ReasoningService } from './reasoning.service';
import { ReasoningController } from './reasoning.controller';
import { InferenceModule } from '../inference/inference.module';
import { LearningModule } from '../learning/learning.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { MaterialsModule } from '../materials/materials.module';
import { PerceptionModule } from '../perception/perception.module';

/**
 * 工业推理模块（ADR-020 / NO-08b，Level 4 独立工业推理层）：结构化事实 →
 * 结论的确定性规则引擎（§18 模板渲染，非 LLM 编造）+ 结论 L4 台账落账
 * （ADR-019 ewoh_inference_result 复用，不新建表）。ADR-026 反馈腿接线：
 * 评估时经 LearningModule 读取本租户 approved 提案的阈值覆盖（人审激活）。
 * NO-25a：经 SchedulerModule 取**权威世界模型快照**，把观测读数与资源列投影成
 * 事实（"感知 → 理解"缺的那一环），调用方不再需要手供事实。
 * NO-58b：经 PerceptionModule 读**感知融合建议门控**并注入事实——
 * 融合置信度低/有冲突时，相关结论标 `advisoryOnly`（只提示、不得生成强建议）。
 */
@Module({
  imports: [InferenceModule, LearningModule, SchedulerModule, MaterialsModule, PerceptionModule],
  controllers: [ReasoningController],
  providers: [ReasoningService],
  exports: [ReasoningService],
})
export class ReasoningModule {}
