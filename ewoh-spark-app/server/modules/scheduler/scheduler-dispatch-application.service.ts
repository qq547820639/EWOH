/* eslint-disable @darraghor/nestjs-typed/injectable-should-be-provided -- 手工组合装配：由 SchedulerService 构造函数 new 实例化，不经 DI providers 注册，规则误报 */
/**
 * SchedulerService Strangler Refactor（Task 2）：执行领域更新应用。
 *
 * 承载 executionUpdate（P4-EXEC：更新 Execution，含 deviation 派生 + 事件）。
 * 执行领域查询（executionList）为只读，位于 SchedulerQueryService。
 */
import { Injectable } from '@nestjs/common';
import type {
  SchedulingExecution,
  ExecutionUpdateRequest,
} from '@shared/api.interface';
import type { OrgContext } from '../shared/org-context.interceptor';
import { ExecutionService } from './execution.service';
import { ExecutionReceiptApplicationService } from './execution-receipt-application.service';

@Injectable()
export class SchedulerDispatchApplicationService {
  constructor(
    private readonly executionService?: ExecutionService,
    private readonly receiptService?: ExecutionReceiptApplicationService,
  ) {}

  /** 执行领域：更新 Execution（含 deviation 派生 + 事件）。 */
  async executionUpdate(
    assignmentId: string,
    body: ExecutionUpdateRequest,
    actor?: OrgContext,
  ): Promise<SchedulingExecution> {
    if (this.receiptService) return this.receiptService.applyFromExecutionUpdate(assignmentId, body, actor);
    throw new Error('Canonical receipt service not available');
  }
}
