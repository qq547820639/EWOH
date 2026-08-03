import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit.service';

@Module({
  controllers: [AuditController],
  providers: [AuditQueryService],
  exports: [AuditQueryService],
})
export class AuditModule {}
