import { Module } from '@nestjs/common';
import { LearningService } from './learning.service';
import { LearningController } from './learning.controller';
import { LearningProposalService } from './learning-proposal.service';
import { LearningProposalController } from './learning-proposal.controller';
import { OutcomeAnnotationService } from './outcome-annotation.service';
import { OutcomeAnnotationController } from './outcome-annotation.controller';
import { LearningSignalService } from './learning-signal.service';
import { LearningSignalController } from './learning-signal.controller';
import { ImprovementActionService } from './improvement-action.service';
import { ImprovementActionController } from './improvement-action.controller';
import { ImprovementActionOverdueWorkerService } from './improvement-action-overdue.worker';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

/**
 * Learning 模块（ADR-021 / NO-09a + ADR-026 / NO-12b，Phase 12）：
 * v1 七项学习指标统一快照（真实事实聚合 + 契约 fail-closed + 幂等落账）+
 * v2 反馈腿（Learning Proposal：影子评估前置 + 人审激活阶梯 + 回滚/拒绝
 * 理由强制；getActiveThresholds 供 ReasoningService 应用激活覆盖）+
 * NO-54a 学习回路接线（运行记忆信号：提醒治理/数据质量积压/偏差复发 →
 * 带证据的信号 → 人点"生成提案"才进提案台账）+
 * NO-55a 经验 → 行动（已发布复盘的**经验条目/缺口** → 有人负责、有期限、有验收判据、
 * 有完成证据的改进行动项）。
 */
@Module({
  imports: [SchedulerModule, KnowledgeModule],
  controllers: [
    LearningController,
    LearningProposalController,
    OutcomeAnnotationController,
    LearningSignalController,
    ImprovementActionController,
  ],
  providers: [
    LearningService,
    LearningProposalService,
    OutcomeAnnotationService,
    LearningSignalService,
    ImprovementActionService,
    ImprovementActionOverdueWorkerService,
  ],
  exports: [
    LearningService,
    LearningProposalService,
    OutcomeAnnotationService,
    LearningSignalService,
    ImprovementActionService,
  ],
})
export class LearningModule {}
