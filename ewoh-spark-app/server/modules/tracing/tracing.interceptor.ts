import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { defer, lastValueFrom, Observable } from 'rxjs';
import { SSE_METADATA } from '@nestjs/common/constants';
import { withRequestContext } from '../../common/request-context';
import { TracingService, type TraceRecord } from './tracing.service';

@Injectable()
export class TracingInterceptor implements NestInterceptor {
  constructor(private readonly tracingService: TracingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    // DATA-FLOW-L1 补充（2026-08-18）：SSE（@Sse）长连接直通——
    // lastValueFrom(next.handle()) 会等待无限事件流 complete 永不返回，
    // 且流中途出错时经 lastValueFrom reject 触发全局过滤器尝试写 500
    // 响应 → "Cannot set headers after they are sent"，SSE 连接直接 error
    // （前端表现为"调度上下文离线"）。与 OrgContextInterceptor 同款 SSE 特判；
    // SSE 端点不写 trace_span（无单一请求边界），租户隔离由应用层过滤保证。
    const routeHandler =
      typeof context.getHandler === 'function' ? context.getHandler() : undefined;
    const handlerIsSse =
      routeHandler != null &&
      Reflect.getMetadata(SSE_METADATA, routeHandler) !== undefined;
    if (handlerIsSse) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<{
      method?: string;
      path?: string;
      route?: { path?: string };
      /** NO-10a：OrgContextInterceptor 挂载的请求上下文（lineage，可缺省）。 */
      userContext?: { primaryOrgId?: string; userId?: string };
    }>();
    const response = http.getResponse<{
      setHeader: (name: string, value: string) => void;
      statusCode?: number;
    }>();
    const traceId = randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    response.setHeader('x-trace-id', traceId);
    const startedAt = Date.now();
    const startedIso = new Date(startedAt).toISOString();
    const method = request.method ?? 'UNKNOWN';
    const path = request.route?.path ?? request.path ?? '';
    // NO-10a（ADR-022）：span lineage（org/user 可空；GLOBAL_SHARED 语义）。
    const orgId = request.userContext?.primaryOrgId ?? null;
    const requestUser = request.userContext?.userId ?? null;

    return defer(() =>
      withRequestContext({ requestId: traceId }, async () => {
        try {
          const value = await lastValueFrom(next.handle());
          await this.record(
            traceId,
            spanId,
            method,
            path,
            response.statusCode ?? 200,
            startedAt,
            startedIso,
            undefined,
            orgId,
            requestUser,
          );
          return value;
        } catch (error: unknown) {
          const status =
            typeof (error as { status?: unknown })?.status === 'number'
              ? Number((error as { status: unknown }).status)
              : response.statusCode ?? 500;
          await this.record(
            traceId,
            spanId,
            method,
            path,
            status,
            startedAt,
            startedIso,
            error instanceof Error
              ? error.message
              : error !== null && typeof error === 'object'
                ? JSON.stringify(error)
                : String(error),
            orgId,
            requestUser,
          );
          throw error;
        }
      }),
    );
  }

  private async record(
    traceId: string,
    spanId: string,
    method: string,
    path: string,
    status: number,
    startedAt: number,
    startedIso: string,
    error?: string,
    orgId?: string | null,
    requestUser?: string | null,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    const entry: TraceRecord = {
      traceId,
      spanId,
      method,
      path,
      status,
      durationMs: Date.now() - startedAt,
      startedAt: startedIso,
      finishedAt,
      error,
      orgId,
      requestUser,
    };
    this.tracingService.record(entry);
    // 2026-08-20：无租户上下文的请求（/health/ready 等探活、公开端点）在 RLS
    // （ewoh_org_visible）下必然拒写 org_id=null 行——每 10s 探活刷一条
    // 'trace span 持久化失败' WARN（日志膨胀/噪音）。此类请求无业务追踪价值，
    // 跳过 DB 持久化（内存环形缓冲仍记录，供服务内查询）。
    if (!orgId) {
      return;
    }
    // DATA-FLOW-L1 修复（2026-08-18）：span 持久化改为在请求事务内同步等待完成。
    // 原实现 fire-and-forget（void persistSpan）在响应 Observable 完成后异步执行，
    // 此时 OrgContextInterceptor 的事务已提交，transaction-local GUC
    // app.current_org_id(s) 失效 → RLS（ewoh_org_visible）拒绝 → trace 永不落库。
    // TracingInterceptor 位于事务栈内层，await 保证 INSERT 在事务提交前完成。
    // 错误路径：handler 抛错 → 事务回滚 → span 随回滚不落库（best-effort 语义保持，
    // 优先保证成功请求的可观测性）。persistSpan 内部已 catch 留痕，不阻断响应。
    await this.tracingService.persistSpan(entry);
  }
}
