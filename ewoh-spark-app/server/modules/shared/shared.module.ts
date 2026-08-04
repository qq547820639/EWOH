import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DatabaseAuditSink } from './database-audit-sink';
import { DbIdempotencyStore } from './db-idempotency.store';
import { IdempotencyService, IDEMPOTENCY_STORE } from './idempotency.service';
import { OrgContextInterceptor } from './org-context.interceptor';
import { OrgScopeService } from './org-scope.service';
import { StateMachineGuard } from './state-machine.guard';
import { RolesGuard } from './roles.guard';
import { AuditChainService } from './audit-chain.service';
import { RedisService } from './redis.service';
import { RateLimitGuard } from './rate-limit.guard';
import { SlowQueryService } from '../observability/slow-query.service';

@Global()
@Module({
  providers: [
    DatabaseAuditSink,
    AuditService,
    IdempotencyService,
    DbIdempotencyStore,
    { provide: IDEMPOTENCY_STORE, useClass: DbIdempotencyStore },
    OrgContextInterceptor,
    OrgScopeService,
    StateMachineGuard,
    RolesGuard,
    AuditChainService,
    RedisService,
    RateLimitGuard,
    SlowQueryService,
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
    SlowQueryService,
  ],
})
export class SharedModule {}
