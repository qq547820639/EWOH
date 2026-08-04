import { Module } from '@nestjs/common';
import { WorkOrchestrationController } from './work-orchestration.controller';
import { WorkOrchestrationService } from './work-orchestration.service';
import { DomainPersistenceService } from './domain-persistence.service';

@Module({
  controllers: [WorkOrchestrationController],
  providers: [WorkOrchestrationService, DomainPersistenceService],
  exports: [WorkOrchestrationService, DomainPersistenceService],
})
export class WorkOrchestrationModule {}
