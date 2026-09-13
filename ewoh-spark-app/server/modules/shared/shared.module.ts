import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DatabaseAuditSink } from './database-audit-sink';
import { DbIdempotencyStore } from './db-idempotency.store';
import {
  DbPayloadStore,
  IdempotencyService,
  IDEMPOTENCY_PAYLOAD_STORE,
  IDEMPOTENCY_STORE,
} from './idempotency.service';
import { OrgContextInterceptor } from './org-context.interceptor';
import { OrgScopeService } from './org-scope.service';
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
    DbPayloadStore,
    { provide: IDEMPOTENCY_STORE, useClass: DbIdempotencyStore },
    // 指纹存储必须与 IDEMPOTENCY_STORE 成对注册：只注册 IDEMPOTENCY_STORE 而漏掉
    // 它时，IdempotencyService 的 @Optional() 注入静默回落进程内
    // InMemoryPayloadStore，"同 key 不同 payload 必须 409"的防护在重启/多实例后
    // 失效（dangerous-action 注释自称 durable 指纹，实际不是——缺陷 D）。
    { provide: IDEMPOTENCY_PAYLOAD_STORE, useClass: DbPayloadStore },
    OrgContextInterceptor,
    OrgScopeService,
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
    RolesGuard,
    AuditChainService,
    RedisService,
    RateLimitGuard,
    SlowQueryService,
  ],
})
export class SharedModule {}
