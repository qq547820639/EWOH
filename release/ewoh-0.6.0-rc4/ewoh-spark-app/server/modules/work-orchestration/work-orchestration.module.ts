import { Module } from '@nestjs/common';
import { WorkOrchestrationController } from './work-orchestration.controller';
import { WorkOrchestrationService } from './work-orchestration.service';

@Module({
  controllers: [WorkOrchestrationController],
  providers: [WorkOrchestrationService],
  exports: [WorkOrchestrationService],
})
export class WorkOrchestrationModule {}
