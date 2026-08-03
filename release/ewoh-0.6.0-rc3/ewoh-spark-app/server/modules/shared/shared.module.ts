import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DatabaseAuditSink } from './database-audit-sink';
import { IdempotencyService } from './idempotency.service';
import { OrgContextInterceptor } from './org-context.interceptor';
import { OrgScopeService } from './org-scope.service';
import { StateMachineGuard } from './state-machine.guard';
import { RolesGuard } from './roles.guard';
import { AuditChainService } from './audit-chain.service';
import { RedisService } from './redis.service';
import { RateLimitGuard } from './rate-limit.guard';

@Global()
@Module({
  providers: [
    DatabaseAuditSink,
    AuditService,
    IdempotencyService,
    OrgContextInterceptor,
    OrgScopeService,
    StateMachineGuard,
    RolesGuard,
    AuditChainService,
    RedisService,
    RateLimitGuard,
  ],
  exports: [
    AuditService,
    IdempotencyService,
    OrgContextInterceptor,
    OrgScopeService,
    StateMachineGuard,
    RolesGuard,
    AuditChainService,
    RedisService,
    RateLimitGuard,
  ],
})
export class SharedModule {}
