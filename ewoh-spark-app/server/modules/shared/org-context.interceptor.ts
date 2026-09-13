import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { SSE_METADATA } from '@nestjs/common/constants';
import { defer, lastValueFrom, type Observable } from 'rxjs';
import { RequestDatabaseContext } from '../../database/request-database-context';

export interface OrgContext {
  userId: string;
  primaryOrgId: string;
  /** Parsed for downstream guards/audit; not emitted as a GUC. */
  role?: string;
  /**
   * Auth roles attached by AccessTokenGuard from the JWT payload (worker,
   * workshop_lead, dispatcher, device_ops, safety_admin, global_admin, …).
   * Distinct from `role` (a single parsed role) and from the Role Workbench
   * product roles (operator/team_lead/quality/equipment/manager).
   */
  roles?: string[];
  accessibleOrgIds?: string[];
  isGlobalAdmin?: boolean;
  /**
   * 业务人员 ID（人员域），来自签名访问令牌中的账号↔人员绑定。
   * 未绑定为 null/undefined——调用方必须 fail-closed，不得回退去猜。
   */
  personId?: string | null;
}

export interface GucSetting {
  name: string;
  value: string;
}

export const ORG_CONTEXT_GUC_ORDER = [
  'app.user_id',
  'app.current_org_id',
  'app.current_org_ids',
  'app.is_global_admin',
] as const;

/**
 * 显式标记"手写 @Res() 的流式响应"端点（非 @Sse：POST + fetch/ReadableStream 消费，
 * 因此拿不到 @Sse 元数据）。
 *
 * 为什么需要它：本拦截器会把每个已认证请求包进 lastValueFrom + 请求级事务，
 * 而手写流式端点的 handler 自己 for await 整条 LLM 流——于是请求级事务与一条
 * 连接被占满**整条流**（实测 /api/ai/chat：首个增量已经推给客户端时 tx 仍为
 * 打开状态）。连接池 max=20，20 个并发问答即可打满 DB_POOL_MAX。
 *
 * 用法与前提（缺一不可，见 org-context.interceptor 豁免分支注释）：
 *   1. 端点必须在缺 org 上下文时 fail-closed（例如 ai.controller 的 requireOrgScope）；
 *   2. 端点必须自己为 DB 步开短租户事务（buildGucSettings + runInTransaction）——
 *      豁免的只是事务的**持有期**，不是租户收敛：RLS 仍然生效。
 */
export const STREAMING_RESPONSE_METADATA = 'ewoh:streaming-response';

/** 把一个手写 @Res() 的流式端点标记为"流期间不持有请求级事务"。 */
export function StreamingResponse(): MethodDecorator {
  return SetMetadata(STREAMING_RESPONSE_METADATA, true);
}

/**
 * 长连接/流式 handler 判定：@Sse 元数据，或显式 @StreamingResponse()。
 *
 * 注意不要把手写 @Res() 但**立即返回**的端点（下载类：file.controller 的
 * /download、operations.controller 的 downloadExport）标进来：它们只是把
 * Readable pipe 给响应后立刻 return，事务在 pipe 开始时就已提交，不存在
 * "整条流持有事务"的问题（用 @StreamingResponse 标记它们是无害但多余的）。
 */
export function isStreamingHandler(handler: unknown): boolean {
  if (typeof handler !== 'function') {
    return false;
  }
  return (
    Reflect.getMetadata(SSE_METADATA, handler) !== undefined ||
    Reflect.getMetadata(STREAMING_RESPONSE_METADATA, handler) === true
  );
}

export function buildGucSettings(context: OrgContext): GucSetting[] {
  const orgIds =
    context.accessibleOrgIds && context.accessibleOrgIds.length > 0
      ? context.accessibleOrgIds
      : [context.primaryOrgId];

  return [
    { name: 'app.user_id', value: context.userId },
    { name: 'app.current_org_id', value: context.primaryOrgId },
    { name: 'app.current_org_ids', value: orgIds.join(',') },
    {
      name: 'app.is_global_admin',
      value: context.isGlobalAdmin ? 'true' : 'false',
    },
  ];
}

/**
 * Applies request org context before the handler runs.
 *
 * IMPORTANT: set_config(..., true) is transaction-local. This interceptor must be
 * paired with RequestDatabaseContext so every authenticated request runs on the
 * same request-scoped transaction/connection that the handler uses. There is no
 * pooled fallback: a missing context is a 500, never a silent GUC skip.
 */
@Injectable()
export class OrgContextInterceptor implements NestInterceptor {
  constructor(
    private readonly requestDatabaseContext: RequestDatabaseContext,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.requestDatabaseContext) {
      throw new InternalServerErrorException(
        'RequestDatabaseContext is required to enforce tenant GUCs',
      );
    }
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context
      .switchToHttp()
      .getRequest<{ userContext?: OrgContext }>();
    if (!request.userContext) {
      return next.handle();
    }

    // P0 修复：SSE（@Sse）返回的是长连接无限事件流，绝不能包进
    // lastValueFrom + 请求级事务——lastValueFrom 等待流完成永不 resolve，
    // 客户端收不到任何事件（静默失败），且请求级事务/连接被占用到断开
    // （连接池 max=20，少量 SSE 客户端即可打满）。
    // SSE 端点（scheduler v2/stream）的租户隔离由应用层事件过滤保证
    // （orgId 过滤见 scheduler.controller.ts），不经 RLS，故可安全直通。
    //
    // H 修复（2026-08-18 二轮审计）：手写 @Res() 的流式端点（/api/ai/chat、
    // /api/ai/suggestions/stream 用 POST + ReadableStream 消费，拿不到 @Sse
    // 元数据）走的是同一个坑：handler 自己 for await 整条 LLM 流，于是
    // runInTransaction 的连接与事务被占满整条流（实测：首个增量已推给客户端
    // 时事务仍打开；思考型模型一次问答可占用连接数十秒）。这类端点用
    // @StreamingResponse() 显式标记后一并直通（见 StreamingResponse 注释）。
    //
    // 豁免的边界（别误读）：豁免的是"把整条流包进一个长事务"，**不是**租户收敛。
    // 标记端点仍然必须：① 缺 org 上下文时 fail-closed，不做全租户混读；
    // ② 自己为 DB 步开短租户事务（buildGucSettings + runInTransaction）。
    // 因为 RLS 照常生效且没有兜底：ewoh_api 是 NOBYPASSRLS 的 service_role 成员，
    // 没有 app.current_org_ids 时 ewoh_org_visible() 恒 false —— 读会静默读空、
    // 写会被 WITH CHECK 拒绝（不是报错就是悄悄丢数据）。
    const routeHandler =
      typeof context.getHandler === 'function' ? context.getHandler() : undefined;
    if (isStreamingHandler(routeHandler)) {
      return next.handle();
    }

    const settings = buildGucSettings(request.userContext);
    return defer(() =>
      this.requestDatabaseContext.runInTransaction(settings, () =>
        lastValueFrom(next.handle()),
      ),
    );
  }
}
