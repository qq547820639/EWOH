import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentMetricsService } from './agent-metrics.service';
import { AgentOrchestratorService } from './agent-orchestrator.service';
import { AgentController } from './agent.controller';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { WorkOrderModule } from '../workorder/workorder.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

/**
 * Agent Runtime 模块（ADR-016 / NO-06b+NO-06c，Phase 9）。
 *
 * Manifest 注册唯一入口（契约校验 + Tool 注册表 fail-closed +
 * ewoh_agent_manifest TENANT_SCOPED RLS）+ 结构化 Command 执行
 * （审批门控 + 预算/超时/回退强制 + AgentTaskProposed/AgentDecisionRecorded
 * 事件与审计）+ NO-12p/ADR-039 审批台账桥接（ewoh_agent_approval 跨重启
 * 持久化，替代原 ApprovalModule 内存状态机桥接）与 FactorySupervisor
 * 建议流（读 World Snapshot，SchedulerModule）。
 */
@Module({
  imports: [SchedulerModule, WorkOrderModule, KnowledgeModule],
  controllers: [AgentController],
  providers: [AgentService, AgentOrchestratorService, AgentMetricsService],
  exports: [AgentService, AgentOrchestratorService, AgentMetricsService],
})
export class AgentModule {}
