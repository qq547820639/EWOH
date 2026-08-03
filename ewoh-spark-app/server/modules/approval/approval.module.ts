import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalPersistenceService } from './approval-persistence.service';
import { ApprovalService } from './approval.service';

@Module({
  controllers: [ApprovalController],
  providers: [ApprovalPersistenceService, ApprovalService],
  exports: [ApprovalPersistenceService, ApprovalService],
})
export class ApprovalModule {}
