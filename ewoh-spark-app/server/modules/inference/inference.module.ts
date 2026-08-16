import { Module } from '@nestjs/common';
import { InferenceResultService } from './inference.service';
import { InferenceController } from './inference.controller';

/**
 * Inference 模块（ADR-019 / NO-08a）：云侧模型结果历史唯一权威写路径
 * （record 契约 fail-closed/幂等/InferenceResultRecorded 事件 + list/get
 * 租户作用域）+ ewoh_inference_result 持久化（standalone_040 TENANT_SCOPED）。
 * Phase 12 Learning Loop 的模型结果事实层。
 */
@Module({
  controllers: [InferenceController],
  providers: [InferenceResultService],
  exports: [InferenceResultService],
})
export class InferenceModule {}
