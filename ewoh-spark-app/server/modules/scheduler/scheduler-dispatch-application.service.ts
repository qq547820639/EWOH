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
import { toOrgContext } from './scheduler-run-context';

@Injectable()
export class SchedulerDispatchApplicationService {
  constructor(private readonly executionService?: ExecutionService) {}

  /** 执行领域：更新 Execution（含 deviation 派生 + 事件）。 */
  async executionUpdate(
    assignmentId: string,
    body: ExecutionUpdateRequest,
    actor?: OrgContext,
  ): Promise<SchedulingExecution> {
    if (!this.executionService) throw new Error('executionService not injected');
    return this.executionService.update(assignmentId, body, toOrgContext(actor).primaryOrgId ?? null);
  }
}
