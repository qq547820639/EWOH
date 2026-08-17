import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import { Roles, ANY_AUTHENTICATED_ROLES } from '../shared/roles.decorator';

/**
 * NEST-438（裁决）：/api/me 是 /api/auth/me 的兼容别名——openapi 契约
 * （openapi.d.ts "/api/me"）与 e2e（ewoh-http.e2e.spec）依赖该路由，物理
 * 删除属对外契约破坏（spec 边界 3 契约冻结层）；两路由语义由本控制器与
 * AuthController.me 各自保持一致（同一 userContext 投影），新增鉴权行为
 * 只在 AuthController 演进，本别名仅跟随。
 */
@Controller('api')
export class MeController {
  @Roles(...ANY_AUTHENTICATED_ROLES)
  @Get('me')
  me(@Req() request: { userContext?: { userId?: string; roles?: string[]; primaryOrgId?: string } }) {
    if (!request.userContext?.userId) {
      throw new UnauthorizedException('Not authenticated');
    }
    return request.userContext;
  }
}
