import { Module } from '@nestjs/common';
import { WorkflowController } from './workflow.controller';
import { WorkflowInstanceService } from './workflow-instance.service';
import { WorkflowService } from './workflow.service';

@Module({
  controllers: [WorkflowController],
  providers: [WorkflowService, WorkflowInstanceService],
  exports: [WorkflowService, WorkflowInstanceService],
})
export class WorkflowModule {}
