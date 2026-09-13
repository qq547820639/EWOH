import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '../auth/auth.service';
import { OrgScopeService } from './org-scope.service';
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
      const scope = await this.orgScopeService?.resolveOrgScope(payload.orgId);
      accessibleOrgIds =
        scope && scope.orgIds.length > 0 ? scope.orgIds : [payload.orgId];
    } catch (error) {
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
