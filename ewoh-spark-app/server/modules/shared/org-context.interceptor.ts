import {
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
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
    const routeHandler =
      typeof context.getHandler === 'function' ? context.getHandler() : undefined;
    const handlerIsSse =
      routeHandler != null &&
      Reflect.getMetadata(SSE_METADATA, routeHandler) !== undefined;
    if (handlerIsSse) {
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
