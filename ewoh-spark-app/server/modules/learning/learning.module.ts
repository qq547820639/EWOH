import { Module } from '@nestjs/common';
import { LearningService } from './learning.service';
import { LearningController } from './learning.controller';
import { LearningProposalService } from './learning-proposal.service';
import { LearningProposalController } from './learning-proposal.controller';
import { OutcomeAnnotationService } from './outcome-annotation.service';
import { OutcomeAnnotationController } from './outcome-annotation.controller';
import { SchedulerModule } from '../scheduler/scheduler.module';

/**
 * Learning 模块（ADR-021 / NO-09a + ADR-026 / NO-12b，Phase 12）：
 * v1 七项学习指标统一快照（真实事实聚合 + 契约 fail-closed + 幂等落账）+
 * v2 反馈腿（Learning Proposal：影子评估前置 + 人审激活阶梯 + 回滚/拒绝
 * 理由强制；getActiveThresholds 供 ReasoningService 应用激活覆盖）。
 */
@Module({
  imports: [SchedulerModule],
  controllers: [LearningController, LearningProposalController, OutcomeAnnotationController],
  providers: [LearningService, LearningProposalService, OutcomeAnnotationService],
  exports: [LearningService, LearningProposalService, OutcomeAnnotationService],
})
export class LearningModule {}
