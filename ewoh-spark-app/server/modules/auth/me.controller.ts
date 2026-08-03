import { Controller, Get, Req, UnauthorizedException } from '@nestjs/common';
import { Roles, ANY_AUTHENTICATED_ROLES } from '../shared/roles.decorator';

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
