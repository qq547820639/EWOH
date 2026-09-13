import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalPersistenceService } from './approval-persistence.service';
import { ApprovalExpiryService } from './approval-expiry.service';
import { ApprovalExpiryWorkerService } from './approval-expiry.worker';
import { ApprovalService } from './approval.service';

@Module({
  controllers: [ApprovalController],
  providers: [
    ApprovalPersistenceService,
    ApprovalService,
    // NO-30a：执行边界授权到期主动提醒（服务 + 定时 worker，幂等）
    ApprovalExpiryService,
    ApprovalExpiryWorkerService,
  ],
  exports: [ApprovalPersistenceService, ApprovalService, ApprovalExpiryService],
})
export class ApprovalModule {}
