import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestDatabaseContext } from '../../database/request-database-context';
import { AuthService } from '../auth/auth.service';
import { OrgScopeHierarchyCycleError, OrgScopeService } from './org-scope.service';
import { IS_PUBLIC_KEY } from './public.decorator';

interface AuthenticatedRequest {
  headers?: { authorization?: string };
  userContext?: {
    userId: string;
    primaryOrgId: string;
    roles: string[];
    accessibleOrgIds: string[];
    isGlobalAdmin: boolean;
    /** 业务人员绑定（来自签名令牌；未绑定为 null）。 */
    personId?: string | null;
  };
}

@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly logger = new Logger(AccessTokenGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    @Optional() private readonly orgScopeService?: OrgScopeService,
    /**
     * AUTH-02（2026-09-24 链行为基线 §5.3em）：org 层级解析发生在**身份与租户上下文
     * 建立之前**——`AccessTokenGuard` 先于 `TracingInterceptor`（请求上下文的建立点）
     * 与 `OrgContextInterceptor`（请求事务的建立点）执行，所以这条读既没有事务 store、
     * 也没有请求上下文：`EWOH_DB_REQUIRE_TX=1` 的 fail-closed（按请求上下文判）对它
     * **结构性不可见**，它一直走"无上下文豁免面"静默回落根句柄（无 statement_timeout、
     * 不进任何事务纪律核算）。V189 实测（隔离集群，Bearer → /api/auth/me，两档开关）：
     * 授权面在两档下都是全层级（推断中的"兜底一开就降级为主组织"不成立——抛错路径
     * 根本不可达）。这里照 V61（登录读）/V65（就绪探针）的同款收口：显式给它一个
     * **系统事务**（无 GUC，走 SECURITY DEFINER 的 `ewoh_find_org*`，与
     * systemTransaction 的约定一致：不依赖 RLS 的表/函数），并把 statement_timeout
     * 带进授权路径。缺省（未注入，如单测直接 new）时退回原句柄行为。
     */
    @Optional() private readonly requestDatabaseContext?: RequestDatabaseContext,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers?.authorization;
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      throw new UnauthorizedException('Bearer access token is required');
    }

    const payload = await this.authService.verifyToken(match[1]);
    let accessibleOrgIds: string[];
    try {
      // AUTH-02：身份前的跨组织系统读，显式进系统事务（无 GUC；见构造函数注释）。
      const resolveScope = () => this.orgScopeService?.resolveOrgScope(payload.orgId);
      const scope = this.requestDatabaseContext
        ? await this.requestDatabaseContext.systemTransaction(resolveScope)
        : await resolveScope();
      accessibleOrgIds =
        scope && scope.orgIds.length > 0 ? scope.orgIds : [payload.orgId];
    } catch (error) {
      // 层级环意味着组织树事实损坏；降级到主组织仍是“用未知层级授权”。
      // 这里必须显式拒绝，绝不能把不可信配置当成可继承事实。
      if (error instanceof OrgScopeHierarchyCycleError) {
        throw new UnauthorizedException('Organization hierarchy is invalid');
      }
      this.logger.warn(
        `Org scope resolution failed for ${payload.orgId}; falling back to primary org`,
        error instanceof Error ? error.stack : error,
      );
      accessibleOrgIds = [payload.orgId];
    }
    request.userContext = {
      userId: payload.sub,
      primaryOrgId: payload.orgId,
      roles: payload.roles,
      accessibleOrgIds,
      isGlobalAdmin: payload.roles.includes('global_admin'),
      // 绑定随令牌下发，不接受请求体/查询参数自报。
      personId: typeof payload.personId === 'string' && payload.personId.trim()
        ? payload.personId.trim()
        : null,
    };
    return true;
  }
}
